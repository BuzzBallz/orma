// Offline checks of reader and publisher edge cases the 19 October audit reproduced: a vault with two
// loan brokers, an empty vault, escrow times, the oracle's LastUpdateTime and its document ids.
//   node src/dev/check-reader-edges.mjs
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { presentVault } from '../present.mjs'
import { Reader } from '../poll.mjs'
import { normaliseVault, normaliseBroker, normaliseLoan } from '../xrpl.mjs'
import { findShareEscrows } from '../collateral.mjs'
import { OraclePublisher, oracleDocId } from '../oracle.mjs'
import { PublishLoop } from '../publish-loop.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const NOW = 800000000
const V = 'AB'.repeat(32)
const vault = (fields) => normaliseVault({ index: V, Owner: 'rOwner', Account: 'rPseudo', shares: { mpt_issuance_id: 'CD'.repeat(24) }, ...fields }, NOW)
const snapOf = (v, brokers = [], loans = []) => ({ vaultId: V, readAt: '2025-05-08T00:00:00Z', closeTimeUsed: NOW, ledgerIndex: 1, vault: v, brokers, loans, ...Reader.nav(v), phaseInfo: Reader.phaseInfo(v, NOW) })

// Two brokers on one vault: each loan is a share of its own broker's debt.
const broker = (id, debt) => normaliseBroker({ index: id, VaultID: V, DebtTotal: String(debt), CoverAvailable: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, LoanSequence: 2 })
const loan = (id, brokerId, principal) => normaliseLoan({ index: id, LoanBrokerID: brokerId, Flags: 0, NextPaymentDueDate: NOW + 30 * 86400, PaymentInterval: 30 * 86400, PrincipalOutstanding: String(principal), TotalValueOutstanding: String(principal) }, NOW)
const two = presentVault(snapOf(vault({ AssetsTotal: '100000000', AssetsAvailable: '0' }), [broker('A1', 10000000), broker('B2', 90000000)],
  [loan('L1', 'A1', 10000000), loan('L2', 'B2', 50000000), loan('L3', 'B2', 40000000)]))
eq('two brokers: each loan against its own broker', two.loans.map((l) => l.shareOfDebtTotal), ['1.0000', '0.5556', '0.4444'])

// An empty vault: no cash because no assets, not a run on the vault.
const empty = presentVault(snapOf(vault({ AssetsTotal: '0', AssetsAvailable: '0' })))
eq('an empty vault raises no liquidity alert', empty.alerts.map((a) => a.code), [])
let published = 0
const loop = new PublishLoop({ vaultIds: [], onSnapshot: null }, { docIdFor: () => 1, publish: async () => { published++; return { ok: true } }, read: async () => null })
await loop.onSnapshot(snapOf(vault({ AssetsTotal: '0', AssetsAvailable: '0' })))
eq('and is not published as a total loss', published, 0)

// Escrow times are ISO, like every other time on the API.
const escrows = await findShareEscrows({ accountObjects: async () => [{ index: 'E1', Account: 'rP', Amount: { mpt_issuance_id: 'CD'.repeat(24), value: '5' }, FinishAfter: 815000000, CancelAfter: 815086400 }] }, 'CD'.repeat(24), ['rP'])
eq('escrow times are ISO', [escrows[0].finishAfter, escrows[0].cancelAfter], ['2025-10-28T20:53:20Z', '2025-10-29T20:53:20Z'])

// LastUpdateTime follows the ledger, whatever this host's clock says.
const sent = []
const client = { submitAndWait: async (tx) => { sent.push(tx.LastUpdateTime); return { result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'H' } } } }
const pub = new OraclePublisher(client, { address: 'rPub' })
const detail = presentVault(snapOf(vault({ AssetsTotal: '1000000', AssetsAvailable: '1000000', shares: { OutstandingAmount: '1000000', mpt_issuance_id: 'CD'.repeat(24) } })))
const realNow = Date.now
Date.now = () => (1792425481 - 360) * 1000   // this host six minutes slow
await pub.publish(detail, 1792425481)
await pub.publish(detail, 1792425481)       // same ledger close: bumped by one second
Date.now = realNow
eq('LastUpdateTime is ledger time, bumped, never the slow host clock', sent, [1792425481, 1792425482])

// Document ids are a pure function of the vault id: not of the instance, the reading order or a pin.
const sha32 = (v) => createHash('sha256').update(v).digest().readUInt32BE(0)
const first = new OraclePublisher(client, { address: 'rPub' })
const second = new OraclePublisher(client, { address: 'rPub' }, { docIds: { V1: 1 } })
const forward = ['V1', 'V2'].map((v) => first.docIdFor(v))
const backward = ['V2', 'V1'].map((v) => second.docIdFor(v)).reverse()
eq('document ids do not depend on the instance or the reading order', backward, forward)
eq('a document id is the first four bytes of sha256(VaultID), big-endian', forward, [sha32('V1'), sha32('V2')])
eq('opts.docIds no longer pins a document id', second.docIdFor('V1'), sha32('V1'))
eq('docIdFor is oracleDocId', first.docIdFor(V), oracleDocId(V))

eq('the provider is Orma unless ORACLE_PROVIDER says otherwise', first.provider, process.env.ORACLE_PROVIDER ?? 'Orma')
eq('src/oracle.mjs names no personal account', readFileSync(new URL('../oracle.mjs', import.meta.url), 'utf8').includes('BuzzBallz'), false)

// Every vault the demo knows, retired ones included, has its own document id.
const demoVaults = new Set()
for (const f of readdirSync('demo').filter((n) => n.endsWith('.json'))) {
  const id = JSON.parse(readFileSync(join('demo', f), 'utf8')).vaultId
  if (/^[A-Fa-f0-9]{64}$/.test(id ?? '')) demoVaults.add(id.toUpperCase())
}
eq('every distinct demo vault has its own document id', new Set([...demoVaults].map(oracleDocId)).size, demoVaults.size)

// A forced collision: the second vault is refused with an error line, and nothing is sent.
const collide = new OraclePublisher(client, { address: 'rPub' })
collide.docIdFor = () => 7
const other = { ...detail, vault: { ...detail.vault, vaultId: 'CD'.repeat(32) } }
await collide.publish(detail, 1792425481)
const before = sent.length
const stderr = []
const write = process.stderr.write
process.stderr.write = (chunk) => (stderr.push(String(chunk)), true)
const refused = await collide.publish(other, 1792425481)
process.stderr.write = write
eq('a second vault on a taken document id is refused', [refused.reason, sent.length - before], ['collision', 0])
eq('and the refusal is an error line', stderr.some((l) => JSON.parse(l).level === 'error'), true)

// The public site relays the pointer and the API to the VPS, ahead of the SPA fallback.
const vercel = JSON.parse(readFileSync('app/vercel.json', 'utf8'))
const VPS = 'https://claude-vps.tailf3fd40.ts.net'
const at = (source) => vercel.rewrites.findIndex((r) => r.source === source)
const spa = vercel.rewrites.findIndex((r) => r.source.startsWith('/((?!'))
const nav = vercel.rewrites[at('/v/:mpt/nav')]
const api = vercel.rewrites[at('/api/:path*')]
const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value
eq('the toml is served with Access-Control-Allow-Origin *', vercel.headers.find((h) => h.source === '/.well-known/xrp-ledger.toml')?.headers, [{ key: 'Access-Control-Allow-Origin', value: '*' }])
eq('/v/:mpt/nav goes to the VPS before the SPA rewrite', [nav?.destination, at('/v/:mpt/nav') < spa], [`${VPS}/orma/api/mpt/:mpt/nav`, true])
eq('/api/:path* goes to the VPS before the SPA rewrite', [api?.destination, at('/api/:path*') < spa], [`${VPS}/orma/api/:path*`, true])
eq('the CSP allows the VPS and the Render fallback', [csp.includes(`connect-src 'self' ${VPS} https://orma-api.onrender.com`)], [true])

// The Oracle is read at the ledger of the OracleSet that was just validated, and nothing is read before.
const reqs = []
const fake = {
  submitAndWait: async () => ({ result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: 'H', ledger_index: 1234 } }),
  request: async (r) => (reqs.push(r), r.command === 'ledger' ? { result: { ledger_index: 1300 } } : { result: { node: {} } }),
}
const reading = new OraclePublisher(fake, { address: 'rPub' })
const published1 = await reading.publish(detail, 1792425481)
eq('publish reads nothing and returns the ledger of its OracleSet', [reqs, published1.ledgerIndex], [[], 1234])
await reading.read(V)
eq('read after a publish asks ledger_entry at that ledger', reqs, [{ command: 'ledger_entry', oracle: { account: 'rPub', oracle_document_id: oracleDocId(V) }, ledger_index: 1234 }])
reqs.length = 0
const never = 'CD'.repeat(32)
await reading.read(never)
eq('read of a never-published vault finds the validated ledger, then reads at its number', reqs, [
  { command: 'ledger', ledger_index: 'validated' },
  { command: 'ledger_entry', oracle: { account: 'rPub', oracle_document_id: oracleDocId(never) }, ledger_index: 1300 },
])

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
