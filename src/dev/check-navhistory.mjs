// Offline check of navhistory.mjs: the metadata shapes are those rippled returned for the
// four Devnet facilities, compacted. No network.
//   node src/dev/check-navhistory.mjs
import { navPoints, fetchNavHistory } from '../navhistory.mjs'
import { rippleToIso } from '../num.mjs'

const VAULT = 'AB'.repeat(32), POOL = 'rVaultPseudoAccount'
const vaultNode = (assets, loss) => ({ ModifiedNode: { LedgerEntryType: 'Vault', LedgerIndex: VAULT, FinalFields: { ...(assets && { AssetsTotal: assets }), ...(loss && { LossUnrealized: loss }) } } })
const shares = (n) => ({ ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', LedgerIndex: 'CD', FinalFields: { Issuer: POOL, ...(n && { OutstandingAmount: n }) } } })

let t = 842562300
const tx = (TransactionType, nodes, { Flags = 0, result = 'tesSUCCESS' } = {}) =>
  ({ tx_json: { TransactionType, Flags, date: t += 10 }, hash: `H${t}`, meta: { TransactionResult: result, AffectedNodes: nodes } })
// account_tx is newest first
const ledger = (...txs) => txs.reverse()
const history = (txs) => navPoints({ vaultId: VAULT, pseudoAccount: POOL }, txs).map((p) => [p.kind, p.navNaive, p.navCorrect].join(' '))

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

// A recognised loss lowers the held NAV and leaves the reported one at par.
eq('impairment: held falls, reported stays', history(ledger(
  tx('VaultCreate', [vaultNode()]),
  tx('VaultDeposit', [shares('51000000'), vaultNode('51000000')]),
  tx('LoanSet', [vaultNode('51000000')]),
  tx('LoanManage', [vaultNode('51000000', '10000000')], { Flags: 0x20000 }),
)), ['deposit 1.000000 1.000000', 'loan 1.000000 1.000000', 'impair 1.000000 0.803922'])

// A default writes assets down: both NAVs fall together and nothing is left unrecognised.
eq('defaults: both NAVs fall', history(ledger(
  tx('VaultDeposit', [shares('50000000'), vaultNode('50000000')]),
  tx('LoanManage', [vaultNode('20400000')], { Flags: 0x10000 }),
  tx('LoanManage', [vaultNode('10500000')], { Flags: 0x10000 }),
)), ['deposit 1.000000 1.000000', 'default 0.408000 0.408000', 'default 0.210000 0.210000'])

// The share count carries forward until a deposit or a withdrawal moves it.
eq('withdrawal changes the share count', history(ledger(
  tx('VaultDeposit', [shares('20000000'), vaultNode('20000000')]),
  tx('VaultWithdraw', [shares('15000000'), vaultNode('15000000')]),
)), ['deposit 1.000000 1.000000', 'withdraw 1.000000 1.000000'])

eq('a failed transaction, an unrelated one and a vault with no shares give no point', history(ledger(
  tx('VaultCreate', [vaultNode()]),
  tx('LoanBrokerSet', []),
  tx('VaultDeposit', [shares('5000000'), vaultNode('5000000')], { result: 'tecINSUFFICIENT_FUNDS' }),
)), [])

const deposit = tx('VaultDeposit', [shares('1000000'), vaultNode('1000000')])
const [first] = navPoints({ vaultId: VAULT, pseudoAccount: POOL }, [deposit])
eq('time comes from the ledger close', first.at, rippleToIso(deposit.tx_json.date))

const full = Array.from({ length: 1000 }, () => tx('LoanBrokerSet', []))
eq('a full window says it may have lost its oldest transactions',
  (await fetchNavHistory({ accountTx: async () => full }, { vaultId: VAULT, pseudoAccount: POOL })).truncated, true)
eq('a short one does not',
  (await fetchNavHistory({ accountTx: async () => full.slice(0, 5) }, { vaultId: VAULT, pseudoAccount: POOL })).truncated, false)

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exit(bad ? 1 : 0)
