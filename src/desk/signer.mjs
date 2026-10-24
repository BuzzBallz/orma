/**
 * The desk signs for real, but only after it has read the ledger again and recomputed the ticket. At
 * the validated ledger L of the decision it reads the escrow the request names, and that one alone (its
 * index, the LoanSet's orma.escrow Memo), the 2-of-3 account it pays into, the pledged share, the
 * borrower's account and the ticket's inputs; it countersigns the borrower's LoanSet only if the escrow
 * meets the policy, the inputsDigest is the one the request kept, the mandate's verdict is PASS and the
 * borrower's Sequence still matches (I2). An inconsistent snapshot refuses before any figure (I7). Every
 * outcome, approved, refused or declined, goes to the chained decision log with L and its hash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashes, signLoanSetByCounterparty } from 'xrpl'
import { num } from '../num.mjs'
import { logger } from '../log.mjs'
import { COLLATERAL_STAGES, judgeCollateralAccount, judgeCollateralShare, NYC_ERRORS } from '../nyc/contracts.mjs'
import { readTicketInputs, readCollateralAccount, allPages, PageLimitError, SnapshotError } from '../ticket/inputs.mjs'
import { buildTicket } from '../ticket/engine.mjs'
import { openLog } from './decision-log.mjs'

const log = logger('desk:signer')
const MEMO_ESCROW = Buffer.from('orma.escrow', 'utf8').toString('hex').toUpperCase()
const MEMO_TICKET = Buffer.from('orma.ticket', 'utf8').toString('hex').toUpperCase()
/** A re-signed LoanSet waits for a human approval: about 30 to 40 minutes, like the first one. */
const LOANSET_WINDOW = 600
/** Closer than this to its LastLedgerSequence, a LoanSet would expire before it is included. */
const EXPIRY_MARGIN = 10

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A refusal with its HTTP status, which the role engine's handle passes through withDeskErrors. */
export class DeskError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.name = 'DeskError'
    Object.assign(this, { status, code, extra, retryable: NYC_ERRORS[code]?.retryable ?? (status === 503 || status === 423) })
  }
}

/**
 * The role engine answers 409 for any code a registered handler returns, and lets any other error
 * through untouched: this wraps its handle so that a DeskError from the desk's handlers leaves with its
 * own status (404 during an approval, 409 with the refusal, 423 LOCKED, 503 NOT_CONFIGURED), after the
 * engine has set the CORS headers of the write policy.
 */
export function withDeskErrors(handle) {
  return async (req, res, url, helpers) => {
    try {
      return await handle(req, res, url, helpers)
    } catch (e) {
      if (!(e instanceof DeskError)) throw e
      helpers.send(e.status, { error: { code: e.code, message: e.message, retryable: e.retryable, ...e.extra } })
      return true
    }
  }
}

const notConfigured = (why) => new DeskError(503, 'NOT_CONFIGURED', `${why}; desk approvals are not configured on this server.`)

/**
 * @param {{
 *   xrpl: any, reader: any, wallet: any,
 *   submit?: (blob: string) => Promise<{ txHash: string|null, engineResult: string, ledgerIndex: number|null }>,
 *   lookupTx?: (hash: string) => Promise<any|null>,
 *   readDesk?: () => any, readSpare?: () => any, readMandate?: () => any,
 *   decisions?: ReturnType<typeof openLog>, logPath?: string, loanSetOf?: (actionId: string) => any, confirmWindowMs?: number, demoDir?: string,
 * }} deps
 */
export function createSigner({ xrpl, reader, wallet, submit, lookupTx, readDesk, readSpare, readMandate, decisions, logPath, loanSetOf, confirmWindowMs = 60_000, demoDir = 'demo' }) {
  const readDemo = (label) => JSON.parse(readFileSync(join(demoDir, `${label}.json`), 'utf8'))
  readDesk ??= () => readDemo('desk')
  readSpare ??= () => readDemo('spare')
  readMandate ??= () => readDemo('mandate-desk-1')
  let journal = decisions ?? null
  const decisionsLog = () => (journal ??= openLog(logPath)) // opened at the first decision, never at construction
  /** escrow index -> { txHash } of each LoanSet this process countersigned and saw succeed */
  const countersigned = new Map()
  /** requestLoan actionId -> the LoanSet a rerequest signed again, which replaces the request's */
  const resigned = new Map()

  lookupTx ??= async (hash) => {
    try {
      const r = await xrpl.req({ command: 'tx', transaction: hash })
      return r.result.validated ? r.result : null
    } catch (e) {
      if (e?.data?.error === 'txnNotFound') return null
      throw e
    }
  }
  /** Submit, then follow by hash until validated; a tem, tef or tel never applies and returns at once. */
  submit ??= async (blob) => {
    const hash = hashes.hashSignedTx(blob)
    const r = await xrpl.req({ command: 'submit', tx_blob: blob })
    const prelim = r.result.engine_result
    if (/^(tem|tef|tel)/.test(prelim)) return { txHash: hash, engineResult: prelim, ledgerIndex: null }
    const until = Date.now() + confirmWindowMs
    while (Date.now() < until) {
      const v = await lookupTx(hash)
      if (v) return { txHash: hash, engineResult: v.meta?.TransactionResult, ledgerIndex: v.ledger_index, meta: v.meta }
      await sleep(1500)
    }
    throw new Error(`the countersigned LoanSet ${hash} was not seen validated within ${confirmWindowMs / 1000} s`)
  }

  const signedOf = (act) => resigned.get(act.actionId) ?? loanSetOf?.(act.actionId) ?? null

  /** The validated ledger L the decision reads, with its hash and close_time. */
  async function ledgerNow() {
    await xrpl.closeTime()
    return { ledgerIndex: xrpl.lastLedger, ledgerHash: xrpl.lastLedgerHash ?? null, closeTime: xrpl.lastCloseTime }
  }

  const entryAt = async (params, L) => {
    try {
      return (await xrpl.req({ command: 'ledger_entry', ...params, ledger_index: L })).result.node
    } catch (e) {
      if (e?.data?.error === 'entryNotFound' || e?.data?.error === 'objectNotFound') return null
      throw e
    }
  }

  /** Whether a desk LoanSet validated tesSUCCESS up to L, or an approval of this process, already names the escrow. */
  async function backing(escrowIndex, borrower, L, brokerIds) {
    const mine = countersigned.get(escrowIndex.toUpperCase())
    if (mine) return `escrow already backs loan ${mine.loanId ?? `countersigned in ${mine.txHash}`}`
    let txs
    try {
      txs = await allPages(xrpl, { command: 'account_tx', account: borrower, ledger_index_min: -1, ledger_index_max: L, limit: 400 }, 'transactions', null, `the history of ${borrower}`)
    } catch (e) {
      if (e instanceof PageLimitError) return `${e.message}: whether the escrow already backs a loan cannot be told`
      throw e
    }
    for (const e of txs) {
      const t = e.tx_json ?? e.tx ?? {}
      if (t.TransactionType !== 'LoanSet' || e.meta?.TransactionResult !== 'tesSUCCESS') continue
      const loan = (e.meta.AffectedNodes ?? []).map((n) => n.CreatedNode).find((c) => c?.LedgerEntryType === 'Loan')
      if (!loan || !brokerIds.has(String(loan.NewFields?.LoanBrokerID ?? t.LoanBrokerID).toUpperCase())) continue
      const memo = (t.Memos ?? []).map((m) => m.Memo).find((m) => same(m?.MemoType, MEMO_ESCROW))
      if (memo && same(memo.MemoData, escrowIndex)) return `escrow already backs loan ${loan.LedgerIndex}`
    }
    return null
  }

  /**
   * Everything the decision reads, at one ledger: the escrow, its account, the share, the recomputed
   * ticket, the digest and the Sequence. Throws SnapshotError on I7, DeskError on a configuration fault.
   */
  async function review(act, at = null) {
    let desk, spare, mandate
    try {
      desk = readDesk()
      spare = readSpare()
      mandate = readMandate()
    } catch {
      throw notConfigured('demo/desk.json, demo/spare.json or demo/mandate-desk-1.json is missing or unreadable')
    }
    if (!wallet || wallet.address !== desk.owner) throw notConfigured('DESK_SEED is not the seed of the desk owner')
    const signed = signedOf(act)
    if (!signed) throw new DeskError(404, 'NOT_FOUND', 'The loan request keeps no signed LoanSet.')
    const tx = signed.tx
    const L = at ?? (await ledgerNow())
    const share = String(act.ticket.share).toUpperCase()
    const escrowIndex = String(act.escrow.index).toUpperCase()
    const policy = mandate.policy
    const reasons = []
    let collateral = { address: null, conforming: false, reasons: [] }

    const escrow = await entryAt({ index: escrowIndex }, L.ledgerIndex)
    if (!escrow) reasons.push('the escrow the request names is no longer on the ledger (finished or cancelled)')
    else {
      const backs = await backing(escrowIndex, tx.Account, L.ledgerIndex, new Set([desk.loanBrokerId, spare.loanBrokerId].map((b) => String(b).toUpperCase())))
      if (backs) reasons.push(backs)
      if (escrow.Account !== tx.Account) reasons.push("the escrow is not the borrower's")
      if (!same(escrow.Amount?.mpt_issuance_id, share) || String(escrow.Amount?.value) !== String(act.ticket.units)) reasons.push('the escrow does not hold the shares of the ticket')
      const read = await readCollateralAccount(xrpl, {
        address: escrow.Destination, shareMptId: share, at: L, borrower: tx.Account, desk: desk.owner, agent: desk.collateral?.agent, namedEscrow: escrowIndex,
      })
      const judged = judgeCollateralAccount(read.raw, { borrower: tx.Account, desk: desk.owner, agent: desk.collateral?.agent, shareMptId: share, ...COLLATERAL_STAGES.pledged, namedEscrow: escrowIndex })
      const accountReasons = read.reasons.length && !judged.reasons.length ? read.reasons : judged.reasons
      const vaultOfShare = reader.getByShareMpt(share)
      const vault = vaultOfShare ? (await xrpl.req({ command: 'vault_info', vault_id: vaultOfShare.vaultId, ledger_index: L.ledgerIndex })).result.vault : null
      const issuance = await entryAt({ mpt_issuance: share }, L.ledgerIndex)
      const mptoken = await entryAt({ mptoken: { mpt_issuance_id: share, account: tx.Account } }, L.ledgerIndex)
      const eligible = judgeCollateralShare({ vault, issuance, mptoken })
      collateral = { address: escrow.Destination, conforming: accountReasons.length === 0 && eligible.eligible, reasons: [...accountReasons, ...eligible.reasons] }
      if (accountReasons.length) reasons.push(`the collateral account ${escrow.Destination} does not conform: ${accountReasons.join('; ')}`)
      if (!eligible.eligible) reasons.push(`The pledged share is not eligible as collateral: ${eligible.reasons.join('; ')}`)
      if (escrow.Condition) reasons.push('escrow carries a crypto-condition')
      const pi = num(tx.PaymentInterval)
      const gp = num(tx.GracePeriod)
      const total = num(tx.PaymentTotal ?? 1)
      const finish = num(escrow.FinishAfter)
      const cancel = num(escrow.CancelAfter)
      const floor = num(L.closeTime).plus(pi).plus(gp).plus(policy.approvalSlackSeconds)
      const ceiling = num(L.closeTime).plus(pi).plus(gp).plus(policy.finishAfterMarginSeconds)
      if (finish.lt(floor)) reasons.push('escrow can be finished before the loan can default')
      if (finish.gt(ceiling)) reasons.push('escrow finishes later than the policy allows')
      if (!cancel.minus(finish).eq(policy.cancelAfterOffsetSeconds)) reasons.push(`escrow can be cancelled ${cancel.minus(finish).toFixed()} s after FinishAfter, not the policy's ${policy.cancelAfterOffsetSeconds} s`)
      if (cancel.lt(num(L.closeTime).plus(pi.times(total)).plus(gp).plus(policy.approvalSlackSeconds))) reasons.push('loan matures after the escrow can be cancelled')
    }

    const inputs = await readTicketInputs(xrpl, { shareMptId: share, reader, at: L })
    const ticket = buildTicket(inputs, { op: 'pledge', units: act.ticket.units, mandate, principalDrops: String(tx.PrincipalRequested) })
    const digest = ticket.inputsDigest === act.ticket.inputsDigest ? 'same' : 'STALE'

    let sequence = 'ok'
    let sequenceReason = null
    const root = (await xrpl.req({ command: 'account_info', account: tx.Account, ledger_index: L.ledgerIndex })).result.account_data
    if (num(root.Sequence).gt(tx.Sequence)) {
      sequence = 'SEQUENCE_PASSED'
      sequenceReason = "Another transaction of the borrower's account has used the Sequence of the signed loan request. Re-request the loan to sign it again. Nothing was sent."
    } else if (num(L.ledgerIndex).gte(num(tx.LastLedgerSequence).minus(EXPIRY_MARGIN))) {
      sequence = 'SEQUENCE_PASSED'
      sequenceReason = "The borrower's signed loan request expires before it can be countersigned. Re-request the loan to sign it again. Nothing was sent."
    }
    return { L, desk, mandate, signed, tx, escrowIndex, escrow: reasons.length ? 'ESCROW_POLICY' : 'ok', escrowReasons: reasons, collateral, ticket, digest, sequence, sequenceReason }
  }

  function append(act, mandate, L, decision, extra = {}) {
    const entry = decisionsLog().append({ ticketId: act.ticket.ticketId, mandateHash: mandate.hash, decision, ledgerIndex: L.ledgerIndex, ledgerHash: L.ledgerHash, ...extra })
    log.info(`decision ${decision}`, { ticketId: act.ticket.ticketId, actionId: act.actionId, ledgerIndex: L.ledgerIndex, code: extra.code ?? null, txHash: extra.txHash ?? null, seq: entry.seq })
    return entry
  }

  /**
   * The approval: every check again at the ledger of the confirm, then the countersignature and the
   * submission. Resolves to { txHash, engineResult, ledgerIndex, loanId } on a LoanSet that reached the
   * ledger (tesSUCCESS or a tec, both logged approved); throws a DeskError on every refusal, logged first.
   * @param {{ actionOfRequest: any, ticketId?: string, stopped?: () => boolean }} o
   */
  async function approve({ actionOfRequest: act, stopped = () => false }) {
    let r
    let L = null
    let mandate = null
    try {
      L = await ledgerNow()
      try {
        mandate = readMandate()
      } catch {
        throw notConfigured('demo/mandate-desk-1.json is missing or unreadable')
      }
      r = await review(act, L)
    } catch (e) {
      if (e instanceof SnapshotError) {
        append(act, mandate, { ledgerIndex: e.ledgerIndex, ledgerHash: e.ledgerHash }, 'refused', { code: 'INCONSISTENT_SNAPSHOT' })
        throw new DeskError(409, 'INCONSISTENT_SNAPSHOT', e.message)
      }
      throw e
    }
    const refuse = (status, code, message, extra = {}) => {
      append(act, r.mandate, r.L, 'refused', { code })
      return new DeskError(status, code, message, extra)
    }
    if (r.escrow !== 'ok') throw refuse(409, 'ESCROW_POLICY', `The escrow does not meet the policy: ${r.escrowReasons.join('; ')}. Nothing was signed.`)
    if (r.digest !== 'same') throw refuse(409, 'STALE', 'A value the ticket read has changed since the request (its inputsDigest differs at this ledger). Nothing was signed. Re-request with a fresh ticket.')
    if (r.ticket.verdict.status !== 'PASS') throw refuse(409, 'BREACHED', `The mandate is breached at this ledger: ${r.ticket.verdict.breaches.map((b) => `${b.limit} ${b.value} over ${b.threshold}`).join('; ')}. Nothing was signed.`, { breaches: r.ticket.verdict.breaches })
    if (r.sequence !== 'ok') throw refuse(409, 'SEQUENCE_PASSED', r.sequenceReason)
    if (stopped()) throw refuse(423, 'LOCKED', 'The kill switch is on; nothing was signed.')

    const blob = signLoanSetByCounterparty(wallet, r.signed.tx_blob).tx_blob
    const hash = hashes.hashSignedTx(blob)
    let out
    try {
      out = await submit(blob)
    } catch (e) {
      log.warn('countersigned LoanSet submission threw, reading it back', { actionId: act.actionId, txHash: hash, err: String(e?.message ?? e).slice(0, 120) })
      const until = Date.now() + confirmWindowMs
      let seen = null
      while (!seen && Date.now() < until) {
        seen = await lookupTx(hash).catch(() => null)
        if (!seen) await sleep(Math.min(1500, confirmWindowMs))
      }
      if (!seen) {
        append(act, r.mandate, r.L, 'refused', { code: 'SUBMIT_UNCONFIRMED', txHash: hash })
        throw new DeskError(409, 'SUBMIT_UNCONFIRMED', `The countersigned LoanSet ${hash} could not be confirmed on the ledger within ${Math.round(confirmWindowMs / 1000)} s. Check it before approving again.`)
      }
      out = { txHash: hash, engineResult: seen.meta?.TransactionResult, ledgerIndex: seen.ledger_index, meta: seen.meta }
    }
    const result = String(out.engineResult ?? '')
    if (result === 'tesSUCCESS' || /^tec/.test(result)) {
      append(act, r.mandate, r.L, 'approved', { txHash: out.txHash ?? hash })
      const loanId = (out.meta?.AffectedNodes ?? []).map((n) => n.CreatedNode).find((c) => c?.LedgerEntryType === 'Loan')?.LedgerIndex ?? null
      if (result === 'tesSUCCESS') countersigned.set(r.escrowIndex, { txHash: out.txHash ?? hash, loanId })
      return { txHash: out.txHash ?? hash, engineResult: result, ledgerIndex: out.ledgerIndex ?? null, loanId }
    }
    if (/^(tef|tem|tel)/.test(result)) throw refuse(409, 'SEQUENCE_PASSED', `The countersigned LoanSet was not included (${result}). Re-request the loan to sign it again.`)
    throw refuse(409, 'SUBMIT_UNCONFIRMED', `The countersigned LoanSet ended ${result || 'without a result'}; it is not on the ledger.`)
  }

  /** The same reads as approve, at one ledger, and nothing signed, submitted or logged. */
  async function previewApprove({ actionOfRequest }) {
    return review(actionOfRequest)
  }

  /** The risk officer declines: logged declined at the ledger now, no transaction. */
  async function decline({ actionOfRequest: act }) {
    const L = await ledgerNow()
    let mandate
    try {
      mandate = readMandate()
    } catch {
      throw notConfigured('demo/mandate-desk-1.json is missing or unreadable')
    }
    return { L, entry: append(act, mandate, L, 'declined') }
  }

  /**
   * A fresh ticket for the same request, and a LoanSet the borrower signs again at its current Sequence,
   * on the same terms, with a new LastLedgerSequence (ledger now + 600), the new ticket's Memo and the same
   * escrow Memo. The request stays pending-approval; nothing is approved here.
   * @param {{ actionOfRequest: any, borrower: any, enqueue: (address: string, fn: () => Promise<any>) => Promise<any> }} o
   */
  async function rerequest({ actionOfRequest: act, borrower, enqueue }) {
    const old = signedOf(act)
    if (!old) throw new DeskError(404, 'NOT_FOUND', 'The loan request keeps no signed LoanSet.')
    let mandate
    try {
      mandate = readMandate()
    } catch {
      throw notConfigured('demo/mandate-desk-1.json is missing or unreadable')
    }
    const share = String(act.ticket.share).toUpperCase()
    const ticket = buildTicket(await readTicketInputs(xrpl, { shareMptId: share, reader }), { op: 'pledge', units: act.ticket.units, mandate, principalDrops: String(old.tx.PrincipalRequested) })
    const signed = await enqueue(borrower.address, async () => {
      await xrpl.closeTime()
      const { TxnSignature: _s, SigningPubKey: _k, Sequence: _q, LastLedgerSequence: _l, Fee: _f, Memos: _m, CounterpartySignature: _c, ...terms } = old.tx
      void [_s, _k, _q, _l, _f, _m, _c]
      const tx = await xrpl.client.autofill({
        ...terms, PaymentTotal: terms.PaymentTotal ?? 1, LastLedgerSequence: xrpl.lastLedger + LOANSET_WINDOW,
        Memos: [
          { Memo: { MemoType: MEMO_TICKET, MemoData: ticket.ticketId.toUpperCase() } },
          { Memo: { MemoType: MEMO_ESCROW, MemoData: String(act.escrow.index).toUpperCase() } },
        ],
      })
      tx.Fee = num(tx.Fee).times(2).toFixed(0) // two signatures on one transaction
      return { tx, ...borrower.sign(tx) }
    })
    resigned.set(act.actionId, signed)
    act.ticket = { share, ticketId: ticket.ticketId, inputsDigest: ticket.inputsDigest, units: act.ticket.units }
    return { ticket, signed }
  }

  return { approve, previewApprove, decline, rerequest, decisions: () => decisionsLog(), signedOf }
}

/**
 * The riskOfficer's three actions on the role engine (body { vault, requestActionId }): approve previews
 * its money line without signing, submitting or simulating anything (the borrower's LoanSet is already
 * signed, which simulate refuses, and lacks the desk's countersignature), and approves at its confirm,
 * through the desk owner's serial queue; decline and rerequest act at their confirm. While a request is
 * approving, their confirms answer 404.
 * @param {any} engine the role engine of src/roles/engine.mjs
 * @param {{ signer: ReturnType<typeof createSigner>, deskAddress: () => string|null, borrower: () => any }} deps
 */
export function registerDeskActions(engine, { signer, deskAddress, borrower }) {
  const requestOf = (run, act) => {
    const r = engine.action(run.runId, act.requestActionId)
    if (!r || r.action !== 'requestLoan') throw new DeskError(404, 'NOT_FOUND', 'requestActionId names no requestLoan of this run.')
    return r
  }
  const awaiting = (r) => {
    if (r.state !== 'pending-approval') throw new DeskError(404, 'NOT_FOUND', `The loan request is ${r.state}, not awaiting approval.`)
  }
  const done = (act, fields) => Object.assign(act, fields) // one assignment: a GET never sees validated without its fields

  engine.register('riskOfficer', 'approve', {
    async preview({ run, action: act }) {
      const req = requestOf(run, act)
      let r
      try {
        r = await signer.previewApprove({ actionOfRequest: req })
      } catch (e) {
        if (e instanceof SnapshotError) throw new DeskError(409, 'INCONSISTENT_SNAPSHOT', e.message)
        throw e
      }
      const f = r.ticket.figures
      return {
        preview: {
          engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED',
          money: {
            principalDrops: String(r.tx.PrincipalRequested),
            collateralHeldDrops: f.heldValue.value,
            ltvHeldBps: JSON.parse(f.ltvHeld.value),
            maxLtvBps: r.mandate.limits.maxLtvBps,
            verdict: r.ticket.verdict,
            breaches: r.ticket.verdict.breaches,
            ltv1to1Bps: JSON.parse(f.lender1to1.value),
            verdict1to1: r.ticket.verdict1to1,
            escrow: r.escrow,
            ...(r.escrowReasons.length && { escrowReasons: r.escrowReasons }),
            collateral: r.collateral,
            digest: r.digest,
            sequence: r.sequence,
            ledgerIndex: r.L.ledgerIndex,
          },
        },
      }
    },
    async confirm({ run, action: act, enqueue, stopped }) {
      if (act.state !== 'previewed') return {} // already confirmed: its state, never a second submission
      const req = requestOf(run, act)
      awaiting(req)
      req.state = 'approving' // before the first await: a decline or rerequest confirm now answers 404
      act.state = 'approving'
      const desk = deskAddress()
      if (!desk) {
        req.state = 'pending-approval'
        throw new DeskError(503, 'NOT_CONFIGURED', 'DESK_SEED is not set; desk approvals are not configured on this server.')
      }
      try {
        const out = await enqueue(desk, () => signer.approve({ actionOfRequest: req, ticketId: req.ticket.ticketId, stopped }))
        if (out.engineResult === 'tesSUCCESS') {
          done(req, { state: 'validated', txHash: out.txHash, engineResult: out.engineResult, ledgerIndex: out.ledgerIndex })
          done(act, { state: 'validated', txHash: out.txHash, engineResult: out.engineResult, ledgerIndex: out.ledgerIndex })
        } else {
          req.state = 'pending-approval'
          done(act, { state: 'failed', txHash: out.txHash, engineResult: out.engineResult, ledgerIndex: out.ledgerIndex })
        }
        return {}
      } catch (e) {
        if (req.state === 'approving') req.state = 'pending-approval'
        done(act, e instanceof DeskError && e.code === 'LOCKED' ? { state: 'failed', engineResult: 'LOCKED' } : { state: 'refused', engineResult: e?.code ?? 'error' })
        throw e
      }
    },
  })

  engine.register('riskOfficer', 'decline', {
    async preview({ run, action: act }) {
      const req = requestOf(run, act)
      return { preview: { engineResult: 'not-simulated (no transaction)', provenance: 'DECLARED', money: { requestActionId: req.actionId, ticketId: req.ticket?.ticketId ?? null } } }
    },
    async confirm({ run, action: act }) {
      if (act.state !== 'previewed') return {}
      const req = requestOf(run, act)
      awaiting(req)
      const { L } = await signer.decline({ actionOfRequest: req })
      done(req, { state: 'refused', engineResult: 'declined' })
      done(act, { state: 'validated', engineResult: 'declined (no transaction)', ledgerIndex: L.ledgerIndex })
      return {}
    },
  })

  engine.register('riskOfficer', 'rerequest', {
    async preview({ run, action: act }) {
      const req = requestOf(run, act)
      return { preview: { engineResult: 'not-simulated (signed again at confirm)', provenance: 'DECLARED', money: { requestActionId: req.actionId } } }
    },
    async confirm({ run, action: act, enqueue }) {
      if (act.state !== 'previewed') return {}
      const req = requestOf(run, act)
      awaiting(req)
      const who = borrower()
      if (!who) throw new DeskError(503, 'NOT_CONFIGURED', 'The borrower account is not configured on this server.')
      const { signed } = await signer.rerequest({ actionOfRequest: req, borrower: who, enqueue })
      done(act, { state: 'validated', engineResult: 'signed again (no transaction)', ledgerIndex: null, lastLedgerSequence: signed.tx.LastLedgerSequence })
      return {}
    },
  })
}
