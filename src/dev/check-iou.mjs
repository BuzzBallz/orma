// Offline check that a vault holding an issued currency is read in whole shares: its share issuance
// carries 10^Scale units per unit of asset, so a healthy USD vault is worth one a share, not
// 0.000001, and has destroyed none of its capital. No network, no ledger.
//   node src/dev/check-iou.mjs
import { Reader } from '../poll.mjs'
import { deriveScoreInputs, buildScore } from '../score.mjs'
import { valuePledge } from '../nav.mjs'
import { navPoints } from '../navhistory.mjs'
import { num } from '../num.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const usd = { assetsTotal: num('10000'), assetsAvailable: num('10000'), lossUnrealized: num('0'), sharesOutstanding: num('10000000000'), scale: 6 }
const xrp = { assetsTotal: num('51000000'), assetsAvailable: num('51000000'), lossUnrealized: num('10000000'), sharesOutstanding: num('51000000'), scale: 0 }
const broker = { debtTotal: 0, coverAvailable: 0, coverRateMinimum: 0, coverRateLiquidation: 0 }

eq('a healthy USD vault, Scale 6', Reader.nav(usd), { navNaive: '1.000000', navCorrect: '1.000000', navDivergenceBps: 0 })
eq('an XRP vault, Scale 0, unchanged', Reader.nav(xrp), { navNaive: '1.000000', navCorrect: '0.803922', navDivergenceBps: 1961 })

const args = deriveScoreInputs({ ...usd, broker, loans: [], phase: 'Open' }).scoreArgs
eq('and it has destroyed none of its capital', args.realisedLossPct.toFixed(2), '0.00')
eq('so it is not graded as a total loss', buildScore(args).grade === 'B', false)

const nav = { unitValue: { held: '0.9', reported: '1' }, provenance: { scale: 6 } }
eq('a pledge of 2,000,000 share units of a USD vault is 2 shares', valuePledge(nav, '2000000'),
  { units: '2000000', valueHeld: '1.8', valueReported: '2', overstatement: '0.2' })
eq('a pledge against a document with no scale is integer, as before', valuePledge({ unitValue: { held: '0.803922', reported: '1' } }, '1000000').valueHeld, '803922')

const vault = { vaultId: 'V'.repeat(64), pseudoAccount: 'rPseudo', scale: 6 }
const tx = {
  hash: 'H', close_time_iso: '2026-10-01T00:00:00Z', tx_json: { TransactionType: 'VaultDeposit' },
  meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [
    { ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', FinalFields: { Issuer: 'rPseudo', OutstandingAmount: '10000000000' } } },
    { ModifiedNode: { LedgerEntryType: 'Vault', LedgerIndex: vault.vaultId, FinalFields: { AssetsTotal: '10000', LossUnrealized: '0' } } },
  ] },
}
eq('the NAV history of a USD vault', navPoints(vault, [tx]).map((p) => p.navCorrect), ['1.000000'])

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
