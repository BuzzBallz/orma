// Offline check of the desk signer (step 10): it countersigns the borrower's LoanSet only after a re-read
// at the ledger of the decision (the escrow the request names and that one alone, its 2-of-3 account,
// the pledged share, the recomputed ticket, the borrower's Sequence), and every outcome is chained in the
// decision log with that ledger (I2); an inconsistent snapshot refuses before any figure (I7). On a fake
// ledger client and a fake submitter, then through the role engine in memory. No Devnet.
//   node src/dev/check-desk.mjs
//   node src/dev/check-desk.mjs --live --vault spare   pledge, request and approve on spare (under with-api)
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { Wallet, hashes, decode } from 'xrpl'
import { createApi } from '../api.mjs'
import { createRoleEngine } from '../roles/engine.mjs'
import { buildTicket } from '../ticket/engine.mjs'
import { readTicketInputs, issuanceIdOf } from '../ticket/inputs.mjs'
import { openLog } from '../desk/decision-log.mjs'
import { createSigner, registerDeskActions, withDeskErrors, DeskError } from '../desk/signer.mjs'
import { mandateHash } from '../nyc/contracts.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const hex64 = (c) => c.repeat(64).slice(0, 64)
const hashOf = (L) => L.toString(16).toUpperCase().padStart(64, '0')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- the cast --------------------------------------------------------------------------------------------

const W = Object.fromEntries(['holder', 'borrower', 'broker', 'deskOwner', 'agent', 'stranger'].map((r) => [r, Wallet.generate()]))
const PSEUDO = Wallet.generate().address
const SHARE = issuanceIdOf({ Issuer: PSEUDO, Sequence: 1 })
const IOU_PSEUDO = Wallet.generate().address
const IOU_SHARE = issuanceIdOf({ Issuer: IOU_PSEUDO, Sequence: 1 })
const VAULT = hex64('A')
const IOU_VAULT = hex64('9')
const HARBOR_BROKER = hex64('B')
const DESK_BROKER = hex64('D')
const SPARE_BROKER = hex64('E')
const L1 = hex64('1')
const CT = 846200000
const POLICY = { escrowFinish: 'only-after-default', finishAfterMarginSeconds: 14400, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 }
const PLAN = { units: '5000000', principalDrops: '2000000', paymentInterval: 86400, gracePeriod: 3600 }
const mandateOf = (maxLtvBps) => {
  const m = { schema: 'orma.mandate/1', id: 'desk-1', desk: 'Test desk (fictional)', riskOfficer: W.stranger.address, limits: { maxLtvBps, maxSingleLoanDrops: '4000000', maxN2LossDrops: '100000000', maxLockupDays: 3650 }, policy: POLICY, issuedAt: '2026-10-24T14:00:00Z' }
  return { ...m, hash: mandateHash(m), anchorTx: hex64('8') }
}
const PASSING = mandateOf(6000)
const TIGHT = mandateOf(4000)
const DESK = { owner: W.deskOwner.address, loanBrokerId: DESK_BROKER, vaultId: hex64('5'), plannedLoan: PLAN, collateral: { borrower: W.borrower.address, desk: W.deskOwner.address, agent: W.agent.address } }
const SPARE = { owner: W.deskOwner.address, loanBrokerId: SPARE_BROKER, vaultId: hex64('4') }

// --- a fake ledger -----------------------------------------------------------------------------------------

/**
 * A fake rippled: the Harbor vault (50 XRP, 10 XRP impaired on L1), an IOU vault, accounts with their
 * objects and histories, escrows by index; the ledger moves by hand. Each request is recorded.
 */
function world() {
  const w = {
    L: 1000, closeTime: CT, requests: [], objects: new Map(), accounts: new Map(), mptokens: new Map(), txs: new Map(), answerLedger: {},
    vault: { index: VAULT, Account: PSEUDO, Owner: W.broker.address, ShareMPTID: SHARE, Asset: { currency: 'XRP' }, VaultKind: 1, LEVersion: 1, AssetsTotal: '50000000', AssetsAvailable: '35000000', LossUnrealized: '10000000', Scale: 0, RedemptionDate: CT + 30 * 86400 },
    issuance: { Issuer: PSEUDO, Sequence: 1, mpt_issuance_id: SHARE, OutstandingAmount: '50000000', Flags: 0x38 },
    broker: { index: HARBOR_BROKER, VaultID: VAULT, Owner: W.broker.address, LoanSequence: 2, DebtTotal: '15000000', CoverAvailable: '3000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000 },
    loan: { index: L1, LoanBrokerID: HARBOR_BROKER, LoanSequence: 1, Borrower: W.stranger.address, PrincipalOutstanding: '10000000', TotalValueOutstanding: '10000000', Flags: 0x00020000, NextPaymentDueDate: CT - 600, GracePeriod: 60 },
    iouVault: { index: IOU_VAULT, Account: IOU_PSEUDO, Owner: W.broker.address, ShareMPTID: IOU_SHARE, Asset: { currency: 'USD', issuer: W.stranger.address }, VaultKind: 1, LEVersion: 1, AssetsTotal: '50000000', AssetsAvailable: '50000000', Scale: 0, RedemptionDate: CT + 30 * 86400 },
    iouIssuance: { Issuer: IOU_PSEUDO, Sequence: 1, mpt_issuance_id: IOU_SHARE, OutstandingAmount: '50000000', Flags: 0x38 },
  }
  w.accounts.set(W.borrower.address, { root: { Account: W.borrower.address, Sequence: 10, Flags: 0, OwnerCount: 3 }, objects: [] })
  w.mptokens.set(`${SHARE}:${W.borrower.address}`, { Account: W.borrower.address, MPTokenIssuanceID: SHARE, MPTAmount: '30000000', Flags: 0 })
  w.mptokens.set(`${IOU_SHARE}:${W.borrower.address}`, { Account: W.borrower.address, MPTokenIssuanceID: IOU_SHARE, MPTAmount: '30000000', Flags: 0 })
  const notFound = (error = 'entryNotFound') => Object.assign(new Error(error), { data: { error } })
  const at = (cmd) => w.answerLedger[cmd] ?? w.L
  const page = (items, marker) => {
    const start = marker ? Number.parseInt(marker, 10) : 0
    return { items: items.slice(start, start + 50), marker: start + 50 < items.length ? String(start + 50) : undefined }
  }
  w.gate = null
  const xrpl = {
    lastLedger: null, lastLedgerHash: null, lastCloseTime: null,
    async closeTime() {
      if (w.gate) await w.gate
      this.lastLedger = w.L
      this.lastLedgerHash = hashOf(w.L)
      this.lastCloseTime = w.closeTime
      return w.closeTime
    },
    async accountTxWindow() { return { transactions: [], ledgerMin: 1, ledgerMax: w.L, truncated: false } },
    async req(p) {
      w.requests.push(structuredClone(p))
      switch (p.command) {
        case 'vault_info': {
          const v = p.vault_id === VAULT ? { ...w.vault, shares: w.issuance } : p.vault_id === IOU_VAULT ? { ...w.iouVault, shares: w.iouIssuance } : null
          if (!v) throw notFound()
          return { result: { vault: v, ledger_index: at('vault_info') } }
        }
        case 'ledger_entry': {
          let node = null
          if (p.mpt_issuance) node = same(p.mpt_issuance, SHARE) ? w.issuance : same(p.mpt_issuance, IOU_SHARE) ? w.iouIssuance : null
          else if (p.mptoken) node = w.mptokens.get(`${p.mptoken.mpt_issuance_id.toUpperCase()}:${p.mptoken.account}`) ?? null
          else if (p.loan) node = p.loan.loan_broker_id === HARBOR_BROKER && p.loan.loan_seq === 1 ? w.loan : null
          else if (p.index) node = w.objects.get(p.index.toUpperCase()) ?? null
          if (!node) throw notFound()
          return { result: { node, ledger_index: p.mpt_issuance ? at('issuance') : w.L } }
        }
        case 'account_objects': {
          if (p.type === 'loan_broker') return { result: { account_objects: p.account === W.broker.address ? [w.broker] : [], ledger_index: w.L } }
          const a = w.accounts.get(p.account)
          const { items, marker } = page(a?.objects ?? [], p.marker)
          return { result: { account_objects: items, ...(marker && { marker }), ledger_index: w.L } }
        }
        case 'account_info': {
          const a = w.accounts.get(p.account)
          if (!a) throw notFound('actNotFound')
          return { result: { account_data: a.root, signer_lists: a.signerList ? [a.signerList] : [], ledger_index: w.L } }
        }
        case 'account_tx': {
          const { items, marker } = page(w.txs.get(p.account) ?? [], p.marker)
          return { result: { transactions: items, ...(marker && { marker }) } }
        }
        default:
          throw new Error(`fake rippled: no ${p.command}`)
      }
    },
    client: { autofill: async (tx) => ({ ...tx, Sequence: w.accounts.get(tx.Account)?.root.Sequence ?? 1, Fee: '12', LastLedgerSequence: tx.LastLedgerSequence ?? w.L + 20 }) },
  }
  w.xrpl = xrpl
  w.reader = { getByShareMpt: (id) => (same(id, SHARE) ? { vaultId: VAULT } : same(id, IOU_SHARE) ? { vaultId: IOU_VAULT } : null) }
  return w
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()

/** A conforming 2-of-3 account, with its MPToken of `share`, in the fake ledger. */
function collateralAccount(w, { share = SHARE, flags = 0x00100000, regularKey, quorum = 2, signers = [W.borrower, W.deskOwner, W.agent], weight = 1, ownerCount = 2, mptoken = true, extraObjects = [] } = {}) {
  const address = Wallet.generate().address
  const signerList = { LedgerEntryType: 'SignerList', SignerQuorum: quorum, SignerEntries: signers.map((s) => ({ SignerEntry: { Account: s.address, SignerWeight: weight } })) }
  const token = { LedgerEntryType: 'MPToken', Account: address, MPTokenIssuanceID: share, MPTAmount: '0', Flags: 0 }
  w.accounts.set(address, { root: { Account: address, Flags: flags, OwnerCount: ownerCount, Sequence: 3, ...(regularKey && { RegularKey: regularKey }) }, signerList, objects: [signerList, ...(mptoken ? [token] : []), ...extraObjects] })
  if (mptoken) w.mptokens.set(`${share}:${address}`, token)
  return address
}

/** A pledge escrow from the borrower to `destination`, created `age` seconds before the ledger's close_time. */
function pledge(w, destination, { share = SHARE, units = PLAN.units, age = 60, finishAfter, cancelAfter, condition, sequence = 1000 + w.objects.size } = {}) {
  const fa = finishAfter ?? (w.closeTime - age + PLAN.paymentInterval + PLAN.gracePeriod + POLICY.finishAfterMarginSeconds)
  const escrow = {
    index: hashes.hashEscrow(W.borrower.address, sequence), LedgerEntryType: 'Escrow', Account: W.borrower.address, Destination: destination,
    Amount: { mpt_issuance_id: share, value: units }, FinishAfter: fa, CancelAfter: cancelAfter ?? fa + POLICY.cancelAfterOffsetSeconds, ...(condition && { Condition: condition }),
  }
  w.objects.set(escrow.index, escrow)
  w.accounts.get(destination)?.objects.push(escrow)
  return { index: escrow.index, owner: W.borrower.address, offerSequence: sequence, destination }
}

/** The ticket the request kept, its digest at the ledger now. */
async function ticketOf(w, share = SHARE, mandate = PASSING) {
  const inputs = await readTicketInputs(w.xrpl, { shareMptId: share, reader: w.reader })
  return buildTicket(inputs, { op: 'pledge', units: PLAN.units, mandate, principalDrops: PLAN.principalDrops })
}

/** A requestLoan awaiting approval: its ticket, its escrow, and the LoanSet the borrower signed. */
async function requestFor(w, escrow, { share = SHARE, mandate = PASSING, paymentTotal = 1, lastLedger, sequence } = {}) {
  const t = await ticketOf(w, share, mandate)
  const tx = {
    TransactionType: 'LoanSet', Account: W.borrower.address, LoanBrokerID: SPARE_BROKER, Counterparty: W.deskOwner.address,
    PrincipalRequested: PLAN.principalDrops, PaymentInterval: PLAN.paymentInterval, GracePeriod: PLAN.gracePeriod, PaymentTotal: paymentTotal,
    Sequence: sequence ?? w.accounts.get(W.borrower.address).root.Sequence, Fee: '24', LastLedgerSequence: lastLedger ?? w.L + 600,
    Memos: [{ Memo: { MemoType: hex('orma.ticket'), MemoData: t.ticketId.toUpperCase() } }, { Memo: { MemoType: hex('orma.escrow'), MemoData: escrow.index } }],
  }
  const signed = { tx, ...W.borrower.sign(tx) }
  return {
    act: { actionId: `req-${Math.random().toString(16).slice(2)}`, action: 'requestLoan', state: 'pending-approval', ticket: { share, ticketId: t.ticketId, inputsDigest: t.inputsDigest, units: PLAN.units }, escrow },
    signed,
  }
}

/** A signer on the fake world, a fresh log, and a fake submitter that records what it is given. */
function signerFor(w, { mandate = PASSING, submitResult = 'tesSUCCESS', throwOnSubmit = false, requests = new Map() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orma-desk-'))
  const decisions = openLog(join(dir, 'decisions.jsonl'))
  const submitted = []
  const signer = createSigner({
    xrpl: w.xrpl, reader: w.reader, wallet: W.deskOwner, decisions,
    readDesk: () => DESK, readSpare: () => SPARE, readMandate: () => w.mandate ?? mandate,
    loanSetOf: (id) => requests.get(id) ?? null,
    lookupTx: async () => null, confirmWindowMs: 30,
    submit: async (blob) => {
      submitted.push(blob)
      if (throwOnSubmit) throw new Error('socket closed')
      const result = typeof submitResult === 'function' ? submitResult(blob) : submitResult
      return { txHash: hashes.hashSignedTx(blob), engineResult: result, ledgerIndex: w.L + 1, meta: { TransactionResult: result, AffectedNodes: result === 'tesSUCCESS' ? [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: hex64('7') + String(submitted.length) } }] : [] } }
    },
  })
  return { signer, decisions, submitted, requests, dir }
}

/** Approve `act`; the outcome as { ok, code, message, entry }. */
async function tryApprove(s, act, stopped = () => false) {
  try {
    const out = await s.signer.approve({ actionOfRequest: act, stopped })
    return { ok: true, out }
  } catch (e) {
    if (!(e instanceof DeskError)) throw e
    return { ok: false, code: e.code, status: e.status, message: e.message, extra: e.extra }
  }
}

// --- the signer --------------------------------------------------------------------------------------------

async function signerCases() {
  console.log('approve, at the ledger of the decision')
  {
    const w = world()
    const s = signerFor(w)
    const acct = collateralAccount(w)
    const { act, signed } = await requestFor(w, pledge(w, acct))
    s.requests.set(act.actionId, signed)
    w.L += 5
    w.closeTime += 20 // the ledger moved on; no object changed
    const r = await tryApprove(s, act)
    eq('the ledger advanced between ticket and approval, same values: approved, one submission', [r.ok, s.submitted.length, s.decisions.entries().map((e) => e.decision)], [true, 1, ['approved']])
    const sent = decode(s.submitted[0])
    eq('the desk countersigned the borrower\'s LoanSet, its ticket Memo kept', [Boolean(sent.CounterpartySignature), sent.Account, sent.Memos[0].Memo.MemoData], [true, W.borrower.address, act.ticket.ticketId.toUpperCase()])
    const e = s.decisions.entries()[0]
    eq('the entry carries the ledger the decision read (I2)', [e.ledgerIndex, e.ledgerHash, e.txHash], [1005, hashOf(1005), hashes.hashSignedTx(s.submitted[0])])
  }

  console.log('STALE, BREACHED, SEQUENCE_PASSED')
  {
    const w = world()
    const s = signerFor(w)
    const a1 = await requestFor(w, pledge(w, collateralAccount(w)))
    s.requests.set(a1.act.actionId, a1.signed)
    w.vault.LossUnrealized = '9999999' // a drop less: still consistent (I7), another value
    eq('LossUnrealized changed since the ticket: 409 STALE, nothing submitted', [(await tryApprove(s, a1.act)).code, s.submitted.length], ['STALE', 0])
    w.vault.LossUnrealized = '10000000'
    const a2 = await requestFor(w, pledge(w, collateralAccount(w)))
    s.requests.set(a2.act.actionId, a2.signed)
    w.broker.CoverAvailable = '2000000' // cover withdrawn
    eq('CoverAvailable changed since the ticket: 409 STALE', (await tryApprove(s, a2.act)).code, 'STALE')
    w.broker.CoverAvailable = '3000000'
    const tight = signerFor(w, { mandate: TIGHT })
    const a3 = await requestFor(w, pledge(w, collateralAccount(w)), { mandate: TIGHT })
    tight.requests.set(a3.act.actionId, a3.signed)
    const br = await tryApprove(tight, a3.act)
    eq('a tight mandate: 409 BREACHED with its breaches, nothing submitted', [br.code, br.extra.breaches?.map((b) => b.limit), tight.submitted.length], ['BREACHED', ['maxLtvBps'], 0])

    const a4 = await requestFor(w, pledge(w, collateralAccount(w)))
    s.requests.set(a4.act.actionId, a4.signed)
    w.accounts.get(W.borrower.address).root.Sequence += 1 // another transaction used the signed Sequence
    const before = s.submitted.length
    eq('the borrower\'s Sequence moved past the signed one: 409 SEQUENCE_PASSED, nothing submitted', [(await tryApprove(s, a4.act)).code, s.submitted.length - before], ['SEQUENCE_PASSED', 0])
    const enqueue = (_a, fn) => fn()
    await s.signer.rerequest({ actionOfRequest: a4.act, borrower: W.borrower, enqueue })
    eq('rerequest signs again at the current Sequence, and approve accepts it', [(await tryApprove(s, a4.act)).ok, decode(s.submitted.at(-1)).Sequence], [true, w.accounts.get(W.borrower.address).root.Sequence])
    const a5 = await requestFor(w, pledge(w, collateralAccount(w)), { lastLedger: w.L + 10 })
    s.requests.set(a5.act.actionId, a5.signed)
    const n5 = s.submitted.length
    eq('a signed LoanSet whose LastLedgerSequence is L + 10: 409 SEQUENCE_PASSED, nothing submitted', [(await tryApprove(s, a5.act)).code, s.submitted.length - n5], ['SEQUENCE_PASSED', 0])
    const tef = signerFor(w, { submitResult: 'tefMAX_LEDGER' })
    const a6 = await requestFor(w, pledge(w, collateralAccount(w)))
    tef.requests.set(a6.act.actionId, a6.signed)
    eq('a submission that ends tefMAX_LEDGER: refused SEQUENCE_PASSED, never approved', [(await tryApprove(tef, a6.act)).code, tef.decisions.entries().map((e) => [e.decision, e.code])], ['SEQUENCE_PASSED', [['refused', 'SEQUENCE_PASSED']]])
    const unconfirmed = signerFor(w, { throwOnSubmit: true })
    const a7 = await requestFor(w, pledge(w, collateralAccount(w)))
    unconfirmed.requests.set(a7.act.actionId, a7.signed)
    const u = await tryApprove(unconfirmed, a7.act)
    const ue = unconfirmed.decisions.entries()
    eq('a submission that throws, not found by the re-read: refused SUBMIT_UNCONFIRMED with the hash sent, never approved', [u.code, ue.map((e) => e.decision), ue[0]?.txHash], ['SUBMIT_UNCONFIRMED', ['refused'], hashes.hashSignedTx(unconfirmed.submitted[0])])
  }

  console.log('INCONSISTENT_SNAPSHOT at the confirm (I7)')
  for (const [name, spoil, restore] of [
    ['LossUnrealized a drop above AssetsTotal − AssetsAvailable', (w) => { w.vault.LossUnrealized = '15000001' }, (w) => { w.vault.LossUnrealized = '10000000' }],
    ['the issuance answered at another ledger', (w) => { w.answerLedger.issuance = w.L + 1 }, (w) => { delete w.answerLedger.issuance }],
  ]) {
    const w = world()
    const s = signerFor(w)
    const a = await requestFor(w, pledge(w, collateralAccount(w)))
    s.requests.set(a.act.actionId, a.signed)
    spoil(w)
    const r = await tryApprove(s, a.act)
    eq(`${name}: 409 INCONSISTENT_SNAPSHOT, logged refused, nothing submitted`, [r.code, s.decisions.entries().map((e) => [e.decision, e.code]), s.submitted.length], ['INCONSISTENT_SNAPSHOT', [['refused', 'INCONSISTENT_SNAPSHOT']], 0])
    restore(w)
  }

  console.log('ESCROW_POLICY')
  const policyCase = async (name, setup, { want = 'ESCROW_POLICY', reason } = {}) => {
    const w = world()
    const s = signerFor(w)
    const { escrow, requestOpts } = await setup(w, s)
    const a = await requestFor(w, escrow, requestOpts)
    s.requests.set(a.act.actionId, a.signed)
    const r = await tryApprove(s, a.act)
    const ok = want === 'ok' ? r.ok : r.code === want && s.submitted.length === 0 && (!reason || r.message.includes(reason))
    eq(name, ok, true)
    if (!ok) console.log(`         ${r.code ?? 'approved'} ${r.message ?? ''}`)
    return { w, s, a, r }
  }
  await policyCase('the destination is the desk owner (the old rule)', async (w) => {
    w.accounts.set(W.deskOwner.address, { root: { Account: W.deskOwner.address, Flags: 0, OwnerCount: 9, Sequence: 1 }, objects: [] })
    return { escrow: pledge(w, W.deskOwner.address) }
  })
  await policyCase('a collateral account whose master key is enabled', async (w) => ({ escrow: pledge(w, collateralAccount(w, { flags: 0 })) }), { reason: 'master key enabled' })
  await policyCase('a collateral account with a RegularKey', async (w) => ({ escrow: pledge(w, collateralAccount(w, { regularKey: W.stranger.address })) }), { reason: 'regular key set' })
  await policyCase('a collateral account of quorum 1', async (w) => ({ escrow: pledge(w, collateralAccount(w, { quorum: 1 })) }), { reason: 'quorum is not 2' })
  await policyCase('a collateral account signed by {borrower, desk, a third party}', async (w) => ({ escrow: pledge(w, collateralAccount(w, { signers: [W.borrower, W.deskOwner, W.stranger] })) }), { reason: 'signers are not' })
  await policyCase('a collateral account with no MPToken of the share', async (w) => ({ escrow: pledge(w, collateralAccount(w, { mptoken: false })) }), { reason: 'no MPToken' })
  await policyCase('a collateral account already named by another pledge escrow', async (w) => {
    const acct = collateralAccount(w)
    pledge(w, acct)
    return { escrow: pledge(w, acct) }
  }, { reason: 'account already used by another pledge' })
  await policyCase('a conforming collateral account with lsfDepositAuth', async (w) => ({ escrow: pledge(w, collateralAccount(w, { flags: 0x00100000 | 0x01000000 })) }), { reason: 'deposit authorization enabled' })
  await policyCase('a collateral account of OwnerCount 3, a Delegate', async (w) => ({ escrow: pledge(w, collateralAccount(w, { ownerCount: 3, extraObjects: [{ LedgerEntryType: 'Delegate', Account: 'x' }] })) }), { reason: 'account holds other ledger objects' })
  await policyCase('CancelAfter − FinishAfter is not the policy\'s offset', async (w) => {
    const fa = w.closeTime - 60 + PLAN.paymentInterval + PLAN.gracePeriod + POLICY.finishAfterMarginSeconds
    return { escrow: pledge(w, collateralAccount(w), { finishAfter: fa, cancelAfter: fa + 3600 }) }
  }, { reason: 'not the policy' })
  const floor = (w) => w.closeTime + PLAN.paymentInterval + PLAN.gracePeriod + POLICY.approvalSlackSeconds
  await policyCase('FinishAfter a second under its floor', async (w) => ({ escrow: pledge(w, collateralAccount(w), { finishAfter: floor(w) - 1 }) }), { reason: 'finished before the loan can default' })
  await policyCase('FinishAfter exactly at its floor: accepted', async (w) => ({ escrow: pledge(w, collateralAccount(w), { finishAfter: floor(w) }) }), { want: 'ok' })
  await policyCase('FinishAfter a second above its ceiling', async (w) => ({ escrow: pledge(w, collateralAccount(w), { finishAfter: w.closeTime + PLAN.paymentInterval + PLAN.gracePeriod + POLICY.finishAfterMarginSeconds + 1 }) }), { reason: 'later than the policy allows' })
  await policyCase('a signed LoanSet of PaymentTotal 3: its last payment after CancelAfter', async (w) => ({ escrow: pledge(w, collateralAccount(w)), requestOpts: { paymentTotal: 3 } }), { reason: 'loan matures after the escrow can be cancelled' })
  await policyCase('an escrow with a crypto-condition', async (w) => ({ escrow: pledge(w, collateralAccount(w), { condition: 'A0258020' + 'E3'.repeat(32) + '810100' }) }), { reason: 'crypto-condition' })
  await policyCase('an escrow a validated desk LoanSet already names', async (w) => {
    const escrow = pledge(w, collateralAccount(w))
    w.txs.set(W.borrower.address, [loanSetEntry(escrow.index, DESK_BROKER, 'tesSUCCESS', hex64('C'))])
    return { escrow }
  }, { reason: 'escrow already backs loan' })
  {
    // an approval of this process, its LoanSet not yet validated on the ledger
    const w = world()
    const s = signerFor(w)
    const escrow = pledge(w, collateralAccount(w))
    const first = await requestFor(w, escrow)
    s.requests.set(first.act.actionId, first.signed)
    await tryApprove(s, first.act)
    const second = await requestFor(w, escrow)
    s.requests.set(second.act.actionId, second.signed)
    const r = await tryApprove(s, second.act)
    eq('an escrow this process countersigned, its LoanSet not yet validated: ESCROW_POLICY, escrow already backs loan', [r.code, r.message.includes('escrow already backs loan'), s.submitted.length], ['ESCROW_POLICY', true, 1])
  }
  {
    const { s, a } = await policyCase('a conforming escrow of shares of a vault in an IOU: "vault asset is not XRP" in the message', async (w) => (
      { escrow: pledge(w, collateralAccount(w, { share: IOU_SHARE }), { share: IOU_SHARE }), requestOpts: { share: IOU_SHARE } }
    ), { reason: 'vault asset is not XRP' })
    const preview = await s.signer.previewApprove({ actionOfRequest: a.act })
    eq('... and in the collateral reasons of the preview', [preview.collateral.conforming, preview.collateral.reasons.some((x) => x.startsWith('vault asset is not XRP'))], [false, true])
  }

  console.log('foreign attachments that block nothing')
  await policyCase('an escrow named only by a tesSUCCESS LoanSet on the borrower\'s own broker: approved', async (w) => {
    const escrow = pledge(w, collateralAccount(w))
    w.txs.set(W.borrower.address, [loanSetEntry(escrow.index, hex64('F'), 'tesSUCCESS', hex64('C'))])
    return { escrow }
  }, { want: 'ok' })
  await policyCase('an escrow named only by a desk LoanSet that ended tec: approved', async (w) => {
    const escrow = pledge(w, collateralAccount(w))
    w.txs.set(W.borrower.address, [loanSetEntry(escrow.index, DESK_BROKER, 'tecINSUFFICIENT_FUNDS', hex64('C'))])
    return { escrow }
  }, { want: 'ok' })
  await policyCase('a conforming escrow whose account also holds a third party\'s XRP escrow: approved', async (w) => {
    const acct = collateralAccount(w)
    const foreign = { index: hex64('3'), LedgerEntryType: 'Escrow', Account: W.stranger.address, Destination: acct, Amount: '1' }
    w.accounts.get(acct).objects.push(foreign)
    return { escrow: pledge(w, acct) }
  }, { want: 'ok' })

  console.log('two escrows alike, each named by its own request')
  {
    const w = world()
    const s = signerFor(w)
    const older = pledge(w, collateralAccount(w), { finishAfter: floor(w) - 30 }) // under the floor
    const newer = pledge(w, collateralAccount(w))
    const ro = await requestFor(w, older)
    const rn = await requestFor(w, newer)
    s.requests.set(ro.act.actionId, ro.signed)
    s.requests.set(rn.act.actionId, rn.signed)
    const gone = { index: hex64('6'), owner: W.borrower.address, offerSequence: 1, destination: collateralAccount(w) }
    const rg = await requestFor(w, gone)
    s.requests.set(rg.act.actionId, rg.signed)
    const results = [await tryApprove(s, rn.act), await tryApprove(s, ro.act), await tryApprove(s, rg.act)]
    eq('the newer is approved, the older and a vanished index get ESCROW_POLICY, one submission', [results.map((x) => x.ok || x.code), s.submitted.length], [[true, 'ESCROW_POLICY', 'ESCROW_POLICY'], 1])
    eq('each entry at the ledger of its decision (I2)', s.decisions.entries().every((e) => e.ledgerIndex === w.L && e.ledgerHash === hashOf(w.L)), true)
    eq('the chain holds', s.decisions.verifyChain(), { ok: true })
    const file = join(s.dir, 'decisions.jsonl')
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace('"decision":"refused"', '"decision":"refuses"'))
    eq('altered by one byte: verifyChain names the first bad entry', s.decisions.verifyChain(), { ok: false, firstBadSeq: 2 })
  }
}

/** A validated LoanSet entry of account_tx that names `escrowIndex` and creates a Loan on `broker`. */
function loanSetEntry(escrowIndex, broker, result, hash) {
  return {
    hash, ledger_index: 990, validated: true,
    tx_json: { TransactionType: 'LoanSet', Account: W.borrower.address, LoanBrokerID: broker, Memos: [{ Memo: { MemoType: hex('orma.escrow'), MemoData: escrowIndex } }] },
    meta: { TransactionResult: result, AffectedNodes: result === 'tesSUCCESS' ? [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: hex64('2'), NewFields: { LoanBrokerID: broker } } }] : [] },
  }
}

// --- through the role engine, in memory ----------------------------------------------------------------------

async function engineCases() {
  console.log('the role engine in memory')
  const ORIGIN = 'https://ormaprotocol.com'
  const harbor = (label) => ({ label, vaultId: hex64(label.at(-1)), shareMptId: label === 'harbor-1' ? SHARE : hex64(label.at(-1)).slice(0, 48), loanBrokerId: HARBOR_BROKER, owner: W.broker.address, loans: { L1, L2: hex64('2') } })
  const setup = async ({ mandate = PASSING, simulate } = {}) => {
    const w = world()
    w.mandate = mandate
    const pool = [collateralAccount(w), collateralAccount(w), collateralAccount(w)]
    const VAULTS = {
      'harbor-1': harbor('harbor-1'), 'harbor-2': harbor('harbor-2'), 'harbor-3': harbor('harbor-3'),
      desk: { label: 'desk', ...DESK, loans: { L1: null, L2: null }, collateral: { ...DESK.collateral, quorum: 2, accounts: { 'harbor-1': pool, 'harbor-2': [], 'harbor-3': [] } } },
      spare: { label: 'spare', ...SPARE, loans: { L1: null, L2: null } },
    }
    const simulated = []
    const engine = createRoleEngine({
      reader: {}, xrpl: w.xrpl, env: { ALLOWED_WRITE_ORIGINS: ORIGIN }, accounts: { ...W }, vaults: VAULTS, mandate: () => mandate,
      simulate: simulate ?? (async (tx) => { simulated.push(tx); return { engine_result: 'tesSUCCESS' } }),
      submit: async (tx) => {
        // the engine's own submissions: the pledges; the escrow appears on the fake ledger
        const acct = w.accounts.get(tx.Account)
        if (tx.TransactionType === 'EscrowCreate') pledge(w, tx.Destination, { sequence: tx.Sequence, finishAfter: tx.FinishAfter, cancelAfter: tx.CancelAfter })
        if (acct) acct.root.Sequence++
        return { txHash: hex64('5'), engineResult: 'tesSUCCESS', ledgerIndex: w.L }
      },
    })
    const s = signerFor(w, { mandate }) // its log and the record of what the desk submitted
    const signer = createSigner({
      xrpl: w.xrpl, reader: w.reader, wallet: W.deskOwner, decisions: s.decisions, readDesk: () => DESK, readSpare: () => SPARE, readMandate: () => mandate,
      loanSetOf: (id) => engine.loanSetOf(id), lookupTx: async () => null, confirmWindowMs: 30,
      submit: async (blob) => {
        s.submitted.push(blob)
        return { txHash: hashes.hashSignedTx(blob), engineResult: 'tesSUCCESS', ledgerIndex: w.L + 1, meta: { AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: hex64('7') } }] } }
      },
    })
    registerDeskActions(engine, { signer, deskAddress: () => W.deskOwner.address, borrower: () => W.borrower })
    const nyc = { handle: withDeskErrors((...a) => engine.handle(...a)) }
    const demo = { run: async () => engine.newRun(), kill: async () => { engine.kill(); return {} }, unkill: async () => { engine.unkill(); return {} } }
    const api = createApi({ serverTime: '2026-10-24T00:00:00Z', ledgerIndex: 1000, snapshots: new Map(), vaultIds: [], missing: new Set(), all: () => [] }, { port: 0, nyc, demo })
    await api.listen()
    const port = api.server.address().port
    const call = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
      const headers = { 'content-type': 'application/json' }
      if (token) headers.authorization = `Bearer ${token}`
      const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }))
      })
      r.on('error', reject)
      if (body) r.write(JSON.stringify(body))
      r.end()
    })
    const { body: run } = await call('POST', '/api/demo/run')
    const t = run.token
    const post = (role, action, body) => call('POST', `/api/roles/${run.runId}/${role}/${action}`, { token: t, body })
    const confirm = (actionId) => call('POST', `/api/roles/${run.runId}/actions/${actionId}/confirm`, { token: t })
    const get = (actionId) => call('GET', `/api/roles/${run.runId}/actions/${actionId}`)
    const until = async (actionId, states) => {
      for (let i = 0; i < 200; i++) {
        const a = (await get(actionId)).body
        if (states.includes(a?.state)) return a
        await sleep(10)
      }
      return (await get(actionId)).body
    }
    /**
     * n pledgeEscrows, then n requestLoans on spare: the actionIds of requests awaiting approval. Every
     * pledge comes first, so that each signed LoanSet carries the borrower's current Sequence.
     */
    const openRequests = async (n) => {
      const tk = await ticketOf(w, SHARE, mandate)
      const body = { vault: 'spare', share: SHARE, ticketId: tk.ticketId, inputsDigest: tk.inputsDigest, units: PLAN.units }
      const pledges = []
      for (let i = 0; i < n; i++) {
        const p = await post('borrower', 'pledgeEscrow', body)
        await confirm(p.body.actionId)
        await until(p.body.actionId, ['validated', 'failed'])
        pledges.push(p.body.actionId)
      }
      const out = []
      for (const id of pledges) out.push((await post('borrower', 'requestLoan', { ...body, pledgeActionId: id })).body.actionId)
      return out
    }
    const openRequest = async () => (await openRequests(1))[0]
    return { w, s, api, call, post, confirm, get, until, request: openRequest, requests: openRequests, simulated, engine }
  }

  {
    const e = await setup({ mandate: TIGHT })
    const req = await e.request()
    const p = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: req })
    eq('approve POST on a tight mandate: 202, preview.money.verdict BREACHED, nothing submitted nor logged', [p.status, p.body.preview?.money?.verdict?.status, e.s.submitted.length, e.s.decisions.entries().length], [202, 'BREACHED', 0, 0])
    const c = await e.confirm(p.body.actionId)
    eq('its confirm: 409 BREACHED, logged refused', [c.status, c.body.error?.code, e.s.decisions.entries().map((x) => [x.decision, x.code])], [409, 'BREACHED', [['refused', 'BREACHED']]])
    await e.api.close()
  }
  {
    const signedRefused = []
    const e = await setup({ simulate: async (tx) => { signedRefused.push(tx); if (tx.TxnSignature) throw Object.assign(new Error('rpcTX_SIGNED'), { data: { error: 'rpcTX_SIGNED' } }); return { engine_result: 'tesSUCCESS' } } })
    const req = await e.request()
    const before = signedRefused.length
    const p = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: req })
    eq('approve POST on a passing mandate: 202, PASS, not-simulated, DECLARED, simulate never called', [p.status, p.body.preview?.money?.verdict?.status, p.body.preview?.engineResult, p.body.preview?.provenance, signedRefused.length - before], [202, 'PASS', 'not-simulated (awaiting countersignature)', 'DECLARED', 0])
    eq('the money line: principal, held value, LTV, the 1:1 column, escrow, collateral, digest, sequence', Object.keys(p.body.preview.money).filter((k) => ['principalDrops', 'collateralHeldDrops', 'ltvHeldBps', 'maxLtvBps', 'verdict', 'breaches', 'ltv1to1Bps', 'verdict1to1', 'escrow', 'collateral', 'digest', 'sequence'].includes(k)).length, 12)
    const c = await e.confirm(p.body.actionId)
    const done = await e.until(p.body.actionId, ['validated'])
    eq('its confirm: 202, the approve and the request validated, approved in the log', [c.status, done?.state, (await e.get(req)).body.state, e.s.decisions.entries().map((x) => x.decision), e.s.decisions.verifyChain().ok], [202, 'validated', 'validated', ['approved'], true])
    const again = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: req })
    eq('an approved request cannot be approved again: 404', again.status, 404)
    await e.api.close()
  }
  {
    const e = await setup()
    const req = await e.request()
    e.w.vault.LossUnrealized = '15000001'
    const p = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: req })
    eq('an inconsistent snapshot at the approve POST: 409, no action kept, nothing logged', [p.status, p.body.error?.code, e.s.decisions.entries().length], [409, 'INCONSISTENT_SNAPSHOT', 0])
    e.w.vault.LossUnrealized = '10000000'
    e.w.answerLedger.issuance = e.w.L + 1
    const p2 = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: req })
    eq('an issuance at another ledger at the approve POST: 409, nothing logged', [p2.status, p2.body.error?.code, e.s.decisions.entries().length], [409, 'INCONSISTENT_SNAPSHOT', 0])
    delete e.w.answerLedger.issuance
    const p3 = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: req })
    e.w.vault.LossUnrealized = '15000001'
    const c3 = await e.confirm(p3.body.actionId)
    eq('consistent at the POST, inconsistent at the confirm: 409, logged refused, nothing submitted', [p3.status, c3.status, c3.body.error?.code, e.s.decisions.entries().map((x) => [x.decision, x.code]), e.s.submitted.length], [202, 409, 'INCONSISTENT_SNAPSHOT', [['refused', 'INCONSISTENT_SNAPSHOT']], 0])
    await e.api.close()
  }
  {
    // kill: one approve caught during its review, one queued behind it on the desk owner's queue
    const e = await setup()
    const [r1, r2] = await e.requests(2)
    const a1 = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: r1 })
    const a2 = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: r2 })
    let release
    e.w.gate = new Promise((r) => { release = r })
    const c1 = e.confirm(a1.body.actionId)
    const c2 = e.confirm(a2.body.actionId)
    await e.until(a1.body.actionId, ['approving'])
    await e.until(a2.body.actionId, ['approving'])
    await e.call('POST', '/api/demo/kill')
    e.w.gate = null
    release()
    const [k1, k2] = await Promise.all([c1, c2])
    eq('kill during the review, and behind it in the queue: both 423 LOCKED, no loan, nothing submitted', [k1.status, k2.status, k1.body.error?.code, k2.body.error?.code, e.s.submitted.length], [423, 423, 'LOCKED', 'LOCKED', 0])
    await e.call('POST', '/api/demo/unkill')
    await e.api.close()
  }
  {
    // a decline posted during an approve
    const e = await setup()
    const req = await e.request()
    const a = await e.post('riskOfficer', 'approve', { vault: 'spare', requestActionId: req })
    const d = await e.post('riskOfficer', 'decline', { vault: 'spare', requestActionId: req })
    let release
    e.w.gate = new Promise((r) => { release = r })
    const ca = e.confirm(a.body.actionId)
    await e.until(a.body.actionId, ['approving'])
    const cd = await e.confirm(d.body.actionId)
    e.w.gate = null
    release()
    await ca
    const cd2 = await e.confirm(d.body.actionId)
    eq('the decline confirm during approving: 404; after the approval, never declined', [cd.status, cd2.status, e.s.decisions.entries().map((x) => x.decision)], [404, 404, ['approved']])
    await e.api.close()
  }
}

// --- live ----------------------------------------------------------------------------------------------------

async function live() {
  const base = process.env.API_BASE
  const vaultArg = process.argv[process.argv.indexOf('--vault') + 1]
  if (!base || vaultArg !== 'spare') {
    console.log('  FAIL --live --vault spare runs under src/dev/with-api.mjs')
    bad++
    return
  }
  const read = (n) => JSON.parse(readFileSync(`demo/${n}.json`, 'utf8'))
  const h1 = read('harbor-1')
  const desk = read('desk')
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
    return { status: r.status, body: await r.json() }
  }
  const ticket = await call('GET', `/api/tickets?share=${h1.shareMptId}&op=pledge&units=${desk.plannedLoan.units}&mandate=desk-1`)
  if (ticket.body.verdict?.status !== 'PASS') {
    console.log(`  FAIL harbor-1 ticket is ${ticket.body.verdict?.status ?? ticket.body.error?.code}: this line proves step 10 only before the first defaultL2 on harbor-1; nothing was pledged`)
    bad++
    return
  }
  const { body: run } = await call('POST', '/api/demo/run')
  const t = run.token
  const role = (r, a, body) => call('POST', `/api/roles/${run.runId}/${r}/${a}`, { token: t, body })
  const confirm = (id) => call('POST', `/api/roles/${run.runId}/actions/${id}/confirm`, { token: t })
  const until = async (id, states, ms = 120000) => {
    const end = Date.now() + ms
    for (;;) {
      const a = (await call('GET', `/api/roles/${run.runId}/actions/${id}`)).body
      if (states.includes(a.state) || Date.now() > end) return a
      await sleep(2000)
    }
  }
  const body = { vault: 'spare', share: h1.shareMptId, ticketId: ticket.body.ticketId, inputsDigest: ticket.body.inputsDigest, units: desk.plannedLoan.units }
  const p = await role('borrower', 'pledgeEscrow', body)
  eq('pledgeEscrow previewed', p.status, 202)
  if (p.status !== 202) return console.log(`         ${JSON.stringify(p.body.error)}`)
  await confirm(p.body.actionId)
  const pledged = await until(p.body.actionId, ['validated', 'failed'])
  eq('pledgeEscrow validated, its escrow known', [pledged.state, /^[0-9A-F]{64}$/.test(pledged.escrow?.index ?? '')], ['validated', true])
  if (pledged.state !== 'validated') return console.log(`         ${pledged.engineResult}`)
  const rq = await role('borrower', 'requestLoan', { ...body, pledgeActionId: p.body.actionId })
  eq('requestLoan signed by the borrower, awaiting approval', [rq.status, rq.body.preview?.money?.escrowIndex], [202, pledged.escrow.index])
  if (rq.status !== 202) return console.log(`         ${JSON.stringify(rq.body.error)}`)
  const ap = await role('riskOfficer', 'approve', { vault: 'spare', requestActionId: rq.body.actionId })
  eq('approve previewed: PASS, escrow ok, collateral conforming', [ap.status, ap.body.preview?.money?.verdict?.status, ap.body.preview?.money?.escrow, ap.body.preview?.money?.collateral?.conforming], [202, 'PASS', 'ok', true])
  if (ap.status !== 202 || ap.body.preview?.money?.escrow !== 'ok') return console.log(`         ${JSON.stringify(ap.body.error ?? ap.body.preview?.money)}`)
  const c = await confirm(ap.body.actionId)
  const approved = await until(ap.body.actionId, ['validated', 'failed', 'refused'])
  eq('approve confirmed: the LoanSet tesSUCCESS on spare', [c.status, approved.state, approved.engineResult], [202, 'validated', 'tesSUCCESS'])
  if (approved.state !== 'validated') return console.log(`         ${JSON.stringify(c.body.error ?? approved)}`)
  const dec = await call('GET', '/api/desk/decisions')
  const last = dec.body.entries?.at(-1)
  eq('the decision log: approved last, with the LoanSet hash, the chain whole', [last?.decision, last?.txHash, dec.body.chain], ['approved', approved.txHash, { ok: true }])
  let line = null
  for (let i = 0; i < 10 && !line; i++) {
    const pos = await call('GET', '/api/desk/positions')
    line = pos.body.positions?.find((x) => x.loanSetTxHash === approved.txHash) ?? null
    if (!line) await sleep(4000)
  }
  eq('positions list the new loan with its LoanSet hash and the escrow its Memo names', [Boolean(line), line?.collateral?.[0]?.escrowId], [true, pledged.escrow.index])
}

// --- run ---------------------------------------------------------------------------------------------------

if (process.argv.includes('--live')) await live()
else {
  await signerCases()
  await engineCases()
}
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
