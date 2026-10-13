// Offline check of navhistory.mjs: the metadata shapes are those rippled returned for the
// four Devnet facilities, compacted. No network.
//   node src/dev/check-navhistory.mjs
import { navPoints, fetchNavHistory } from '../navhistory.mjs'
import { rippleToIso } from '../num.mjs'
import { Xrpl } from '../xrpl.mjs'

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

// The page limit is read from the server's marker, not guessed from a count, and the range kept
// is the narrowest any page stated (a reconnect can land on a server with a higher floor).
const paged = (pages) => {
  const x = new Xrpl('wss://unused.invalid')
  let n = 0
  x.req = async () => { n++; return { result: { transactions: [tx('LoanBrokerSet', [])], ledger_index_min: 100 + n, ledger_index_max: 900 - n, ...(n < pages && { marker: { n } }) } } }
  return x.accountTxWindow(POOL, { maxPages: 5 })
}
const stopped = await paged(7)
eq('a read the page limit stopped says so', [stopped.transactions.length, stopped.truncated], [5, true])
eq('it keeps the narrowest range a page stated', [stopped.ledgerMin, stopped.ledgerMax], [105, 895])
const whole = await paged(5)
eq('a read that ran out of pages first does not', [whole.transactions.length, whole.truncated], [5, false])

const window = (truncated) => ({ accountTxWindow: async () => ({ transactions: [deposit], ledgerMin: 1, ledgerMax: 9, truncated }) })
eq('the route passes the page limit through',
  (await fetchNavHistory(window(true), { vaultId: VAULT, pseudoAccount: POOL }, { archive: null })).truncated, true)
eq('and says when it was not hit',
  (await fetchNavHistory(window(false), { vaultId: VAULT, pseudoAccount: POOL }, { archive: null })).truncated, false)

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exit(bad ? 1 : 0)
