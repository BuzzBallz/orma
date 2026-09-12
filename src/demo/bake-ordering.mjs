/**
 * Bake the facility that Exhibit 3 and Slide 7 are built on.
 *
 * THE FINDING. First-loss cover consumed on a default is
 *
 *     min( ceil(LoanBroker.DebtTotal x CoverRateMinimum/1e5 x CoverRateLiquidation/1e5),
 *          DefaultAmount, CoverAvailable )
 *
 * keyed to the broker's TOTAL outstanding book at that instant, not to the principal of
 * the loan that defaulted. DebtTotal is decremented as each default lands, so every
 * default shrinks the base for the next one, and the TOTAL cover consumed across a
 * fixed set of defaults depends on the ORDER they are declared in.
 *
 * Only the LoanBroker owner may declare a default, and that owner is necessarily the
 * vault owner. So the party whose capital absorbs the loss also chooses the sequence
 * that decides how much of it is absorbed. The remainder lands on the depositors.
 *
 * THE SHAPE, chosen so the numbers on the slide are exact. Two loans, 30 and 10 XRP,
 * CoverRateMinimum 10% and CoverRateLiquidation 10%, so c = 0.01:
 *
 *   declared BIG first (what this bakes -- the self-serving order)
 *     default 30 at DebtTotal 40  -> ceil(40 x 0.01) = 0.40
 *     default 10 at DebtTotal 10  -> ceil(10 x 0.01) = 0.10   TOTAL 0.50
 *
 *   declared SMALL first (the order best for depositors)
 *     default 10 at DebtTotal 40  -> ceil(40 x 0.01) = 0.40
 *     default 30 at DebtTotal 30  -> ceil(30 x 0.01) = 0.30   TOTAL 0.70
 *
 * Same losses, same rates. 0.20 XRP of difference, a 40% swing in what the first-loss
 * capital actually absorbed, and it is depositor money.
 *
 * No impairment is declared first, deliberately: this facility is the badly-run one.
 * The manager neither warned anyone nor sequenced the losses in the depositors' favour,
 * which is what earns the E. The honestly-managed comparison is the vault baked by
 * capture-impair.mjs, where the loss was flagged before it was taken.
 *
 * Run: node src/demo/bake-ordering.mjs [--window 3600] [--label "Name"]
 * Out: demo/ordering-vault.json  (TRACKED -- the demo must survive a clean clone)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client, signLoanSetByCounterparty } from 'xrpl'
import { Xrpl, normaliseBroker } from '../xrpl.mjs'
import { fetchBrokerHistory, analyseOrdering, reputation } from '../history.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = 'demo/ordering-vault.json'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
// The redemption window only has to outlast the loan schedule (3 x 60s + grace). It is
// generous by default so the facility stays in its Investment phase long enough to be
// shown, rehearsed against, and shown again.
const WINDOW = Number(arg('window', 3600))
const LABEL = arg('label', 'Kestrel Bridge Financing II')

const code = (r) => r.result.meta.TransactionResult
const created = (meta, t) => meta.AffectedNodes.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const xrp = (drops) => (Number(drops) / 1e6).toFixed(2)

/** A closed-ended vault's dates are immutable, so a half-baked vault is unrecoverable. */
function must(r, what) {
  const c = code(r)
  if (c !== 'tesSUCCESS') {
    console.error(`\n  ABORT  ${what} -> ${c}`)
    process.exit(1)
  }
  console.log(`    ok    ${what.padEnd(28)} ${r.result.hash.slice(0, 24)}...`)
  return r
}

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const closeTime = async () => Number((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)
const waitTo = async (t, why) => {
  const now = await closeTime()
  if (t > now) console.log(`  waiting ${t - now}s — ${why}`)
  while ((await closeTime()) < t) await sleep(3000)
}

const buildVersion = (await c.request({ command: 'server_info' })).result.info.build_version
console.log(`\n  rippled ${buildVersion} on ${WS}`)
console.log(`  baking "${LABEL}", redemption window ${WINDOW}s\n`)

console.log('  funding')
const { wallet: owner } = await c.fundWallet()
const { wallet: borrowerBig } = await c.fundWallet()
const { wallet: borrowerSmall } = await c.fundWallet()

const now = await closeTime()
const SUB = now + 25
const RED = SUB + WINDOW

console.log('\n  building the facility')
let r = must(await c.submitAndWait({
  TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' },
  VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, WithdrawalPolicy: 1,
}, { wallet: owner, autofill: true }), 'VaultCreate')
const vaultId = created(r.result.meta, 'Vault').LedgerIndex

must(await c.submitAndWait({
  TransactionType: 'VaultDeposit', Account: owner.address, VaultID: vaultId, Amount: '50000000',
}, { wallet: owner, autofill: true }), 'VaultDeposit 50 XRP')

r = must(await c.submitAndWait({
  TransactionType: 'LoanBrokerSet', Account: owner.address, VaultID: vaultId,
  ManagementFeeRate: 1000, DebtMaximum: '45000000',
  // Both rates are in 1e-5 units, so BOTH are divided by 1e5. 10000 is 10%, not 10000%.
  // This is finding U3: the only written-down source is a constant inside node_modules.
  CoverRateMinimum: 10000, CoverRateLiquidation: 10000,
}, { wallet: owner, autofill: true }), 'LoanBrokerSet')
const brokerId = created(r.result.meta, 'LoanBroker').LedgerIndex

must(await c.submitAndWait({
  TransactionType: 'LoanBrokerCoverDeposit', Account: owner.address, LoanBrokerID: brokerId, Amount: '10000000',
}, { wallet: owner, autofill: true }), 'CoverDeposit 10 XRP')

await waitTo(SUB + 5, 'Subscription closes, Investment opens')

console.log('\n  originating two unequal loans')
const mkLoan = async (bw, principal, label) => {
  const tx = await c.autofill({
    TransactionType: 'LoanSet', Account: owner.address, LoanBrokerID: brokerId, Counterparty: bw.address,
    PrincipalRequested: String(principal), InterestRate: 100000, LateInterestRate: 20000,
    PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 60,
  })
  // Two signatures on one transaction, so the fee must cover both. The helper takes the
  // WALLET first, and the transaction must already be signed by the first party.
  tx.Fee = String(Number(tx.Fee) * 2)
  const res = must(await c.submitAndWait(signLoanSetByCounterparty(bw, owner.sign(tx).tx_blob).tx_blob), label)
  return created(res.result.meta, 'Loan').LedgerIndex
}
const bigLoan = await mkLoan(borrowerBig, 30000000, 'LoanSet 30 XRP')
const smallLoan = await mkLoan(borrowerSmall, 10000000, 'LoanSet 10 XRP')

const ln = (await c.request({ command: 'ledger_entry', index: bigLoan })).result.node
await waitTo(Number(ln.NextPaymentDueDate) + Number(ln.GracePeriod) + 8, 'both loans must be past due')

console.log('\n  declaring the losses BIG FIRST (the sequence that costs the manager least)')
const declared = []
for (const [label, id] of [['30 XRP', bigLoan], ['10 XRP', smallLoan]]) {
  // tfLoanDefault. No impairment first: this manager warned nobody.
  const d = must(await c.submitAndWait({
    TransactionType: 'LoanManage', Account: owner.address, LoanID: id, Flags: 0x10000,
  }, { wallet: owner, autofill: true }), `default ${label}`)
  declared.push({ label, loanId: id, hash: d.result.hash })
}

// --- prove it, through the product's own code --------------------------------
// Reconstructed from public ledger history alone. Nothing here needed privileged access.
const x = new Xrpl(WS)
await x.connect()
const brokerNode = (await c.request({ command: 'ledger_entry', index: brokerId })).result.node
const broker = normaliseBroker({ ...brokerNode, index: brokerId })
const events = await fetchBrokerHistory(x, owner.address, brokerId)
const ordering = analyseOrdering(events, broker)
const rep = reputation(events, ordering, broker)

console.log('\n  ORDERING, reconstructed from the ledger')
if (!ordering.applicable) {
  console.error(`    NOT APPLICABLE: ${ordering.reason}`)
} else {
  console.log(`    cover actually consumed  ${xrp(ordering.actualCoverPaid)} XRP`)
  console.log(`    best for depositors      ${xrp(ordering.bestPossible)} XRP   (smallest first)`)
  console.log(`    worst for depositors     ${xrp(ordering.worstPossible)} XRP   (largest first)`)
  console.log(`    cost of the sequence     ${xrp(ordering.costToDepositors)} XRP`)
  console.log(`    sequence score           ${ordering.fairness}`)
}
console.log(`\n  CONDUCT  ${rep.grade} (${rep.score}/100)`)
for (const f of rep.findings) console.log(`    [${f.code}]`)

const out = {
  bakedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  bakedDuring: 'XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026',
  network: 'devnet',
  buildVersion,
  label: LABEL,
  vaultId,
  loanBrokerId: brokerId,
  owner: owner.address,
  subscriptionDate: SUB,
  redemptionDate: RED,
  loans: { big: bigLoan, small: smallLoan },
  declaredOrder: declared,
  expected: { actualCoverPaid: '500000', bestPossible: '700000', worstPossible: '500000', fairness: '0.0000' },
  observed: ordering,
  conduct: { grade: rep.grade, score: rep.score, findings: rep.findings.map((f) => f.code) },
}
mkdirSync('demo', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')

console.log(`\n  vault  ${vaultId}`)
console.log(`  -> ${OUT}`)
console.log(`\n  serve it:\n    node src/index.mjs --vault ${vaultId}:"${LABEL}"\n`)

await x.disconnect()
await c.disconnect()

// The bake is only useful if it reproduces the slide. Fail loudly rather than leave a
// facility that quietly says something else.
const ok = ordering.applicable
  && ordering.actualCoverPaid === '500000'
  && ordering.bestPossible === '700000'
if (!ok) {
  console.error('  THE BAKE DID NOT REPRODUCE THE SLIDE NUMBERS. Do not demo this vault.')
  process.exit(1)
}
