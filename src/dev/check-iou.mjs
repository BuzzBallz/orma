// Offline check that a vault holding an issued currency is read in whole shares: its share issuance
// carries 10^Scale units per unit of asset, so a healthy USD vault is worth one a share, not
// 0.000001, and has destroyed none of its capital. No network, no ledger.
//   node src/dev/check-iou.mjs
import { Reader } from '../poll.mjs'
import { deriveScoreInputs, buildScore } from '../score.mjs'
import { valuePledge, presentNav } from '../nav.mjs'
import { presentCollateral } from '../collateral.mjs'
import { navPoints } from '../navhistory.mjs'
import { amountText, num } from '../num.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const USD = { kind: 'IOU', currency: 'USD', issuer: 'rIssuer', mptIssuanceId: null }
const usd = { assetsTotal: num('10000'), assetsAvailable: num('10000'), lossUnrealized: num('0'), sharesOutstanding: num('10000000000'), scale: 6 }
const xrp = { assetsTotal: num('51000000'), assetsAvailable: num('51000000'), lossUnrealized: num('10000000'), sharesOutstanding: num('51000000'), scale: 0 }
const broker = { debtTotal: 0, coverAvailable: 0, coverRateMinimum: 0, coverRateLiquidation: 0 }

eq('a healthy USD vault, Scale 6', Reader.nav(usd), { navNaive: '1.000000', navCorrect: '1.000000', navDivergenceBps: 0 })
eq('an XRP vault, Scale 0, unchanged', Reader.nav(xrp), { navNaive: '1.000000', navCorrect: '0.803922', navDivergenceBps: 1961 })

const args = deriveScoreInputs({ ...usd, broker, loans: [], phase: 'Open' }).scoreArgs
eq('and it has destroyed none of its capital', args.realisedLossPct.toFixed(2), '0.00')
eq('so it is not graded as a total loss', buildScore(args).grade, 'AAA')

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

eq('an alert amount in USD', amountText('12.5', USD), '12.50 USD')
eq('an alert amount in XRP', amountText('200000', null, 6), '0.200000 XRP')

// Amounts in an issued currency keep their decimals; whole units are for drops and MPTs.
const lossy = { ...usd, assetsTotal: num('1.5'), lossUnrealized: num('0.4'), sharesOutstanding: num('1500000'), asset: USD, vaultId: 'V'.repeat(64) }
const doc = presentNav({ vault: lossy, ...Reader.nav(lossy) })
const p = doc.provenance
const recomputed = num(p.assetsTotal).minus(p.lossUnrealized).div(num(p.unitsOutstanding).div(10 ** p.scale)).toFixed(6)
eq('the nav provenance of a USD vault recomputes to its own unit value', [p.assetsTotal, p.lossUnrealized, recomputed], ['1.5', '0.4', doc.unitValue.held])

const pledged = presentCollateral([{ escrowId: 'E', pledgor: 'rPledgor', shares: num('2000000') }], { navNaive: '1.000000', navCorrect: '0.900000', vault: { ...usd, asset: USD, shareMptId: 'CD'.repeat(24) } })
eq('2,000,000 escrowed share units of a USD vault are 2 shares, worth 1.8 USD held', [pledged.pledges[0].valueCorrect, pledged.totalValueCorrect], ['1.8', '1.8'])

const atMinimum = deriveScoreInputs({ ...usd, asset: USD, broker: { debtTotal: '40.5', coverAvailable: '4.05', coverRateMinimum: 10000, coverRateLiquidation: 10000 }, loans: [], phase: 'Open' })
eq('a USD broker exactly at its minimum cover is not short', [atMinimum.broker.coverRequired.toFixed(), atMinimum.broker.coverShortfall.toFixed()], ['4.05', '0'])

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
