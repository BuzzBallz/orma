/**
 * Continuous publication: turns reader snapshots into on-ledger oracle updates.
 *
 * Publishing every tick would be wrong twice over. It costs a fee and a sequence
 * number for a number that did not move, and `LastUpdateTime` must strictly increase
 * so a 4-second cadence eventually collides with the one-per-second ceiling. So we
 * publish on MATERIAL CHANGE, plus a heartbeat so a stale oracle is distinguishable
 * from a dead publisher.
 *
 * Publication never blocks a read. A failed publish must not stop the reader from
 * seeing the next impairment: reading correctly is the product, publishing is
 * distribution.
 */
import { presentVault } from './present.mjs'
import { logger } from './log.mjs'

const log = logger('publish')

export const HEARTBEAT_MS = Number(process.env.PUBLISH_HEARTBEAT_MS ?? 60000)

export class PublishLoop {
  /**
   * @param {import('./poll.mjs').Reader} reader
   * @param {import('./oracle.mjs').OraclePublisher} publisher
   */
  constructor(reader, publisher) {
    this.reader = reader
    this.publisher = publisher
    /** @type {Map<string,{navCorrect:string, grade:string, at:number}>} */
    this.lastPublished = new Map()
    /** @type {Map<string,object>} cached oracle read, served on the vault detail */
    this.oracleCache = new Map()
    this.inflight = new Set()
    this.publishCount = 0
    this.failCount = 0
  }

  /** Material change, or the heartbeat has elapsed. */
  shouldPublish(vaultId, detail) {
    const prev = this.lastPublished.get(vaultId)
    if (!prev) return 'first'
    if (prev.navCorrect !== detail.vault.navCorrect) return 'nav'
    if (prev.grade !== detail.score.grade) return 'grade'
    if (Date.now() - prev.at >= HEARTBEAT_MS) return 'heartbeat'
    return null
  }

  /**
   * Handle one snapshot. Deliberately not awaited by the reader.
   * @param {object} snap
   */
  async onSnapshot(snap) {
    const vaultId = snap.vaultId
    if (this.inflight.has(vaultId)) return
    let detail
    try {
      detail = presentVault(snap, { oracle: this.oracleCache.get(vaultId) ?? null })
    } catch (e) {
      log.warn('present failed, not publishing', { vault: vaultId.slice(0, 12), err: String(e).slice(0, 80) })
      return
    }
    const reason = this.shouldPublish(vaultId, detail)
    if (!reason) return

    this.inflight.add(vaultId)
    try {
      // Ledger close time in UNIX, which is what LastUpdateTime wants. Never wall clock:
      // a skewed laptop that publishes into the future bricks the object.
      const lut = snap.closeTimeUsed + 946684800
      const res = await this.publisher.publish(detail, lut)
      if (res?.ok) {
        this.publishCount++
        this.lastPublished.set(vaultId, {
          navCorrect: detail.vault.navCorrect,
          grade: detail.score.grade,
          at: Date.now(),
        })
        log.info('published', { vault: vaultId.slice(0, 12), reason, nav: detail.vault.navCorrect, grade: detail.score.grade })
        try {
          this.oracleCache.set(vaultId, await this.publisher.read(vaultId))
        } catch { /* the cache is cosmetic; the ledger is the record */ }
      } else if (!res?.skipped) {
        this.failCount++
        log.warn('publish rejected', { vault: vaultId.slice(0, 12), reason, result: res?.result })
      }
    } catch (e) {
      this.failCount++
      log.warn('publish threw', { vault: vaultId.slice(0, 12), err: (e?.data?.error ?? String(e)).slice(0, 100) })
    } finally {
      this.inflight.delete(vaultId)
    }
  }

  /** Attach to the reader. Fire-and-forget so a slow publish cannot stall a read. */
  attach() {
    this.reader.onSnapshot = (snap) => {
      this.onSnapshot(snap).catch((e) => log.warn('onSnapshot failed', { err: String(e).slice(0, 80) }))
    }
    log.info('attached', { heartbeatMs: HEARTBEAT_MS })
  }

  oracleFor(vaultId) {
    return this.oracleCache.get(vaultId) ?? null
  }

  stats() {
    return { published: this.publishCount, failed: this.failCount, tracked: this.lastPublished.size }
  }
}
