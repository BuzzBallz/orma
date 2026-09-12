// Builds a broker with two unequal loans, defaults them BIG-FIRST (the order that
// minimises the broker's own first-loss contribution), and checks that the history
// module reconstructs it and calls it out.
//   node src/dev/check-history.mjs
import { Client, signLoanSetByCounterparty } from 'xrpl'
import { Xrpl, sleep, normaliseBroker } from '../xrpl.mjs'
import { fetchBrokerHistory, analyseOrdering, reputation, recommendOrder } from '../history.mjs'
import { num } from '../num.mjs'

const WS = 'wss://s.devnet.rippletest.net:51233'
const ok = (r) => r.result.meta.TransactionResult
const created = (meta, t) => meta.AffectedNodes.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)
const must = (r, what) => { if (ok(r) !== 'tesSUCCESS') { console.error(`  ABORT ${what} -> ${ok(r)}`); process.exit(1) } return r }
const xrp = (d) => (Number(d) / 1e6).toFixed(2)

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const closeTime = async () => Number((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)
const waitTo = async (t) => { while ((await closeTime()) < t) await sleep(3000) }

const { wallet: owner } = await c.fundWallet()
const { wallet: b1 } = await c.fundWallet()
const { wallet: b2 } = await c.fundWallet()
const now = await closeTime()
const SUB = now + 25, RED = SUB + 900

let r = must(await c.submitAndWait({
  TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' },
  VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, WithdrawalPolicy: 1,
}, { wallet: owner, autofill: true }), 'VaultCreate')
const vaultId = created(r.result.meta, 'Vault').LedgerIndex
must(await c.submitAndWait({ TransactionType: 'VaultDeposit', Account: owner.address, VaultID: vaultId, Amount: '50000000' }, { wallet: owner, autofill: true }), 'VaultDeposit')

r = must(await c.submitAndWait({
  TransactionType: 'LoanBrokerSet', Account: owner.address, VaultID: vaultId,
  ManagementFeeRate: 1000, DebtMaximum: '45000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000,
}, { wallet: owner, autofill: true }), 'LoanBrokerSet')
const brokerId = created(r.result.meta, 'LoanBroker').LedgerIndex
must(await c.submitAndWait({ TransactionType: 'LoanBrokerCoverDeposit', Account: owner.address, LoanBrokerID: brokerId, Amount: '10000000' }, { wallet: owner, autofill: true }), 'CoverDeposit')
console.log(`  broker ${brokerId.slice(0, 20)}...  cover 10 XRP  cmin=10% cliq=10%`)

await waitTo(SUB + 5)
const mkLoan = async (bw, principal) => {
  let tx = await c.autofill({
    TransactionType: 'LoanSet', Account: owner.address, LoanBrokerID: brokerId, Counterparty: bw.address,
    PrincipalRequested: String(principal), InterestRate: 100000, LateInterestRate: 20000,
    PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 60,
  })
  tx.Fee = String(Number(tx.Fee) * 2)
  const res = must(await c.submitAndWait(signLoanSetByCounterparty(bw, owner.sign(tx).tx_blob).tx_blob), 'LoanSet')
  return created(res.result.meta, 'Loan').LedgerIndex
}
const big = await mkLoan(b1, 30000000)
const small = await mkLoan(b2, 10000000)
console.log('  loans: 30 XRP and 10 XRP, DebtTotal 40 XRP')

const ln = (await c.request({ command: 'ledger_entry', index: big })).result.node
await waitTo(Number(ln.NextPaymentDueDate) + Number(ln.GracePeriod) + 8)

console.log('\n  declaring BIG first (the self-serving order)')
for (const [label, id] of [['BIG 30', big], ['SMALL 10', small]]) {
  const d = must(await c.submitAndWait({ TransactionType: 'LoanManage', Account: owner.address, LoanID: id, Flags: 65536 }, { wallet: owner, autofill: true }), `default ${label}`)
  console.log(`    default ${label} -> ${ok(d)}`)
}

const x = new Xrpl(WS)
await x.connect()
const brokerNode = (await c.request({ command: 'ledger_entry', index: brokerId })).result.node
const broker = normaliseBroker({ ...brokerNode, index: brokerId })

const events = await fetchBrokerHistory(x, owner.address, brokerId)
console.log(`\n  reconstructed ${events.length} event(s) from ledger history:`)
for (const e of events) {
  console.log(`    ${String(e.kind).padEnd(14)} debtBefore=${xrp(e.debtBefore).padStart(6)}  coverUsed=${xrp(e.coverConsumed).padStart(5)}  principal=${xrp(e.principal).padStart(6)}`)
}

const ord = analyseOrdering(events, broker)
console.log('\n  ORDERING ANALYSIS')
if (!ord.applicable) console.log(`    n/a: ${ord.reason}`)
else {
  console.log(`    actual cover paid   ${xrp(ord.actualCoverPaid)} XRP`)
  console.log(`    best for depositors ${xrp(ord.bestPossible)} XRP  (smallest first)`)
  console.log(`    worst for them      ${xrp(ord.worstPossible)} XRP  (largest first)`)
  console.log(`    cost of this choice ${xrp(ord.costToDepositors)} XRP`)
  console.log(`    fairness            ${ord.fairness}  (0 = self-serving, 1 = fair)`)
}

const rep = reputation(events, ord, broker)
console.log(`\n  REPUTATION  ${rep.grade} (${rep.score}/100)`)
for (const f of rep.findings) console.log(`    [${f.code}] ${f.detail}`)

await x.disconnect(); await c.disconnect()
