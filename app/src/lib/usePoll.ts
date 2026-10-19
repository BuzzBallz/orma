import { useEffect, useState } from 'react'
import { ApiFailure, getJson } from './api'

export interface Poll<T> {
  data: T | null          // LAST GOOD payload. Never cleared once set.
  error: string | null    // most recent failure, or null
  code: string | null     // error code from the API envelope, when it sent one
  stale: boolean          // true when the last good payload is older than 6000ms
  ageMs: number           // age of the last good payload, from performance.now()
  fails: number           // consecutive failures
  receivedAt: number      // performance.now() of the last good payload, 0 before the first
  waiting: boolean        // the request in flight has taken longer than WAITING_AFTER_MS
}

const STALE_AFTER_MS = 6000
/** A request this slow is a service waking up, and the page says so instead of drawing nothing. */
const WAITING_AFTER_MS = 3000

/**
 * A failing poll backs off exponentially instead of hammering, capped at 5s — long enough
 * to stop being a storm, short enough that the desk is back within one beat of the
 * operator restarting the API. A poll that is already slower than the cap keeps its own
 * interval: backing off must never make a poll go faster.
 */
const BACKOFF_CAP_MS = 5000
const nextDelay = (intervalMs: number, fails: number, capMs = BACKOFF_CAP_MS) =>
  fails === 0 ? intervalMs
    : Math.min(intervalMs * 2 ** fails, Math.max(intervalMs, capMs))

/**
 * setTimeout-chained poll. Never setInterval: a slow response must not stack requests.
 * `data` is never set back to null after a success — not on error, not on a 404, not on a url change.
 */
export function usePoll<T>(path: string | null, intervalMs: number, opts?: {
  /** Consecutive failures after which the cap widens — for a base we already distrust. */
  slowAfter?: number
  slowCapMs?: number
}): Poll<T> {
  const slowAfter = opts?.slowAfter ?? Infinity
  const slowCapMs = opts?.slowCapMs ?? BACKOFF_CAP_MS
  // `path` is the address the error, the code and the waiting flag belong to. They are dropped as
  // soon as the address changes: the last facility's 404 is not the next one's.
  const [state, setState] = useState<Omit<Poll<T>, 'stale' | 'ageMs'> & { path: string | null }>({
    data: null, error: null, code: null, fails: 0, receivedAt: 0, waiting: false, path: null,
  })
  // The clock the age is read against, ticked so `stale`/`ageMs` stay live between polls.
  const [now, setNow] = useState(() => performance.now())

  useEffect(() => {
    // `cancelled` is per effect run, deliberately NOT a ref. A ref is shared across runs:
    // switching vault sets it false on cleanup and the next run sets it true again, so a
    // request still in flight for the OLD path would see `true`, write the old vault's
    // payload under the new vault's url, and schedule a second polling loop that fights
    // the first one every 3s. Pressing 1-5 quickly on stage is exactly that.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let fails = 0

    async function cycle() {
      if (cancelled) return
      if (path === null) { timer = setTimeout(cycle, intervalMs); return }
      const slow = setTimeout(() => {
        if (!cancelled) setState(s => ({ ...(s.path === path ? s : { ...s, error: null, code: null, fails: 0 }), waiting: true, path }))
      }, WAITING_AFTER_MS)
      try {
        const data = await getJson<T>(path)
        if (cancelled) return
        fails = 0
        setState({ data, error: null, code: null, fails: 0, receivedAt: performance.now(), waiting: false, path })
      } catch (e) {
        if (cancelled) return
        const f = e instanceof ApiFailure ? e : null
        fails += 1
        // keep data: last good payload stays on screen
        setState(s => ({ ...s, error: f?.message ?? 'network error', code: f?.code ?? null, fails: (s.path === path ? s.fails : 0) + 1, waiting: false, path }))
      } finally {
        clearTimeout(slow)
        // whatever the outcome, schedule the next poll. The loop must be unkillable —
        // it just slows down while nobody is answering.
        if (!cancelled) timer = setTimeout(cycle, nextDelay(intervalMs, fails, fails >= slowAfter ? slowCapMs : BACKOFF_CAP_MS))
      }
    }
    cycle()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [path, intervalMs, slowAfter, slowCapMs])

  // 1Hz heartbeat so the stale bar's numbers move without a new payload.
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // The clock can lag a fresh payload by up to a tick; that payload is simply new.
  const ageMs = state.receivedAt === 0 ? 0 : Math.max(0, now - state.receivedAt)
  const mine = state.path === path
  return {
    data: state.data, receivedAt: state.receivedAt, ageMs, stale: state.receivedAt !== 0 && ageMs > STALE_AFTER_MS,
    error: mine ? state.error : null, code: mine ? state.code : null, fails: mine ? state.fails : 0, waiting: mine && state.waiting,
  }
}
