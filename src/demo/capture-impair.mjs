/**
 * Capture the finding that Demo 1 is built on, live, during the event.
 *
 * WHY THIS EXISTS. `/api/indexer-race` served `fixtures/indexer-race.json`, and
 * `fixtures/` is gitignored as pre-event reconnaissance. So on the clean clone the
 * judges receive, the single most important demo in the pitch returned 404, and the
 * payload behind it derived from a probe we ran before the event opened and may not
 * submit. Both problems have the same fix: capture it again now, from a vault built
 * during the event, and write it somewhere tracked.
 *
 * THE FINDING. rippled omits from `PreviousFields` any field whose previous value was
 * the type default. `LossUnrealized` on a healthy vault is 0. Under cash-basis
 * accounting (`LEVersion=1`) impairment moves nothing else on the Vault object. So the
 * first impairment of a healthy vault emits `PreviousFields: {}` — an indexer that
 * diffs metadata sees an empty change set and reports nothing, while the fund has just
 * lost a fifth of its value.
 *
 * THE SHAPE, chosen so the numbers on the slide stay exactly what they were:
 *
 *     deposit      51 XRP   -> AssetsTotal 51000000, 51000000 shares, NAV 1.000000
 *     lend         10 XRP   -> AssetsAvailable 41000000 (cash basis: AssetsTotal is untouched)
 *     impair       10 XRP   -> LossUnrealized 10000000
 *     naive NAV    51/51          = 1.000000
 *     correct NAV  (51-10)/51     = 0.803922
 *     divergence                  = 1961 bps
 *
 * Run: node src/demo/capture-impair.mjs
 * Out: demo/indexer-race.json  (TRACKED — this is the point of the exercise)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client, signLoanSetByCounterparty } from 'xrpl'
import { Reader } from '../poll.mjs'
import { Xrpl, normaliseVault } from '../xrpl.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = 'demo/indexer-race.json'

const code = (r) => r.result.meta.TransactionResult
const created = (meta, t) => meta.AffectedNodes.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)
const modified = (meta, t) => meta.AffectedNodes.map((n) => n.ModifiedNode).find((n) => n?.LedgerEntryType === t)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Abort on any non-tesSUCCESS. A half-built vault is worthless: its dates are immutable. */
function must(r, what) {
  const c = code(r)
  if (c !== 'tesSUCCESS') {
    console.error(`\n  ABORT  ${what} -> ${c}`)
    process.exit(1)
  }
  console.log(`    ok    ${what.padEnd(26)} ${r.result.hash.slice(0, 24)}...`)
  return r
}

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const closeTime = async () => Number((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)
const waitTo = async (t, why) => {
  const first = await closeTime()
  if (t > first) console.log(`  waiting ${t - first}s — ${why}`)
  while ((await closeTime()) < t) await sleep(3000)
}

const serverInfo = await c.request({ command: 'server_info' })
const buildVersion = serverInfo.result.info.build_version
console.log(`\n  rippled ${buildVersion} on ${WS}\n`)

console.log('  funding')
const { wallet: owner } = await c.fundWallet()
const { wallet: borrower } = await c.fundWallet()

const now = await closeTime()
const SUB = now + 25
// 900s is generous: the loan must mature strictly before RedemptionDate or LoanSet
// returns tecNO_PERMISSION (finding U1, confirmed twice — see FEEDBACK-APPENDIX.md E).
const RED = SUB + 900

console.log('\n  building the vault')
let r = must(await c.submitAndWait({
  TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' },
  VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, WithdrawalPolicy: 1,
}, { wallet: owner, autofill: true }), 'VaultCreate')
const vaultId = created(r.result.meta, 'Vault').LedgerIndex

// 51 XRP against a 100 XRP faucet grant leaves the owner reserve intact. Depositing the
// whole grant is how we earned two tecINSUFFICIENT_FUNDS earlier in the event.
must(await c.submitAndWait({
  TransactionType: 'VaultDeposit', Account: owner.address, VaultID: vaultId, Amount: '51000000',
}, { wallet: owner, autofill: true }), 'VaultDeposit 51 XRP')

r = must(await c.submitAndWait({
  TransactionType: 'LoanBrokerSet', Account: owner.address, VaultID: vaultId,
  ManagementFeeRate: 1000, DebtMaximum: '45000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000,
}, { wallet: owner, autofill: true }), 'LoanBrokerSet')
const brokerId = created(r.result.meta, 'LoanBroker').LedgerIndex
must(await c.submitAndWait({
  TransactionType: 'LoanBrokerCoverDeposit', Account: owner.address, LoanBrokerID: brokerId, Amount: '5000000',
}, { wallet: owner, autofill: true }), 'CoverDeposit 5 XRP')

await waitTo(SUB + 5, 'Subscription closes, Investment opens')

console.log('\n  originating the loan')
let tx = await c.autofill({
  TransactionType: 'LoanSet', Account: owner.address, LoanBrokerID: brokerId, Counterparty: borrower.address,
  PrincipalRequested: '10000000', InterestRate: 100000, LateInterestRate: 20000,
  PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 60,
})
// Two signatures on one transaction: the counterparty signature is additive, and the
// fee must cover both. signLoanSetByCounterparty takes the WALLET first.
tx.Fee = String(Number(tx.Fee) * 2)
r = must(await c.submitAndWait(signLoanSetByCounterparty(borrower, owner.sign(tx).tx_blob).tx_blob), 'LoanSet 10 XRP')
const loanId = created(r.result.meta, 'Loan').LedgerIndex

// --- the state that makes the finding visible --------------------------------
// Read the vault BEFORE impairment, so the capture proves it was healthy: a reader who
// only sees the after-state cannot tell that PreviousFields was empty because nothing
// changed, or because the previous value was the default.
// Read through the shipped reader, not raw ledger_entry: there is no SharesTotal on a
// Vault (ledger_entries.macro: "no SharesTotal ever, use MPTIssuance.sfOutstandingAmount"),
// and vault_info is where the share count actually comes from.
const x = new Xrpl(WS)
await x.connect()
const readVault = async () => normaliseVault(await x.vaultInfo(vaultId), await closeTime())
const before = await readVault()

const loan = (await c.request({ command: 'ledger_entry', index: loanId })).result.node
await waitTo(Number(loan.NextPaymentDueDate) + Number(loan.GracePeriod) + 8, 'the loan must be past due before it may be impaired')

console.log('\n  impairing')
// tfLoanImpair. Only the LoanBroker owner may do this, and that owner is necessarily
// the vault owner — the party whose loss-absorbing obligation shrinks when they delay.
const impair = must(await c.submitAndWait({
  TransactionType: 'LoanManage', Account: owner.address, LoanID: loanId, Flags: 0x20000,
}, { wallet: owner, autofill: true }), 'LoanManage tfLoanImpair')

const meta = impair.result.meta
const vaultNode = modified(meta, 'Vault')
const loanNode = modified(meta, 'Loan')
const after = await readVault()

// --- the two readings, through the product's own code ------------------------
// Deliberately Reader.nav and not a local formula: if the shipped reader ever stopped
// agreeing with the slide, this capture must fail rather than quietly disagree.
const readings = Reader.nav(after)

const previousFields = vaultNode?.PreviousFields ?? null
const isEmpty = previousFields !== null && Object.keys(previousFields).length === 0

const out = {
  capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  capturedDuring: 'XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026',
  network: 'devnet',
  buildVersion,
  transactionHash: impair.result.hash,
  transactionResult: code(impair),
  finding: 'The first impairment of a previously-healthy vault is invisible to metadata diffing.',
  why: 'LossUnrealized was 0 (the type default) so rippled omits it from PreviousFields. Under cash-basis accounting impairment changes nothing else on the Vault, so PreviousFields is entirely {} while FinalFields carries a non-zero LossUnrealized.',
  vaultId,
  loanBrokerId: brokerId,
  loanId,
  vaultNode: {
    ledgerIndex: vaultId,
    previousFields: previousFields ?? {},
    finalFields: {
      AssetsTotal: after.assetsTotal.toFixed(0),
      AssetsAvailable: after.assetsAvailable.toFixed(0),
      LossUnrealized: after.lossUnrealized.toFixed(0),
    },
    healthyBefore: {
      AssetsTotal: before.assetsTotal.toFixed(0),
      AssetsAvailable: before.assetsAvailable.toFixed(0),
      LossUnrealized: before.lossUnrealized.toFixed(0),
    },
    sharesOutstanding: after.sharesOutstanding.toFixed(0),
  },
  loanNode: {
    ledgerIndex: loanId,
    previousFields: loanNode?.PreviousFields ?? {},
    finalFieldsFlags: loanNode?.FinalFields?.Flags ?? null,
  },
  readings: {
    naive: { formula: 'AssetsTotal / sharesOutstanding', value: readings.navNaive },
    correct: { formula: '(AssetsTotal - LossUnrealized) / sharesOutstanding', value: readings.navCorrect },
    divergenceBps: readings.navDivergenceBps,
  },
  verdict: isEmpty
    ? 'PreviousFields is empty. An indexer diffing metadata sees no change on this vault.'
    : 'PreviousFields is NOT empty on this capture — the finding did not reproduce.',
}

mkdirSync('demo', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')

console.log(`
  PreviousFields      ${JSON.stringify(previousFields)}
  LossUnrealized      ${after.lossUnrealized.toFixed(0)}  (was ${before.lossUnrealized.toFixed(0)})
  shares              ${after.sharesOutstanding.toFixed(0)}
  naive NAV           ${readings.navNaive}
  correct NAV         ${readings.navCorrect}
  divergence          ${readings.navDivergenceBps} bps
  tx                  ${impair.result.hash}

  -> ${OUT}
`)
await x.disconnect()
await c.disconnect()
if (!isEmpty) {
  console.error('  THE FINDING DID NOT REPRODUCE. Do not ship this capture.')
  process.exit(1)
}
