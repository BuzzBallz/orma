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
import { num, str, ratio, bps, Decimal, wholeShares } from './num.mjs'
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
    /** hash of ledgerIndex, null when the server did not give one */
    this.ledgerHash = null
    this.closeTime = null
    this.degraded = false
    this.lastGoodAt = null
    /** full passes over every vault. The first reads them one by one, seconds apart, so until it
     * ends a vault without a snapshot may simply not have been reached yet. */
    this.passes = 0
    /** vaults the ledger says do not exist: an answer, not a read that failed */
    this.missing = new Set()
    this._timer = null
    this._running = false
    /** called with each snapshot, in subscription order; none may block or throw into tick() */
    this._subscribers = []
    this._hook = null
    this._hookOff = null
  }

  /**
   * Be told of every snapshot a pass produces. A subscriber that throws or rejects is logged and the
   * pass goes on.
   * @param {(snap: object) => unknown} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe takes a function')
    const entry = { fn }
    this._subscribers.push(entry)
    return () => { this._subscribers = this._subscribers.filter((e) => e !== entry) }
  }

  /**
   * The single hook the publish loop sets (`reader.onSnapshot = fn`, PublishLoop.attach()). Setting it
   * subscribes fn, replacing the hook set before it; null removes it. Other consumers use subscribe().
   */
  set onSnapshot(fn) {
    this._hookOff?.()
    this._hookOff = null
    this._hook = null
    if (typeof fn === 'function') {
      this._hookOff = this.subscribe(fn)
      this._hook = fn
    }
  }

  get onSnapshot() { return this._hook ?? null }

  _notify(snap) {
    for (const { fn } of this._subscribers) {
      try {
        const r = fn(snap)
        if (r && typeof r.catch === 'function') r.catch((e) => log.warn('snapshot subscriber failed', { vault: snap.vaultId.slice(0, 12), err: String(e).slice(0, 80) }))
      } catch (e) {
        // never let a consumer break a read
        log.warn('snapshot subscriber failed', { vault: snap.vaultId.slice(0, 12), err: String(e).slice(0, 80) })
      }
    }
  }

  addVault(id) {
    if (!this.vaultIds.includes(id)) {
      this.vaultIds.push(id)
      log.info('vault added', { vaultId: id.slice(0, 16) })
    }
  }

  /** Read one vault completely, at one ledger: vault, its brokers, and every loan under them. */
  async readVault(vaultId, closeTime, at = this.ledgerIndex ?? undefined) {
    // Every read of the pass on the ledger the pass took its close time from: asked for "validated"
    // one by one, a vault read before an impairment and its loan read after it graded a state that
    // never existed on any ledger.
    const raw = await this.xrpl.vaultInfo(vaultId, at)
    const vault = normaliseVault({ ...raw, index: raw.index ?? vaultId }, closeTime)

    // brokers that point at this vault
    const owned = await this.xrpl.accountObjects(vault.owner, 'loan_broker', at)
    const brokers = owned
      .filter((b) => b.VaultID === vaultId)
      .map((b) => normaliseBroker({ ...b, index: b.index ?? b.LedgerIndex }))

    const loans = []
    for (const b of brokers) {
      for (let seq = 1; seq < b.loanSequence; seq++) {
        try {
          const l = await this.xrpl.loan({ loan_broker_id: b.loanBrokerId, loan_seq: seq }, at)
          loans.push(normaliseLoan({ ...l, index: l.index ?? l.LedgerIndex }, closeTime))
        } catch (e) {
          // A deleted (fully repaid) loan is expected to be missing. Not an error. Any other failure
          // fails the vault's read: a snapshot missing a loan grades the facility as if it never lent.
          const code = e?.data?.error
          if (code !== 'entryNotFound' && code !== 'objectNotFound') throw e
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
    const { assetsTotal, lossUnrealized } = vault
    const s = wholeShares(vault.sharesOutstanding, vault.scale)
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
    let closeTime
    try {
      closeTime = await this.xrpl.closeTime()
    } catch (e) {
      this.degraded = true
      throw e
    }
    this.closeTime = closeTime
    this.ledgerIndex = this.xrpl.lastLedger
    this.ledgerHash = this.xrpl.lastLedgerHash ?? null
    const L = this.ledgerIndex
    const H = this.ledgerHash
    this.serverTime = new Date((closeTime + 946684800) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

    let failed = false
    for (const id of this.vaultIds) {
      try {
        const { vault, brokers, loans } = await this.readVault(id, closeTime, L ?? undefined)
        const snap = {
          vaultId: id,
          readAt: this.serverTime,
          // Wall clock as well as ledger time: when the ledger cannot be read at all, the ledger
          // clock stops too, and only this one says how old the snapshot has become.
          readMs: Date.now(),
          closeTimeUsed: closeTime,
          ledgerIndex: L,
          ledgerHash: H,
          vault,
          brokers,
          loans,
          ...Reader.nav(vault),
          phaseInfo: Reader.phaseInfo(vault, closeTime),
        }
        const prev = this.snapshots.get(id)
        this.snapshots.set(id, snap)
        this.missing.delete(id)
        this._notify(snap)
        this.lastGoodAt = Date.now()

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
        const code = e?.data?.error
        if (code === 'entryNotFound' || code === 'objectNotFound') this.missing.add(id)
        failed = true
        this.degraded = true
        log.warn('vault read failed, keeping last good snapshot', {
          vault: id.slice(0, 12),
          err: (e?.data?.error ?? String(e)).slice(0, 100),
        })
      }
    }
    // Degraded until a whole pass reads every vault: one vault read fine says nothing of the next.
    this.degraded = failed
    this.passes++
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
  /**
   * Find a facility by its SHARE token rather than by its vault id.
   *
   * This is the lookup a holder needs. Someone pledged vault shares is given an MPT
   * issuance id; they have no reason to know, and no way to discover, the vault behind
   * it. Valuation has to be reachable from the token.
   */
  getByShareMpt(mptId) {
    const want = String(mptId).toUpperCase()
    return this.all().find((s) => String(s.vault.shareMptId ?? '').toUpperCase() === want) ?? null
  }
  all() { return [...this.snapshots.values()] }
  get lastLedgerAgeSeconds() {
    return this.lastGoodAt ? Math.floor((Date.now() - this.lastGoodAt) / 1000) : null
  }
}
