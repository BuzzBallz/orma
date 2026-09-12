import { useEffect, useRef, useState } from 'react'
import { ApiFailure, getJson } from './api'

export interface Poll<T> {
  data: T | null          // LAST GOOD payload. Never cleared once set.
  error: string | null    // most recent failure, or null
  code: string | null     // error code from the API envelope, when it sent one
  stale: boolean          // true when the last good payload is older than 6000ms
  ageMs: number           // age of the last good payload, from performance.now()
  fails: number           // consecutive failures
  receivedAt: number      // performance.now() of the last good payload, 0 before the first
}

const STALE_AFTER_MS = 6000

/**
 * setTimeout-chained poll. Never setInterval: a slow response must not stack requests.
 * `data` is never set back to null after a success — not on error, not on a 404, not on a url change.
 */
export function usePoll<T>(path: string | null, intervalMs: number): Poll<T> {
  const [state, setState] = useState<Omit<Poll<T>, 'stale' | 'ageMs'>>({
    data: null, error: null, code: null, fails: 0, receivedAt: 0,
  })
  // A tick purely to re-render so `stale`/`ageMs` stay live between polls.
  const [, setBeat] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout> | undefined

    async function cycle() {
      if (!alive.current) return
      if (path === null) { timer = setTimeout(cycle, intervalMs); return }
      try {
        const data = await getJson<T>(path)
        if (!alive.current) return
        setState({ data, error: null, code: null, fails: 0, receivedAt: performance.now() })
      } catch (e) {
        if (!alive.current) return
        const f = e instanceof ApiFailure ? e : null
        // keep data: last good payload stays on screen
        setState(s => ({ ...s, error: f?.message ?? 'network error', code: f?.code ?? null, fails: s.fails + 1 }))
      } finally {
        // whatever the outcome, schedule the next poll. The loop must be unkillable.
        if (alive.current) timer = setTimeout(cycle, intervalMs)
      }
    }
    cycle()
    return () => { alive.current = false; if (timer) clearTimeout(timer) }
  }, [path, intervalMs])

  // 1Hz heartbeat so the stale bar's numbers move without a new payload.
  useEffect(() => {
    const id = setInterval(() => setBeat(b => b + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const ageMs = state.receivedAt === 0 ? 0 : performance.now() - state.receivedAt
  return { ...state, ageMs, stale: state.receivedAt !== 0 && ageMs > STALE_AFTER_MS }
}
