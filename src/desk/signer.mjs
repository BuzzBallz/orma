/**
 * The desk signs for real, but only after it has read the ledger again and recomputed the ticket. At
 * the validated ledger L of the decision it reads the escrow the request names, and that one alone (its
 * index, the LoanSet's orma.escrow Memo), the 2-of-3 account it pays into, the pledged share, the
 * borrower's account and the ticket's inputs; it countersigns the borrower's LoanSet only if the escrow
 * meets the policy, the inputsDigest is the one the request kept, the mandate's verdict is PASS and the
 * borrower's Sequence still matches (I2). An inconsistent snapshot refuses before any figure (I7). Every
 * outcome, approved, refused or declined, goes to the chained decision log with L and its hash.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashes, signLoanSetByCounterparty } from 'xrpl'
import { num } from '../num.mjs'
import { logger } from '../log.mjs'
import { COLLATERAL_STAGES, judgeCollateralAccount, judgeCollateralShare, NYC_ERRORS, usdTermsHash, SCHEMAS } from '../nyc/contracts.mjs'
import { readTicketInputs, readCollateralAccount, allPages, PageLimitError, SnapshotError } from '../ticket/inputs.mjs'
import { buildTicket } from '../ticket/engine.mjs'
import { openLog } from './decision-log.mjs'
import { readXrpUsd, PriceUnavailableError } from '../fx/price.mjs'
import { sleep } from '../xrpl.mjs'
import { PARTIES } from '../roles/remote-signer.mjs'

const log = logger('desk:signer')
const MEMO_ESCROW = Buffer.from('orma.escrow', 'utf8').toString('hex').toUpperCase()
const MEMO_TICKET = Buffer.from('orma.ticket', 'utf8').toString('hex').toUpperCase()
/** A re-signed LoanSet waits for a human approval: about 30 to 40 minutes, like the first one. */
const LOANSET_WINDOW = 600
/** Closer than this to its LastLedgerSequence, a LoanSet would expire before it is included. */
const EXPIRY_MARGIN = 10

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()

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
 *   readDesk?: () => any, readSpare?: () => any, readMandate?: () => any, readDeskUsd?: () => any|null, readUsdTerms?: () => any,
 *   decisions?: ReturnType<typeof openLog>, logPath?: string, loanSetOf?: (actionId: string) => any, confirmWindowMs?: number, demoDir?: string,
 * }} deps
 */
export function createSigner({ xrpl, reader, wallet, submit, lookupTx, readDesk, readSpare, readMandate, readDeskUsd, readUsdTerms, decisions, logPath, loanSetOf, confirmWindowMs = 60_000, demoDir = 'demo' }) {
  const readDemo = (label) => JSON.parse(readFileSync(join(demoDir, `${label}.json`), 'utf8'))
  readDesk ??= () => readDemo('desk')
  readSpare ??= () => readDemo('spare')
  readMandate ??= () => readDemo('mandate-desk-1')
  // step 21: the dollar pool and its terms, read at each decision; no dollar pool on this server reads null
  readDeskUsd ??= () => (existsSync(join(demoDir, 'desk-usd.json')) ? readDemo('desk-usd') : null)
  readUsdTerms ??= () => readDemo('usd-terms-desk-1')

  /**
   * The loan's currency, from the LoanBroker its LoanSet names: the dollar pool's lends the test dollar, any
   * other the XRP the ticket has always priced. `terms(principal)` is what buildTicket takes for it.
   */
  function loanAssetOf(tx, mandate) {
    let usdDesk
    try {
      usdDesk = readDeskUsd()
    } catch {
      throw notConfigured('demo/desk-usd.json is unreadable')
    }
    const isUsd = Boolean(usdDesk) && same(tx.LoanBrokerID, usdDesk.loanBrokerId)
    if (!isUsd) return { isUsd, usdDesk, terms: async (principal) => ({ principalDrops: principal }) }
    let terms
    try {
      terms = readUsdTerms()
    } catch {
      throw notConfigured('demo/usd-terms-desk-1.json is missing or unreadable')
    }
    if (SCHEMAS.usdTerms(terms).length || usdTermsHash(terms) !== terms.hash || terms.mandateHash !== mandate?.hash) {
      throw notConfigured('demo/usd-terms-desk-1.json does not hash to its own hash, or names another mandate')
    }
    // the XRP/USD price at the ledger of the decision: the median of the terms' oracles (src/fx/price.mjs)
    return { isUsd, usdDesk, terms: async (principal, at) => ({ usd: { terms, principalUsd: principal, price: await readXrpUsd(xrpl, terms, at) } }) }
  }
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
    // step 21: the loan's currency is the broker the signed LoanSet names, and it must be the request's
    const loan = loanAssetOf(tx, mandate)
    const L = at ?? (await ledgerNow())
    const share = String(act.ticket.share).toUpperCase()
    const escrowIndex = String(act.escrow.index).toUpperCase()
    const policy = mandate.policy
    const reasons = []
    let collateral = { address: null, conforming: false, reasons: [] }

    const escrow = await entryAt({ index: escrowIndex }, L.ledgerIndex)
    if (!escrow) reasons.push('the escrow the request names is no longer on the ledger (finished or cancelled)')
    else {
      const backs = await backing(escrowIndex, tx.Account, L.ledgerIndex, new Set([desk.loanBrokerId, spare.loanBrokerId, ...(loan.usdDesk ? [loan.usdDesk.loanBrokerId] : [])].map((b) => String(b).toUpperCase())))
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

    if ((act.asset === 'USD') !== loan.isUsd) reasons.push(`the signed LoanSet lends ${loan.isUsd ? 'USD' : 'XRP'}, not the ${act.asset ?? 'XRP'} of the request`)
    const inputs = await readTicketInputs(xrpl, { shareMptId: share, reader, at: L })
    let ticket
    try {
      ticket = buildTicket(inputs, { op: 'pledge', units: act.ticket.units, mandate, ...(await loan.terms(String(tx.PrincipalRequested), L)) })
    } catch (e) {
      // a pledge worth 0 at the withdrawal value has no LTV: the mandate cannot pass, nothing is signed
      if (e instanceof RangeError) throw new DeskError(409, 'BREACHED', `The mandate cannot pass at this ledger: ${e.message}. Nothing was signed.`, { breaches: [] })
      throw e
    }
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
   * `countersign` (the demo lab): the desk owner's countersignature asked of the page, only once every check
   * has passed at the logged ledger L (I2); without it the desk wallet countersigns, as always. A request
   * that expires refuses SIGNATURE_TIMEOUT and the kill switch LOCKED, both logged, nothing submitted.
   * @param {{ actionOfRequest: any, ticketId?: string, stopped?: () => boolean,
   *   countersign?: (blob: string, purpose: string) => Promise<{ tx_blob: string }> }} o
   */
  async function approve({ actionOfRequest: act, stopped = () => false, countersign }) {
    let r
    let L = null
    let mandate = null
    try {
      decisionsLog()
    } catch (e) {
      // I2: no countersignature outside the log; a log that cannot be opened refuses before anything is signed
      log.error('decision log unavailable, approval refused', { actionId: act.actionId, ticketId: act.ticket?.ticketId ?? null, err: String(e?.message ?? e).slice(0, 120) })
      throw notConfigured('the decision log cannot be opened')
    }
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
      // step 21: no usable XRP/USD price at the ledger of the decision, no dollar figure, nothing signed
      if (e instanceof PriceUnavailableError) {
        append(act, mandate, L, 'refused', { code: 'PRICE_UNAVAILABLE' })
        throw new DeskError(409, 'PRICE_UNAVAILABLE', `${e.message} Nothing was signed.`)
      }
      if (e instanceof DeskError && e.code === 'BREACHED') append(act, mandate, L, 'refused', { code: 'BREACHED' })
      throw e
    }
    const refuse = (status, code, message, extra = {}) => {
      append(act, r.mandate, r.L, 'refused', { code })
      return new DeskError(status, code, message, extra)
    }
    if (r.escrow !== 'ok') throw refuse(409, 'ESCROW_POLICY', `The escrow does not meet the policy: ${r.escrowReasons.join('; ')}. Nothing was signed.`)
    if (r.digest !== 'same') throw refuse(409, 'STALE', 'A value the ticket read has changed since the request (its inputsDigest differs at this ledger). Nothing was signed. Re-request with a fresh ticket.')
    if (r.ticket.verdict.status !== 'PASS') throw refuse(409, 'BREACHED', `The mandate is breached at this ledger: ${r.ticket.verdict.breaches.map((b) => breachText(b)).join('; ')}. Nothing was signed.`, { breaches: r.ticket.verdict.breaches })
    if (r.sequence !== 'ok') throw refuse(409, 'SEQUENCE_PASSED', r.sequenceReason)
    if (stopped()) throw refuse(423, 'LOCKED', 'The kill switch is on; nothing was signed.')

    let blob
    if (countersign) {
      const principal = r.ticket.usd ? `${String(r.tx.PrincipalRequested)} test dollars` : `${String(r.tx.PrincipalRequested)} drops of XRP`
      log.info('mandate passed, countersignature asked of the page', { ticketId: act.ticket.ticketId, actionId: act.actionId, ledgerIndex: r.L.ledgerIndex })
      try {
        blob = (await countersign(r.signed.tx_blob, `${PARTIES.deskOwner} countersigns the loan of ${principal} to ${PARTIES.borrower}, backed by escrow ${r.escrowIndex}, after its mandate passed at ledger ${r.L.ledgerIndex}.`)).tx_blob
      } catch (e) {
        if (e?.code === 'SIGNATURE_TIMEOUT') throw refuse(409, 'SIGNATURE_TIMEOUT', 'No countersignature of the desk owner arrived before the request expired. Nothing was submitted.')
        if (e?.code === 'LOCKED') throw refuse(423, 'LOCKED', 'The kill switch is on; nothing was signed.')
        throw e
      }
      if (stopped()) throw refuse(423, 'LOCKED', 'The kill switch is on; nothing was submitted.')
    } else {
      blob = signLoanSetByCounterparty(wallet, r.signed.tx_blob).tx_blob
    }
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
      const loanId = (out.meta?.AffectedNodes ?? []).map((n) => n.CreatedNode).find((c) => c?.LedgerEntryType === 'Loan')?.LedgerIndex ?? null
      // known to this process before the append: a log write that fails cannot let a second approve sign again
      if (result === 'tesSUCCESS') countersigned.set(r.escrowIndex, { txHash: out.txHash ?? hash, loanId })
      try {
        append(act, r.mandate, r.L, 'approved', { txHash: out.txHash ?? hash })
      } catch (e) {
        // the LoanSet is on the ledger: the approval stands, and the missing entry is said loudly with its hash
        log.error('approved LoanSet validated but its decision entry was not written', { actionId: act.actionId, ticketId: act.ticket.ticketId, txHash: out.txHash ?? hash, ledgerIndex: out.ledgerIndex ?? null, engineResult: result, err: String(e?.message ?? e).slice(0, 120) })
      }
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
   * escrow Memo. The request stays pending-approval; nothing is approved here. `sign` (the demo lab): the
   * borrower's signature asked of the page, after the fresh ticket is built and outside the borrower's queue,
   * as the LoanSet waits for its approval unsent; without it the borrower's wallet signs in the queue.
   * @param {{ actionOfRequest: any, borrower: any, enqueue: (address: string, fn: () => Promise<any>) => Promise<any>,
   *   sign?: (tx: any, purpose: string) => Promise<{ tx_blob: string, hash: string }> }} o
   */
  async function rerequest({ actionOfRequest: act, borrower, enqueue, sign }) {
    const old = signedOf(act)
    if (!old) throw new DeskError(404, 'NOT_FOUND', 'The loan request keeps no signed LoanSet.')
    let mandate
    try {
      mandate = readMandate()
    } catch {
      throw notConfigured('demo/mandate-desk-1.json is missing or unreadable')
    }
    const share = String(act.ticket.share).toUpperCase()
    const inputs = await readTicketInputs(xrpl, { shareMptId: share, reader })
    const at = { ledgerIndex: inputs.ledgerIndex, ledgerHash: inputs.ledgerHash, closeTime: inputs.closeTime }
    let loanTerms
    try {
      loanTerms = await loanAssetOf(old.tx, mandate).terms(String(old.tx.PrincipalRequested), at)
    } catch (e) {
      if (e instanceof PriceUnavailableError) throw new DeskError(409, 'PRICE_UNAVAILABLE', `${e.message} Nothing was signed.`)
      throw e
    }
    const ticket = buildTicket(inputs, { op: 'pledge', units: act.ticket.units, mandate, ...loanTerms })
    const built = await enqueue(borrower.address, async () => {
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
      return sign ? { tx } : { tx, ...borrower.sign(tx) }
    })
    const principal = () => (ticket.usd ? `${String(built.tx.PrincipalRequested)} test dollars` : `${String(built.tx.PrincipalRequested)} drops of XRP`)
    const signed = sign
      ? { tx: built.tx, ...(await sign(built.tx, `${PARTIES.borrower} signs its request to borrow ${principal()} from ${PARTIES.deskOwner} again, on a fresh ticket, backed by escrow ${String(act.escrow.index).toUpperCase()}.`)) }
      : built
    resigned.set(act.actionId, signed)
    act.ticket = { share, ticketId: ticket.ticketId, inputsDigest: ticket.inputsDigest, units: act.ticket.units }
    return { ticket, signed }
  }

  return { approve, previewApprove, decline, rerequest, decisions: () => decisionsLog() }
}

/** One breach as a refusal says it. */
function breachText(b) {
  return `${b.limit} ${b.value} over ${b.threshold}`
}

/** The money line of a dollar loan's approve preview: the same reads as XRP, in dollars (step 21). */
function usdApproveMoney(r) {
  const f = r.ticket.figures
  const u = r.ticket.usd
  return {
    asset: 'USD',
    loanAsset: u.loanAsset,
    principalUsd: String(r.tx.PrincipalRequested),
    collateralHeldDrops: f.heldValue.value,
    collateralHeldUsd: u.collateralHeldUsd,
    ltvHeldBps: u.ltvHeldBps,
    maxLtvBps: r.mandate.limits.maxLtvBps,
    verdict: r.ticket.verdict,
    breaches: r.ticket.verdict.breaches,
    ltv1to1Bps: JSON.parse(f.lender1to1Usd.value),
    verdict1to1: r.ticket.verdict1to1,
    reference: u.reference,
    collateralRule: u.collateralRule,
    escrow: r.escrow,
    ...(r.escrowReasons.length && { escrowReasons: r.escrowReasons }),
    collateral: r.collateral,
    digest: r.digest,
    sequence: r.sequence,
    ledgerIndex: r.L.ledgerIndex,
  }
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
  /** the requests a decline or a rerequest is confirming: not served, so the served states stay those of the contract */
  const busy = new WeakSet()
  const awaiting = (r) => {
    if (r.state !== 'pending-approval') throw new DeskError(404, 'NOT_FOUND', `The loan request is ${r.state}, not awaiting approval.`)
    if (busy.has(r)) throw new DeskError(404, 'NOT_FOUND', 'The loan request is being declined or signed again, not awaiting approval.')
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
        if (e instanceof PriceUnavailableError) throw new DeskError(409, 'PRICE_UNAVAILABLE', `${e.message} Nothing was signed.`)
        throw e
      }
      const f = r.ticket.figures
      if (r.ticket.usd) return { preview: { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED', money: usdApproveMoney(r) } }
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
    async confirm({ run, action: act, enqueue, stopped, signerFor }) {
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
      const settle = (out) => {
        if (out.engineResult === 'tesSUCCESS') {
          done(req, { state: 'validated', txHash: out.txHash, engineResult: out.engineResult, ledgerIndex: out.ledgerIndex })
          done(act, { state: 'validated', txHash: out.txHash, engineResult: out.engineResult, ledgerIndex: out.ledgerIndex })
        } else {
          req.state = 'pending-approval'
          done(act, { state: 'failed', txHash: out.txHash, engineResult: out.engineResult, ledgerIndex: out.ledgerIndex })
        }
      }
      const fail = (e) => {
        if (req.state === 'approving') req.state = 'pending-approval'
        done(act, e instanceof DeskError && ['LOCKED', 'SIGNATURE_TIMEOUT'].includes(e.code) ? { state: 'failed', engineResult: e.code } : { state: 'refused', engineResult: e?.code ?? 'error' })
      }
      // the demo lab: the desk owner's countersignature is asked of the page once the review has passed
      const page = act.signer === 'browser' && signerFor ? signerFor(act, 'deskOwner') : null
      try {
        const work = enqueue(desk, () => signer.approve({ actionOfRequest: req, ticketId: req.ticket.ticketId, stopped, ...(page && { countersign: page.countersign }) }))
        if (page) {
          // a refusal of the review answers this confirm, as without the page; a countersignature asked answers 202
          const first = await Promise.race([work.then(() => 'settled', () => 'settled'), page.requested.then(() => 'asked')])
          if (first === 'asked') {
            work.then(settle, (e) => {
              fail(e)
              log.info('approval ended after its countersignature was asked', { actionId: act.actionId, ticketId: req.ticket?.ticketId ?? null, code: e?.code ?? null })
            })
            return {}
          }
        }
        settle(await work)
        return {}
      } catch (e) {
        fail(e)
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
      busy.add(req) // before the first await: an approve, a rerequest or a second decline confirm now answers 404
      let L
      try {
        ;({ L } = await signer.decline({ actionOfRequest: req }))
      } finally {
        busy.delete(req)
      }
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
    async confirm({ run, action: act, enqueue, signerFor }) {
      if (act.state !== 'previewed') return {}
      const req = requestOf(run, act)
      awaiting(req)
      const who = borrower()
      if (!who) throw new DeskError(503, 'NOT_CONFIGURED', 'The borrower account is not configured on this server.')
      busy.add(req) // before the first await: an approve, a decline or a second rerequest confirm now answers 404
      const resigned = ({ signed }) => done(act, { state: 'validated', engineResult: 'signed again (no transaction)', ledgerIndex: null, lastLedgerSequence: signed.tx.LastLedgerSequence })
      // the demo lab: the borrower signs the fresh LoanSet in the page, after the new ticket is built
      const page = act.signer === 'browser' && signerFor ? signerFor(act, 'borrower') : null
      if (page) {
        act.state = 'queued' // on the borrower's account; awaiting-signature while the page signs
        const work = signer.rerequest({ actionOfRequest: req, borrower: who, enqueue, sign: page.sign })
        const first = await Promise.race([work.then(() => 'settled', () => 'settled'), page.requested.then(() => 'asked')])
        if (first === 'asked') {
          work.then(resigned, (e) => {
            done(act, { state: 'failed', engineResult: e?.code ?? String(e?.message ?? e).slice(0, 120) })
            log.info('rerequest ended after its signature was asked', { actionId: act.actionId, code: e?.code ?? null })
          }).finally(() => busy.delete(req))
          return {}
        }
        try {
          resigned(await work)
        } catch (e) {
          act.state = 'previewed' // nothing was asked of the page: as a server-signed rerequest that threw
          throw e
        } finally {
          busy.delete(req)
        }
        return {}
      }
      let signed
      try {
        ;({ signed } = await signer.rerequest({ actionOfRequest: req, borrower: who, enqueue }))
      } finally {
        busy.delete(req)
      }
      done(act, { state: 'validated', engineResult: 'signed again (no transaction)', ledgerIndex: null, lastLedgerSequence: signed.tx.LastLedgerSequence })
      return {}
    },
  })
}
