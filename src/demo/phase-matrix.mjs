/**
 * Phase-rejection matrix for a closed-ended vault.
 *
 * Track 2's minimum bar asks for rejected VaultDeposit, VaultWithdraw and LoanSet at
 * the wrong phase. This walks one vault through Subscription, Investment and
 * Redemption and attempts all three in each, so every rejection sits next to a
 * CONTROL that succeeds in the phase where it is legal. Without the controls a
 * rejection proves nothing: it could be a malformed transaction or a funding problem.
 *
 * It also captures the open-vs-closed mismatch, which is the case an XRPL product
 * lead described as the one that should return a clear permission error rather than
 * something confusing.
 *
 * Output: .demo/phase-matrix-<ts>.json plus a markdown table for the report.
 * Run:    node src/demo/phase-matrix.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client, signLoanSetByCounterparty } from 'xrpl'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()

const closeTime = async () => Number((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitTo = async (t, label) => {
  while ((await closeTime()) < t) await sleep(3000)
  console.log(`\n  == ${label} ==`)
}
const created = (meta, t) => meta.AffectedNodes.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)

const results = []
/** Attempt a transaction and record the outcome, whatever it is. */
async function attempt({ phase, label, expect, tx, wallet, blob }) {
  let code, hash = null, note = ''
  try {
    const r = blob ? await c.submitAndWait(blob) : await c.submitAndWait(tx, { wallet, autofill: true })
    code = r.result.meta.TransactionResult
    hash = r.result.hash
  } catch (e) {
    // Rejected before it reached a ledger: still a real outcome, but there is no hash.
    code = (e?.data?.error_exception ?? e?.data?.error ?? String(e)).slice(0, 90)
    note = 'rejected locally, never reached a ledger'
  }
  const isControl = expect === 'tesSUCCESS'
  const pass = isControl ? code === 'tesSUCCESS' : code !== 'tesSUCCESS'
  results.push({ phase, label, expected: expect, got: code, hash, control: isControl, pass, note })
  const mark = pass ? (isControl ? 'ok  ' : 'REJ ') : 'XX  '
  console.log(`    ${mark} ${label.padEnd(34)} ${code}${hash ? '  ' + hash.slice(0, 16) + '...' : ''}`)
  return code
}

console.log('  funding...')
const { wallet: owner } = await c.fundWallet()
const { wallet: lp } = await c.fundWallet()
const { wallet: borrower } = await c.fundWallet()

// ---------------------------------------------------------------------------
// A. open vs closed: a LoanBroker may only attach to a closed-ended vault
// ---------------------------------------------------------------------------
console.log('\n  == OPEN-ENDED VAULT (no phases at all) ==')
let r = await c.submitAndWait({ TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' }, WithdrawalPolicy: 1 }, { wallet: owner, autofill: true })
const openVault = created(r.result.meta, 'Vault').LedgerIndex
await attempt({ phase: 'OpenEnded', label: 'VaultDeposit (control)', expect: 'tesSUCCESS', wallet: owner, tx: { TransactionType: 'VaultDeposit', Account: owner.address, VaultID: openVault, Amount: '10000000' } })
await attempt({ phase: 'OpenEnded', label: 'VaultWithdraw (control)', expect: 'tesSUCCESS', wallet: owner, tx: { TransactionType: 'VaultWithdraw', Account: owner.address, VaultID: openVault, Amount: '1000000' } })
await attempt({
  phase: 'OpenEnded', label: 'LoanBrokerSet on an OPEN vault', expect: 'reject', wallet: owner,
  tx: { TransactionType: 'LoanBrokerSet', Account: owner.address, VaultID: openVault, ManagementFeeRate: 1000, DebtMaximum: '5000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000 },
})

// ---------------------------------------------------------------------------
// B. the closed-ended lifecycle
// ---------------------------------------------------------------------------
const now = await closeTime()
const SUB = now + 45
const RED = SUB + 190
r = await c.submitAndWait({
  TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' },
  VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, WithdrawalPolicy: 1,
}, { wallet: owner, autofill: true })
const vaultId = created(r.result.meta, 'Vault').LedgerIndex
console.log(`\n  closed-ended vault ${vaultId.slice(0, 20)}...  sub=+45s  red=+235s`)

console.log('\n  == SUBSCRIPTION PHASE ==')
await attempt({ phase: 'Subscription', label: 'VaultDeposit (control)', expect: 'tesSUCCESS', wallet: lp, tx: { TransactionType: 'VaultDeposit', Account: lp.address, VaultID: vaultId, Amount: '50000000' } })
await attempt({ phase: 'Subscription', label: 'VaultWithdraw (control)', expect: 'tesSUCCESS', wallet: lp, tx: { TransactionType: 'VaultWithdraw', Account: lp.address, VaultID: vaultId, Amount: '1000000' } })
r = await c.submitAndWait({
  TransactionType: 'LoanBrokerSet', Account: owner.address, VaultID: vaultId,
  ManagementFeeRate: 1000, DebtMaximum: '40000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000,
}, { wallet: owner, autofill: true })
const brokerId = created(r.result.meta, 'LoanBroker').LedgerIndex
await c.submitAndWait({ TransactionType: 'LoanBrokerCoverDeposit', Account: owner.address, LoanBrokerID: brokerId, Amount: '5000000' }, { wallet: owner, autofill: true })

const loanSet = async (phase, expect) => {
  try {
    let tx = await c.autofill({
      TransactionType: 'LoanSet', Account: owner.address, LoanBrokerID: brokerId, Counterparty: borrower.address,
      PrincipalRequested: '10000000', InterestRate: 100000, LateInterestRate: 20000,
      PaymentInterval: 60, PaymentTotal: 2, GracePeriod: 60,
    })
    tx.Fee = String(Number(tx.Fee) * 2)
    const blob = signLoanSetByCounterparty(borrower, owner.sign(tx).tx_blob).tx_blob
    return await attempt({ phase, label: 'LoanSet', expect, blob })
  } catch (e) {
    results.push({ phase, label: 'LoanSet', expected: expect, got: String(e?.data?.error_exception ?? e).slice(0, 90), hash: null, control: expect === 'tesSUCCESS', pass: expect !== 'tesSUCCESS', note: 'rejected locally' })
    console.log(`    REJ  ${'LoanSet'.padEnd(34)} ${String(e?.data?.error_exception ?? e).slice(0, 60)}`)
  }
}
await loanSet('Subscription', 'reject')

await waitTo(SUB + 6, 'INVESTMENT PHASE')
await attempt({ phase: 'Investment', label: 'VaultDeposit at wrong phase', expect: 'reject', wallet: lp, tx: { TransactionType: 'VaultDeposit', Account: lp.address, VaultID: vaultId, Amount: '1000000' } })
await attempt({ phase: 'Investment', label: 'VaultWithdraw at wrong phase', expect: 'reject', wallet: lp, tx: { TransactionType: 'VaultWithdraw', Account: lp.address, VaultID: vaultId, Amount: '1000000' } })
await loanSet('Investment', 'tesSUCCESS')

await waitTo(RED + 6, 'REDEMPTION PHASE')
await attempt({ phase: 'Redemption', label: 'VaultDeposit at wrong phase', expect: 'reject', wallet: lp, tx: { TransactionType: 'VaultDeposit', Account: lp.address, VaultID: vaultId, Amount: '1000000' } })
await attempt({ phase: 'Redemption', label: 'VaultWithdraw (control)', expect: 'tesSUCCESS', wallet: lp, tx: { TransactionType: 'VaultWithdraw', Account: lp.address, VaultID: vaultId, Amount: '1000000' } })
await loanSet('Redemption', 'reject')

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
mkdirSync('.demo', { recursive: true })
const ts = Date.now()
writeFileSync(`.demo/phase-matrix-${ts}.json`, JSON.stringify({ vaultId, openVault, brokerId, results }, null, 2))

const md = [
  '| phase | transaction | expected | result | hash |',
  '|---|---|---|---|---|',
  ...results.map((x) => `| ${x.phase} | ${x.label} | ${x.control ? 'succeed' : 'reject'} | \`${x.got}\` | ${x.hash ? '`' + x.hash.slice(0, 24) + '...`' : x.note || '-'} |`),
].join('\n')
writeFileSync(`.demo/phase-matrix-${ts}.md`, md)

const failures = results.filter((x) => !x.pass)
console.log(`\n  ${results.length} attempts, ${results.filter((x) => x.pass).length} behaved as expected, ${failures.length} did not`)
for (const f of failures) console.log(`    UNEXPECTED  ${f.phase}/${f.label}: expected ${f.expected}, got ${f.got}`)
const distinct = [...new Set(results.filter((x) => !x.control && x.pass).map((x) => x.got))]
console.log(`  distinct rejection codes observed: ${distinct.join(', ')}`)
console.log(`  -> .demo/phase-matrix-${ts}.json and .md`)
await c.disconnect()
