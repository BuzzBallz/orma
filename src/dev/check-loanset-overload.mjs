// Is tecNO_PERMISSION on LoanSet overloaded? Same closed-ended vault, same broker,
// same everything except the loan TERM. If a short loan succeeds and a long one is
// refused with the same code as an open-ended vault, the code carries two meanings.
import { Client, signLoanSetByCounterparty } from 'xrpl'
const c = new Client('wss://s.devnet.rippletest.net:51233',{connectionTimeout:20000}); await c.connect()
const ok=r=>r.result.meta.TransactionResult
const created=(m,t)=>m.AffectedNodes.map(n=>n.CreatedNode).find(n=>n?.LedgerEntryType===t)
const ct=async()=>Number((await c.request({command:'ledger',ledger_index:'validated'})).result.ledger.close_time)
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const { wallet: owner } = await c.fundWallet()
const { wallet: b1 } = await c.fundWallet()
const { wallet: b2 } = await c.fundWallet()
const now = await ct(), SUB = now+30, RED = SUB+900   // deliberately LONG window
let r = await c.submitAndWait({TransactionType:'VaultCreate',Account:owner.address,Asset:{currency:'XRP'},
  VaultKind:1,SubscriptionDate:SUB,RedemptionDate:RED,WithdrawalPolicy:1},{wallet:owner,autofill:true})
const vaultId = created(r.result.meta,'Vault').LedgerIndex
await c.submitAndWait({TransactionType:'VaultDeposit',Account:owner.address,VaultID:vaultId,Amount:'50000000'},{wallet:owner,autofill:true})
r = await c.submitAndWait({TransactionType:'LoanBrokerSet',Account:owner.address,VaultID:vaultId,
  ManagementFeeRate:1000,DebtMaximum:'40000000',CoverRateMinimum:10000,CoverRateLiquidation:10000},{wallet:owner,autofill:true})
const brokerId = created(r.result.meta,'LoanBroker').LedgerIndex
await c.submitAndWait({TransactionType:'LoanBrokerCoverDeposit',Account:owner.address,LoanBrokerID:brokerId,Amount:'5000000'},{wallet:owner,autofill:true})
while ((await ct()) < SUB+6) await sleep(3000)
const tryLoan = async (bw,interval,total,label)=>{
  try{
    let tx = await c.autofill({TransactionType:'LoanSet',Account:owner.address,LoanBrokerID:brokerId,
      Counterparty:bw.address,PrincipalRequested:'5000000',InterestRate:100000,LateInterestRate:20000,
      PaymentInterval:interval,PaymentTotal:total,GracePeriod:60})
    tx.Fee=String(Number(tx.Fee)*2)
    const res = await c.submitAndWait(signLoanSetByCounterparty(bw, owner.sign(tx).tx_blob).tx_blob)
    const term = interval*total
    const rem = RED - (await ct())
    console.log(`  ${label.padEnd(26)} term=${String(term).padStart(4)}s  window left=${String(rem).padStart(4)}s  -> ${ok(res)}`)
    return ok(res)
  }catch(e){ console.log(`  ${label.padEnd(26)} -> LOCAL ${(e?.data?.error_exception||e.message).slice(0,60)}`); return 'local' }
}
console.log(`\n  closed-ended vault, redemption window ${RED-SUB}s. Only the TERM varies.\n`)
const short = await tryLoan(b1, 60, 3, 'short term (180s)')
const long  = await tryLoan(b2, 60, 20, 'long term (1200s)')
console.log(`\n  short: ${short}`)
console.log(`  long:  ${long}`)
console.log(long==='tecNO_PERMISSION' && short==='tesSUCCESS'
  ? '\n  CONFIRMED: tecNO_PERMISSION on LoanSet is OVERLOADED. Same code for\n  "this vault is not closed-ended" and "this loan outlives the vault".'
  : '\n  inconclusive')
await c.disconnect()
