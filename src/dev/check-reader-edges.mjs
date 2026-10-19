// Offline checks of reader and publisher edge cases the 19 October audit reproduced: a vault with two
// loan brokers, an empty vault, escrow times, the oracle's LastUpdateTime and its document ids.
//   node src/dev/check-reader-edges.mjs
import { presentVault } from '../present.mjs'
import { Reader } from '../poll.mjs'
import { normaliseVault, normaliseBroker, normaliseLoan } from '../xrpl.mjs'
import { findShareEscrows } from '../collateral.mjs'
import { OraclePublisher } from '../oracle.mjs'
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

// Document ids in the reader's order, whichever vault is read first.
const ids = new OraclePublisher(client, { address: 'rPub' })
new PublishLoop({ vaultIds: ['V1', 'V2'], onSnapshot: null }, ids).attach()
ids.docIdFor('V2')
eq('document ids follow the reader, not the first read', [ids.docIdFor('V1'), ids.docIdFor('V2')], [1, 2])

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
