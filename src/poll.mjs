/**
 * The correct reader.
 *
 * Polls a known list of VaultIDs every POLL_MS and re-reads full state each time.
 * It never diffs transaction metadata, so it cannot miss the first impairment of a
 * healthy vault (the case where the Vault node emits `PreviousFields: {}`).
 *
 * Discovery of a vault's brokers: the Vault does not point at its LoanBrokers, the
 * brokers point at the Vault. So we list the vault owner's objects and keep the
 * loan_brokers whose VaultID matches. Loans are then enumerated deterministically by
 * walking loan_seq from 1 to LoanBroker.LoanSequence - 1, which avoids owner-directory
 * guesswork and is trivial at the loan counts this protocol produces.
 */
import { Xrpl, sleep, normaliseVault, normaliseBroker, normaliseLoan, PHASE } from './xrpl.mjs'
import { num, str, ratio, bps, Decimal } from './num.mjs'
import { logger } from './log.mjs'

const log = logger('poll')
export const POLL_MS = Number(process.env.POLL_MS ?? 4000)

export class Reader {
  /** @param {string[]} vaultIds */
  constructor(vaultIds, xrpl = new Xrpl()) {
    this.vaultIds = [...new Set(vaultIds)]
    this.xrpl = xrpl
    /** @type {Map<string, object>} latest snapshot per vault */
    this.snapshots = new Map()
    this.serverTime = null
    this.ledgerIndex = null
    this.closeTime = null
    this.degraded = false
    this.lastGoodAt = null
    this._timer = null
    this._running = false
    /** optional hook, set by the publish loop. Must never block or throw into tick(). */
    this.onSnapshot = null
  }

  addVault(id) {
    if (!this.vaultIds.includes(id)) {
      this.vaultIds.push(id)
      log.info('vault added', { vaultId: id.slice(0, 16) })
    }
  }

  /** Read one vault completely: vault, its brokers, and every loan under them. */
  async readVault(vaultId, closeTime) {
    const raw = await this.xrpl.vaultInfo(vaultId)
    const vault = normaliseVault({ ...raw, index: raw.index ?? vaultId }, closeTime)

    // brokers that point at this vault
    const owned = await this.xrpl.accountObjects(vault.owner, 'loan_broker')
    const brokers = owned
      .filter((b) => b.VaultID === vaultId)
      .map((b) => normaliseBroker({ ...b, index: b.index ?? b.LedgerIndex }))

    const loans = []
    for (const b of brokers) {
      for (let seq = 1; seq < b.loanSequence; seq++) {
        try {
          const l = await this.xrpl.loan({ loan_broker_id: b.loanBrokerId, loan_seq: seq })
          loans.push(normaliseLoan({ ...l, index: l.index ?? l.LedgerIndex }, closeTime))
        } catch (e) {
          // A deleted (fully repaid) loan is expected to be missing. Not an error.
          const code = e?.data?.error
          if (code !== 'entryNotFound' && code !== 'objectNotFound') {
            log.debug('loan read failed', { broker: b.loanBrokerId?.slice(0, 12), seq, err: code ?? String(e).slice(0, 60) })
          }
        }
      }
    }
    return { vault, brokers, loans }
  }

  /**
   * The two readings. This is the product in four lines.
   *
   *   naive   = AssetsTotal / shares                       <- what the obvious tool shows
   *   correct = (AssetsTotal - LossUnrealized) / shares     <- what a holder can actually redeem
   *
   * They agree until a loss is recognised, and diverge the instant it is. The naive
   * one can even RISE while the vault is being emptied, because a withdrawal burns
   * shares faster than it removes assets.
   */
  static nav(vault) {
    const { assetsTotal, lossUnrealized, sharesOutstanding: s } = vault
    const naive = s.isZero() ? new Decimal(0) : assetsTotal.div(s)
    const correct = s.isZero() ? new Decimal(0) : assetsTotal.minus(lossUnrealized).div(s)
    return {
      navNaive: naive.toFixed(6),
      navCorrect: correct.toFixed(6),
      navDivergenceBps: bps(naive, correct),
    }
  }

  /** Phase-derived facts the UI needs, including why a withdrawal would be refused. */
  static phaseInfo(vault, closeTime) {
    const inInvestment = vault.phase === PHASE.INVESTMENT
    const boundaryRipple =
      vault.phase === PHASE.SUBSCRIPTION ? vault.subscriptionRipple
      : vault.phase === PHASE.INVESTMENT ? vault.redemptionRipple
      : null
    return {
      phase: vault.phase,
      canDeposit: vault.phase === PHASE.SUBSCRIPTION || vault.phase === PHASE.OPEN,
      // Verified on Devnet: tecTOO_SOON fires for the WHOLE Investment phase, with
      // 80 XRP of AssetsAvailable present. It is a phase predicate, not a liquidity check.
      canWithdraw: !inInvestment,
      withdrawBlockedReason: inInvestment ? 'tecTOO_SOON' : null,
      nextBoundaryAt: boundaryRipple === null ? null : new Date((Number(boundaryRipple) + 946684800) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      secondsToNextBoundary: boundaryRipple === null ? 0 : Number(boundaryRipple) - closeTime,
    }
  }

  /** One full pass over every tracked vault. */
  async tick() {
    const closeTime = await this.xrpl.closeTime()
    this.closeTime = closeTime
    this.ledgerIndex = this.xrpl.lastLedger
    this.serverTime = new Date((closeTime + 946684800) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

    for (const id of this.vaultIds) {
      try {
        const { vault, brokers, loans } = await this.readVault(id, closeTime)
        const snap = {
          vaultId: id,
          readAt: this.serverTime,
          closeTimeUsed: closeTime,
          ledgerIndex: this.ledgerIndex,
          vault,
          brokers,
          loans,
          ...Reader.nav(vault),
          phaseInfo: Reader.phaseInfo(vault, closeTime),
        }
        const prev = this.snapshots.get(id)
        this.snapshots.set(id, snap)
        if (this.onSnapshot) { try { this.onSnapshot(snap) } catch { /* never let a consumer break a read */ } }
        this.lastGoodAt = Date.now()
        this.degraded = false

        // Log only transitions, so the operator console stays readable on stage.
        if (!prev || prev.navCorrect !== snap.navCorrect || prev.loans.length !== snap.loans.length) {
          log.info('vault state', {
            vault: id.slice(0, 12),
            phase: vault.phase,
            navNaive: snap.navNaive,
            navCorrect: snap.navCorrect,
            bps: snap.navDivergenceBps,
            loans: loans.length,
            distressed: loans.filter((l) => ['overdue', 'impaired', 'defaultable', 'defaulted'].includes(l.status)).length,
          })
        }
      } catch (e) {
        this.degraded = true
        log.warn('vault read failed, keeping last good snapshot', {
          vault: id.slice(0, 12),
          err: (e?.data?.error ?? String(e)).slice(0, 100),
        })
      }
    }
  }

  async start() {
    if (this._running) return
    this._running = true
    await this.xrpl.connect()
    log.info('reader started', { vaults: this.vaultIds.length, everyMs: POLL_MS })
    const loop = async () => {
      while (this._running) {
        const t0 = Date.now()
        try { await this.tick() } catch (e) { log.error('tick failed', { err: String(e).slice(0, 120) }) }
        await sleep(Math.max(0, POLL_MS - (Date.now() - t0)))
      }
    }
    loop()
  }

  async stop() {
    this._running = false
    await this.xrpl.disconnect()
  }

  get(vaultId) { return this.snapshots.get(vaultId) ?? null }
  all() { return [...this.snapshots.values()] }
  get lastLedgerAgeSeconds() {
    return this.lastGoodAt ? Math.floor((Date.now() - this.lastGoodAt) / 1000) : null
  }
}
