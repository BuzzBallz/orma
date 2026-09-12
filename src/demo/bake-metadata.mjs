/**
 * The self-describing collateral instrument, end to end on Devnet.
 *
 * WHAT THIS PROVES. A second broker is offered vault shares as collateral. They hold an
 * MPT issuance id and nothing else: no relationship with the facility, no access to its
 * reporting, no reason to trust a number anyone hands them. This bakes a facility whose
 * share token carries, in its own metadata, a pointer to an honest valuation, and then
 * runs exactly the loop that broker would run:
 *
 *   1. read the MPTokenIssuance off the ledger
 *   2. decode MPTokenMetadata
 *   3. substitute the token's own id into the pointer template
 *   4. follow it, and value the pledge
 *
 * Nothing in that loop needs us. That is the difference between a dashboard, which you
 * have to already know about, and a primitive, which is reachable from the asset itself.
 *
 * THE FACILITY IS BUILT TO HAVE SOMETHING WORTH SAYING. It takes 51 XRP, lends 10, and
 * impairs it, so the reported unit value is 1.000000 while the held value is 0.803922.
 * A lender who values the pledge naively is 19.61% over. The pointer is what closes that
 * gap, and a pledge with no divergence would prove nothing.
 *
 * Run: node src/demo/bake-metadata.mjs [--base http://localhost:8787] [--label "Name"]
 * Out: demo/metadata-vault.json  (TRACKED)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client, signLoanSetByCounterparty } from 'xrpl'
import { Xrpl } from '../xrpl.mjs'
import { buildShareMetadata, encodeShareMetadata, MPT_PLACEHOLDER } from '../metadata.mjs'
import { resolveFromIssuance, valuePledge } from '../nav.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = 'demo/metadata-vault.json'

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const BASE = arg('base', process.env.PUBLIC_BASE ?? 'http://localhost:8787')
const LABEL = arg('label', 'Calder Structured Credit III')
const TICKER = arg('ticker', 'ORMA-CSC3')
const WINDOW = Number(arg('window', 3600))

const code = (r) => r.result.meta.TransactionResult
const created = (meta, t) => meta.AffectedNodes.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const must = (r, what) => {
  if (code(r) !== 'tesSUCCESS') { console.error(`\n  ABORT ${what} -> ${code(r)}`); process.exit(1) }
  console.log(`    ok    ${what.padEnd(30)} ${r.result.hash.slice(0, 24)}...`)
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
console.log(`\n  rippled ${buildVersion}`)
console.log(`  baking "${LABEL}" with a valuation pointer at ${BASE}\n`)

// --- the metadata, written before the thing it describes exists ---------------
// This is the constraint that shapes the whole design. MPTokenMetadata is only settable
// on VaultCreate, so it is composed before the vault or its share issuance have ids, and
// it can never be corrected afterwards. The pointer is therefore a TEMPLATE carrying the
// substitution the reader will perform with the id they already hold.
const navTemplate = `${BASE.replace(/\/+$/, '')}/api/mpt/${MPT_PLACEHOLDER}/nav`
const meta = buildShareMetadata({
  ticker: TICKER,
  name: LABEL,
  navUrl: navTemplate,
  icon: `${BASE.replace(/\/+$/, '')}/assets/mark.svg`,
  issuerName: 'Orma',
  desc: 'Redeemable claim on a closed-ended private credit facility. Valuation is net of recognised loss.',
})
const blob = encodeShareMetadata(meta)
console.log(`  metadata ${Buffer.byteLength(JSON.stringify(meta), 'utf8')} bytes, ${blob.length / 2} bytes hex`)
console.log(`  pointer  ${navTemplate}\n`)

console.log('  funding')
const { wallet: owner } = await c.fundWallet()
const { wallet: borrower } = await c.fundWallet()

const now = await closeTime()
const SUB = now + 25
const RED = SUB + WINDOW

console.log('\n  building the facility')
let r = await c.submitAndWait({
  TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' },
  VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, WithdrawalPolicy: 1,
  MPTokenMetadata: blob,
}, { wallet: owner, autofill: true })
must(r, 'VaultCreate + metadata')
const vaultId = created(r.result.meta, 'Vault').LedgerIndex

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
const tx = await c.autofill({
  TransactionType: 'LoanSet', Account: owner.address, LoanBrokerID: brokerId, Counterparty: borrower.address,
  PrincipalRequested: '10000000', InterestRate: 100000, LateInterestRate: 20000,
  PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 60,
})
tx.Fee = String(Number(tx.Fee) * 2)
r = must(await c.submitAndWait(signLoanSetByCounterparty(borrower, owner.sign(tx).tx_blob).tx_blob), 'LoanSet 10 XRP')
const loanId = created(r.result.meta, 'Loan').LedgerIndex

const ln = (await c.request({ command: 'ledger_entry', index: loanId })).result.node
await waitTo(Number(ln.NextPaymentDueDate) + Number(ln.GracePeriod) + 8, 'the loan must be past due before it may be impaired')

console.log('\n  impairing, so the pointer has something worth saying')
const impair = must(await c.submitAndWait({
  TransactionType: 'LoanManage', Account: owner.address, LoanID: loanId, Flags: 0x20000,
}, { wallet: owner, autofill: true }), 'LoanManage tfLoanImpair')

// --- the loop a second broker runs -------------------------------------------
const x = new Xrpl(WS)
await x.connect()
const vault = await x.vaultInfo(vaultId)
const issuanceId = vault.shares?.mpt_issuance_id
console.log(`\n  share issuance ${issuanceId}`)
console.log('\n  RESOLVING FROM THE TOKEN ALONE')

const resolved = await resolveFromIssuance(x, issuanceId, {})
for (const s of resolved.steps) {
  console.log(`    ${s.ok ? 'ok  ' : 'FAIL'} ${s.step.padEnd(26)} ${String(s.detail ?? '').slice(0, 74)}`)
}

let pledge = null
if (resolved.nav) {
  // What a lender would actually compute: 1,000,000 units offered as collateral.
  pledge = valuePledge(resolved.nav, '1000000')
  const over = (Number(pledge.overstatement) / 1e6).toFixed(6)
  console.log(`\n  A PLEDGE OF 1,000,000 UNITS`)
  console.log(`    on the reported figure   ${(Number(pledge.valueReported) / 1e6).toFixed(6)} XRP`)
  console.log(`    on the honest figure     ${(Number(pledge.valueHeld) / 1e6).toFixed(6)} XRP`)
  console.log(`    a naive lender is over by ${over} XRP`)
}

const out = {
  bakedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  bakedDuring: 'XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026',
  network: 'devnet',
  buildVersion,
  label: LABEL,
  ticker: TICKER,
  vaultId,
  loanBrokerId: brokerId,
  loanId,
  shareMptId: issuanceId,
  owner: owner.address,
  impairHash: impair.result.hash,
  metadata: meta,
  metadataHex: blob,
  navTemplate,
  resolution: { steps: resolved.steps, resolved: resolved.resolved, navUrl: resolved.navUrl ?? null },
  pledgeExample: pledge,
}
mkdirSync('demo', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(`\n  vault ${vaultId}`)
console.log(`  -> ${OUT}\n`)

await x.disconnect()
await c.disconnect()

// The bake is only useful if the whole loop closes. Fail loudly rather than leave a
// facility that looks right and resolves to nothing.
if (!resolved.resolved) {
  console.error('  THE POINTER WAS NOT READABLE. Metadata or template is wrong.')
  process.exit(1)
}
if (!resolved.nav) {
  // Expected on a first run and not a failure: the service reads the facilities in
  // demo/ at startup, and this one was written seconds ago. The ledger side of the loop
  // -- the part that had to be proven -- is already closed above.
  console.log('  The pointer resolves but the service does not serve this facility YET.')
  console.log('  Restart it so it picks up demo/, then:')
  console.log(`    curl ${BASE}/api/mpt/${issuanceId}/resolve
`)
}
