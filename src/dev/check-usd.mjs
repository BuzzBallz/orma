// Check of step 21 (addendum A11): loans in the Devnet test dollar that stands in for RLUSD, against the same
// shares of XRP vaults, at the XRP/USD price of the XLS-47 oracle documents the risk officer's terms name.
// Offline: the price (the median of the fresh sources read at L, the ledger's aggregate agreeing, or no price
// and why), the dollar ticket's LTV with the haircut, every figure a decimal string at precision 40 and
// recomputable, issued-currency amount objects, an unusable price refused, the XRP path unchanged byte for
// byte, collateral still shares of XRP vaults only (I4), positions and the margin call in dollars, the relay's
// encoding, and the stand-in label on every dollar the desk shows. --live, read only, under with-api.mjs: the
// vault of demo/desk-usd.json at one validated ledger, its asset, the issuer's clawback flag, the borrower's
// trust line, the terms' anchor and sources on Devnet, and the API's dollar ticket at the oracles' price.
//   node src/dev/check-usd.mjs
//   node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-usd.mjs --live
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { Wallet } from 'xrpl'
import { num, Decimal } from '../num.mjs'
import {
  SCHEMAS, canonical, sha256Hex, usdTermsHash, usdAmount, USD_LABEL, USD_COLLATERAL_RULE, USD_FIGURES,
  judgeCollateralShare, PROVEN_SHARE_FLAGS, RIPPLE_EPOCH_OFFSET, medianOf,
} from '../nyc/contracts.mjs'
import { buildTicket, buildPositions, evaluateFormula, dropsToUsd } from '../ticket/engine.mjs'
import { judgePrice, readXrpUsd, pairOf, PriceUnavailableError } from '../fx/price.mjs'
import { FX_VENUES, quoteOf, priceDataOf } from '../fx/venues.mjs'
import { judgeMarginCall, sharesToRestoreUsd, valueOfUnits } from '../desk/margin-call.mjs'
import { createRoleEngine } from '../roles/engine.mjs'
import { createApi } from '../api.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const throws = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.constructor.name : 'thrown'
  }
}
const rejects = async (p) => {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}
const DOWN = Decimal.ROUND_DOWN
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** Every Figure of a document, with its path. */
function figuresOf(v, path = '', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => figuresOf(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') {
    if (typeof v.formulaId === 'string' && Array.isArray(v.inputs)) out.push([path, v])
    else for (const [k, x] of Object.entries(v)) figuresOf(x, path ? `${path}.${k}` : k, out)
  }
  return out
}
const recomputes = (doc) => figuresOf(doc).filter(([, f]) => evaluateFormula(f.formulaId, f.inputs) !== f.value).map(([p]) => p)

// --- the fixture: demo/desk.json's calibration objects, Harbor-1 at one ledger -----------------------------
const desk = read('demo/desk.json')
const mandate = read('demo/mandate-desk-1.json')
const c = desk.calibration
const { shares, ...vaultRaw } = c.objects.vault
const inputs = {
  ledgerIndex: c.ledgerIndex, ledgerHash: c.ledgerHash, closeTime: c.closeTime,
  vault: { id: vaultRaw.index, fields: vaultRaw, raw: vaultRaw },
  issuance: { id: shares.mpt_issuance_id, fields: shares, raw: shares },
  brokers: [{ id: c.objects.broker.index, fields: c.objects.broker, raw: c.objects.broker, loans: ['L1', 'L2'].map((k) => ({ id: c.objects.loans[k].index, label: k, fields: c.objects.loans[k], raw: c.objects.loans[k] })) }],
  conduct: { recognitionLagSeconds: ['92'], defaultsWithoutImpairment: 0, coverOrderCostDrops: '0' },
}
const AT = { ledgerIndex: c.ledgerIndex, ledgerHash: c.ledgerHash, closeTime: c.closeTime }
const CLOSE_UNIX = c.closeTime + RIPPLE_EPOCH_OFFSET
const ISSUER = 'rUSDw1nGKbkLj9hTjHmBPbVSVcXCoVhQe7'
const RELAY = 'rRe1ayXRPUSDfeedsDevnetQvTnkGqh5u'
/** Terms as anchor-usd-terms writes them, on the real mandate, hashed: the three relay documents. */
function termsFor(o = {}, oracle = {}) {
  const body = {
    schema: 'orma.usdterms/1', id: mandate.id, mandateHash: mandate.hash,
    loanAsset: { currency: 'USD', issuer: ISSUER, label: USD_LABEL },
    xrpUsdOracle: {
      baseAsset: 'XRP', quoteAsset: 'USD', sources: FX_VENUES.map((v) => ({ account: RELAY, documentId: v.documentId, provider: v.provider, uri: v.uri })),
      aggregation: 'median', minSources: 2, maxAgeSeconds: 300, maxSpreadBps: 100, note: 'fixture', ...oracle,
    },
    fxHaircutBps: 1000, maxSingleLoanUsd: '10', issuedAt: '2026-10-24T22:00:00.000Z',
    ...o,
  }
  return { ...body, hash: usdTermsHash(body), anchorTx: 'A'.repeat(64) }
}
const TERMS = termsFor()
const PRINCIPAL_USD = '2.322'
/** An Oracle object as ledger_entry returns it, one XRP/USD pair, updated `ago` seconds before L's close. */
const oracleNode = (price, ago, documentId = 1) => ({ LedgerEntryType: 'Oracle', Owner: RELAY, OracleDocumentID: documentId, LastUpdateTime: CLOSE_UNIX - ago, PriceDataSeries: [{ PriceData: priceDataOf(price) }] })
/** A fake rippled: the three documents at L, and get_aggregate_price as rippled computes it over the ones asked. */
function fakeLedger(nodes, { aggregate = null, answeredAt = AT.ledgerIndex, failing = {} } = {}) {
  const calls = []
  return {
    calls,
    req: async (p) => {
      calls.push(p)
      if (p.command === 'ledger_entry') {
        const fault = failing[p.oracle.oracle_document_id]
        if (fault) throw fault
        const n = nodes[p.oracle.oracle_document_id - 1]
        if (!n) throw Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
        return { result: { node: n, ledger_index: answeredAt } }
      }
      if (p.command === 'get_aggregate_price') {
        const prices = p.oracles.map((o) => pairOf(nodes[o.oracle_document_id - 1]).price)
        return { result: { median: aggregate ?? medianOf(prices), entire_set: { size: prices.length }, ledger_index: p.ledger_index, ledger_hash: AT.ledgerHash, validated: true } }
      }
      throw new Error(`unexpected ${p.command}`)
    },
  }
}
const FRESH = [oracleNode('1.29', 40, 1), oracleNode('1.2899', 50, 2), oracleNode('1.2902', 30, 3)]
const PRICE = await readXrpUsd(fakeLedger(FRESH), TERMS, AT)
const usdTicket = (price = PRICE, principalUsd = PRINCIPAL_USD, at = inputs, terms = TERMS) => buildTicket(at, { op: 'pledge', units: c.units, mandate, usd: { terms, principalUsd, price } })

if (process.argv.includes('--live')) await live()
else await offline()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0

async function offline() {
  console.log('the XRP/USD price: the median of the fresh oracle documents at L, the ledger agreeing')
  {
    eq('three fresh documents: the median, REAL, its spread, the oldest update, each read at L', [PRICE.value, PRICE.provenance, PRICE.spreadBps, PRICE.ageSeconds, PRICE.sources.map((s) => [s.provider, s.price, s.ageSeconds, s.used, s.ledgerIndex])],
      ['1.29', 'REAL', 3, '50', [['kraken', '1.29', '40', true, AT.ledgerIndex], ['bitstamp', '1.2899', '50', true, AT.ledgerIndex], ['coinbase', '1.2902', '30', true, AT.ledgerIndex]]])
    const x = fakeLedger(FRESH)
    await readXrpUsd(x, TERMS, AT)
    eq('every read is pinned to L: three ledger_entry, then get_aggregate_price over the same three at L',
      [x.calls.map((p) => [p.command, p.ledger_index]), x.calls.at(-1).oracles], [[['ledger_entry', AT.ledgerIndex], ['ledger_entry', AT.ledgerIndex], ['ledger_entry', AT.ledgerIndex], ['get_aggregate_price', AT.ledgerIndex]], FX_VENUES.map((v) => ({ account: RELAY, oracle_document_id: v.documentId }))])
    eq('the ledger aggregate is kept beside the median', PRICE.ledgerAggregate, { median: '1.29', size: 3, ledgerIndex: AT.ledgerIndex, ledgerHash: AT.ledgerHash })
    const one = await readXrpUsd(fakeLedger([FRESH[0], oracleNode('1.29', 301, 2), FRESH[2]]), TERMS, AT)
    eq('one document 301 s old: left out, the median of the two others (the mean of the middle two)', [one.value, one.sources.map((s) => s.used), one.ledgerAggregate.size], ['1.2901', [true, false, true], 2])
    const why = async (nodes, o = {}, terms = TERMS) => {
      const e = await rejects(readXrpUsd(fakeLedger(nodes, o), terms, AT))
      return e instanceof PriceUnavailableError ? [e.code, e.message] : [String(e)]
    }
    const twoStale = await why([FRESH[0], oracleNode('1.29', 400, 2), oracleNode('1.29', 900, 3)])
    eq('two stale of three, with minSources 2: PRICE_UNAVAILABLE, naming the stale ones and their age', [twoStale[0], /Only 1 of the 3 .* fresh .*bitstamp 400 s old, coinbase 900 s old/.test(twoStale[1])], ['PRICE_UNAVAILABLE', true])
    const gone = await why([FRESH[0], null, null])
    eq('documents missing from the ledger count as no price', [gone[0], /no price: bitstamp, coinbase/.test(gone[1])], ['PRICE_UNAVAILABLE', true])
    const apart = await why([oracleNode('1.29', 10, 1), oracleNode('1.31', 10, 2), oracleNode('1.30', 10, 3)])
    eq('fresh sources 154 bps apart, over the terms\' 100: PRICE_UNAVAILABLE', [apart[0], /disagree by 154 bps/.test(apart[1])], ['PRICE_UNAVAILABLE', true])
    const disagree = await why(FRESH, { aggregate: '1.31' })
    eq('the ledger\'s get_aggregate_price disagreeing with the documents: PRICE_UNAVAILABLE', [disagree[0], /median of 1\.31 over 3 documents, not the 1\.29/.test(disagree[1])], ['PRICE_UNAVAILABLE', true])
    const elsewhere = await why(FRESH, { answeredAt: AT.ledgerIndex + 1 })
    eq('documents answered at another ledger: not read, never mixed into L, PRICE_UNAVAILABLE', [elsewhere[0], /not read: .*answered at ledger/.test(elsewhere[1])], ['PRICE_UNAVAILABLE', true])
    const nodeError = Object.assign(new Error('lgrNotFound'), { data: { error: 'lgrNotFound' } })
    const oneDown = await readXrpUsd(fakeLedger(FRESH, { failing: { 2: nodeError } }), TERMS, AT)
    eq('one document unreadable (lgrNotFound): that source has no price, the two others decide', [oneDown.value, oneDown.sources.map((s) => [s.provider, s.price, s.used]), oneDown.ledgerAggregate.size],
      ['1.2901', [['kraken', '1.29', true], ['bitstamp', null, false], ['coinbase', '1.2902', true]], 2])
    const timeout = new Error('Timeout for request: {"command":"ledger_entry"}')
    const twoDown = await why(FRESH, { failing: { 1: timeout, 3: nodeError } })
    eq('two documents unreadable (a timeout, lgrNotFound): PRICE_UNAVAILABLE, naming each and why', [twoDown[0], /not read: kraken \(Timeout for request.*\), coinbase \(lgrNotFound\)/.test(twoDown[1])], ['PRICE_UNAVAILABLE', true])
    const ahead = await readXrpUsd(fakeLedger([oracleNode('1.29', -200, 1), FRESH[1], FRESH[2]]), TERMS, AT)
    eq('a document dated 200 s after the ledger read is not fresh: the two others decide', [ahead.value, ahead.sources.map((s) => [s.provider, s.ageSeconds, s.used])],
      ['1.29005', [['kraken', '-200', false], ['bitstamp', '50', true], ['coinbase', '30', true]]])
    const aheadAll = await why([oracleNode('1.29', -200, 1), oracleNode('1.29', -10, 2), FRESH[2]])
    eq('two dated after the ledger: PRICE_UNAVAILABLE, saying so', [aheadAll[0], /dated after the ledger: kraken 200 s, bitstamp 10 s/.test(aheadAll[1])], ['PRICE_UNAVAILABLE', true])
    eq('a reference that uses a source dated after its ledger is refused by the contract', SCHEMAS.ticket(usdTicket({ ...PRICE, sources: PRICE.sources.map((s, i) => (i === 0 ? { ...s, ageSeconds: '-200' } : s)) })).some((p) => p.includes('dated after the ledger')), true)
    eq('judgePrice is pure: the same reads give the same answer', JSON.stringify(judgePrice(FRESH.map((node, i) => ({ source: TERMS.xrpUsdOracle.sources[i], node })), TERMS.xrpUsdOracle, AT)) === JSON.stringify(judgePrice(FRESH.map((node, i) => ({ source: TERMS.xrpUsdOracle.sources[i], node })), TERMS.xrpUsdOracle, AT)), true)
    eq('the XLS-47 encoding round-trips: 1.28962 is 1F7C2 at Scale 5, read back as 1.28962', [priceDataOf('1.28962'), pairOf({ LastUpdateTime: 1, PriceDataSeries: [{ PriceData: priceDataOf('1.28962') }] })?.price],
      [{ BaseAsset: 'XRP', QuoteAsset: 'USD', AssetPrice: '1F7C2', Scale: 5 }, '1.28962'])
    eq('a pair whose price was withdrawn (no AssetPrice) is no price', pairOf({ LastUpdateTime: 1, PriceDataSeries: [{ PriceData: { BaseAsset: 'XRP', QuoteAsset: 'USD' } }] }), null)
  }

  console.log('the relay\'s quotes: decimal strings from the venues, or why not')
  {
    const answer = (status, body) => async () => ({ status, json: async () => body })
    const now = Date.parse('2026-10-24T22:20:00Z')
    eq('Kraken: the last trade c[0], a string', await quoteOf(FX_VENUES[0], { fetchImpl: answer(200, { error: [], result: { XXRPZUSD: { c: ['1.28962000', '5.1'] } } }), nowMs: now }), { ok: true, price: '1.28962', at: null })
    eq('Bitstamp: last, with its UNIX timestamp', await quoteOf(FX_VENUES[1], { fetchImpl: answer(200, { last: '1.28965', timestamp: String(now / 1000 - 10) }), nowMs: now }), { ok: true, price: '1.28965', at: '2026-10-24T22:19:50.000Z' })
    eq('a price sent as a JSON number is refused, never coerced', (await quoteOf(FX_VENUES[2], { fetchImpl: answer(200, { price: 1.2898, time: '2026-10-24T22:19:59Z' }), nowMs: now })).ok, false)
    eq('a last trade older than 120 s is not relayed as fresh', (await quoteOf(FX_VENUES[2], { fetchImpl: answer(200, { price: '1.2898', time: '2026-10-24T22:15:00Z' }), nowMs: now })).reason, "coinbase's last trade is 300 s old, more than 120 s")
    eq('an HTTP error is said', (await quoteOf(FX_VENUES[0], { fetchImpl: answer(503, {}), nowMs: now })).reason, 'kraken answered HTTP 503')
  }

  console.log('the dollar ticket (demo/desk.json calibration objects, Harbor-1 at 0.800000, XRP/USD 1.29)')
  {
    const t = usdTicket()
    const x = buildTicket(inputs, { op: 'pledge', units: c.units, mandate, principalDrops: c.principalDrops })
    eq('it passes SCHEMAS.ticket', SCHEMAS.ticket(t), [])
    const byHand = new Decimal(t.figures.heldValue.value).div(1e6).times('1.29').times(new Decimal(1).minus(new Decimal(1000).div(10000))).toFixed(6, DOWN)
    eq('collateralHeldUsd = withdrawal value in XRP × the oracles\' median × (1 − 1000 / 10000), rounded down', [t.figures.heldValue.value, t.figures.collateralHeldUsd.value, byHand], ['4000000', '4.644000', '4.644000'])
    eq('ltvHeldUsd = floor(2.322 × 10000 / 4.644): at 1.29 the dollar plan sits at the XRP plan\'s LTV', [t.figures.ltvHeldUsd.value, x.figures.ltvHeld.value, t.usd.ltvHeldBps], ['5000', '5000', 5000])
    eq('maxLoanUsd, requestedUsd, lender1to1Usd (5 XRP at par, in dollars), priceAge (the oldest source used)', [t.figures.maxLoanUsd.value, t.figures.requestedUsd.value, t.figures.lender1to1Usd.value, t.figures.priceAge.value], ['2.481753', '2.322', '4000', '50'])
    eq('every figure of the dollar ticket recomputes from its own inputs', recomputes(t), [])
    eq('the price enters the figures as OracleAggregate inputs (REAL), the haircut as a UsdTerms input (DECLARED)', t.figures.ltvHeldUsd.inputs.filter((i) => ['xrpUsd', 'fxHaircutBps', 'principalUsd'].includes(i.name)).map((i) => [i.name, i.object, i.value]),
      [['xrpUsd', 'OracleAggregate', '1.29'], ['fxHaircutBps', 'UsdTerms', '1000'], ['principalUsd', 'Plan', '2.322']])
    eq('the six dollar figures, none of the four in drops', [USD_FIGURES.every((k) => k in t.figures), ['maxLoan', 'requested', 'ltvHeld', 'lender1to1'].some((k) => k in t.figures)], [true, false])
    eq('the verdicts judge the dollar loan on maxLtvBps, maxSingleLoanUsd, N2 and lock-up', [t.verdict, t.verdict1to1], [{ status: 'PASS', breaches: [] }, { status: 'PASS', breaches: [] }])
    eq('the usd block: the label, the collateral line, the price as read', [t.usd.loanAsset, t.usd.collateralRule, t.usd.reference.value, t.usd.reference.provenance], [{ currency: 'USD', issuer: ISSUER, label: USD_LABEL }, USD_COLLATERAL_RULE, '1.29', 'REAL'])
    eq('a dollar ticket and an XRP ticket at one ledger have two ids and two digests', [t.ticketId !== x.ticketId, t.inputsDigest !== x.inputsDigest], [true, true])
    const moved = usdTicket(await readXrpUsd(fakeLedger([oracleNode('1.31', 40, 1), oracleNode('1.3099', 50, 2), oracleNode('1.3102', 30, 3)]), TERMS, AT))
    eq('the price moves: the figures move, the digest does not (the approval judges again at its own price)', [moved.figures.ltvHeldUsd.value !== t.figures.ltvHeldUsd.value, moved.inputsDigest === t.inputsDigest], [true, true])
    eq('the haircut changes: the digest moves (STALE)', usdTicket(PRICE, PRINCIPAL_USD, inputs, termsFor({ fxHaircutBps: 1500 })).inputsDigest !== t.inputsDigest, true)
    eq('a buy has no loan currency', throws(() => buildTicket(inputs, { op: 'buy', units: c.units, mandate, usd: { terms: TERMS, principalUsd: '1', price: PRICE } })), 'RangeError')
    const big = usdTicket(PRICE, '10.000001')
    eq('one millionth of a dollar above maxSingleLoanUsd: BREACHED', big.verdict.breaches.map((b) => b.limit), ['maxLtvBps', 'maxSingleLoanUsd'])
    const low = usdTicket(await readXrpUsd(fakeLedger([oracleNode('1.20', 40, 1), oracleNode('1.2001', 50, 2), oracleNode('1.1999', 30, 3)]), TERMS, AT))
    eq('XRP at 1.20: the same loan at 5375 bps breaks the mandate\'s 5344, in dollars', [low.figures.ltvHeldUsd.value, low.verdict.status], ['5375', 'BREACHED'])
  }

  console.log('decimal strings at precision 40')
  {
    // 0.29 × 100 is 28.999999999999996 in floating point; the dollar figure is 29.000000
    const one = (name, value) => ({ name, value: String(value), object: 'Fixture', field: name, id: 'x', ledgerIndex: 1, ledgerHash: '0'.repeat(64) })
    const base = { AssetsTotal: '290000', LossUnrealized: '0', OutstandingAmount: '290000', Scale: '0', units: '290000', xrpUsd: '100', fxHaircutBps: '0' }
    const ins = (o) => Object.entries({ ...base, ...o }).map(([k, v]) => one(k, v))
    eq('0.29 XRP at 100 dollars: 29.000000, where floating point reads 28.999999999999996', [evaluateFormula('collateralHeldUsd', ins({})), String(0.29 * 100)], ['29.000000', '28.999999999999996'])
    let seed = 2101
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const digits = (n) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('').replace(/^0+(?=\d)/, '')
    let off = 0
    let shape = 0
    for (let i = 0; i < 500; i++) {
      const total = digits(4 + Math.floor(rand() * 12)) || '1'
      const loss = new Decimal(total).times(rand() < 0.5 ? 0 : '0.' + digits(3)).toFixed(0)
      const sharesOut = new Decimal(total).plus(digits(3) || '0').toFixed(0)
      const units = new Decimal(sharesOut).div(1 + Math.floor(rand() * 9)).toFixed(0)
      const price = `${digits(1 + Math.floor(rand() * 3)) || '0'}.${digits(1 + Math.floor(rand() * 28)) || '1'}`
      const h = String(Math.floor(rand() * 9999))
      const got = evaluateFormula('collateralHeldUsd', ins({ AssetsTotal: total, LossUnrealized: loss, OutstandingAmount: sharesOut, units, xrpUsd: price, fxHaircutBps: h }))
      const per = new Decimal(new Decimal(total).minus(loss).div(new Decimal(sharesOut)).toFixed(6))
      const held = new Decimal(new Decimal(units).times(per).toFixed(0))
      const want = held.div(1e6).times(price).times(new Decimal(1).minus(new Decimal(h).div(10000))).toFixed(6, DOWN)
      if (got !== want) off++
      if (!/^\d+\.\d{6}$/.test(got)) shape++
    }
    eq('500 seeded cases, prices of up to 31 significant digits: the figure is the precision-40 computation, as a decimal string', [off, shape], [0, 0])
    eq('a median of prices of 30 digits is exact', medianOf(['1.234567890123456789012345678901', '1.234567890123456789012345678903']), '1.234567890123456789012345678902')
  }

  console.log('issued-currency amount objects')
  eq('usdAmount: currency, issuer and the value as a decimal string', usdAmount('2.322', ISSUER), { currency: 'USD', issuer: ISSUER, value: '2.322' })
  eq('a number, an exponent, a negative or no issuer is refused, never coerced', [throws(() => usdAmount(2.322, ISSUER)), throws(() => usdAmount('2e3', ISSUER)), throws(() => usdAmount('-1', ISSUER)), throws(() => usdAmount('1', 'nobody'))], ['TypeError', 'TypeError', 'TypeError', 'TypeError'])
  {
    const src = readFileSync('src/demo/bake-usd.mjs', 'utf8')
    const amounts = src.split(/\r?\n/).filter((l) => /\b(Amount|LimitAmount):/.test(l))
    eq('every amount bake-usd sends is built by usdAmount: no XRP drops, no number', [amounts.length, amounts.every((l) => /(Amount|LimitAmount): usdAmount\(/.test(l))], [5, true])
    const noNumber = ['src/demo/bake-usd.mjs', 'src/fx/price.mjs', 'src/demo/fx-relay.mjs'].filter((f) => /\bNumber\(|parseFloat\(/.test(readFileSync(f, 'utf8')))
    eq('no Number( nor parseFloat( in the bake, the price reader or the relay', noNumber, [])
  }

  console.log('no usable price, no dollar figure (I7 applied to the price)')
  {
    const signer = readFileSync('src/desk/signer.mjs', 'utf8')
    const route = readFileSync('src/nyc/index.mjs', 'utf8')
    eq('the desk refuses PRICE_UNAVAILABLE at its approval and its preview, logged', [/PriceUnavailableError\) \{\s*append\(act, mandate, L, 'refused', \{ code: 'PRICE_UNAVAILABLE' \}\)/.test(signer), (signer.match(/new DeskError\(409, 'PRICE_UNAVAILABLE'/g) ?? []).length], [true, 3])
    eq('the ticket route answers 409 PRICE_UNAVAILABLE, retryable', /fail\(409, 'PRICE_UNAVAILABLE', e\.message, true\)/.test(route), true)
    const p = buildPositions({ ...positionsDoc('USD', PRINCIPAL_USD), usdTerms: TERMS, usdPrice: null, usdPriceError: 'Only 1 of the 3 XRP/USD oracle documents of the terms is fresh.' }, mandate).positions[0]
    eq('a dollar position with no usable price: no LTV, no dollar collateral, no reference, and why', [p.ltvHeldBps, p.usd.collateralHeldUsd, p.usd.reference, p.usd.priceUnavailable], [null, null, null, 'Only 1 of the 3 XRP/USD oracle documents of the terms is fresh.'])
    const policy = read('demo/margin-policy-desk-1.json')
    const snapshot = { ledgerIndex: 7000, ledgerHash: '7'.repeat(64), closeTime: 846200000 }
    const issued = { status: 'ISSUED', loanId: 'A'.repeat(64), issuedLedger: 6990, issuedAt: '2026-10-25T14:00:00Z', cureBy: '2026-10-25T14:10:00Z', ltvHeldBps: 5689, maxLtvBps: 5344, shortfall: { collateralValueDrops: '1', sharesToAdd: '1', withdrawalValuePerShare: '0.703000', collateralValueUsd: '0.000001' }, reasons: ['r1', 'r2'], provenance: 'DECLARED', ledgerIndex: 6990, ledgerHash: '6'.repeat(64), entryHash: 'E'.repeat(64), currency: 'USD' }
    const kept = judgeMarginCall({ position: { ...p, withdrawalValuePerShare: '0.800000', shareScale: 0 }, policy, mandate, snapshot, previous: issued })
    eq('the margin call: the previous status stands, with the reason, in dollars', [kept.status, kept.issuedLedger, kept.currency, kept.reasons.at(-1).startsWith('No XRP/USD price at ledger 7000')], ['ISSUED', 6990, 'USD', true])
    const none = judgeMarginCall({ position: { ...p, withdrawalValuePerShare: '0.800000', shareScale: 0 }, policy, mandate, snapshot })
    eq('with no call before: NONE, saying why, never a breach invented', [none.status, none.ltvHeldBps, none.currency], ['NONE', null, 'USD'])
    // a call restored from the decision log at startup, as the step-20 block builds it, its shortfall from the entry
    const restored = { status: 'ISSUED', loanId: 'A'.repeat(64), issuedLedger: 6990, issuedAt: issued.issuedAt, cureBy: issued.cureBy, ltvHeldBps: 5689, maxLtvBps: 5344, shortfall: issued.shortfall, reasons: [], provenance: 'DECLARED', ledgerIndex: 6990, ledgerHash: '6'.repeat(64), entryHash: 'E'.repeat(64) }
    const afterRestart = judgeMarginCall({ position: { ...p, withdrawalValuePerShare: '0.800000', shareScale: 0 }, policy, mandate, snapshot, previous: restored })
    eq('restarted with no usable price: the call restored from its log entry stands whole and passes SCHEMAS.marginCall', [afterRestart.status, afterRestart.shortfall?.sharesToAdd, SCHEMAS.marginCall(afterRestart)], ['ISSUED', '1', []])
  }

  console.log('the XRP path, unchanged')
  {
    // hashes of the XRP ticket and positions as buildTicket and buildPositions gave them before step 21
    eq('the XRP pledge ticket, byte for byte', sha256Hex(canonical(buildTicket(inputs, { op: 'pledge', units: c.units, mandate, principalDrops: c.principalDrops }))), '4235973687f5fb7d924add34002391d37092b02c2f28a0993e0eda7e389dda1a')
    eq('the XRP buy ticket, byte for byte', sha256Hex(canonical(buildTicket(inputs, { op: 'buy', units: c.units, mandate }))), 'ef17fab3ba87d64cf4fad1f18342ea0f2274e2670eab73cf11472d0ddf1c9255')
    const p = buildPositions(positionsDoc('XRP', c.principalDrops), mandate)
    // the two fields of the Harbor-1 demo fix (the LoanSet's ledger and ticket Memo) are not what this pin guards
    const { currency, loanSetLedger: _ledger, loanSetTicket: _ticket, ...rest } = p.positions[0]
    void _ledger; void _ticket
    eq('an XRP position: what it was, plus currency XRP', [currency, sha256Hex(canonical({ ...p, positions: [rest] }))], ['XRP', 'ef1a3ce518b613d33ebe51c6e87dc7b2f0245d1139611a0249655c409e5917f6'])
    const x = buildTicket(inputs, { op: 'pledge', units: c.units, mandate, principalDrops: c.principalDrops })
    eq('an XRP ticket carries no usd and no dollar figure', ['usd' in x, USD_FIGURES.some((k) => k in x.figures)], [false, false])
  }

  console.log('collateral: shares of XRP vaults only (I4)')
  {
    const share = { Flags: PROVEN_SHARE_FLAGS }
    eq('a share of a USD vault is refused: its issuer can claw back or freeze the asset', judgeCollateralShare({ vault: { Asset: { currency: 'USD', issuer: ISSUER }, VaultKind: 1 }, issuance: share, mptoken: {} }),
      { eligible: false, reasons: ['vault asset is not XRP: its issuer can claw it back or freeze it'] })
    eq('a share of an XRP vault, closed-ended, with the proven flags, is eligible', judgeCollateralShare({ vault: { Asset: { currency: 'XRP' }, VaultKind: 1 }, issuance: share, mptoken: {} }).eligible, true)
  }

  console.log('positions and the margin call in dollars')
  {
    const p = buildPositions({ ...positionsDoc('USD', PRINCIPAL_USD), usdTerms: TERMS, usdPrice: PRICE }, mandate).positions[0]
    eq('a USD position: currency, principal in dollars as the ledger states it, the LTV in dollars, its usage rows',
      [p.currency, p.principalOutstanding, p.ltvHeldBps, p.collateralHeldDrops, p.usage.map((u) => u.limit)],
      ['USD', '2.322', 5000, '4000000', ['maxLtvBps', 'maxSingleLoanUsd', 'maxN2LossDrops', 'maxLockupDays']])
    eq('its usd block: the label, the collateral in dollars, the price as read', [p.usd.loanAsset.label, p.usd.collateralHeldUsd, p.usd.principalOutstandingUsd, p.usd.reference.value, p.usd.terms.hash], [USD_LABEL, '4.644000', '2.322', '1.29', TERMS.hash])
    // terms that do not hash, or name another mandate: no dollar figure, and the XRP positions as they are
    const both = (usdTerms) => {
      const doc = positionsDoc('USD', PRINCIPAL_USD)
      const xrpLoan = positionsDoc('XRP', c.principalDrops).loans[0]
      return buildPositions({ ...doc, loans: [{ ...xrpLoan, loanId: 'D'.repeat(64) }, ...doc.loans], usdTerms, usdPrice: PRICE, usdLoanAsset: { currency: 'USD', issuer: ISSUER, label: USD_LABEL } }, mandate).positions
    }
    const tampered = both({ ...TERMS, fxHaircutBps: 0 })
    const foreign = both(termsFor({ mandateHash: 'B'.repeat(64) }))
    eq('terms that do not hash, or name another mandate: the dollar position unpriced, saying why, the XRP one served as it is',
      [tampered[1].ltvHeldBps, tampered[1].usd.terms, tampered[1].usd.reference, /does not hash to its own hash, or names another mandate/.test(tampered[1].usd.priceUnavailable), foreign[1].ltvHeldBps, tampered[0].currency, tampered[0].ltvHeldBps, tampered[0].ltvHeldBps === buildPositions(positionsDoc('XRP', c.principalDrops), mandate).positions[0].ltvHeldBps],
      [null, null, null, true, null, 'XRP', 5000, true])
    eq('unpriced, the dollar position still names its loan asset with the label', tampered[1].usd.loanAsset, { currency: 'USD', issuer: ISSUER, label: USD_LABEL })

    // after L2 defaults alone: 0.703000 per share, 3.515 XRP of collateral, 4.080915 dollars at 1.29
    const after = { ...p, collateralHeldDrops: '3515000', ltvHeldBps: JSON.parse(num(PRINCIPAL_USD).times(10000).div(dropsToUsd('3515000', '1.29', 1000)).floor().toFixed(0)), withdrawalValuePerShare: '0.703000', shareScale: 0 }
    const snapshot = { ledgerIndex: 7000, ledgerHash: '7'.repeat(64), closeTime: 846200000 }
    const policy = read('demo/margin-policy-desk-1.json')
    const call = judgeMarginCall({ position: after, policy, mandate, snapshot })
    const sh = call.shortfall
    const restores = (units) => num(PRINCIPAL_USD).times(10000).div(dropsToUsd(num('3515000').plus(valueOfUnits(units, '0.703000', 0)), '1.29', 1000)).floor().lte(mandate.limits.maxLtvBps)
    eq('the same default crosses the same limit at 1.29: ISSUED in dollars, LTV 5689 against 5344', [call.status, call.currency, call.ltvHeldBps, call.maxLtvBps], ['ISSUED', 'USD', 5689, 5344])
    eq('sharesToAdd is the smallest whole number that restores the limit, in dollars', [restores(sh.sharesToAdd), restores(num(sh.sharesToAdd).minus(1).toFixed(0))], [true, false])
    eq('the shortfall in drops and in dollars, the reasons in dollars with the label', [/^\d+$/.test(sh.collateralValueDrops), /^\d+\.\d{6}$/.test(sh.collateralValueUsd), call.reasons.every((r) => !/RLUSD/.test(r) || r.includes(USD_LABEL)), call.reasons.some((r) => r.includes(USD_LABEL))], [true, true, true, true])
    eq('a USD margin call passes SCHEMAS.marginCall', SCHEMAS.marginCall({ ...call, entryHash: 'E'.repeat(64) }), [])
    const cured = judgeMarginCall({ position: { ...p, withdrawalValuePerShare: '0.800000', shareScale: 0 }, policy, mandate, snapshot: { ...snapshot, ledgerIndex: 7001, closeTime: 846200060 }, previous: { ...call, entryHash: 'E'.repeat(64) } })
    eq('back within the limit before cureBy: CURED, still in dollars', [cured.status, cured.currency, cured.shortfall], ['CURED', 'USD', null])
    const xrpCall = judgeMarginCall({ position: { ...buildPositions(positionsDoc('XRP', c.principalDrops), mandate).positions[0], withdrawalValuePerShare: '0.800000', shareScale: 0 }, policy, mandate, snapshot })
    eq('an XRP call carries no currency key, as at step 20', 'currency' in xrpCall, false)
    let seed = 2102
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    let wrong = 0
    for (let i = 0; i < 300; i++) {
      const principal = new Decimal(1 + Math.floor(rand() * 9999)).div(1000).toFixed()
      const heldD = String(100000 + Math.floor(rand() * 9000000))
      const per = new Decimal(1 + Math.floor(rand() * 999999)).div(1e6).toFixed(6)
      const max = 1000 + Math.floor(rand() * 8000)
      const xrpUsd = new Decimal(1 + Math.floor(rand() * 400)).div(100).toFixed()
      const fxHaircutBps = Math.floor(rand() * 3000)
      const r = sharesToRestoreUsd({ principalUsd: principal, heldDrops: heldD, perShare: per, scale: 0, maxLtvBps: max, xrpUsd, fxHaircutBps })
      const ok = (u) => {
        const usd = dropsToUsd(num(heldD).plus(valueOfUnits(u, per, 0)), xrpUsd, fxHaircutBps)
        return usd.gt(0) && num(principal).times(10000).div(usd).floor().lte(max)
      }
      if (!r || !ok(r.sharesToAdd) || (num(r.sharesToAdd).gt(0) && ok(num(r.sharesToAdd).minus(1).toFixed(0)))) wrong++
    }
    eq('300 seeded cases: the dollar shortfall restores the limit and is the least that does', wrong, 0)
  }

  console.log('the role engine: requestLoan with asset USD')
  await roleEngine()

  console.log('the stand-in label on every dollar, and the demo files')
  {
    const terms = read('demo/usd-terms-desk-1.json')
    const pool = read('demo/desk-usd.json')
    const relay = terms.xrpUsdOracle.sources[0]?.account
    eq('demo/usd-terms-desk-1.json: valid, hashed, on the mandate, labelled', [SCHEMAS.usdTerms(terms), terms.hash === usdTermsHash(terms), terms.mandateHash, terms.loanAsset.label], [[], true, mandate.hash, USD_LABEL])
    eq('its sources are the three relay documents, one per venue, of one account', terms.xrpUsdOracle.sources.map((s) => [s.account === relay, s.documentId, s.provider, s.uri]), FX_VENUES.map((v) => [true, v.documentId, v.provider, v.uri]))
    eq('the terms ask for 2 fresh sources of 3, at most 300 s old, within 100 bps, the median', [terms.xrpUsdOracle.minSources, terms.xrpUsdOracle.maxAgeSeconds, terms.xrpUsdOracle.maxSpreadBps, terms.xrpUsdOracle.aggregation], [2, 300, 100, 'median'])
    eq('demo/desk-usd.json: labelled, the issuer of the terms, kept out of the served facilities (no vaultId), no terms of its own', [pool.asset.label, pool.asset.issuer === terms.loanAsset.issuer, /^[0-9A-F]{64}$/.test(pool.usdVaultId), 'vaultId' in pool, 'terms' in pool], [USD_LABEL, true, true, false, false])
    const planned = new Decimal(desk.plannedLoan.principalDrops).div(1e6).times('1.29').times(new Decimal(1).minus(new Decimal(terms.fxHaircutBps).div(10000))).toFixed(6, DOWN)
    eq('the dollar plan is the XRP plan in dollars at 1.29, less the haircut', [pool.plannedLoan.principalUsd, new Decimal(planned).toFixed(), pool.plannedLoan.units], ['2.322', '2.322', desk.plannedLoan.units])
    const ledger = readFileSync('app/src/components/Ledger.tsx', 'utf8')
    eq('every dollar Figure in the browser carries the label (Ledger.tsx formats unit usd with USD_LABEL)', (ledger.match(/case 'usd':[^\n]*USD_LABEL/g) ?? []).length, 2)
    const deskTsx = readFileSync('app/src/screens/Desk.tsx', 'utf8')
    eq('the desk screen names the dollar with USD_LABEL', deskTsx.includes('USD_LABEL'), true)
    const loose = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(tsx?|css|html)$/.test(e.name) && readFileSync(p, 'utf8').split(USD_LABEL).join('').includes('RLUSD')) loose.push(p)
      }
    }
    walk('app/src')
    eq('no surface of app/src names RLUSD outside the whole label', loose, [])
  }
}

/** A positions read with one desk loan against the calibration's Harbor-1 shares. */
function positionsDoc(currency, principal) {
  return {
    ledgerIndex: c.ledgerIndex, ledgerHash: c.ledgerHash, closeTime: c.closeTime,
    loans: [{ loanId: 'A'.repeat(64), loanSetTxHash: 'B'.repeat(64), vaultId: desk.vaultId, borrower: desk.collateral.borrower, principalOutstanding: principal, currency: currency === 'USD' ? 'USD' : undefined,
      collateral: [{ escrowId: 'C'.repeat(64), shareMptId: shares.mpt_issuance_id, units: c.units, account: { address: 'rx', raw: {} }, ticketInputs: inputs }] }],
  }
}

/** requestLoan on a fake ledger: USD to the dollar pool's broker, XRP as before, a closed parameter. */
async function roleEngine() {
  const ORIGIN = 'https://ormaprotocol.com'
  const W = Object.fromEntries(['holder', 'borrower', 'broker', 'deskOwner', 'agent'].map((r) => [r, Wallet.generate()]))
  const SHARE = { 'harbor-1': '11'.repeat(24), 'harbor-2': '12'.repeat(24), 'harbor-3': '13'.repeat(24), desk: '14'.repeat(24), spare: '15'.repeat(24) }
  const POOLACCT = Wallet.generate().address
  const PLAN = { units: '5000000', principalDrops: '2000000', paymentInterval: 86400, gracePeriod: 3600 }
  const vault = (label, owner) => ({ label, vaultId: label.length.toString(16).padStart(2, '0').repeat(32), shareMptId: SHARE[label], loanBrokerId: `B${label.length}`.repeat(32), owner, loans: { L1: null, L2: null } })
  const VAULTS = {
    'harbor-1': vault('harbor-1', W.broker.address), 'harbor-2': vault('harbor-2', W.broker.address), 'harbor-3': vault('harbor-3', W.broker.address),
    desk: { ...vault('desk', W.deskOwner.address), loanBrokerId: 'BD'.repeat(32), plannedLoan: PLAN, collateral: { agent: W.agent.address, borrower: W.borrower.address, desk: W.deskOwner.address, quorum: 2, accounts: { 'harbor-1': [POOLACCT], 'harbor-2': [], 'harbor-3': [] } } },
    spare: { ...vault('spare', W.deskOwner.address), loanBrokerId: 'B5'.repeat(32) },
  }
  const USDPOOL = { label: 'desk-usd', asset: { currency: 'USD', issuer: ISSUER, label: USD_LABEL }, owner: W.deskOwner.address, usdVaultId: 'DD'.repeat(32), shareMptId: '16'.repeat(24), loanBrokerId: 'BE'.repeat(32), plannedLoan: { units: PLAN.units, principalUsd: '2.322', paymentInterval: 86400, gracePeriod: 3600 } }
  const accounts = new Map([[W.borrower.address, { root: { Account: W.borrower.address, Sequence: 10 }, objects: [] }], [POOLACCT, {
    root: { Account: POOLACCT, Flags: 0x00100000, OwnerCount: 2, Sequence: 7 },
    objects: [
      { LedgerEntryType: 'SignerList', SignerQuorum: 2, SignerEntries: [W.borrower, W.deskOwner, W.agent].map((s) => ({ SignerEntry: { Account: s.address, SignerWeight: 1 } })) },
      { LedgerEntryType: 'MPToken', Account: POOLACCT, MPTokenIssuanceID: SHARE['harbor-1'], MPTAmount: '0' },
    ],
  }]])
  const xrpl = {
    lastLedger: null,
    closeTime: async () => { xrpl.lastLedger = 1000; return 846000000 },
    req: async (p) => {
      const a = accounts.get(p.account)
      if (p.command === 'account_info') {
        if (!a) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } })
        return { result: { account_data: a.root } }
      }
      if (p.command === 'account_objects') return { result: { account_objects: a?.objects ?? [] } }
      if (p.command === 'account_tx') return { result: { transactions: [] } }
      throw new Error(`unexpected ${p.command}`)
    },
    client: { autofill: async (tx) => ({ ...tx, Sequence: accounts.get(tx.Account)?.root.Sequence ?? 1, Fee: '12', LastLedgerSequence: tx.LastLedgerSequence ?? 1020 }) },
  }
  const engine = createRoleEngine({
    reader: {}, xrpl, env: { ALLOWED_WRITE_ORIGINS: ORIGIN }, accounts: W, vaults: VAULTS,
    mandate: () => ({ policy: { finishAfterMarginSeconds: 14400, cancelAfterOffsetSeconds: 86400 } }), usdDesk: () => USDPOOL,
    simulate: async () => ({ engine_result: 'tesSUCCESS' }),
    submit: async (tx) => {
      const a = accounts.get(tx.Account)
      if (a) a.root.Sequence++
      return { txHash: '9'.repeat(64), engineResult: 'tesSUCCESS', ledgerIndex: 1001 }
    },
  })
  const fakeReader = { serverTime: '2026-10-24T00:00:00Z', ledgerIndex: 1000, snapshots: new Map(), vaultIds: [], missing: new Set(), all: () => [] }
  const api = createApi(fakeReader, { port: 0, nyc: engine, demo: { run: async () => engine.newRun(), kill: async () => ({}), unkill: async () => ({}) } })
  await api.listen()
  const port = api.server.address().port
  const call = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let s = ''
      res.on('data', (d) => { s += d })
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }))
    })
    r.on('error', reject)
    r.end(body === undefined ? undefined : JSON.stringify(body))
  })
  try {
    const run = (await call('POST', '/api/demo/run')).body
    const post = (action, body) => call('POST', `/api/roles/${run.runId}/borrower/${action}`, { token: run.token, body })
    const ticket = (vaultLabel, extra = {}) => ({ vault: vaultLabel, share: SHARE['harbor-1'], ticketId: 'E'.repeat(64), inputsDigest: 'F'.repeat(64), units: PLAN.units, ...extra })
    const pledge = async () => {
      const p = await post('pledgeEscrow', ticket('desk'))
      await call('POST', `/api/roles/${run.runId}/actions/${p.body.actionId}/confirm`, { token: run.token })
      for (let i = 0; i < 400; i++) {
        const a = (await call('GET', `/api/roles/${run.runId}/actions/${p.body.actionId}`)).body
        if (a?.state === 'validated' || a?.state === 'failed') return a
        await new Promise((r) => setTimeout(r, 5))
      }
      return null
    }
    const p1 = await pledge()
    const usd = await post('requestLoan', ticket('desk', { pledgeActionId: p1.actionId, asset: 'USD' }))
    const tx = engine.loanSetOf(usd.body.actionId).tx
    eq('asset USD: the LoanSet goes to the dollar pool\'s broker, for its plan in dollars, as a decimal string, countersigned by the desk',
      [usd.status, tx.LoanBrokerID, tx.PrincipalRequested, typeof tx.PrincipalRequested, tx.Counterparty, tx.PaymentTotal], [202, USDPOOL.loanBrokerId, '2.322', 'string', W.deskOwner.address, 1])
    eq('its preview money: USD, the loan asset with its label, the principal in dollars', [usd.body.preview.money.asset, usd.body.preview.money.loanAsset, usd.body.preview.money.principalUsd], ['USD', USDPOOL.asset, '2.322'])
    eq('the request remembers its asset', (await call('GET', `/api/roles/${run.runId}/actions/${usd.body.actionId}`)).body.asset, 'USD')
    const p2 = await pledge()
    const xrp = await post('requestLoan', ticket('desk', { pledgeActionId: p2.actionId }))
    const txX = engine.loanSetOf(xrp.body.actionId).tx
    eq('without asset: the desk\'s XRP broker, the planned drops, the money as before', [xrp.status, txX.LoanBrokerID, txX.PrincipalRequested, Object.keys(xrp.body.preview.money)], [202, 'BD'.repeat(32), '2000000', ['principalDrops', 'escrowIndex', 'lastLedgerSequence']])
    const codes = [
      (await post('requestLoan', ticket('desk', { pledgeActionId: p2.actionId, asset: 'EUR' }))).status,
      (await post('requestLoan', ticket('spare', { pledgeActionId: p2.actionId, asset: 'USD' }))).status,
      (await post('pledgeEscrow', ticket('desk', { asset: 'USD' }))).status,
      (await post('pledgeEscrow', { ...ticket('desk'), share: USDPOOL.shareMptId })).status,
    ]
    eq('asset EUR, USD on spare, asset on pledgeEscrow, and a pledge of the dollar pool\'s own share: all 400', codes, [400, 400, 400, 400])
  } finally {
    await api.close()
  }
}

async function live() {
  const base = process.env.API_BASE
  if (!base) {
    console.log('  API_BASE is not set: run under src/dev/with-api.mjs')
    bad++
    return
  }
  const { Xrpl } = await import('../xrpl.mjs')
  const pool = read('demo/desk-usd.json')
  const terms = read('demo/usd-terms-desk-1.json')
  const roles = { borrower: desk.collateral.borrower, deskOwner: desk.owner }
  const x = new Xrpl(process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233')
  try {
    await x.connect()
    await x.closeTime()
    const L = x.lastLedger
    console.log(`the dollar pool on Devnet, read at ledger ${L}`)
    const v = (await x.req({ command: 'vault_info', vault_id: pool.usdVaultId, ledger_index: L })).result
    eq('the vault of demo/desk-usd.json exists at L, read at L', [v.ledger_index, v.vault.index ?? pool.usdVaultId], [L, pool.usdVaultId])
    eq('its asset is USD of usdIssuer, closed-ended, owned by the desk', [v.vault.Asset, v.vault.VaultKind, v.vault.Owner], [{ currency: 'USD', issuer: pool.usdIssuer }, 1, roles.deskOwner])
    const issuer = (await x.req({ command: 'account_info', account: pool.usdIssuer, ledger_index: L })).result.account_data
    eq('the issuer carries lsfAllowTrustLineClawback', (BigInt(issuer.Flags) & 0x80000000n) !== 0n, true)
    const lines = (await x.req({ command: 'account_lines', account: roles.borrower, peer: pool.usdIssuer, ledger_index: L })).result.lines
    eq('the borrower\'s USD trust line to the issuer exists at L', lines.some((l) => l.currency === 'USD' && l.account === pool.usdIssuer), true)
    const broker = (await x.req({ command: 'ledger_entry', index: pool.loanBrokerId, ledger_index: L })).result.node
    eq('the dollar LoanBroker is on that vault, with its cover', [broker.VaultID, num(broker.CoverAvailable).gt(0)], [pool.usdVaultId, true])
    const anchor = (await x.req({ command: 'tx', transaction: terms.anchorTx })).result
    const memo = (anchor.tx_json?.Memos ?? anchor.Memos ?? []).map((m) => Buffer.from(m.Memo.MemoData ?? '', 'hex').toString('utf8'))
    eq('the terms are anchored by an AccountSet of the risk officer carrying their hash', [anchor.validated, (anchor.tx_json ?? anchor).TransactionType, (anchor.tx_json ?? anchor).Account, memo.includes(`orma.usdterms/1:${terms.hash}`)], [true, 'AccountSet', mandate.riskOfficer, true])
    const at = { ledgerIndex: L, ledgerHash: x.lastLedgerHash ?? null, closeTime: x.lastCloseTime }
    let price = null
    try {
      price = await readXrpUsd(x, terms, at)
    } catch (e) {
      console.log(`    ${e.message}`)
    }
    eq('the terms\' oracle documents give a price at L, the ledger\'s get_aggregate_price agreeing', [Boolean(price), price?.ledgerAggregate?.ledgerIndex], [true, L])
    if (price) console.log(`    XRP/USD ${price.value} at ledger ${L}: ${price.sources.map((s) => `${s.provider} ${s.price ?? 'none'} (${s.ageSeconds ?? '?'} s${s.used ? '' : ', not used'})`).join(', ')}; spread ${price.spreadBps} bps`)
  } finally {
    await x.disconnect().catch(() => {})
  }

  console.log(`the API at ${base}`)
  const get = async (path) => {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(60000) })
    return { status: r.status, body: await r.json() }
  }
  const harbor = read('demo/harbor-1.json')
  const m = await get('/api/desk/mandates/desk-1')
  eq('the desk plan serves the dollar pool and its terms', [m.status, m.body.deskPlan?.usd?.loanBrokerId, m.body.deskPlan?.usd?.terms?.hash, m.body.deskPlan?.usd?.plannedLoan?.principalUsd], [200, pool.loanBrokerId, terms.hash, pool.plannedLoan.principalUsd])
  let t = null
  for (let i = 0; i < 6; i++) {
    t = await get(`/api/tickets?share=${harbor.shareMptId}&op=pledge&units=${pool.plannedLoan.units}&mandate=desk-1&asset=USD`)
    if (t.status !== 503) break
    await new Promise((r) => setTimeout(r, 5000))
  }
  eq('GET /api/tickets?…&asset=USD answers a valid dollar ticket', [t.status, t.status === 200 ? SCHEMAS.ticket(t.body) : t.body], [200, []])
  if (t.status === 200) {
    eq('it carries the label, the collateral line, the price REAL from the terms\' documents at its ledger, and its figures recompute',
      [t.body.usd.loanAsset.label, t.body.usd.collateralRule, t.body.usd.reference.provenance, t.body.usd.reference.sources.map((s) => `${s.account}/${s.documentId}`), t.body.usd.reference.ledgerAggregate.ledgerIndex === t.body.ledgerIndex, recomputes(t.body)],
      [USD_LABEL, USD_COLLATERAL_RULE, 'REAL', terms.xrpUsdOracle.sources.map((s) => `${s.account}/${s.documentId}`), true, []])
    console.log(`    at ledger ${t.body.ledgerIndex}: XRP/USD ${t.body.usd.reference.value}, LTV ${t.body.usd.ltvHeldBps} bps, verdict ${t.body.verdict.status}${t.body.verdict.breaches.length ? ` (${t.body.verdict.breaches.map((b) => b.limit).join(', ')})` : ''}`)
  }
  eq('asset EUR is 400, asset USD on a buy is 400 BAD_OP', [(await get(`/api/tickets?share=${harbor.shareMptId}&op=pledge&units=5&mandate=desk-1&asset=EUR`)).status, (await get(`/api/tickets?share=${harbor.shareMptId}&op=buy&units=5&mandate=desk-1&asset=USD`)).body.error?.code], [400, 'BAD_OP'])
  const pos = await get('/api/desk/positions')
  eq('GET /api/desk/positions: every position names its currency', [pos.status, pos.status === 200 && pos.body.positions.every((p) => p.currency === 'XRP' || p.currency === 'USD')], [200, true])
}
