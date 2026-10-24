// Offline check of orma-mark: the verification chain on a fake ledger client and a fake fetch, the
// additions to orma.nav/1, the anti-spoof of /resolve, and the routes /api/mpt/{id}/status and
// /api/mark/{id}. No Devnet. With --live (under with-api.mjs): the shares baked in demo/.
//   node src/dev/check-mark.mjs
//   node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-mark.mjs --live
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { verify, exitCodeFor, defaultPublisherDomain } from '../mark/verify.mjs'
import { presentNav, resolveFromIssuance } from '../nav.mjs'
import { oracleDocId, encodePrice } from '../oracle.mjs'
import { Reader } from '../poll.mjs'
import { normaliseVault, normaliseBroker } from '../xrpl.mjs'
import { createApi } from '../api.mjs'
import { createNyc } from '../nyc/index.mjs'
import { MARK_STEPS, SCHEMAS } from '../nyc/contracts.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const TOKEN = 'CD'.repeat(24)
const OTHER = 'EF'.repeat(24)
const VAULT = 'AB'.repeat(32)
const ISSUER = 'rIssuer'
const PUB = 'rPublisher'
const DECOY = 'rDecoy'
const DOMAIN = 'ormaprotocol.com'
const DOC_L = 1500
const CHANGE_L = 1400
const CLOSE_UNIX = 800000000 + 946684800 // the ripple close_time of CHANGE_L, as unix seconds
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase()
const notFound = () => Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
const pointer = (form, token = TOKEN, host = DOMAIN) => `https://${host}/${form === 'v' ? 'v' : 'api/mpt'}/${token}/nav`

/** The ledger as the verifier reads it. `o` bends one thing at a time. */
function world(o = {}) {
  const calls = []
  const changeAt = o.changeAt ?? 900
  const vaultAt = (at) => ({
    index: VAULT, Owner: 'rOwner', Account: 'rPseudo', ShareMPTID: TOKEN, AssetsTotal: '1000000',
    ...(o.loss && at >= changeAt ? { LossUnrealized: o.loss } : {}),
    shares: { OutstandingAmount: '1000000', mpt_issuance_id: TOKEN },
    PreviousTxnLgrSeq: changeAt,
  })
  const oracleNode = (nav, lut) => ({ LastUpdateTime: lut, PriceDataSeries: [{ PriceData: { BaseAsset: 'X', QuoteAsset: 'NAV', AssetPrice: encodePrice(nav), Scale: 6 } }] })
  return {
    url: 'wss://fake.test', lastLedger: 2000, lastLedgerHash: 'A'.repeat(64), calls,
    closeTime: async () => 0,
    mptIssuance: async () => {
      if (o.noIssuance) throw notFound()
      return { Issuer: ISSUER, OutstandingAmount: '1000000', MPTokenMetadata: hex(JSON.stringify({ orma: { nav_url: o.pointer ?? pointer('v') } })) }
    },
    vaultInfo: async (id, at) => (calls.push({ command: 'vault_info', at }), vaultAt(at)),
    req: async (p) => {
      calls.push(p)
      if (p.command === 'account_info') {
        if (p.account === ISSUER) return { result: { account_data: o.noVaultId ? {} : { VaultID: VAULT } } }
        if (p.account === PUB) return { result: { account_data: { Domain: hex(o.pubDomain ?? DOMAIN) } } }
        throw notFound()
      }
      if (p.command === 'vault_info') return { result: { vault: { ...vaultAt(p.ledger_index), ShareMPTID: o.vaultShare ?? TOKEN } } }
      if (p.command === 'ledger') return { result: { ledger: { close_time: 800000000 } } }
      if (p.command === 'ledger_entry') {
        const { account, oracle_document_id: id } = p.oracle
        if (account === DECOY && id === 1) return { result: { node: oracleNode('1', CLOSE_UNIX) } }
        if (account === PUB && id === oracleDocId(VAULT) && o.oracle) return { result: { node: oracleNode(o.oracle.nav, o.oracle.lut) } }
        throw notFound()
      }
      throw new Error(`unexpected ${p.command}`)
    },
  }
}

const navDoc = (held, { share = TOKEN, vault = VAULT, ledgerIndex = DOC_L } = {}) =>
  ({ schema: 'orma.nav/1', ledgerIndex, unitValue: { held, reported: held }, instrument: { shareMptId: share, vaultId: vault } })
const TOML = `[[ACCOUNTS]]\naddress = "${DECOY}"\nnetwork = "devnet"\n\n[[ACCOUNTS]]\naddress = "${PUB}"\nnetwork = "devnet"\n\n[[PRINCIPALS]]\nname = "Orma"\n`

/** What the web answers: the valuation at any /nav, the toml, nothing else. */
function web(o = {}) {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url.endsWith('/.well-known/xrp-ledger.toml')) return o.toml === null ? new Response('', { status: 404 }) : new Response(o.toml ?? TOML)
    if (url.endsWith('/nav')) return Response.json(o.doc ?? navDoc('1.000000'))
    return new Response('', { status: 404 })
  }
  return { urls, fetchImpl }
}

async function run(w = {}, f = {}, extra = {}) {
  const xrpl = world(w)
  const site = web(f)
  const mark = await verify(TOKEN, { xrpl, fetchImpl: site.fetchImpl, publisherDomain: DOMAIN, ...extra })
  return { mark, xrpl, urls: site.urls, steps: mark.steps, oracle: mark.steps.at(-1) }
}
const valid = (mark) => SCHEMAS.mark(mark)
const names = (mark) => mark.steps.map((s) => s.step)

// --- the chain, both forms of pointer ---------------------------------------------------------
for (const form of ['v', 'api']) {
  const r = await run({ pointer: pointer(form), oracle: { nav: '1000000', lut: CLOSE_UNIX - 1000 } })
  eq(`agree on /${form === 'v' ? 'v/<token>' : 'api/mpt/<token>'}/nav, every step ok`, [r.mark.verdict, r.steps.every((s) => s.ok), names(r.mark)], ['agree', true, MARK_STEPS])
  eq(`and the mark is an orma.mark/1 (${form})`, valid(r.mark), [])
}
const found = await run({ oracle: { nav: '1000000', lut: CLOSE_UNIX - 1000 } })
eq('the Oracle is the publisher\'s, at oracleDocId(vaultId), named in the detail', [found.oracle.detail.includes(PUB), found.oracle.detail.includes(`doc ${oracleDocId(VAULT)}`)], [true, true])
const reads = found.xrpl.calls.filter((c) => c.command === 'ledger_entry')
eq('only that Oracle is read, at the ledger of the document', [reads.length, reads.every((c) => c.oracle.account === PUB && c.oracle.oracle_document_id === oracleDocId(VAULT) && c.ledger_index === DOC_L)], [1, true])

// --- a pointer copied onto another share ------------------------------------------------------
const foreign = [
  ['the right form on another host', { pointer: pointer('v', TOKEN, 'evil.example') }, {}],
  ['a pointer to another share\'s valuation', { pointer: pointer('v', OTHER) }, {}],
  ['an overrideUrl copied from another share', {}, {}, { overrideUrl: pointer('api', OTHER) }],
  ['a query string on the pointer', { pointer: `${pointer('v')}?x=1` }, {}],
]
for (const [name, w, f, extra] of foreign) {
  const r = await run(w, f, extra)
  eq(`SPOOFED, nothing fetched, three steps: ${name}`, [r.mark.verdict, r.mark.reason, r.urls.length, r.steps.length, r.steps[2].ok, r.steps[2].detail.startsWith('SPOOFED')], ['disagree', 'SPOOFED', 0, 3, false, true])
  eq(`and it is a valid mark: ${name}`, valid(r.mark), [])
}
const mismatches = [
  ['AccountRoot.VaultID missing', { noVaultId: true }, {}],
  ['Vault.ShareMPTID is another share', { vaultShare: OTHER }, {}],
  ['instrument.shareMptId is another share', {}, { doc: navDoc('1.000000', { share: OTHER }) }],
  ['instrument.vaultId is another vault', {}, { doc: navDoc('1.000000', { vault: 'EE'.repeat(32) }) }],
]
for (const [name, w, f] of mismatches) {
  const r = await run(w, f)
  eq(`SPOOFED at anti-spoof: ${name}`, [r.mark.verdict, r.mark.reason, r.steps[3].ok, r.steps[3].detail.startsWith('SPOOFED'), r.steps.length, valid(r.mark)], ['disagree', 'SPOOFED', false, true, 6, []])
}

// --- recompute, unreachable, resolution -------------------------------------------------------
const wrong = await run({}, { doc: navDoc('0.900000') })
eq('RECOMPUTE_MISMATCH when the document is not what the vault gives at its ledger', [wrong.mark.verdict, wrong.mark.reason, valid(wrong.mark)], ['disagree', 'RECOMPUTE_MISMATCH', []])
const gone = await run({ noIssuance: true })
eq('UNREACHABLE when the issuance cannot be read, with all six steps reported', [gone.mark.reason, names(gone.mark), valid(gone.mark)], ['UNREACHABLE', MARK_STEPS, []])
for (const [name, w, f] of [
  ['an unreachable toml', {}, { toml: null }],
  ['a toml whose account does not carry the domain', { pubDomain: 'other.test' }, {}],
  ['no Oracle at that account and docId', {}, {}],
]) {
  const r = await run(w, f)
  eq(`agree, "no oracle published": ${name}`, [r.mark.verdict, r.oracle.ok, r.oracle.detail.startsWith('no oracle published')], ['agree', true, true])
}

// --- the Oracle against the value the document gives ------------------------------------------
const lateWorld = { changeAt: CHANGE_L, loss: '200000' }
const pending = await run({ ...lateWorld, oracle: { nav: '1000000', lut: CLOSE_UNIX - 10 } }, { doc: navDoc('0.800000') })
eq('oracle pending: a publish that precedes the last change of the vault, with the value from before it', [pending.mark.verdict, pending.oracle.ok, pending.oracle.detail], ['agree', true, 'oracle pending: last publish precedes this ledger'])
const steady = await run({ oracle: { nav: '1000000', lut: CLOSE_UNIX - 100000 } })
eq('an older Oracle whose NAV matches keeps the ordinary detail', [steady.mark.verdict, steady.oracle.detail.startsWith('oracle pending')], ['agree', false])
const mismatch = await run({ ...lateWorld, oracle: { nav: '500000', lut: CLOSE_UNIX - 10 } }, { doc: navDoc('0.800000') })
eq('ORACLE_MISMATCH when the NAV is neither value', [mismatch.mark.verdict, mismatch.mark.reason, valid(mismatch.mark)], ['disagree', 'ORACLE_MISMATCH', []])
const informed = await run({ ...lateWorld, oracle: { nav: '1000000', lut: CLOSE_UNIX + 100 } }, { doc: navDoc('0.800000') })
eq('a publish after the change that still says the old value is a mismatch, not pending', [informed.mark.verdict, informed.mark.reason], ['disagree', 'ORACLE_MISMATCH'])

// --- exit codes, the CLI ----------------------------------------------------------------------
eq('exitCodeFor: 0 for agree, 4 for disagree', [exitCodeFor({ verdict: 'agree' }), exitCodeFor({ verdict: 'disagree' })], [0, 4])
const cli = fileURLToPath(new URL('../mark/verify.mjs', import.meta.url))
for (const args of [[], ['zz']]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000 })
  eq(`the CLI exits 64 on ${args.length ? `"${args[0]}"` : 'no id'}, before any connection`, [r.status, r.stderr.includes('usage')], [64, true])
}

// --- the publisher's domain follows PUBLIC_BASE -----------------------------------------------
eq('the default domain is the host of an https PUBLIC_BASE, else ormaprotocol.com', [defaultPublisherDomain({ PUBLIC_BASE: 'https://example.test' }), defaultPublisherDomain({ PUBLIC_BASE: 'http://localhost:5173' }), defaultPublisherDomain({})], ['example.test', DOMAIN, DOMAIN])
const base = process.env.PUBLIC_BASE
process.env.PUBLIC_BASE = 'https://example.test'
const hosted = await verify(TOKEN, { xrpl: world({ pointer: pointer('v', TOKEN, 'example.test') }), fetchImpl: web().fetchImpl })
const notHosted = await verify(TOKEN, { xrpl: world({ pointer: pointer('v') }), fetchImpl: web().fetchImpl })
if (base === undefined) delete process.env.PUBLIC_BASE; else process.env.PUBLIC_BASE = base
eq('with PUBLIC_BASE=https://example.test: a pointer there is accepted, one on ormaprotocol.com is SPOOFED', [hosted.verdict, notHosted.reason], ['agree', 'SPOOFED'])

// --- orma.nav/1: additions only ---------------------------------------------------------------
const snapOf = (Scale) => {
  const vault = normaliseVault({ index: VAULT, Owner: 'rOwner', Account: 'rPseudo', ShareMPTID: TOKEN, AssetsTotal: '1000000', AssetsAvailable: '400000', LossUnrealized: '200000', LEVersion: 1, Scale, shares: { OutstandingAmount: '1000000', mpt_issuance_id: TOKEN } }, 0)
  const brokers = [normaliseBroker({ index: 'B1', VaultID: VAULT, DebtTotal: '300000', CoverAvailable: '50000', CoverRateMinimum: 10000, CoverRateLiquidation: 20000 })]
  return { vaultId: VAULT, readAt: '2026-10-24T00:00:00Z', readMs: Date.now(), closeTimeUsed: 0, ledgerIndex: 1000, ledgerHash: 'B'.repeat(64), vault, brokers, loans: [], ...Reader.nav(vault) }
}
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const at = (o, path) => path.split('.').reduce((x, k) => x?.[k], o)
const nav = presentNav(snapOf(0), {})
const existing = {
  schema: 'string', asOf: 'string', ledgerIndex: 'number', freshness: 'object', 'freshness.readAt': 'string', 'freshness.readLedgerIndex': 'number', 'freshness.ageSeconds': 'number', 'freshness.stale': 'boolean',
  instrument: 'object', 'instrument.kind': 'string', 'instrument.vaultId': 'string', 'instrument.shareMptId': 'string', 'instrument.unitsOutstanding': 'string', 'instrument.asset': 'object', 'instrument.vaultKind': 'string', 'instrument.phase': 'string', 'instrument.redemptionAt': 'null',
  unitValue: 'object', 'unitValue.held': 'string', 'unitValue.reported': 'string', 'unitValue.divergenceBps': 'number', 'unitValue.basis': 'string',
  valuation: 'object', 'valuation.currency': 'string', 'valuation.scale': 'number', 'valuation.perUnitHeld': 'string', 'valuation.perUnitReported': 'string',
  assessment: 'null',
  provenance: 'object', 'provenance.network': 'string', 'provenance.source': 'string', 'provenance.assetsTotal': 'string', 'provenance.lossUnrealized': 'string', 'provenance.unitsOutstanding': 'string', 'provenance.scale': 'number', 'provenance.recompute': 'string', 'provenance.buildVersion': 'null',
}
eq('every existing field of orma.nav/1 keeps its name and its type', Object.keys(existing).filter((k) => typeOf(at(nav, k)) !== existing[k]), [])
eq('valuation.scale stays 6 and provenance.scale is the vault\'s Scale', [nav.valuation.scale, nav.provenance.scale, presentNav(snapOf(6), {}).valuation.scale, presentNav(snapOf(6), {}).provenance.scale], [6, 0, 6, 6])
eq('the unit value is unchanged: (assets - loss) / shares', [nav.unitValue.held, nav.valuation.perUnitHeld], ['0.800000', '0.800000'])
eq('ledgerHash, attestation, inputs and unit are added', [nav.ledgerHash, nav.attestation, nav.unit], ['B'.repeat(64), { status: 'attested' }, { numerator: 'drops', denominator: 'share-unit', shareScale: 0 }])
eq('inputs are decimal strings, brokers included', nav.inputs, { assetsAvailable: '400000', lockedAmount: '0', leVersion: '1', brokers: [{ id: 'B1', debtTotal: '300000', coverAvailable: '50000', coverRateMinimum: '10000', coverRateLiquidation: '20000' }] })
eq('a stale snapshot says so in attestation.status', presentNav({ ...snapOf(0), readMs: Date.now() - 60000 }, {}).attestation.status, 'stale')
const bare = presentNav({ ...snapOf(0), brokers: undefined, ledgerHash: undefined }, {})
eq('a hand-built snapshot is tolerated: no brokers, no hash', [bare.inputs.brokers, bare.ledgerHash], [[], null])

// --- /resolve: the five step names, and the anti-spoof inside follow pointer -------------------
const resolved = (o) => resolveFromIssuance({
  lastLedger: 2000,
  mptIssuance: async () => ({ Issuer: ISSUER, OutstandingAmount: '1', MPTokenMetadata: hex(JSON.stringify({ orma: { nav_url: 'https://93.184.215.14/nav' } })) }),
  req: world(o).req,
}, TOKEN, { fetchImpl: async () => Response.json(o.doc ?? navDoc('1.000000')) })
const good = await resolved({})
eq('/resolve keeps its five step names', good.steps.map((s) => s.step), ['read MPTokenIssuance', 'decode metadata', 'XLS-89 conformance', 'find valuation pointer', 'follow pointer'])
eq('and a matching document is served', [good.steps.at(-1).ok, good.nav?.unitValue.held], [true, '1.000000'])
const copied = await resolved({ doc: navDoc('1.000000', { share: OTHER }) })
eq('a document that names another share is SPOOFED in follow pointer, nav null', [copied.nav, copied.steps.at(-1).ok, copied.steps.at(-1).detail.startsWith('SPOOFED')], [null, false, true])

// --- the routes -------------------------------------------------------------------------------
const reader = new Reader([], {})
reader.passes = 1
reader.serverTime = '2026-10-24T00:00:00Z'
reader.closeTime = 0
const track = (vaultId, share, ageMs = 0) => reader.snapshots.set(vaultId, { ...snapOf(0), vaultId, vault: { ...snapOf(0).vault, vaultId, shareMptId: share }, readMs: Date.now() - ageMs })
track('11'.repeat(32), '11'.repeat(24))
track('22'.repeat(32), '22'.repeat(24), 60000)
track('33'.repeat(32), '33'.repeat(24))
reader.missing.add('33'.repeat(32))

// A ledger node that answers every request with entryNotFound, which Xrpl.req does not retry: enough to count the connections a verification opens.
let connections = 0
let hold = null
const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (s) => {
  connections++
  s.on('message', async (m) => {
    const r = JSON.parse(m)
    await hold
    s.send(JSON.stringify({ id: r.id, status: 'error', type: 'response', error: 'entryNotFound', request: r }))
  })
})
await new Promise((r) => wss.on('listening', r))

const api = createApi(reader, { port: 0, nyc: createNyc({ reader, env: { XRPL_WS: `ws://127.0.0.1:${wss.address().port}` } }) })
await api.listen()
const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${api.server.address().port}${path}`)
  return { status: res.status, body: await res.json() }
}
const statusOf = async (id) => (await get(`/api/mpt/${id}/status`)).body.status
eq('status: an untracked share is not-tracked, with a 200', [(await get(`/api/mpt/${OTHER}/status`)).status, await statusOf(OTHER)], [200, 'not-tracked'])
eq('status: attested, stale, revoked', [await statusOf('11'.repeat(24)), await statusOf('22'.repeat(24)), await statusOf('33'.repeat(24))], ['attested', 'stale', 'revoked'])
const badId = await get('/api/mpt/zz/status')
eq('status: an id that is not 48 hex is a 400 BAD_REQUEST', [badId.status, badId.body.error.code], [400, 'BAD_REQUEST'])
const untracked = await get(`/api/mpt/${OTHER}/nav`)
eq('nav: an untracked share keeps its 404 SHARE_NOT_TRACKED', [untracked.status, untracked.body.error.code], [404, 'SHARE_NOT_TRACKED'])
eq('mark: an id that is not 48 hex is a 400', (await get('/api/mark/zz')).status, 400)

const quiet = console.error
console.error = () => {} // xrpl.js prints the server's error to the console on each connection
const id = (n) => n.toString(16).padStart(48, '0')
let held
hold = new Promise((r) => { held = r })
const five = [1, 2, 3, 4, 5].map((n) => get(`/api/mark/${id(n)}`))
await new Promise((r) => setTimeout(r, 300))
eq('mark: at most four verifications at once, the fifth is told to retry', [connections, (await Promise.race(five.map((p, i) => p.then((v) => [i, v])))).slice(1).map((v) => [v.status, v.body.error.message.startsWith('Too many')])[0]], [4, [503, true]])
held()
hold = null
await Promise.all(five)
const before = connections
const again = await get(`/api/mark/${id(1)}`)
eq('mark: a failed verification is kept as the answer for 15 s', [again.status, connections - before], [503, 0])
for (let n = 10; n < 10 + 101; n++) await get(`/api/mark/${id(n)}`)
const afterFill = connections
await get(`/api/mark/${id(110)}`)
const keptNewest = connections === afterFill
await get(`/api/mark/${id(10)}`)
const reran = connections === afterFill + 1
await get(`/api/mark/${id(60)}`)
eq('mark: a full cache drops its oldest entry, not all of them', [keptNewest, reran, connections === afterFill + 1], [true, true, true])
console.error = quiet
await api.close()
await new Promise((r) => wss.close(r))

// --- live ---------------------------------------------------------------------------------------
if (process.argv.includes('--live')) {
  const { readFileSync } = await import('node:fs')
  const { Xrpl } = await import('../xrpl.mjs')
  const share = (f) => JSON.parse(readFileSync(`demo/${f}.json`, 'utf8')).shareMptId
  const xrpl = new Xrpl()
  await xrpl.client.connect()
  try {
    const harbor = await verify(share('harbor-1'), { xrpl })
    eq('live: Harbor-1 agrees, with an Oracle found by the toml', [harbor.verdict, harbor.steps.at(-1).detail.startsWith('no oracle published')], ['agree', false])
    const navUrl = JSON.parse(readFileSync('demo/harbor-1.json', 'utf8')).navUrl
    const copiedLive = await verify(share('spare'), { xrpl, overrideUrl: navUrl })
    eq('live: Harbor-1\'s pointer on the spare share is SPOOFED', [copiedLive.verdict, copiedLive.reason], ['disagree', 'SPOOFED'])
    eq('live: Halden agrees', (await verify(share('showcase-vault'), { xrpl })).verdict, 'agree')
  } finally {
    await xrpl.disconnect()
  }
  const r = spawnSync(process.execPath, [cli, share('harbor-1')], { encoding: 'utf8', timeout: 60000 })
  eq('live: the CLI exits 0 and prints the mark', [r.status, r.stdout.includes('"schema":"orma.mark/1"'), r.stdout.includes('"verdict":"agree"')], [0, true, true])
}

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
