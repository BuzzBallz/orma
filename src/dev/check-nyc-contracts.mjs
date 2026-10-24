// Offline check of the NYC contract (src/nyc/contracts.mjs): every example passes its schema, every
// Figure carries a closed formula and exactly its inputs, the TypeScript FormulaId union names the same
// formulas, every NYC route is in the OpenAPI document and the prose reference, and the pure judges
// (manager statements, the 2-of-3 collateral account, the pledged share) answer each case. No network.
//   node src/dev/check-nyc-contracts.mjs
//   node src/dev/check-nyc-contracts.mjs --self-test   each example, mutated, must be refused
import { readFileSync } from 'node:fs'
import {
  SCHEMAS, EXAMPLES, EXAMPLE_SCHEMA, NYC_ROUTES, FORMULAS, AMOUNT_FIELDS, MARK_STEPS, NYC_ERRORS, ACTION_STATES,
  DECISION_CODES, canonical, sha256Hex, mandateHash, decisionHash, encodeStatement, parseStatement,
  statementConsistency, COLLATERAL_POLICY, COLLATERAL_STAGES, collateralStageOf, judgeCollateralAccount,
  judgeCollateralShare, marginPolicyHash, usdTermsHash, usdAmount, USD_LABEL, USD_COLLATERAL_RULE, USD_FIGURES, medianOf, spreadBpsOf,
} from '../nyc/contracts.mjs'

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
const clone = (o) => structuredClone(o)

if (process.argv.includes('--self-test')) selfTest()
else main()

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0

function main() {
  console.log('examples')
  for (const name of ['ticket', 'change', 'mandate', 'mark', 'feedEvent', 'feedEventStatement', 'universe', 'decision', 'statement']) {
    eq(`EXAMPLES.${name} exists`, name in EXAMPLES, true)
  }
  for (const [name, doc] of Object.entries(EXAMPLES)) eq(`EXAMPLES.${name} passes SCHEMAS.${EXAMPLE_SCHEMA[name]}`, SCHEMAS[EXAMPLE_SCHEMA[name]](doc), [])
  eq('every schema has an example', Object.keys(SCHEMAS).filter((s) => !Object.values(EXAMPLE_SCHEMA).includes(s)), [])

  const figures = []
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') {
      if ('formulaId' in v) figures.push([path, v])
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
    }
  }
  walk(EXAMPLES, 'EXAMPLES')
  eq('the examples carry Figures of all twenty-one formulas', [...new Set(figures.map(([, f]) => f.formulaId))].sort(), Object.keys(FORMULAS).sort())
  eq('each Figure of the examples has a formula of FORMULAS and exactly its inputs', figures.filter(([, f]) => SCHEMAS.figure(f).length).map(([p]) => p), [])
  const ticket = EXAMPLES.ticket
  const cover = ticket.figures.n2[0].cover
  eq('the ticket example reads LEVersion on the Vault', cover.inputs.find((x) => x.name === 'LEVersion')?.object, 'Vault')
  eq('every input of the ticket is read at its ledger', figures.filter(([p]) => p.startsWith('EXAMPLES.ticket')).every(([, f]) => f.inputs.every((x) => x.ledgerIndex === ticket.ledgerIndex && x.ledgerHash === ticket.ledgerHash)), true)
  eq('the change example cites LoanManage.cpp:311', EXAMPLES.change.rows.some((r) => r.rule.file === 'LoanManage.cpp' && r.rule.line === 311), true)
  eq('the universe example carries a vault of each reason', EXAMPLES.universe.vaults.map((v) => v.reason).filter(Boolean).sort(), ['inconsistent snapshot', 'not priced'])
  eq('the mandate example hash is over its own keys', EXAMPLES.mandate.hash, mandateHash(EXAMPLES.mandate))
  eq('the mandate hash ignores the envelope and deskPlan', mandateHash({ ...EXAMPLES.mandate, serverTime: 'x', ledgerIndex: 1, deskPlan: {} }), EXAMPLES.mandate.hash)
  eq('the decision example hash is over the entry without hash', EXAMPLES.decision.hash, decisionHash(EXAMPLES.decision))

  console.log('schemas refuse what they should')
  const fig = clone(EXAMPLES.figure)
  eq('a Figure with an unknown formulaId', SCHEMAS.figure({ ...fig, formulaId: 'magic' }).length > 0, true)
  eq('a Figure that lacks an input of its formula', SCHEMAS.figure({ ...fig, inputs: fig.inputs.filter((x) => x.name !== 'LossUnrealized') }).some((p) => p.includes('lacks LossUnrealized')), true)
  eq('a Figure with an input its formula does not name', SCHEMAS.figure({ ...fig, inputs: [...fig.inputs, { ...fig.inputs[0], name: 'Mood' }] }).some((p) => p.includes('not an input of heldValue')), true)
  eq('a Figure in the wrong unit', SCHEMAS.figure({ ...fig, unit: 'bps' }).length > 0, true)
  const t2 = clone(ticket)
  t2.figures.heldValue.inputs[0].ledgerIndex = ticket.ledgerIndex - 1
  eq('a ticket input read at another ledger', SCHEMAS.ticket(t2).some((p) => p.includes("document's ledger")), true)
  const buy = clone(ticket)
  buy.op = 'buy'
  eq('a buy ticket that carries the 1:1 column and no maxUnits', SCHEMAS.ticket(buy).length >= 5, true)
  const spoofed = { ...clone(EXAMPLES.mark), verdict: 'disagree', reason: 'SPOOFED', steps: MARK_STEPS.slice(0, 3).map((step, i) => ({ step, ok: i < 2, detail: '' })) }
  eq('a SPOOFED mark that stops at fetch nav', SCHEMAS.mark(spoofed), [])
  eq('an agree mark with three steps', SCHEMAS.mark({ ...spoofed, verdict: 'agree', reason: undefined }).length > 0, true)
  eq('a mark whose steps are out of order', SCHEMAS.mark({ ...clone(EXAMPLES.mark), steps: [...EXAMPLES.mark.steps].reverse() }).length > 0, true)
  const u2 = clone(EXAMPLES.universe)
  u2.vaults[1].reason = 'unlisted'
  eq('a universe reason outside the set', SCHEMAS.universe(u2).length > 0, true)
  const u3 = clone(EXAMPLES.universe)
  u3.vaults[2].perUnitHeld = '0.5'
  eq('a vault that is not priced but shows a figure', SCHEMAS.universe(u3).length > 0, true)
  eq('a refused decision with SUBMIT_UNCONFIRMED and no txHash', SCHEMAS.decision(withHash({ ...EXAMPLES.decision, decision: 'refused', code: 'SUBMIT_UNCONFIRMED', txHash: undefined })).some((p) => p.startsWith('txHash')), true)
  eq('a refused decision with SUBMIT_UNCONFIRMED and its txHash', SCHEMAS.decision(withHash({ ...EXAMPLES.decision, decision: 'refused', code: 'SUBMIT_UNCONFIRMED' })), [])
  eq('a decision whose hash was not recomputed', SCHEMAS.decision({ ...EXAMPLES.decision, ledgerIndex: 1 }).some((p) => p.startsWith('hash')), true)
  eq('a mandate whose limits changed after hashing', SCHEMAS.mandate({ ...EXAMPLES.mandate, limits: { ...EXAMPLES.mandate.limits, maxLtvBps: 9000 } }).some((p) => p.startsWith('hash')), true)
  eq('a STATEMENT event with a money effect', SCHEMAS.feedEvent({ ...clone(EXAMPLES.feedEventStatement), moneyEffect: { value: '1', unit: 'drops' } }).length > 0, true)
  eq('a STATEMENT event labelled REAL', SCHEMAS.feedEvent({ ...clone(EXAMPLES.feedEventStatement), provenance: 'REAL' }).length > 0, true)
  eq('an approving action passes, a previewing one is never served', [SCHEMAS.action(EXAMPLES.action).length, SCHEMAS.action({ ...EXAMPLES.action, state: 'previewing' }).length > 0], [0, true])
  eq('BUSY is retryable', SCHEMAS.error({ error: { code: 'BUSY', message: 'x', retryable: false } }).length > 0, true)

  console.log('margin calls (step 20)')
  eq('the margin policy example hash is over its own keys, not the envelope', [EXAMPLES.marginPolicy.hash, marginPolicyHash({ ...EXAMPLES.marginPolicy, serverTime: 'x', ledgerIndex: 1 })], [marginPolicyHash(EXAMPLES.marginPolicy), EXAMPLES.marginPolicy.hash])
  eq('a margin policy whose cure window changed after hashing', SCHEMAS.marginPolicy({ ...EXAMPLES.marginPolicy, cureSeconds: 43200 }).some((p) => p.startsWith('hash')), true)
  eq('a margin policy whose cure action is not pledgeEscrow', SCHEMAS.marginPolicy({ ...EXAMPLES.marginPolicy, cureAction: 'seize' }).some((p) => p.startsWith('cureAction')), true)
  const none = { ...clone(EXAMPLES.marginCall), status: 'NONE', issuedLedger: null, issuedAt: null, cureBy: null, shortfall: null, entryHash: undefined }
  delete none.entryHash
  eq('a NONE call carries no deadline, no shortfall and no log entry', SCHEMAS.marginCall(none), [])
  eq('a NONE call with a cureBy is refused', SCHEMAS.marginCall({ ...none, cureBy: '2026-10-25T14:10:00Z' }).some((p) => p.startsWith('cureBy')), true)
  eq('an ISSUED call without its log entry is refused', SCHEMAS.marginCall({ ...clone(EXAMPLES.marginCall), entryHash: undefined }).some((p) => p.startsWith('entryHash')), true)
  eq('an ISSUED call whose deadline is not after its issue is refused', SCHEMAS.marginCall({ ...clone(EXAMPLES.marginCall), cureBy: EXAMPLES.marginCall.issuedAt }).some((p) => p.startsWith('cureBy')), true)
  eq('a CURED call keeps no shortfall', SCHEMAS.marginCall({ ...clone(EXAMPLES.marginCall), status: 'CURED' }).some((p) => p.startsWith('shortfall')), true)
  eq('shares to add as a fraction are refused', SCHEMAS.marginCall({ ...clone(EXAMPLES.marginCall), shortfall: { ...EXAMPLES.marginCall.shortfall, sharesToAdd: '1.5' } }).some((p) => p.startsWith('shortfall.sharesToAdd')), true)
  eq('a margin call is DECLARED, a desk decision', SCHEMAS.marginCall({ ...clone(EXAMPLES.marginCall), provenance: 'REAL' }).some((p) => p.startsWith('provenance')), true)
  eq('a margin-call entry is accepted by the decision schema, by its own rules', SCHEMAS.decision(EXAMPLES.marginCallEntry), [])
  eq('a margin-call entry whose hash was not recomputed', SCHEMAS.marginCallEntry({ ...EXAMPLES.marginCallEntry, ltvHeldBps: 1 }).some((p) => p.startsWith('hash')), true)
  eq('a margin-call entry that carries a decision is refused', SCHEMAS.decision({ ...EXAMPLES.marginCallEntry, decision: 'approved' }).some((p) => p.startsWith('decision')), true)
  eq('a MARGIN_CALL_ISSUED event labelled REAL', SCHEMAS.feedEvent({ ...clone(EXAMPLES.feedEventMarginCall), provenance: 'REAL' }).some((p) => p.startsWith('provenance')), true)
  eq('a MARGIN_CALL_ISSUED event with a money effect', SCHEMAS.feedEvent({ ...clone(EXAMPLES.feedEventMarginCall), moneyEffect: { value: '1', unit: 'drops' } }).length > 0, true)
  eq('a MARGIN_CALL_ISSUED event without its log entry', SCHEMAS.feedEvent({ ...clone(EXAMPLES.feedEventMarginCall), entryHash: undefined }).some((p) => p.startsWith('entryHash')), true)
  eq('the seven earlier feed types are unchanged: an IMPAIRMENT stays REAL', SCHEMAS.feedEvent({ ...clone(EXAMPLES.feedEvent), provenance: 'DECLARED' }).some((p) => p.startsWith('provenance')), true)
  const otherLedger = clone(EXAMPLES.marginCalls)
  otherLedger.marginCalls[0].ledgerIndex += 1
  eq('a margin-calls document with a call read at another ledger', SCHEMAS.marginCalls(otherLedger).some((p) => p.includes("document's ledger")), true)
  eq('the hardening values are in the contract', [ACTION_STATES.includes('approving'), DECISION_CODES.includes('SUBMIT_UNCONFIRMED'), NYC_ERRORS.BUSY], [true, true, { status: 503, retryable: true }])

  console.log('loans in the test dollar (step 21)')
  const terms = EXAMPLES.usdTerms
  const oracle = terms.xrpUsdOracle
  eq('the USD terms example hash is over its own keys, not the envelope', [terms.hash, usdTermsHash({ ...terms, serverTime: 'x', ledgerIndex: 1 })], [usdTermsHash(terms), terms.hash])
  eq('terms whose haircut changed after hashing are refused', SCHEMAS.usdTerms({ ...clone(terms), fxHaircutBps: 0 }).some((p) => p.startsWith('hash')), true)
  eq('terms whose sources changed after hashing are refused', SCHEMAS.usdTerms({ ...clone(terms), xrpUsdOracle: { ...clone(oracle), minSources: 1 } }).some((p) => p.startsWith('hash')), true)
  eq('the terms name sources, never a price: a declared price is not a key of the hash', usdTermsHash({ ...clone(terms), xrpUsdReference: { value: '9.99' } }), terms.hash)
  eq('the dollar is never called RLUSD alone', SCHEMAS.usdTerms({ ...clone(terms), loanAsset: { ...terms.loanAsset, label: 'RLUSD' } }).some((p) => p.startsWith('loanAsset.label')), true)
  eq('the label is the whole sentence', USD_LABEL, 'test dollar, stands in for RLUSD (Devnet)')
  eq('a haircut of 10000 bps leaves nothing to lend against', SCHEMAS.usdTerms({ ...clone(terms), fxHaircutBps: 10000 }).some((p) => p.startsWith('fxHaircutBps')), true)
  eq('more sources required than named, one document named twice, an age above the 300 s rippled allows: refused',
    [SCHEMAS.usdTerms({ ...clone(terms), xrpUsdOracle: { ...clone(oracle), minSources: 4 } }).some((p) => p.startsWith('xrpUsdOracle.minSources')),
      SCHEMAS.usdTerms({ ...clone(terms), xrpUsdOracle: { ...clone(oracle), sources: [oracle.sources[0], oracle.sources[0]] } }).some((p) => p.startsWith('xrpUsdOracle.sources')),
      SCHEMAS.usdTerms({ ...clone(terms), xrpUsdOracle: { ...clone(oracle), maxAgeSeconds: 86400 } }).some((p) => p.startsWith('xrpUsdOracle.maxAgeSeconds'))], [true, true, true])
  eq('maxSingleLoanUsd is an amount: as a number it is refused', SCHEMAS.usdTerms({ ...clone(terms), maxSingleLoanUsd: 10 }).some((p) => p.includes('is a number')), true)
  eq('medianOf: the middle price, or the mean of the two middle ones, exact', [medianOf(['1.2902', '1.2899', '1.29']), medianOf(['1.29', '1.2901']), medianOf(['3'])], ['1.29', '1.29005', '3'])
  eq('spreadBpsOf: ceil((max − min) × 10000 / median)', [spreadBpsOf(['1.2899', '1.29', '1.2902']), spreadBpsOf(['1', '1'])], [3, 0])
  const tu = EXAMPLES.ticketUsd
  const ref = tu.usd.reference
  const withRef = (o) => ({ ...clone(tu), usd: { ...clone(tu.usd), reference: { ...clone(ref), ...o } } })
  eq('the USD ticket carries the six dollar figures and none of the four in drops', [USD_FIGURES.every((k) => k in tu.figures), ['maxLoan', 'requested', 'ltvHeld', 'lender1to1'].some((k) => k in tu.figures)], [true, false])
  eq('a USD ticket that also carries requested in drops is refused', SCHEMAS.ticket({ ...clone(tu), figures: { ...clone(tu.figures), requested: clone(EXAMPLES.ticket.figures.requested) } }).some((p) => p.startsWith('figures.requested')), true)
  const xrpWithUsdFigure = clone(EXAMPLES.ticket)
  xrpWithUsdFigure.figures.ltvHeldUsd = clone(tu.figures.ltvHeldUsd)
  eq('an XRP ticket that carries a dollar figure is refused', SCHEMAS.ticket(xrpWithUsdFigure).some((p) => p.startsWith('figures.ltvHeldUsd')), true)
  eq('the usd block names the value of its figure: an LTV that is not ltvHeldUsd is refused', SCHEMAS.ticket({ ...clone(tu), usd: { ...clone(tu.usd), ltvHeldBps: 1 } }).some((p) => p.startsWith('usd.ltvHeldBps')), true)
  eq('a price age that is not priceAge is refused', SCHEMAS.ticket(withRef({ ageSeconds: '1' })).some((p) => p.startsWith('usd.reference.ageSeconds')), true)
  eq('the price is REAL, read from the ledger, never DECLARED', SCHEMAS.ticket(withRef({ provenance: 'DECLARED' })).some((p) => p.startsWith('usd.reference.provenance')), true)
  eq('a price that is not the median of the used sources is refused', SCHEMAS.ticket(withRef({ value: '1.2902' })).some((p) => p.startsWith('usd.reference.value')), true)
  eq('a stale source used, or used sources fewer than minSources, is refused',
    [SCHEMAS.ticket(withRef({ sources: ref.sources.map((s, i) => (i === 0 ? { ...s, fresh: false } : s)) })).some((p) => p.startsWith('usd.reference.sources[0].used')),
      SCHEMAS.ticket(withRef({ sources: ref.sources.map((s, i) => (i === 0 ? { ...s, ageSeconds: '301' } : s)) })).some((p) => p.startsWith('usd.reference.sources[0].ageSeconds')),
      SCHEMAS.ticket(withRef({ minSources: 4 })).some((p) => p.startsWith('usd.reference.sources'))], [true, true, true])
  eq('a source read at another ledger is refused', SCHEMAS.ticket(withRef({ sources: ref.sources.map((s, i) => (i === 1 ? { ...s, ledgerIndex: s.ledgerIndex - 1 } : s)) })).some((p) => p.includes("document's ledger")), true)
  eq('sources further apart than maxSpreadBps are refused', SCHEMAS.ticket(withRef({ maxSpreadBps: 2 })).some((p) => p.startsWith('usd.reference.spreadBps')), true)
  eq('the ledger aggregate must agree with the median, over the same sources', [SCHEMAS.ticket(withRef({ ledgerAggregate: { ...ref.ledgerAggregate, median: '1.31' } })).some((p) => p.startsWith('usd.reference.ledgerAggregate.median')), SCHEMAS.ticket(withRef({ ledgerAggregate: { ...ref.ledgerAggregate, size: 2 } })).some((p) => p.startsWith('usd.reference.ledgerAggregate.size'))], [true, true])
  eq('the reference is the xrpUsd input of the dollar figures', SCHEMAS.ticket(withRef({ value: '1.2901', sources: ref.sources.map((s) => ({ ...s, price: '1.2901' })), spreadBps: 0, ledgerAggregate: { ...ref.ledgerAggregate, median: '1.2901' } })).some((p) => p.startsWith('usd.reference.value')), true)
  eq('the USD ticket carries the collateral line, word for word', [tu.usd.collateralRule, SCHEMAS.ticket({ ...clone(tu), usd: { ...clone(tu.usd), collateralRule: 'Collateral: anything.' } }).some((p) => p.startsWith('usd.collateralRule'))], [USD_COLLATERAL_RULE, true])
  eq('a buy ticket carries no loan in dollars', SCHEMAS.ticket({ ...clone(EXAMPLES.ticketBuy), usd: clone(tu.usd) }).some((p) => p.startsWith('usd')), true)
  eq('a dollar figure carries its unit usd', SCHEMAS.figure({ ...clone(tu.figures.collateralHeldUsd), unit: 'drops' }).some((p) => p.endsWith('unit is not usd, the unit of collateralHeldUsd')), true)
  eq('the dollar figures read the price as an OracleAggregate input and the haircut from UsdTerms', tu.figures.collateralHeldUsd.inputs.filter((x) => ['xrpUsd', 'fxHaircutBps'].includes(x.name)).map((x) => [x.name, x.object]).sort(), [['fxHaircutBps', 'UsdTerms'], ['xrpUsd', 'OracleAggregate']])
  eq('no usable price is PRICE_UNAVAILABLE, 409, retryable', NYC_ERRORS.PRICE_UNAVAILABLE, { status: 409, retryable: true })
  const mu = EXAMPLES.marginCallUsd
  eq('a USD margin call without its shortfall in dollars is refused', SCHEMAS.marginCall({ ...clone(mu), shortfall: { ...EXAMPLES.marginCall.shortfall } }).some((p) => p.startsWith('shortfall.collateralValueUsd')), true)
  eq('a margin call in a currency the desk does not lend is refused', SCHEMAS.marginCall({ ...clone(mu), currency: 'EUR' }).some((p) => p.startsWith('currency')), true)
  eq('an XRP margin call is what it was: no currency key', 'currency' in EXAMPLES.marginCall, false)
  eq('an issued-currency amount: currency, issuer and a decimal string', usdAmount('2.322', terms.loanAsset.issuer), { currency: 'USD', issuer: terms.loanAsset.issuer, value: '2.322' })
  eq('an amount given as a number, in exponent form, or without its issuer is refused', [throws(() => usdAmount(2.322, terms.loanAsset.issuer)), throws(() => usdAmount('1e3', terms.loanAsset.issuer)), throws(() => usdAmount('1', ''))], ['TypeError', 'TypeError', 'TypeError'])

  console.log('canonical and sha256Hex')
  eq('canonical sorts keys at every depth, no spaces', canonical({ b: 1, a: [{ d: 2, c: '3' }], u: undefined }), '{"a":[{"c":"3","d":2}],"b":1}')
  eq('sha256Hex of the empty string', sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

  console.log('FormulaId in app/src/lib/types.ts')
  const ts = readFileSync(new URL('../../app/src/lib/types.ts', import.meta.url), 'utf8')
  const union = /export type FormulaId\s*=([^;]*?)(?:\r?\n\s*\r?\n|\r?\nexport |;)/.exec(ts)
  const names = union ? [...union[1].matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]) : null
  eq('the union names exactly the twenty-one keys of FORMULAS', names?.slice().sort(), Object.keys(FORMULAS).sort())
  eq('twenty-one formulas: fourteen at step 1, six in dollars at step 21, pastDue at step 22', [Object.keys(FORMULAS).length, Object.keys(FORMULAS).slice(14)], [21, ['collateralHeldUsd', 'maxLoanUsd', 'requestedUsd', 'ltvHeldUsd', 'lender1to1Usd', 'priceAge', 'pastDue']])

  console.log('routes')
  eq('sixteen NYC routes: fifteen at step 1, GET /api/desk/margin-calls at step 20', [NYC_ROUTES.length, NYC_ROUTES.at(-1).path], [16, '/api/desk/margin-calls'])
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
  const doc = readFileSync(new URL('../../documentation/pages/http-api.mdx', import.meta.url), 'utf8')
  eq('every NYC route is in openapi.json, with a summary and a described 200', NYC_ROUTES.filter((r) => {
    const op = spec.paths?.[r.path]?.[r.method.toLowerCase()]
    return !(op && typeof op.summary === 'string' && op.summary && typeof op.responses?.['200']?.description === 'string')
  }).map((r) => `${r.method} ${r.path}`), [])
  const rows = new Set([...doc.matchAll(/^\| `([A-Z]+) (\/api\/[^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`))
  eq('every NYC route is indexed in http-api.mdx', NYC_ROUTES.map((r) => `${r.method} ${r.path.replace(/\{(\w+)\}/g, ':$1')}`).filter((r) => !rows.has(r)), [])
  eq('info.version stays 1.0.0', spec.info?.version, '1.0.0')
  const errors = new Set([...doc.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \| (true|false) \|/gm)].map((m) => `${m[1]} ${m[2]} ${m[3]}`))
  eq('every NYC error code is in the error table, with its status', Object.entries(NYC_ERRORS).filter(([c, e]) => !errors.has(`${c} ${e.status} ${e.retryable}`)).map(([c]) => c), [])

  statements()
  collateral()
  shares()
}

function withHash(entry) {
  const e = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))
  return { ...e, hash: decisionHash(e) }
}

function statements() {
  console.log('orma.stmt/1')
  const loan = 'A'.repeat(64)
  const docs = [
    { s: 'orma.stmt/1', loan, kind: 'impaired', text: 'L1 is impaired at full principal.', at: 846199000 },
    { s: 'orma.stmt/1', loan, kind: 'defaulted', text: 'L2 defaulted; cover drawn.', at: 1 },
    { s: 'orma.stmt/1', loan, kind: 'repaid', text: 'Repaid in full, café included.', at: 0 },
    { s: 'orma.stmt/1', kind: 'note', text: 'Quarterly letter is out.', at: 846000000 },
  ]
  for (const d of docs) eq(`parseStatement(encodeStatement(${d.kind})) is the document`, parseStatement(encodeStatement(d)), d)
  const base = { s: 'orma.stmt/1', loan, kind: 'impaired', text: '', at: 846388800 }
  eq('the empty-text impaired document is 136 bytes', Buffer.byteLength(JSON.stringify(base)), 136)
  eq('120 ASCII characters fill exactly 256 bytes, accepted', encodeStatement({ ...base, text: 'x'.repeat(120) }).length, 512)
  eq('a text of 121 characters is refused', throws(() => encodeStatement({ ...base, text: 'x'.repeat(121) })), 'RangeError')
  const doc257 = { ...base, text: `${'x'.repeat(119)}é` }
  eq('a document of 257 bytes (120 characters) is refused', [Buffer.byteLength(JSON.stringify(doc257)), throws(() => encodeStatement(doc257))], [257, 'RangeError'])
  eq('an empty text is refused', throws(() => encodeStatement(base)), 'RangeError')
  eq('a kind outside the set is refused', throws(() => encodeStatement({ ...base, text: 'x', kind: 'fine' })), 'RangeError')
  eq('a loan that is not 64 hex is refused', throws(() => encodeStatement({ ...base, text: 'x', loan: 'L1' })), 'RangeError')
  eq('an extra key is refused', throws(() => encodeStatement({ ...base, text: 'x', grade: 'A' })), 'RangeError')
  eq('the encoding order is s, loan, kind, text, at', Buffer.from(encodeStatement({ at: 5, text: 'x', kind: 'note', s: 'orma.stmt/1' }), 'hex').toString('utf8'), '{"s":"orma.stmt/1","kind":"note","text":"x","at":5}')
  const hex = (s) => Buffer.from(s, 'utf8').toString('hex')
  eq('parseStatement: not hex, not JSON, not UTF-8, wrong schema, too long', [
    parseStatement('zz'), parseStatement(hex('{not json')), parseStatement('C3'), parseStatement(hex('{"s":"orma.stmt/2","kind":"note","text":"x","at":1}')),
    parseStatement(hex(JSON.stringify({ ...base, text: 'x'.repeat(130) }))), parseStatement(''), parseStatement(null),
  ], [null, null, null, null, null, null, null])

  const at = { ledgerIndex: 6280301, ledgerHash: 'B'.repeat(64) }
  const impaired = { loanId: loan, label: 'L1', flags: 0x00020000, paymentRemaining: 1 }
  const healthy = { loanId: loan, label: 'L1', flags: 0, paymentRemaining: 3 }
  const defaulted = { index: loan, Flags: 0x00010000 }
  const repaid = { loanId: loan, label: 'L1', flags: 0 }
  const st = (d, loans) => statementConsistency(d, loans, at)
  eq('impaired on an impaired loan: CONSISTENT, at the ledger', st(docs[0], [impaired]), { status: 'CONSISTENT', detail: 'L1 carries lsfLoanImpaired at ledger 6280301', provenance: 'REAL', ledgerIndex: 6280301, ledgerHash: 'B'.repeat(64) })
  eq('impaired on a healthy loan: INCONSISTENT', st(docs[0], [healthy]).status, 'INCONSISTENT')
  eq('impaired on a loan not under this vault: INCONSISTENT', st(docs[0], []).status, 'INCONSISTENT')
  eq('defaulted on a raw ledger Loan in default: CONSISTENT', st(docs[1], [defaulted]).status, 'CONSISTENT')
  eq('defaulted on an impaired loan: INCONSISTENT', st(docs[1], [impaired]).status, 'INCONSISTENT')
  eq('repaid with no payment remaining: CONSISTENT', st(docs[2], [repaid]).status, 'CONSISTENT')
  eq('repaid on an active loan, then on a defaulted one: INCONSISTENT', [st(docs[2], [healthy]).status, st(docs[2], [defaulted]).status], ['INCONSISTENT', 'INCONSISTENT'])
  eq('repaid on a deleted loan: NOT_CHECKABLE', st(docs[2], []).status, 'NOT_CHECKABLE')
  eq('a note: NOT_CHECKABLE', st(docs[3], [impaired]).status, 'NOT_CHECKABLE')
  eq('an unreadable Data: UNPARSEABLE', st(null, [impaired]).status, 'UNPARSEABLE')
  eq('a loan id in lowercase still matches', st({ ...docs[0], loan: loan.toLowerCase() }, [impaired]).status, 'CONSISTENT')
}

function collateral() {
  console.log('2-of-3 collateral account (I3a)')
  eq('the policy', COLLATERAL_POLICY, { quorum: 2, weight: 1, roles: ['borrower', 'desk', 'agent'] })
  eq('the three states', COLLATERAL_STAGES, { free: { expectEscrows: 0, expectShares: 'none' }, pledged: { expectEscrows: 'named', expectShares: 'none' }, structural: { expectEscrows: 'any', expectShares: 'any' } })
  const borrower = 'rBorrowerXXXXXXXXXXXXXXXXXXXX'
  const desk = 'rDeskXXXXXXXXXXXXXXXXXXXXXXXX'
  const agent = 'rAgentXXXXXXXXXXXXXXXXXXXXXXX'
  const account = 'rCollateralXXXXXXXXXXXXXXXXXX'
  const share = '0000000A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E'
  const pledgeIndex = '1'.repeat(64)
  const accountRoot = { Account: account, Flags: 0x00100000, OwnerCount: 2 }
  const signerList = { SignerQuorum: 2, SignerEntries: [borrower, desk, agent].map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })) }
  const mptoken = { Account: account, MPTokenIssuanceID: share }
  const pledge = { index: pledgeIndex, Account: borrower, Amount: { mpt_issuance_id: share, value: '1000000' } }
  const stranger = { index: '2'.repeat(64), Account: 'rStrangerXXXXXXXXXXXXXXXXXXXX', Amount: '1' }
  const borrowerXrp = { index: '3'.repeat(64), Account: borrower, Amount: '1' }
  const who = { borrower, desk, agent, shareMptId: share }
  const judge = (o, stage, extra = {}) => judgeCollateralAccount({ accountRoot, signerList, mptoken, escrows: [], ...o }, { ...who, ...COLLATERAL_STAGES[stage], ...extra })
  const ok = { conforming: true, reasons: [] }
  const no = (reason) => ({ conforming: false, reasons: [reason] })

  eq('free: no escrow, no share', judge({}, 'free'), ok)
  eq('pledged: its one pledge escrow, named', judge({ escrows: [pledge] }, 'pledged', { namedEscrow: pledgeIndex }), ok)
  eq('pledged: its one pledge escrow, none named', judge({ escrows: [pledge] }, 'pledged'), ok)
  const finished = { mptoken: { ...mptoken, MPTAmount: '1000000' } }
  eq('structural: after EscrowFinish, no escrow and every share held', judge(finished, 'structural'), ok)
  eq('structural: an escrow still there', judge({ escrows: [pledge] }, 'structural'), ok)
  for (const stage of ['free', 'pledged', 'structural']) {
    const escrows = stage === 'pledged' ? [pledge, stranger, borrowerXrp] : [stranger, borrowerXrp]
    eq(`a third party's XRP escrow (and the borrower's own XRP one) is ignored when ${stage}`, judge({ escrows, ...(stage === 'structural' ? finished : {}) }, stage), ok)
  }

  eq('master key enabled', judge({ escrows: [pledge], accountRoot: { ...accountRoot, Flags: 0 } }, 'pledged'), no('master key enabled'))
  eq('regular key set', judge({ escrows: [pledge], accountRoot: { ...accountRoot, RegularKey: desk } }, 'pledged'), no('regular key set'))
  eq('quorum is not 2', judge({ escrows: [pledge], signerList: { ...signerList, SignerQuorum: 1 } }, 'pledged'), no('quorum is not 2'))
  const swapped = { ...signerList, SignerEntries: [borrower, desk, 'rOtherXXXXXXXXXXXXXXXXXXXXXXX'].map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })) }
  eq('signers are not {borrower, desk, Orma agent}', judge({ escrows: [pledge], signerList: swapped }, 'pledged'), no('signers are not {borrower, desk, Orma agent}'))
  const heavy = { ...signerList, SignerEntries: signerList.SignerEntries.map((e, i) => (i === 1 ? { SignerEntry: { ...e.SignerEntry, SignerWeight: 2 } } : e)) }
  eq('signer weight is not 1', judge({ escrows: [pledge], signerList: heavy }, 'pledged'), no('signer weight is not 1'))
  eq('no MPToken for the pledged share', judge({ escrows: [pledge], mptoken: null }, 'pledged'), no('no MPToken for the pledged share'))
  eq('an MPToken of another share', judge({ escrows: [pledge], mptoken: { ...mptoken, MPTokenIssuanceID: 'F'.repeat(48) } }, 'pledged'), no('no MPToken for the pledged share'))
  const delegated = { accountRoot: { ...accountRoot, OwnerCount: 3 } }
  eq('OwnerCount 3, a Delegate: other ledger objects', judge({ escrows: [pledge], ...delegated }, 'pledged'), no('account holds other ledger objects (delegate, ticket, …)'))
  eq('the same delegated account is refused in every state', ['free', 'structural'].map((s) => judge({ ...delegated }, s).conforming), [false, false])
  eq('an account holding shares, judged pledged', judge(finished, 'pledged'), { conforming: false, reasons: ['account already used by another pledge', 'collateral account already holds shares'] })
  eq('an account holding shares beside its escrow, judged pledged', judge({ escrows: [pledge], ...finished }, 'pledged'), no('collateral account already holds shares'))
  eq('deposit authorization enabled', judge({ escrows: [pledge], accountRoot: { ...accountRoot, Flags: 0x00100000 | 0x01000000 } }, 'pledged'), no('deposit authorization enabled'))
  eq('free, but a pledge escrow is there', judge({ escrows: [pledge] }, 'free'), no('account already used by another pledge'))
  eq('pledged, but another escrow than the named one', judge({ escrows: [pledge] }, 'pledged', { namedEscrow: '9'.repeat(64) }), no('account already used by another pledge'))
  const second = { ...pledge, index: '4'.repeat(64) }
  eq('two pledge escrows when pledged', judge({ escrows: [pledge, second] }, 'pledged'), no('account already used by another pledge'))
  eq('no account at all', judge({ accountRoot: null }, 'free'), no('collateral account not found'))
  eq('an unknown state is a programming error', throws(() => judgeCollateralAccount({ accountRoot, signerList, mptoken }, { ...who, expectEscrows: 1, expectShares: 'none' })), 'TypeError')
  eq('every departure at once, one reason each', judgeCollateralAccount(
    { accountRoot: { Account: account, Flags: 0x01000000, RegularKey: desk, OwnerCount: 5 }, signerList: { SignerQuorum: 3, SignerEntries: [{ SignerEntry: { Account: desk, SignerWeight: 3 } }] }, mptoken: null, escrows: [pledge, second] },
    { ...who, ...COLLATERAL_STAGES.free },
  ).reasons.length, 9)

  console.log('collateralStageOf')
  const stage = (o) => collateralStageOf({ escrows: [], mptoken, pledges: [], ...o }, { borrower, shareMptId: share })
  eq('a live pledge escrow, empty history: pledged, named', stage({ escrows: [pledge] }), { stage: 'pledged', namedEscrow: pledgeIndex })
  eq('two live pledge escrows: pledged, none named', stage({ escrows: [pledge, second] }), { stage: 'pledged', namedEscrow: null })
  eq('shares and no escrow: structural', stage(finished), { stage: 'structural', namedEscrow: null })
  eq('neither escrow nor shares, a pledge EscrowCreate in the history: structural', stage({ pledges: [{ account: borrower, sequence: 41, index: pledgeIndex, txHash: '5'.repeat(64), ledgerIndex: 10 }] }), { stage: 'structural', namedEscrow: null })
  eq('nothing: free', stage({}), { stage: 'free', namedEscrow: null })
  eq("a third party's escrow only: free", stage({ escrows: [stranger, borrowerXrp] }), { stage: 'free', namedEscrow: null })
}

function shares() {
  console.log('the pledged share (seam table, honest refusal)')
  const vault = { Asset: { currency: 'XRP' }, VaultKind: 1 }
  const issuance = { Flags: 0x00000038 }
  const mptoken = { Flags: 0 }
  const j = (o) => judgeCollateralShare({ vault, issuance, mptoken, ...o })
  const no = (reason) => ({ eligible: false, reasons: [reason] })
  eq('a closed-ended XRP vault, issuance flags 0x00000038: eligible', j({}), { eligible: true, reasons: [] })
  eq('a vault in an IOU', j({ vault: { ...vault, Asset: { currency: 'USD', issuer: 'rIssuerXXXXXXXXXXXXXXXXXXXXXX' } } }), no('vault asset is not XRP: its issuer can claw it back or freeze it'))
  eq('a vault in an MPT', j({ vault: { ...vault, Asset: { mpt_issuance_id: 'F'.repeat(48) } } }), no('vault asset is not XRP: its issuer can claw it back or freeze it'))
  eq('a locked share issuance', j({ issuance: { Flags: 0x00000039 } }), no('share issuance is locked'))
  eq('locked pledged shares', j({ mptoken: { Flags: 0x00000001 } }), no('pledged shares are locked'))
  eq('a private vault (lsfMPTRequireAuth)', j({ issuance: { Flags: 0x0000003C } }), no('share issuance flags are outside the proven set'))
  eq('an open vault (VaultKind 0)', j({ vault: { Asset: { currency: 'XRP' }, VaultKind: 0 } }), no('vault is not closed-ended'))
  eq('an issuance that can be clawed back', j({ issuance: { Flags: 0x00000078 } }), no('share issuance can be locked or clawed back'))
  eq('a flag the seam table does not know (confidential balance)', j({ issuance: { Flags: 0x000000B8 } }), no('share issuance flags are outside the proven set'))
  eq('non-transferable shares', j({ issuance: { Flags: 0x00000018 } }), no('share issuance flags are outside the proven set'))
  eq('nothing read at all is not eligible', judgeCollateralShare({ vault: null, issuance: null, mptoken: null }).eligible, false)
}

/**
 * Two mutations of every example, each of which the validator must refuse: an amount changed into a
 * JSON number, and a `grade` key added (at the root and one level down).
 */
function selfTest() {
  console.log('self-test: each mutation is refused')
  for (const [name, example] of Object.entries(EXAMPLES)) {
    const validate = SCHEMAS[EXAMPLE_SCHEMA[name]]
    eq(`${name}: the example itself passes`, validate(example), [])

    const asNumber = clone(example)
    const path = amountPath(asNumber)
    if (path) setAt(asNumber, path, 12345)
    else asNumber.principalDrops = 12345
    const label = path ? path.join('.') : 'principalDrops (added: the example has no amount)'
    eq(`${name}: ${label} as a number is refused`, validate(asNumber).some((p) => p.includes('is a number')), true)

    const graded = clone(example)
    graded.grade = 'B'
    eq(`${name}: a grade key at the root is refused`, validate(graded).some((p) => p.includes('grade')), true)

    const deep = clone(example)
    const nested = nestedObject(deep)
    if (nested) {
      nested.grade = 'B'
      eq(`${name}: a grade key one level down is refused`, validate(deep).some((p) => p.includes('grade')), true)
    }
  }
}

/** The path of the first amount field of a document: a string, or null for moneyEffect. */
function amountPath(v, path = []) {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = amountPath(v[i], [...path, i])
      if (p) return p
    }
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (AMOUNT_FIELDS.includes(k) && (typeof x === 'string' || x === null)) return [...path, k]
    }
    for (const [k, x] of Object.entries(v)) {
      const p = amountPath(x, [...path, k])
      if (p) return p
    }
  }
  return null
}

function setAt(o, path, value) {
  let cur = o
  for (const k of path.slice(0, -1)) cur = cur[k]
  cur[path.at(-1)] = value
}

function nestedObject(o) {
  for (const x of Object.values(o)) {
    if (x && typeof x === 'object' && !Array.isArray(x)) return x
    if (Array.isArray(x) && x[0] && typeof x[0] === 'object') return x[0]
  }
  return null
}
