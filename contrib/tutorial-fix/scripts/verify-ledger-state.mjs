import xrpl from 'xrpl'
import fs from 'fs'
const d = JSON.parse(fs.readFileSync('lendingSetup.json','utf8'))
const c = new xrpl.Client('wss://s.devnet.rippletest.net:51233'); await c.connect()
const show = async (label, index) => {
  const r = await c.request({ command:'ledger_entry', index, ledger_index:'validated' })
  const n = r.result.node
  console.log(`${label} (${n.LedgerEntryType}) ${index}`)
  for (const k of ['VaultKind','SubscriptionDate','RedemptionDate','AssetsTotal','AssetsAvailable','DebtTotal','Owner','VaultID','PrincipalOutstanding','LoanBrokerID','PaymentTotal','PaymentInterval','StartDate','NextPaymentDueDate'])
    if (n[k] !== undefined) console.log(`   ${k}: ${JSON.stringify(n[k])}`)
}
await show('VAULT      ', d.vaultID)
await show('LOANBROKER ', d.loanBrokerID)
await show('LOAN 1     ', d.loanID1)
await show('LOAN 2     ', d.loanID2)
const lg = await c.request({command:'ledger', ledger_index:'validated'})
console.log('validated close_time:', lg.result.ledger.close_time, '| ledger', lg.result.ledger_index)
// pull tx history for the loan broker account to list hashes
const h = await c.request({ command:'account_tx', account: d.loanBroker.address, ledger_index_min:-1, ledger_index_max:-1, limit:30 })
console.log('\n--- loanBroker account_tx (oldest first) ---')
for (const t of h.result.transactions.reverse())
  console.log(`  ${(t.tx_json?.TransactionType||t.tx?.TransactionType||'?').padEnd(22)} ${t.meta.TransactionResult.padEnd(16)} ${t.hash||t.tx_json?.hash}`)
await c.disconnect()
