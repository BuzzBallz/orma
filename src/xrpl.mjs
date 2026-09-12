/**
 * The XRPL read layer.
 *
 * Deliberately a POLLER, not a streaming indexer. Reasons, both learned the hard way:
 *
 *  - Transaction metadata OMITS any field whose previous value was the type default,
 *    so the first impairment of a healthy vault emits `PreviousFields: {}` on the Vault
 *    node while `LossUnrealized` becomes non-zero. Any indexer that diffs metadata
 *    misses the single most important credit event in the protocol. Re-reading the
 *    object cannot miss it.
 *  - Devnet history is pruned to roughly 29 days, so a backfill by walking
 *    PreviousTxnID hits txnNotFound on anything older.
 *
 * Everything here re-reads current state. Nothing here diffs metadata.
 */
import { Client } from 'xrpl'
import { logger } from './log.mjs'
import { num, str, rippleToIso, hasFlag, LOAN_FLAG } from './num.mjs'

const log = logger('xrpl')

export const DEVNET_WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'

/** Vault phases for a closed-ended vault (VaultKind 1). Open-ended vaults have none. */
export const PHASE = { SUBSCRIPTION: 'Subscription', INVESTMENT: 'Investment', REDEMPTION: 'Redemption', OPEN: 'Open' }

export class Xrpl {
  constructor(url = DEVNET_WS) {
    this.url = url
    this.client = new Client(url, { connectionTimeout: 20000, timeout: 20000 })
    this.connected = false
    this._backoff = 500
    this.lastLedger = null
    this.lastCloseTime = null
    this.client.on('disconnected', (code) => {
      this.connected = false
      log.warn('disconnected', { code })
    })
    this.client.on('error', (e) => log.warn('client error', { err: String(e) }))
  }

  /**
   * Connect, retrying forever with a capped backoff. Deliberately unbounded: this
   * process has to survive 36 hours and must not die because the venue wifi blinked.
   * Per-request retries ARE bounded, in `req()`.
   */
  async connect() {
    for (;;) {
      try {
        if (!this.client.isConnected()) await this.client.connect()
        this.connected = true
        this._backoff = 500
        log.info('connected', { url: this.url })
        return
      } catch (e) {
        log.warn('connect failed, retrying', { err: String(e).slice(0, 120), inMs: this._backoff })
        await sleep(this._backoff)
        this._backoff = Math.min(this._backoff * 2, 8000)
      }
    }
  }

  async disconnect() {
    try { await this.client.disconnect() } catch { /* already gone */ }
    this.connected = false
  }

  /** One request with bounded retries. Reconnects if the socket dropped underneath us. */
  async req(payload, attempts = 3) {
    let lastErr
    for (let i = 0; i < attempts; i++) {
      try {
        if (!this.client.isConnected()) await this.connect()
        return await this.client.request(payload)
      } catch (e) {
        lastErr = e
        const msg = e?.data?.error ?? String(e)
        // A genuine "not found" is an answer, not a failure. Do not burn retries on it.
        if (msg === 'entryNotFound' || msg === 'objectNotFound') throw e
        log.debug('request retry', { cmd: payload.command, attempt: i + 1, err: String(msg).slice(0, 80) })
        await sleep(300 * (i + 1))
      }
    }
    throw lastErr
  }

  /** Validated ledger close_time. The ONLY clock we trust: Devnet lags wall clock by up to 10s. */
  async closeTime() {
    const r = await this.req({ command: 'ledger', ledger_index: 'validated' })
    this.lastLedger = r.result.ledger_index ?? Number(r.result.ledger.ledger_index)
    this.lastCloseTime = Number(r.result.ledger.close_time)
    return this.lastCloseTime
  }

  /**
   * Read a Vault plus its share issuance.
   * NOTE: the parameter is `vault_id`, NOT `vault` as XLS-65 section 3.9.1 states.
   */
  async vaultInfo(vaultId) {
    const r = await this.req({ command: 'vault_info', vault_id: vaultId })
    return r.result.vault
  }

  /** Read a LoanBroker by its object index, or by {owner, seq}. */
  async loanBroker(ref) {
    const param = typeof ref === 'string' ? ref : { loan_broker: ref }
    const r = await this.req(typeof ref === 'string' ? { command: 'ledger_entry', index: ref } : { command: 'ledger_entry', ...param })
    return r.result.node
  }

  /** Read a Loan by object index, or by {loan_broker_id, loan_seq}. */
  async loan(ref) {
    const r = await this.req(
      typeof ref === 'string' ? { command: 'ledger_entry', index: ref } : { command: 'ledger_entry', loan: ref },
    )
    return r.result.node
  }

  /** Objects owned by an account, optionally filtered. Used to discover a vault's brokers. */
  async accountObjects(account, type) {
    const r = await this.req({ command: 'account_objects', account, type, limit: 400 })
    return r.result.account_objects ?? []
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Normalisation: raw ledger JSON -> our shapes, with absent-means-zero applied once.
// ---------------------------------------------------------------------------

/**
 * Which phase a vault is in, from validated ledger time.
 * Open-ended vaults (no VaultKind) have no phases and always permit withdrawal.
 */
export function vaultPhase(vault, closeTime) {
  if (Number(vault.VaultKind ?? 0) !== 1) return PHASE.OPEN
  const sub = Number(vault.SubscriptionDate ?? 0)
  const red = Number(vault.RedemptionDate ?? 0)
  if (closeTime < sub) return PHASE.SUBSCRIPTION
  if (closeTime < red) return PHASE.INVESTMENT
  return PHASE.REDEMPTION
}

/**
 * Normalise a Vault. `shares` comes from vault_info's own `shares` object, because
 * there is NO SharesTotal field on the Vault ledger entry: ledger_entries.macro
 * carries the comment "no SharesTotal ever (use MPTIssuance.sfOutstandingAmount)".
 */
export function normaliseVault(v, closeTime) {
  const assetsTotal = num(v.AssetsTotal)
  const lossUnrealized = num(v.LossUnrealized)
  const shares = num(v.shares?.OutstandingAmount)
  return {
    vaultId: v.index ?? v.LedgerIndex ?? null,
    owner: v.Owner,
    pseudoAccount: v.Account,
    shareMptId: v.ShareMPTID ?? v.shares?.mpt_issuance_id ?? null,
    vaultKind: Number(v.VaultKind ?? 0) === 1 ? 'ClosedEnded' : 'OpenEnded',
    leVersion: Number(v.LEVersion ?? 0) === 1 ? 'CashBasis' : 'Legacy',
    phase: vaultPhase(v, closeTime),
    assetsTotal,
    assetsAvailable: num(v.AssetsAvailable),
    lossUnrealized,
    sharesOutstanding: shares,
    scale: Number(v.Scale ?? 0),
    withdrawalPolicy: Number(v.WithdrawalPolicy ?? 1) === 1 ? 'FirstComeFirstServe' : String(v.WithdrawalPolicy),
    isPrivate: hasFlag(v.Flags, 0x00010000),
    subscriptionAt: rippleToIso(v.SubscriptionDate),
    redemptionAt: rippleToIso(v.RedemptionDate),
    subscriptionRipple: v.SubscriptionDate ?? null,
    redemptionRipple: v.RedemptionDate ?? null,
    asset: v.Asset?.currency === 'XRP' || v.Asset?.currency === undefined && !v.Asset?.mpt_issuance_id
      ? { kind: 'XRP', currency: 'XRP', issuer: null, mptIssuanceId: null }
      : v.Asset?.mpt_issuance_id
        ? { kind: 'MPT', currency: null, issuer: null, mptIssuanceId: v.Asset.mpt_issuance_id }
        : { kind: 'IOU', currency: v.Asset.currency, issuer: v.Asset.issuer ?? null, mptIssuanceId: null },
  }
}

/** Normalise a LoanBroker. */
export function normaliseBroker(b) {
  return {
    loanBrokerId: b.index ?? b.LedgerIndex ?? null,
    owner: b.Owner,
    pseudoAccount: b.Account,
    vaultId: b.VaultID,
    debtTotal: num(b.DebtTotal),
    debtMaximum: num(b.DebtMaximum),
    coverAvailable: num(b.CoverAvailable),
    coverRateMinimum: Number(b.CoverRateMinimum ?? 0),
    coverRateLiquidation: Number(b.CoverRateLiquidation ?? 0),
    managementFeeRate: Number(b.ManagementFeeRate ?? 0),
    loanSequence: Number(b.LoanSequence ?? 0),
  }
}

/**
 * Normalise a Loan.
 *
 * Trap: a DEFAULTED loan has `PrincipalOutstanding` and `NextPaymentDueDate` DELETED
 * by rippled, not zeroed. Branch on Flags BEFORE coalescing so "absent because
 * deleted" is not confused with "absent because zero".
 */
export function normaliseLoan(l, closeTime) {
  const defaulted = hasFlag(l.Flags, LOAN_FLAG.DEFAULTED)
  const impaired = hasFlag(l.Flags, LOAN_FLAG.IMPAIRED)
  const dueRipple = l.NextPaymentDueDate === undefined ? null : Number(l.NextPaymentDueDate)
  const grace = Number(l.GracePeriod ?? 0)
  const secondsUntilDue = dueRipple === null ? null : dueRipple - closeTime
  const overdue = secondsUntilDue !== null && secondsUntilDue < 0

  let status
  if (defaulted) status = 'defaulted'
  else if (impaired) status = 'impaired'
  else if (dueRipple === null) status = 'closed'
  else if (overdue && closeTime > dueRipple + grace) status = 'defaultable'
  else if (overdue) status = 'overdue'
  else if (secondsUntilDue <= Number(l.PaymentInterval ?? 0)) status = 'due_soon'
  else status = 'current'

  return {
    loanId: l.index ?? l.LedgerIndex ?? null,
    borrower: l.Borrower,
    loanBrokerId: l.LoanBrokerID,
    status,
    principalOutstanding: num(l.PrincipalOutstanding),
    totalValueOutstanding: num(l.TotalValueOutstanding),
    managementFeeOutstanding: num(l.ManagementFeeOutstanding),
    periodicPayment: num(l.PeriodicPayment),
    interestRate: Number(l.InterestRate ?? 0),
    lateInterestRate: Number(l.LateInterestRate ?? 0),
    paymentInterval: Number(l.PaymentInterval ?? 0),
    gracePeriod: grace,
    paymentRemaining: Number(l.PaymentRemaining ?? 0),
    nextPaymentDueAt: rippleToIso(dueRipple),
    secondsUntilDue: secondsUntilDue ?? 0,
    secondsUntilDefaultable: dueRipple === null ? 0 : dueRipple + grace - closeTime,
    flags: Number(l.Flags ?? 0),
  }
}
