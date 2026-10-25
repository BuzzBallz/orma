/**
 * Bake the New York demo: three Harbor vaults whose L1 is impaired and declared by their manager, the
 * desk and spare vaults Orma Desk lends from, the 2-of-3 collateral accounts the pledges go to, a chain
 * test that proves the seams on Devnet, and the risk officer's mandate, calibrated and anchored.
 *
 * ONCE. Closed-ended vault dates and share metadata are immutable: a vault baked wrong is replaced by a
 * new bake, never repaired. So the pointer base is checked first (https, public, served by Orma), and
 * every step that the rest of the event depends on is re-read on the ledger; the bake stops (exit 1) on
 * the first one that does not hold, before writing demo/.
 *
 * Seeds go to .demo/roles.json and nowhere else. The collateral accounts' generated seeds are written
 * nowhere: two of their three signers could turn the master key back on, and a kept seed would then
 * sign alone. The Harbor debtor's seed is written nowhere either: nothing repays a demo loan (I5).
 *
 * Run:  node --env-file-if-exists=.env src/demo/bake-nyc.mjs [--dry-run] [--public-base <url>]
 * Exit: 0 baked (or, with --dry-run, preflight passed), 2 preflight refused, 64 bad usage, 1 any other
 *       failure. A script that opened a socket sets process.exitCode and lets the process end. --dry-run
 *       judges the pointer base only: it names each output already in demo/, which the real run refuses.
 * Out:  demo/{harbor-1,harbor-2,harbor-3,desk,spare,mandate-desk-1}.json (committed),
 *       .demo/roles.json and .demo/bake-nyc-receipt.json (never committed)
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { Wallet, decode, hashes, multisign, signLoanSetByCounterparty } from 'xrpl'
import { Xrpl } from '../xrpl.mjs'
import { Reader } from '../poll.mjs'
import { num, Decimal, wholeShares } from '../num.mjs'
import { coverForOrder } from '../history.mjs'
import { buildShareMetadata, encodeShareMetadata, MPT_PLACEHOLDER, permanentBaseProblem } from '../metadata.mjs'
import {
  encodeStatement, parseStatement, statementConsistency, mandateHash, COLLATERAL_STAGES,
  judgeCollateralAccount, judgeCollateralShare,
} from '../nyc/contracts.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = {
  'harbor-1': 'demo/harbor-1.json', 'harbor-2': 'demo/harbor-2.json', 'harbor-3': 'demo/harbor-3.json',
  desk: 'demo/desk.json', spare: 'demo/spare.json', mandate: 'demo/mandate-desk-1.json',
}
const ROLES_FILE = '.demo/roles.json'
const RECEIPT = '.demo/bake-nyc-receipt.json'
const ROLES = ['holder', 'borrower', 'broker', 'riskOfficer', 'deskOwner', 'buyer', 'agent']
const HARBORS = ['harbor-1', 'harbor-2', 'harbor-3']

// --- dates, in Ripple seconds --------------------------------------------------------------------------
/** Tue 10 Nov 2026 04:00 UTC: every Harbor stays in Investment (capital locked) through the event. */
const HARBOR_REDEMPTION = 847598400
/** Tue 27 Oct 2026 00:00 ET: desk and spare outlive the last demo loan by a day. */
const DESK_REDEMPTION = 846388800
/** Sun 25 Oct 17:00 ET, the latest a desk LoanSet may be validated (the last slot's preparation). */
const LATEST_DESK_LOANSET = 846277200
const LOAN_REDEMPTION_BUFFER = 60
/** The desk loan's terms, which plannedLoan carries and every desk LoanSet repeats (PaymentTotal 1). */
const DESK_LOAN = { paymentInterval: 86400, gracePeriod: 3600 }
const SUBSCRIPTION_SECONDS = 420 // the deposits land well inside it; the collateral accounts fill the wait

// --- amounts, in drops ---------------------------------------------------------------------------------
const BORROWER_DEPOSIT = num('30000000') // D shares in each Harbor (Scale 0: one share a drop)
const HOLDER_DEPOSIT = num('20000000')
const RATE = 10000 // CoverRateMinimum and CoverRateLiquidation, in 1e-5 units: 10 %
const COLLATERAL_FUNDING = '2000000' // reserve 1.4 XRP (base, signer list, MPToken) plus fees
const POOL = { 'harbor-1': 6, 'harbor-2': 5, 'harbor-3': 5 }

const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const created = (meta, type) => (meta?.AffectedNodes ?? []).map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === type)
const modified = (meta, type) => (meta?.AffectedNodes ?? []).map((n) => n.ModifiedNode).find((n) => n?.LedgerEntryType === type)
const drops = (d) => new Decimal(d).toFixed(0)
const ceil = (d) => new Decimal(d).ceil()

class BakeError extends Error {}
class UsageError extends Error {}

const argv = process.argv.slice(2)
const opts = { dryRun: false, base: process.env.PUBLIC_BASE ?? null }

let c = null
let x = null
let started = false // the receipt is written only by a run that got past the guards
let lastSubmitted = 0 // the ledger of the last transaction validated on c: reads on x never go below it
const receipt = { bakedAt: null, network: 'devnet', ws: WS, buildVersion: null, publicBase: null, roles: {}, harborDebtor: null, impairments: {}, statements: {}, collateral: {}, chainTest: {}, steps: [] }

process.exitCode = await main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(`  usage: node src/demo/bake-nyc.mjs [--dry-run] [--public-base <url>]\n  ${e.message}`)
    return 64
  }
  console.error(`\n  ABORT  ${e instanceof BakeError ? e.message : String(e?.stack ?? e).slice(0, 600)}`)
  saveReceipt()
  return 1
}).finally(async () => {
  try { await x?.disconnect() } catch { /* already gone */ }
})

async function main() {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true
    else if (argv[i] === '--public-base') {
      opts.base = argv[++i]
      if (!opts.base || opts.base.startsWith('--')) throw new UsageError('--public-base takes a URL')
    } else throw new UsageError(`unknown argument ${JSON.stringify(argv[i])}`)
  }
  if (!opts.base) throw new UsageError('no pointer base: set PUBLIC_BASE or pass --public-base')
  const base = opts.base.replace(/\/+$/, '')

  // --- preflight: the pointer is engraved for ever ------------------------------------------------------
  console.log(`\n  preflight  ${base}/v/<48 zeros>/nav`)
  const problem = await permanentBaseProblem(base)
  if (problem) {
    console.error(`  REFUSED  ${problem}`)
    return 2
  }
  console.log('    ok    https, public, served by Orma')
  if (DESK_REDEMPTION < LATEST_DESK_LOANSET + DESK_LOAN.paymentInterval * 1 + LOAN_REDEMPTION_BUFFER) {
    throw new BakeError(`desk and spare RedemptionDate ${DESK_REDEMPTION} is under ${LATEST_DESK_LOANSET} + ${DESK_LOAN.paymentInterval} + ${LOAN_REDEMPTION_BUFFER}: the last demo LoanSet would be refused`)
  }
  const existing = Object.values(OUT).filter((f) => existsSync(f))
  if (opts.dryRun) {
    // The dry run stays a pointer-base check (exit 0), but never reads as a go for a bake that would refuse.
    for (const f of existing) console.log(`    note  ${f} already exists: a real run refuses, the NYC bake runs once`)
    return 0
  }

  if (existing.length) throw new BakeError(`${existing[0]} already exists: the NYC bake runs once, and its outputs are never overwritten`)
  receipt.publicBase = base
  mkdirSync('.demo', { recursive: true })
  // A run that died earlier left its seeds and receipt: keep them aside, its accounts still exist.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const f of [ROLES_FILE, RECEIPT]) {
    if (existsSync(f)) {
      renameSync(f, `${f}.${stamp}.bak`)
      console.log(`  kept the previous run's ${f} as ${f}.${stamp}.bak`)
    }
  }
  started = true

  // One connection for reads and writes, whose reads ride out a dropped socket (Devnet closes one with
  // 1006 now and then, and reconnecting too soon fails with "Websocket connection never cleaned up").
  x = new Xrpl(WS)
  await x.connect()
  c = x.client
  const pinnedReq = x.req.bind(x)
  x.req = async (payload) => {
    for (let i = 0; ; i++) {
      try {
        return await pinnedReq(payload)
      } catch (e) {
        const code = e?.data?.error
        if (['entryNotFound', 'objectNotFound', 'actNotFound', 'txnNotFound'].includes(code) || i >= 7) throw e
        await pause(e, payload.command, i)
      }
    }
  }
  receipt.buildVersion = x.buildVersion
  console.log(`\n  rippled ${x.buildVersion} on ${WS}`)

  // --- 1. role accounts ---------------------------------------------------------------------------------
  console.log('\n  1. role accounts')
  const w = Object.fromEntries(ROLES.map((r) => [r, Wallet.generate()]))
  const debtor = Wallet.generate() // signs the six Harbor LoanSets and nothing else; its seed is kept nowhere
  // Seeds first, before any funding: a bake that dies later must not lose the accounts it paid for.
  writeFileSync(ROLES_FILE, JSON.stringify({ accounts: Object.fromEntries(ROLES.map((r) => [r, { address: w[r].address, seed: w[r].seed }])) }, null, 2) + '\n')
  receipt.roles = Object.fromEntries(ROLES.map((r) => [r, w[r].address]))
  receipt.harborDebtor = debtor.address
  const need = { holder: 130, borrower: 110, broker: 40, deskOwner: 60, riskOfficer: 10, buyer: 10, agent: 10 }
  for (const r of ROLES) await fundTo(w[r], need[r], r)
  await fundTo(debtor, 10, 'debtor')
  console.log(`    ${ROLES.map((r) => `${r} ${w[r].address}`).join('\n    ')}\n    debtor ${debtor.address}`)
  saveReceipt()

  // --- 2. the three Harbors, and 3. desk and spare: created together, subscriptions closing together ------
  console.log('\n  2-3. vaults')
  const t0 = await x.closeTime()
  const SUB = t0 + SUBSCRIPTION_SECONDS
  const vaults = {}
  const meta = (ticker, name) => buildShareMetadata({
    ticker, name, navUrl: `${base}/v/${MPT_PLACEHOLDER}/nav`,
    desc: 'Redeemable claim on a closed-ended private credit facility (fictional). Valuation is net of recognised loss.',
  })
  const specs = [
    ['harbor-1', w.broker, 'ORMA-HBR1', 'Harbor Private Credit I (fictional)', HARBOR_REDEMPTION],
    ['harbor-2', w.broker, 'ORMA-HBR2', 'Harbor Private Credit II (fictional)', HARBOR_REDEMPTION],
    ['harbor-3', w.broker, 'ORMA-HBR3', 'Harbor Private Credit III (fictional)', HARBOR_REDEMPTION],
    ['desk', w.deskOwner, 'ORMA-DESK', 'Harbor Credit Desk lending pool (fictional)', DESK_REDEMPTION],
    ['spare', w.deskOwner, 'ORMA-SPARE', 'Harbor Credit Desk spare pool (fictional)', DESK_REDEMPTION],
  ]
  for (const [label, owner, ticker, name, red] of specs) {
    const blob = encodeShareMetadata(meta(ticker, name))
    const r = await submit({
      TransactionType: 'VaultCreate', Account: owner.address, Asset: { currency: 'XRP' },
      VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: red, WithdrawalPolicy: 1, MPTokenMetadata: blob,
    }, owner, `VaultCreate ${label}`)
    const vaultId = created(r.result.meta, 'Vault').LedgerIndex
    const info = await x.vaultInfo(vaultId, await atLedger(r.result.ledger_index))
    const shareMptId = info.ShareMPTID ?? info.shares?.mpt_issuance_id
    const debtMax = label.startsWith('harbor') ? drops(HOLDER_DEPOSIT.plus(BORROWER_DEPOSIT)) : drops(principalCap().times(6))
    const b = await submit({
      TransactionType: 'LoanBrokerSet', Account: owner.address, VaultID: vaultId,
      ManagementFeeRate: 1000, DebtMaximum: debtMax, CoverRateMinimum: RATE, CoverRateLiquidation: RATE,
    }, owner, `LoanBrokerSet ${label}`)
    vaults[label] = { label, owner, vaultId, shareMptId, loanBrokerId: created(b.result.meta, 'LoanBroker').LedgerIndex, subscriptionDate: SUB, redemptionDate: red, ticker, name }
  }

  // Deposits, during the subscription. One share a drop at Scale 0, so D = BORROWER_DEPOSIT shares.
  for (const label of HARBORS) {
    await submit({ TransactionType: 'VaultDeposit', Account: w.holder.address, VaultID: vaults[label].vaultId, Amount: drops(HOLDER_DEPOSIT) }, w.holder, `holder deposits in ${label}`)
    await submit({ TransactionType: 'VaultDeposit', Account: w.borrower.address, VaultID: vaults[label].vaultId, Amount: drops(BORROWER_DEPOSIT) }, w.borrower, `borrower deposits in ${label}`)
  }
  const cap = principalCap()
  for (const label of ['desk', 'spare']) {
    await submit({ TransactionType: 'VaultDeposit', Account: w.holder.address, VaultID: vaults[label].vaultId, Amount: drops(cap.times(3)) }, w.holder, `holder deposits 3 × principalCap in ${label}`)
    // N = 3 loans of principalCap each; x2 for the interest the protocol's debt counts beside principal
    const cover = ceil(cap.times(3).times(RATE).div(1e5)).times(2)
    await submit({ TransactionType: 'LoanBrokerCoverDeposit', Account: w.deskOwner.address, LoanBrokerID: vaults[label].loanBrokerId, Amount: drops(cover) }, w.deskOwner, `cover deposit ${label}`)
  }
  // Harbor loans: L1 about 20 % of AssetsTotal, L2 about 10 %, covered twice over before their LoanSets.
  const harborAssets = HOLDER_DEPOSIT.plus(BORROWER_DEPOSIT)
  const L1 = harborAssets.times('0.2').floor()
  const L2 = harborAssets.times('0.1').floor()
  for (const label of HARBORS) {
    const cover = ceil(L1.plus(L2).times(RATE).div(1e5)).times(2)
    await submit({ TransactionType: 'LoanBrokerCoverDeposit', Account: w.broker.address, LoanBrokerID: vaults[label].loanBrokerId, Amount: drops(cover) }, w.broker, `cover deposit ${label}`)
  }
  // The desk receives a released pledge: without its MPToken the transfer is tecNO_AUTH.
  for (const label of HARBORS) {
    await submit({ TransactionType: 'MPTokenAuthorize', Account: w.deskOwner.address, MPTokenIssuanceID: vaults[label].shareMptId }, w.deskOwner, `desk MPToken on ${label}`, ['tesSUCCESS', 'tecDUPLICATE'])
  }

  // Re-read every deposit: spare exactly 3 × principalCap bounds the OTC leg; desk at least that. The
  // borrower holds D share units in each Harbor, the same D for the three, and u = floor(D / 6).
  let D
  {
    const L = await fresh()
    const held = await Promise.all(HARBORS.map((label) => mptBalance(w.borrower.address, vaults[label].shareMptId, L)))
    D = held[0]
    if (!held.every((h) => h.eq(D)) || D.lt(6)) throw new BakeError(`the borrower holds ${held.map((h) => h.toFixed()).join(', ')} share units in the three Harbors, not the same D ≥ 6`)
    console.log(`    ok    the borrower holds D = ${D.toFixed()} share units in each Harbor`)
    for (const label of ['desk', 'spare']) {
      const v = await x.vaultInfo(vaults[label].vaultId, L)
      const total = num(v.AssetsTotal)
      if (label === 'spare' ? !total.eq(cap.times(3)) : total.lt(cap.times(3))) throw new BakeError(`${label} holds ${total.toFixed()} drops, not ${label === 'spare' ? 'exactly' : 'at least'} 3 × principalCap (${cap.times(3).toFixed()})`)
    }
  }

  // --- 3b. the 2-of-3 collateral accounts ---------------------------------------------------------------
  console.log('\n  3b. 2-of-3 collateral accounts {borrower, deskOwner, agent}')
  const collateral = { 'harbor-1': [], 'harbor-2': [], 'harbor-3': [] }
  const makeAccount = async (label, tag) => {
    const acct = Wallet.generate() // its seed is written nowhere
    await submit({ TransactionType: 'Payment', Account: w.deskOwner.address, Destination: acct.address, Amount: COLLATERAL_FUNDING }, w.deskOwner, `fund ${tag}`)
    await submit({
      TransactionType: 'SignerListSet', Account: acct.address, SignerQuorum: 2,
      SignerEntries: [w.borrower, w.deskOwner, w.agent].map((s) => ({ SignerEntry: { Account: s.address, SignerWeight: 1 } })),
    }, acct, `${tag} SignerListSet`)
    // Before the master key goes: a third party's EscrowFinish to an account with no MPToken is tecNO_PERMISSION.
    await submit({ TransactionType: 'MPTokenAuthorize', Account: acct.address, MPTokenIssuanceID: vaults[label].shareMptId }, acct, `${tag} MPTokenAuthorize`)
    await submit({ TransactionType: 'AccountSet', Account: acct.address, SetFlag: 4 }, acct, `${tag} asfDisableMaster`)
    return acct.address
  }
  for (const label of HARBORS) {
    for (let i = 0; i < POOL[label]; i++) collateral[label].push(await makeAccount(label, `${label} pool #${i + 1}`))
  }
  const testAccount = await makeAccount('harbor-1', 'test account (outside the pool)')
  receipt.collateral = { pool: collateral, testAccount }
  saveReceipt()
  {
    const L = await fresh()
    for (const label of HARBORS) {
      for (const address of collateral[label]) {
        const judged = judgeCollateralAccount(await readCollateralObjects(address, vaults[label].shareMptId, L), {
          borrower: w.borrower.address, desk: w.deskOwner.address, agent: w.agent.address, shareMptId: vaults[label].shareMptId, ...COLLATERAL_STAGES.free,
        })
        if (!judged.conforming) throw new BakeError(`collateral account ${address} (${label}) is not conforming: ${judged.reasons.join('; ')}`)
      }
      const share = await readShareObjects(vaults[label], w.borrower.address, L)
      const eligible = judgeCollateralShare(share)
      if (!eligible.eligible) throw new BakeError(`the ${label} share is not eligible collateral: ${eligible.reasons.join('; ')}`)
    }
    const test = judgeCollateralAccount(await readCollateralObjects(testAccount, vaults['harbor-1'].shareMptId, L), {
      borrower: w.borrower.address, desk: w.deskOwner.address, agent: w.agent.address, shareMptId: vaults['harbor-1'].shareMptId, ...COLLATERAL_STAGES.free,
    })
    if (!test.conforming) throw new BakeError(`the test collateral account is not conforming: ${test.reasons.join('; ')}`)
    console.log(`    ok    ${collateral['harbor-1'].length + collateral['harbor-2'].length + collateral['harbor-3'].length} pool accounts and the test account conforming (free); the three shares eligible, at ledger ${L}`)
  }

  // --- the Investment phase opens on all five --------------------------------------------------------------
  await waitTo(SUB + 5, 'subscriptions close, Investment opens on all five vaults')

  // --- 2 (continued). L1 then L2 on each Harbor, countersigned by the debtor ------------------------------
  console.log('\n  2. Harbor loans')
  for (const label of HARBORS) {
    vaults[label].loans = {
      L1: await harborLoan(vaults[label], L1, `${label} L1`),
      L2: await harborLoan(vaults[label], L2, `${label} L2`),
    }
  }
  const lastL2 = await x.loan(vaults['harbor-3'].loans.L2, await fresh())
  const l2Defaultable = Number(lastL2.NextPaymentDueDate) + Number(lastL2.GracePeriod) + 8

  // --- 5. the chain test on spare, while the Harbor loans fall due --------------------------------------
  console.log('\n  5. chain test on spare')
  const u = D.div(6).floor() // plannedLoan.units, in share units, the same for the three Harbors
  const chain = receipt.chainTest
  {
    const pledgeTo = collateral['harbor-1'][0]
    const t = await x.closeTime()
    const finishAfter = t + DESK_LOAN.paymentInterval + DESK_LOAN.gracePeriod + 14400
    const cancelAfter = finishAfter + 86400
    const e = await submit({
      TransactionType: 'EscrowCreate', Account: w.borrower.address, Destination: pledgeTo,
      Amount: { mpt_issuance_id: vaults['harbor-1'].shareMptId, value: u.toFixed(0) }, FinishAfter: finishAfter, CancelAfter: cancelAfter,
    }, w.borrower, `EscrowCreate ${u.toFixed(0)} Harbor-1 shares to pool #1`)
    const sequence = txJson(e).Sequence
    const index = hashes.hashEscrow(w.borrower.address, sequence)
    if (created(e.result.meta, 'Escrow')?.LedgerIndex !== index) throw new BakeError('the pledge escrow index is not hashEscrow(owner, sequence)')
    chain.escrowCreate = await result(e, { destination: pledgeTo, owner: w.borrower.address, offerSequence: sequence, index, finishAfter, cancelAfter, units: u.toFixed(0) })

    const ls = await send(async () => {
      const loanTx = await c.autofill({
        TransactionType: 'LoanSet', Account: w.borrower.address, LoanBrokerID: vaults.spare.loanBrokerId, Counterparty: w.deskOwner.address,
        PrincipalRequested: drops(cap), PaymentInterval: DESK_LOAN.paymentInterval, GracePeriod: DESK_LOAN.gracePeriod, PaymentTotal: 1,
        Memos: [{ Memo: { MemoType: hex('orma.escrow'), MemoData: index } }],
      })
      loanTx.Fee = drops(num(loanTx.Fee).times(2)) // two signatures on one transaction
      return signLoanSetByCounterparty(w.deskOwner, w.borrower.sign(loanTx).tx_blob).tx_blob
    }, 'LoanSet on spare, countersigned by the desk')
    chain.loanSet = await result(ls, { loanId: created(ls.result.meta, 'Loan')?.LedgerIndex ?? null })

    // Negative proofs on the long escrow: too early, by about 29 h and 53 h. It stays pledged for the event.
    chain.earlyFinish = await result(await submit({ TransactionType: 'EscrowFinish', Account: w.buyer.address, Owner: w.borrower.address, OfferSequence: sequence }, w.buyer, 'third-party EscrowFinish, too early', 'tecNO_PERMISSION'))
    chain.earlyCancel = await result(await submit({ TransactionType: 'EscrowCancel', Account: w.buyer.address, Owner: w.borrower.address, OfferSequence: sequence }, w.buyer, 'third-party EscrowCancel, too early', 'tecNO_PERMISSION'))
    saveReceipt()

    // Positive proofs on the test account: a third party finishes, a third party cancels, two signers move.
    const share1 = { mpt_issuance_id: vaults['harbor-1'].shareMptId, value: '1' }
    let s = await x.closeTime()
    const shortFinish = await submit({ TransactionType: 'EscrowCreate', Account: w.holder.address, Destination: testAccount, Amount: share1, FinishAfter: s + 30, CancelAfter: s + 120 }, w.holder, 'EscrowCreate 1 share to the test account (finish)')
    chain.shortFinishCreate = await result(shortFinish, { finishAfter: s + 30, cancelAfter: s + 120 })
    await waitTo(s + 32, 'the short escrow can be finished')
    chain.shortFinish = await result(await submit({ TransactionType: 'EscrowFinish', Account: w.buyer.address, Owner: w.holder.address, OfferSequence: txJson(shortFinish).Sequence }, w.buyer, 'third-party EscrowFinish to the 2-of-3 account'))
    s = await x.closeTime()
    const shortCancel = await submit({ TransactionType: 'EscrowCreate', Account: w.holder.address, Destination: testAccount, Amount: share1, FinishAfter: s + 20, CancelAfter: s + 40 }, w.holder, 'EscrowCreate 1 share to the test account (cancel)')
    chain.shortCancelCreate = await result(shortCancel, { finishAfter: s + 20, cancelAfter: s + 40 })
    await waitTo(s + 42, 'the second short escrow can be cancelled')
    chain.shortCancel = await result(await submit({ TransactionType: 'EscrowCancel', Account: w.buyer.address, Owner: w.holder.address, OfferSequence: txJson(shortCancel).Sequence }, w.buyer, 'third-party EscrowCancel back to holder'))
    chain.paymentIn = await result(await submit({ TransactionType: 'Payment', Account: w.holder.address, Destination: testAccount, Amount: share1 }, w.holder, 'Payment of 1 share to the test account'))
    chain.multisignPayment = await result(await send(async () => {
      const out = await c.autofill({ TransactionType: 'Payment', Account: testAccount, Destination: w.deskOwner.address, Amount: { mpt_issuance_id: vaults['harbor-1'].shareMptId, value: '2' } }, 2)
      return multisign([w.deskOwner.sign(out, true).tx_blob, w.agent.sign(out, true).tx_blob])
    }, 'Payment of both shares, signed by deskOwner and agent'))
    saveReceipt()
  }

  // --- 2 (continued). every L2 defaultable, then L1 impaired and declared on each Harbor ----------------
  await waitTo(l2Defaultable, 'L2 of every Harbor eligible for default')
  console.log('\n  2. impair L1, then the manager declares it')
  for (const label of HARBORS) await impairAndDeclare(vaults[label], w.broker)

  // --- 6. calibrate on Harbor-1 after its impairment, then anchor the mandate --------------------------------
  console.log('\n  6. calibration and mandate')
  const L = await fresh()
  const ledgerHash = x.lastLedgerHash
  const closeTime = x.lastCloseTime
  const rawVault = await x.vaultInfo(vaults['harbor-1'].vaultId, L)
  const rawBroker = await x.loanBroker(vaults['harbor-1'].loanBrokerId, L)
  const rawL1 = await x.loan(vaults['harbor-1'].loans.L1, L)
  const rawL2 = await x.loan(vaults['harbor-1'].loans.L2, L)
  const scale = Number(rawVault.Scale ?? 0)
  const units = u // share units
  const principalDrops = wholeShares(units, scale).times('0.4').floor() // 40 % of their value at 1:1
  if (principalDrops.gt(cap)) throw new BakeError(`principalDrops ${principalDrops.toFixed()} is above principalCap ${cap.toFixed()}`)
  const vault = navInputs(rawVault)
  const heldNow = Reader.nav(vault).navCorrect
  const naiveNow = Reader.nav(vault).navNaive
  const exposure = (l) => (Number(rawVault.LEVersion ?? 0) === 1 ? num(l.PrincipalOutstanding) : num(l.TotalValueOutstanding).minus(num(l.ManagementFeeOutstanding)))
  const coverL2 = coverForOrder([exposure(rawL2)], rawBroker.DebtTotal, rawBroker.CoverRateMinimum, rawBroker.CoverRateLiquidation, rawBroker.CoverAvailable)
  const l2Impaired = (Number(rawL2.Flags ?? 0) & 0x00020000) !== 0
  const heldIfL2 = Reader.nav({
    ...vault,
    assetsTotal: vault.assetsTotal.minus(exposure(rawL2).minus(coverL2)),
    lossUnrealized: l2Impaired ? vault.lossUnrealized.minus(exposure(rawL2)) : vault.lossUnrealized,
  }).navCorrect
  const valueAt = (perUnit) => wholeShares(units, scale).times(perUnit).toFixed(0) // valuePledge, ROUND_HALF_UP
  const ltv = (perUnit) => principalDrops.times(10000).div(valueAt(perUnit)).floor().toNumber()
  const ltvNow = ltv(heldNow)
  const ltvIfL2 = ltv(heldIfL2)
  const maxLtvBps = Math.floor((ltvNow + ltvIfL2) / 2)
  const ltv1to1 = principalDrops.times(10000).div(wholeShares(units, scale)).floor().toNumber()
  const lossL2 = num(valueAt(heldNow)).minus(valueAt(heldIfL2))
  const limits = {
    maxLtvBps,
    maxSingleLoanDrops: drops(principalDrops.times(2)),
    maxN2LossDrops: drops(Decimal.max(lossL2, 0).times(2)), // L1's loss is already in the withdrawal value: L2 sets it
    maxLockupDays: Math.floor((HARBOR_REDEMPTION - closeTime) / 86400) + 7,
  }
  const checks = [
    [new Decimal(heldNow).lt(naiveNow), `heldNow ${heldNow} is not under the value read by all ${naiveNow}: the impairment did not take`],
    [ltvIfL2 - ltvNow >= 200, `ltvIfL2 ${ltvIfL2} is less than 200 bps above ltvNow ${ltvNow}`],
    [ltvNow < maxLtvBps && maxLtvBps < ltvIfL2, `ltvNow ${ltvNow} < maxLtvBps ${maxLtvBps} < ltvIfL2 ${ltvIfL2} does not hold`],
    [ltvIfL2 < 10000, `ltvIfL2 ${ltvIfL2} reaches 10000 bps`],
    [ltv1to1 < maxLtvBps, `the 1:1 LTV ${ltv1to1} is not under maxLtvBps ${maxLtvBps}`],
  ]
  for (const [ok, why] of checks) if (!ok) throw new BakeError(`calibration: ${why}`)
  console.log(`    heldNow ${heldNow}  heldIfL2 ${heldIfL2}  ltvNow ${ltvNow}  ltvIfL2 ${ltvIfL2}  maxLtvBps ${maxLtvBps}  1:1 ${ltv1to1}`)
  const calibration = {
    vault: 'harbor-1', ledgerIndex: L, ledgerHash, closeTime,
    objects: { vault: rawVault, broker: rawBroker, loans: { L1: rawL1, L2: rawL2 } },
    units: units.toFixed(0), principalDrops: principalDrops.toFixed(0),
    heldNow, naiveNow, heldIfL2, coverL2: coverL2.toFixed(0), exposureL2: exposure(rawL2).toFixed(0),
    ltvNow, ltvIfL2, ltv1to1, lossL2Drops: lossL2.toFixed(0),
  }

  const mandateBody = {
    schema: 'orma.mandate/1', id: 'desk-1', desk: 'Harbor Credit Desk (fictional)', riskOfficer: w.riskOfficer.address, limits,
    policy: { escrowFinish: 'only-after-default', finishAfterMarginSeconds: 14400, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 },
    issuedAt: new Date().toISOString(),
  }
  const hash = mandateHash(mandateBody)
  const anchor = await submit({
    TransactionType: 'AccountSet', Account: w.riskOfficer.address,
    Memos: [{ Memo: { MemoType: hex('orma.mandate/1'), MemoData: hex(`orma.mandate/1:${hash}`) } }],
  }, w.riskOfficer, 'mandate anchored by the risk officer')
  const mandate = { ...mandateBody, hash, anchorTx: anchor.result.hash }
  receipt.mandate = { hash, anchorTx: anchor.result.hash, ledgerIndex: anchor.result.ledger_index }

  // --- 4. the demo files ------------------------------------------------------------------------------------
  const L4 = await fresh()
  const spareHeld = await mptBalance(w.holder.address, vaults.spare.shareMptId, L4)
  const bakedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const record = (v, extra = {}) => ({
    label: v.label, vaultId: v.vaultId, shareMptId: v.shareMptId, loanBrokerId: v.loanBrokerId, owner: v.owner.address,
    navUrl: `${base}/v/${v.shareMptId}/nav`, subscriptionDate: v.subscriptionDate, redemptionDate: v.redemptionDate,
    loans: v.loans ?? { L1: null, L2: null },
    impairL1Tx: v.impairL1Tx ?? null, impairL1Hidden: v.impairL1Hidden ?? null, statementTx: v.statementTx ?? null,
    bakedAt, ...extra,
  })
  mkdirSync('demo', { recursive: true })
  const write = (f, o) => writeFileSync(f, JSON.stringify(o, null, 2) + '\n')
  for (const label of HARBORS) write(OUT[label], record(vaults[label]))
  write(OUT.spare, record(vaults.spare))
  write(OUT.desk, record(vaults.desk, {
    plannedLoan: { units: units.toFixed(0), principalDrops: principalDrops.toFixed(0), paymentInterval: DESK_LOAN.paymentInterval, gracePeriod: DESK_LOAN.gracePeriod },
    plannedBuy: { share: vaults.spare.shareMptId, units: spareHeld.div(3).floor().toFixed(0) },
    mandate: { hash, anchorTx: anchor.result.hash },
    calibration,
    collateral: { agent: w.agent.address, borrower: w.borrower.address, desk: w.deskOwner.address, quorum: 2, accounts: collateral },
  }))
  write(OUT.mandate, mandate)
  receipt.bakedAt = bakedAt
  saveReceipt()

  console.log('\n  baked')
  for (const label of [...HARBORS, 'desk', 'spare']) console.log(`    ${label.padEnd(9)} ${vaults[label].vaultId}  share ${vaults[label].shareMptId}`)
  console.log(`    mandate   ${hash}  anchored by ${anchor.result.hash}`)
  console.log(`\n  -> ${Object.values(OUT).join(', ')}\n  -> ${ROLES_FILE} (seeds), ${RECEIPT}`)
  console.log('\n  Next, by hand: copy the deskOwner seed of .demo/roles.json into DESK_SEED of .env, printing nothing.')
  return 0

  // --- helpers that close over the clients ------------------------------------------------------------

  function principalCap() {
    return BORROWER_DEPOSIT.times('0.2').floor() // a fifth of the borrower's Harbor-1 deposit
  }

  async function harborLoan(v, principal, what) {
    const r = await send(async () => {
      const tx = await c.autofill({
        TransactionType: 'LoanSet', Account: w.broker.address, LoanBrokerID: v.loanBrokerId, Counterparty: debtor.address,
        PrincipalRequested: drops(principal), InterestRate: 100000, LateInterestRate: 20000,
        PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 60,
      })
      tx.Fee = drops(num(tx.Fee).times(2))
      return signLoanSetByCounterparty(debtor, w.broker.sign(tx).tx_blob).tx_blob
    }, `LoanSet ${what} ${new Decimal(principal).div(1e6).toFixed(2)} XRP`)
    return created(r.result.meta, 'Loan').LedgerIndex
  }

  /** Impair L1 (past due by now), record the state before it, then the manager's statement in Vault.Data. */
  async function impairAndDeclare(v, broker) {
    const Lb = await fresh()
    const before = {
      ledgerIndex: Lb, ledgerHash: x.lastLedgerHash,
      Vault: await x.vaultInfo(v.vaultId, Lb), Loan: await x.loan(v.loans.L1, Lb),
      AccountRoot: (await x.req({ command: 'account_info', account: broker.address, ledger_index: Lb })).result.account_data,
      LoanBroker: await x.loanBroker(v.loanBrokerId, Lb),
    }
    const dueBefore = Number(before.Loan.NextPaymentDueDate)
    const imp = await submit({ TransactionType: 'LoanManage', Account: broker.address, LoanID: v.loans.L1, Flags: 0x00020000 }, broker, `${v.label} LoanManage tfLoanImpair on L1`)
    receipt.impairments[v.label] = { ...(await result(imp)), txJson: txJson(imp), meta: imp.result.meta, before }
    const vaultNode = modified(imp.result.meta, 'Vault')
    if (!vaultNode) throw new BakeError(`${v.label}: the impairment's metadata does not modify the Vault`)
    if (vaultNode.PreviousFields && 'LossUnrealized' in vaultNode.PreviousFields) throw new BakeError(`${v.label}: the impairment's metadata records LossUnrealized in PreviousFields; the field is no longer hidden`)
    const after = await x.vaultInfo(v.vaultId, await atLedger(imp.result.ledger_index))
    if (!num(after.LossUnrealized).gt(0)) throw new BakeError(`${v.label}: LossUnrealized is ${after.LossUnrealized ?? 'absent'} after the impairment`)
    v.impairL1Tx = imp.result.hash
    v.impairL1Hidden = ['Vault.LossUnrealized']

    const Ls = await fresh()
    const at = x.lastCloseTime
    const minutes = Math.max(1, Math.floor((at - dueBefore) / 60))
    const doc = { s: 'orma.stmt/1', loan: v.loans.L1, kind: 'impaired', text: `L1 marked impaired: payment missed by ${minutes} min`, at }
    const data = encodeStatement(doc)
    const stateBefore = { ledgerIndex: Ls, ledgerHash: x.lastLedgerHash, Vault: await x.vaultInfo(v.vaultId, Ls) }
    const set = await submit({ TransactionType: 'VaultSet', Account: broker.address, VaultID: v.vaultId, Data: data }, broker, `${v.label} VaultSet: the manager's statement`)
    receipt.statements[v.label] = { ...(await result(set)), txJson: txJson(set), meta: set.result.meta, before: stateBefore, doc }
    const La = await atLedger(set.result.ledger_index)
    const reread = await x.vaultInfo(v.vaultId, La)
    if (reread.Data !== data) throw new BakeError(`${v.label}: Vault.Data is ${reread.Data ?? 'absent'}, not the statement`)
    const l1 = await x.loan(v.loans.L1, La)
    const hashAt = (await x.req({ command: 'ledger', ledger_index: La })).result.ledger_hash
    const check = statementConsistency(parseStatement(reread.Data), [{ ...l1, label: 'L1' }], { ledgerIndex: La, ledgerHash: hashAt })
    if (check.status !== 'CONSISTENT') throw new BakeError(`${v.label}: the statement is ${check.status}: ${check.detail}`)
    console.log(`          ${check.detail}`)
    v.statementTx = set.result.hash
    saveReceipt()
  }

  async function readCollateralObjects(address, shareMptId, L) {
    const accountRoot = (await x.req({ command: 'account_info', account: address, ledger_index: L })).result.account_data
    const signerList = (await x.accountObjects(address, 'signer_list', L))[0] ?? null
    const mptoken = (await x.accountObjects(address, 'mptoken', L)).find((o) => String(o.MPTokenIssuanceID).toUpperCase() === shareMptId.toUpperCase()) ?? null
    const escrows = (await x.accountObjects(address, 'escrow', L)).filter((e) => e.Destination === address)
    return { accountRoot, signerList, mptoken, escrows }
  }

  async function readShareObjects(v, holder, L) {
    const vault = await x.vaultInfo(v.vaultId, L)
    const issuance = await x.mptIssuance(v.shareMptId, L)
    const mptoken = (await x.accountObjects(holder, 'mptoken', L)).find((o) => String(o.MPTokenIssuanceID).toUpperCase() === v.shareMptId.toUpperCase()) ?? null
    return { vault, issuance, mptoken }
  }

  async function mptBalance(account, shareMptId, L) {
    const t = (await x.accountObjects(account, 'mptoken', L)).find((o) => String(o.MPTokenIssuanceID).toUpperCase() === shareMptId.toUpperCase())
    return num(t?.MPTAmount)
  }
}

// --- helpers that only need the clients to exist --------------------------------------------------------

/** Sign, submit, wait for validation, and require the result. */
async function submit(tx, wallet, what, expect = 'tesSUCCESS') {
  return send(async () => wallet.sign(await c.autofill({ ...tx })).tx_blob, what, expect)
}

/**
 * Submit what `build` signs and follow it by its hash until it is validated, whatever happens to the
 * socket meanwhile. It is signed again (a new Sequence and LastLedgerSequence) only once the ledger has
 * passed its LastLedgerSequence without it, so a transaction never applies twice. A tem never applies:
 * it stops the bake at once.
 */
async function send(build, what, expect = 'tesSUCCESS') {
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    let blob
    try {
      blob = await build()
    } catch (e) {
      lastError = e
      await pause(e, `${what}: signing`, attempt)
      continue
    }
    const hash = hashes.hashSignedTx(blob)
    const last = decode(blob).LastLedgerSequence
    try {
      const r = await c.request({ command: 'submit', tx_blob: blob })
      if (/^tem/.test(r.result.engine_result)) throw new BakeError(`${what}: ${r.result.engine_result} (${r.result.engine_result_message})`)
    } catch (e) {
      if (e instanceof BakeError) throw e
      lastError = e // it may have gone out before the socket dropped: its hash tells
    }
    const validated = await outcome(hash, last)
    if (validated) return settle({ result: validated }, what, expect)
    console.log(`    retry  ${what}: not validated by ledger ${last}, signing again`)
  }
  throw new BakeError(`${what}: not validated after 5 attempts (${String(lastError?.message ?? lastError).slice(0, 100)})`)
}

/** The validated transaction with this hash, or null once the ledger is past its LastLedgerSequence. */
async function outcome(hash, last) {
  for (let i = 0; ; i++) {
    try {
      const r = await c.request({ command: 'tx', transaction: hash })
      if (r.result.validated) return r.result
    } catch (e) {
      if (e?.data?.error !== 'txnNotFound') await pause(e, 'tx lookup', Math.min(i, 3))
    }
    await x.closeTime()
    if (x.lastLedger > last) {
      try {
        const r = await c.request({ command: 'tx', transaction: hash })
        if (r.result.validated) return r.result
      } catch { /* not found: it never applied */ }
      return null
    }
    await sleep(1500)
  }
}

/** A dropped socket or a transient error: wait, then reconnect if the socket is gone. */
async function pause(e, what, i = 0) {
  const ms = Math.min(8000, 1000 * 2 ** i)
  console.log(`    wait   ${what}: ${String(e?.data?.error ?? e?.message ?? e).slice(0, 70)}; again in ${ms / 1000}s`)
  await sleep(ms)
  try {
    if (!c.isConnected()) await c.connect()
  } catch { /* the next request tries again */ }
}

function settle(r, what, expect = 'tesSUCCESS') {
  const code = r.result.meta?.TransactionResult
  const want = Array.isArray(expect) ? expect : [expect]
  const ok = want.includes(code)
  receipt.steps.push({ what, result: code, txHash: r.result.hash, ledgerIndex: r.result.ledger_index })
  lastSubmitted = Math.max(lastSubmitted, r.result.ledger_index ?? 0)
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${what.padEnd(58)} ${String(code).padEnd(17)} ${String(r.result.hash).slice(0, 16)}…`)
  if (!ok) throw new BakeError(`${what}: ${code}, expected ${want.join(' or ')}`)
  return r
}

function txJson(r) {
  return r.result.tx_json ?? r.result
}

/** A receipt entry: the result, its hash and the ledger it was validated in, with that ledger's hash. */
async function result(r, extra = {}) {
  const ledgerIndex = r.result.ledger_index
  const ledgerHash = r.result.ledger_hash ?? (await x.req({ command: 'ledger', ledger_index: await atLedger(ledgerIndex) })).result.ledger_hash
  return { result: r.result.meta?.TransactionResult, txHash: r.result.hash, ledgerIndex, ledgerHash, ...extra }
}

function navInputs(raw) {
  return {
    assetsTotal: num(raw.AssetsTotal), assetsAvailable: num(raw.AssetsAvailable), lossUnrealized: num(raw.LossUnrealized),
    sharesOutstanding: num(raw.shares?.OutstandingAmount), scale: Number(raw.Scale ?? 0),
  }
}

/** Faucet until the account holds at least `xrp`, read at the validated ledger. */
async function fundTo(wallet, xrp, role) {
  for (let i = 0; i < 8; i++) {
    const L = await fresh()
    let balance = new Decimal(0)
    try {
      balance = num((await x.req({ command: 'account_info', account: wallet.address, ledger_index: L })).result.account_data.Balance)
    } catch (e) {
      if (e?.data?.error !== 'actNotFound') throw e
    }
    if (balance.gte(new Decimal(xrp).times(1e6))) return
    try {
      await c.fundWallet(wallet)
      console.log(`    faucet  ${role.padEnd(12)} ${wallet.address}`)
    } catch (e) {
      await pause(e, `faucet for ${role}`, Math.min(i, 3))
    }
  }
  throw new BakeError(`the faucet did not bring ${role} to ${xrp} XRP after 8 requests`)
}

async function waitTo(t, why) {
  const now = await x.closeTime()
  if (t > now) console.log(`  waiting ${t - now}s — ${why}`)
  const deadline = Date.now() + (Math.max(0, t - now) + 600) * 1000
  while ((await x.closeTime()) < t) {
    if (Date.now() > deadline) throw new BakeError(`gave up waiting for close_time ${t} (${why}): the ledger is at ${x.lastCloseTime}`)
    await sleep(3000)
  }
}

/**
 * The validated ledger to read at: the latest this node holds, and never one before the last transaction
 * the bake saw validated (transactions go out on c, reads on x, which may lag).
 */
async function fresh() {
  await atLedger(lastSubmitted)
  return x.lastLedger
}

/** A ledger number this node holds as validated: the one asked for, waited for (2 min at most). */
async function atLedger(n) {
  const deadline = Date.now() + 120000
  while ((await x.closeTime(), x.lastLedger) < n) {
    if (Date.now() > deadline) throw new BakeError(`the node never validated ledger ${n}`)
    await sleep(1000)
  }
  return n
}

function saveReceipt() {
  if (!started) return
  try {
    mkdirSync('.demo', { recursive: true })
    writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n')
  } catch (e) {
    console.error(`  could not write ${RECEIPT}: ${String(e).slice(0, 120)}`)
  }
}

