/**
 * The institutional collateral scenario, end to end on Devnet.
 *
 *   1. An LP deposits into vault A and receives shares 1:1.
 *   2. The LP ESCROWS those shares to a second broker as collateral (XLS-85).
 *   3. Both readings agree. The broker is happy to lend.
 *   4. A loan inside vault A goes bad and the broker impairs it.
 *   5. The naive reading still says par. Ours does not. The escrowed collateral
 *      just lost value and the lender's obvious mark cannot see it.
 *
 * Run:  node src/demo/collateral-scenario.mjs
 * Writes state to .demo/collateral-<ts>.json so the API and the deck can reuse it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client, signLoanSetByCounterparty } from 'xrpl'
import { Xrpl, normaliseVault, normaliseLoan, sleep } from '../xrpl.mjs'
import { Reader } from '../poll.mjs'
import { findShareEscrows, presentCollateral } from '../collateral.mjs'
import { num } from '../num.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const ok = (r) => r.result.meta.TransactionResult
const created = (meta, type) => {
  for (const an of meta.AffectedNodes) if (an.CreatedNode?.LedgerEntryType === type) return an.CreatedNode
  return null
}
const line = (s) => console.log(s)
const must = (r, what) => {
  const res = ok(r)
  if (res !== 'tesSUCCESS') { console.error(`
    ABORT: ${what} -> ${res}`); process.exit(1) }
  return r
}
const step = (n, s) => console.log(`\n[36m[${n}][0m ${s}`)

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const closeTime = async () => Number((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)
const waitTo = async (t, label) => { while ((await closeTime()) < t) await sleep(3000); if (label) line(`    ...waited to ${label}`) }

step(1, 'Funding four unrelated accounts')
const { wallet: owner } = await c.fundWallet()     // vault A owner + its loan broker
const { wallet: lp } = await c.fundWallet()        // the LP who will pledge
const { wallet: borrower } = await c.fundWallet()  // borrows from vault A, then defaults
const { wallet: lender } = await c.fundWallet()    // the SECOND broker taking the collateral
line(`    vaultOwner ${owner.address}`)
line(`    lp         ${lp.address}`)
line(`    borrower   ${borrower.address}`)
line(`    lender     ${lender.address}  <- takes the shares as collateral`)

const now = await closeTime()
const SUB = now + 25
const RED = SUB + 900

step(2, 'Vault A: closed-ended, and an LP deposits 100 XRP for 100 shares')
let r = await c.submitAndWait({
  TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' },
  VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, WithdrawalPolicy: 1,
}, { wallet: owner, autofill: true })
const vaultId = created(r.result.meta, 'Vault').LedgerIndex
line(`    VaultCreate ${ok(r)}  ${vaultId.slice(0, 20)}...`)

r = await c.submitAndWait({ TransactionType: 'VaultDeposit', Account: lp.address, VaultID: vaultId, Amount: '60000000' }, { wallet: lp, autofill: true })
must(r, 'VaultDeposit by LP')
line(`    VaultDeposit by LP ${ok(r)}  (60 XRP -> 60 shares, 1:1)`)

const vi = (await c.request({ command: 'vault_info', vault_id: vaultId })).result.vault
const shareMptId = vi.ShareMPTID
line(`    share MPT ${shareMptId}`)

step(3, 'The LP pledges 40 shares to a SECOND lender, on-ledger, via TokenEscrow')
r = await c.submitAndWait({ TransactionType: 'MPTokenAuthorize', Account: lender.address, MPTokenIssuanceID: shareMptId }, { wallet: lender, autofill: true })
line(`    lender MPTokenAuthorize ${ok(r)}   <- required, and easy to miss`)
const t = await closeTime()
r = await c.submitAndWait({
  TransactionType: 'EscrowCreate', Account: lp.address, Destination: lender.address,
  Amount: { mpt_issuance_id: shareMptId, value: '40000000' },
  FinishAfter: t + 120, CancelAfter: t + 86400,
}, { wallet: lp, autofill: true })
must(r, 'EscrowCreate')
const escrowId = created(r.result.meta, 'Escrow')?.LedgerIndex
line(`    EscrowCreate ${ok(r)}  40 shares locked as collateral`)
line(`    escrow ${escrowId}`)

step(4, 'Vault A lends out. A loan is originated against the pool.')
await waitTo(SUB + 5, 'Investment phase')
r = await c.submitAndWait({
  TransactionType: 'LoanBrokerSet', Account: owner.address, VaultID: vaultId,
  ManagementFeeRate: 1000, DebtMaximum: '50000000', CoverRateMinimum: 10000, CoverRateLiquidation: 20000,
}, { wallet: owner, autofill: true })
const brokerId = created(r.result.meta, 'LoanBroker').LedgerIndex
line(`    LoanBrokerSet ${ok(r)}`)
r = await c.submitAndWait({ TransactionType: 'LoanBrokerCoverDeposit', Account: owner.address, LoanBrokerID: brokerId, Amount: '5000000' }, { wallet: owner, autofill: true })
line(`    LoanBrokerCoverDeposit ${ok(r)}  (5 XRP first-loss)`)

let tx = await c.autofill({
  TransactionType: 'LoanSet', Account: owner.address, LoanBrokerID: brokerId,
  Counterparty: borrower.address, PrincipalRequested: '30000000', InterestRate: 100000,
  LateInterestRate: 20000, PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 60,
})
tx.Fee = String(Number(tx.Fee) * 2)
const dual = signLoanSetByCounterparty(borrower, owner.sign(tx).tx_blob)
r = await c.submitAndWait(dual.tx_blob)
must(r, 'LoanSet')
const loanId = created(r.result.meta, 'Loan').LedgerIndex
line(`    LoanSet ${ok(r)}  30 XRP lent to the borrower`)

// ---- value the collateral BEFORE anything goes wrong ----
const xrpl = new Xrpl(WS); await xrpl.connect()
const reader = new Reader([vaultId], xrpl)
await reader.tick()
let snap = reader.get(vaultId)
let escrows = await findShareEscrows(xrpl, shareMptId, [lp.address, lender.address])
const before = presentCollateral(escrows, snap)

step(5, 'The lender values its collateral. Both readings agree.')
line(`    NAV naive ${before.navNaive}   NAV correct ${before.navCorrect}`)
line(`    40 shares -> naive ${(Number(before.totalValueNaive) / 1e6).toFixed(2)} XRP | correct ${(Number(before.totalValueCorrect) / 1e6).toFixed(2)} XRP`)
line(`    overstatement ${before.totalOverstatementPct}%  <- nothing to see yet`)

step(6, 'The borrower misses a payment. The broker impairs the loan.')
const loanNode = (await c.request({ command: 'ledger_entry', index: loanId })).result.node
await waitTo(Number(loanNode.NextPaymentDueDate) + 5, 'loan past due')
r = await c.submitAndWait({ TransactionType: 'LoanManage', Account: owner.address, LoanID: loanId, Flags: 131072 }, { wallet: owner, autofill: true })
line(`    LoanManage tfLoanImpair ${ok(r)}`)
const vaultNode = r.result.meta.AffectedNodes.find((n) => n.ModifiedNode?.LedgerEntryType === 'Vault')?.ModifiedNode
line(`    Vault PreviousFields = ${JSON.stringify(vaultNode?.PreviousFields)}   <-- the warning nobody receives`)
line(`    Vault FinalFields.LossUnrealized = ${vaultNode?.FinalFields?.LossUnrealized}`)

await reader.tick()
snap = reader.get(vaultId)
escrows = await findShareEscrows(xrpl, shareMptId, [lp.address, lender.address])
const after = presentCollateral(escrows, snap)

step(7, 'The same collateral, valued again')
line(`    NAV naive ${after.navNaive}   NAV correct ${after.navCorrect}   (${snap.navDivergenceBps} bps apart)`)
line(`    40 shares -> naive ${(Number(after.totalValueNaive) / 1e6).toFixed(2)} XRP | correct ${(Number(after.totalValueCorrect) / 1e6).toFixed(2)} XRP`)
line(`\n    [31mThe lender is over-collateralised on paper by ${(Number(after.totalOverstatement) / 1e6).toFixed(2)} XRP (${after.totalOverstatementPct}%)[0m`)
line(`    and the ledger event that caused it showed an EMPTY diff.`)

mkdirSync('.demo', { recursive: true })
const stateFile = `.demo/collateral-${Date.now()}.json`
writeFileSync(stateFile, JSON.stringify({
  vaultId, shareMptId, brokerId, loanId, escrowId,
  accounts: { owner: owner.address, lp: lp.address, borrower: borrower.address, lender: lender.address },
  before, after,
}, null, 2))
line(`\n    state -> ${stateFile}`)
line(`    vault  -> https://devnet.xrpl.org/accounts/${vi.Account}`)

await reader.stop(); await c.disconnect()
