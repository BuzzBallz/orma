export const API_BASE = (import.meta.env.VITE_API_BASE ?? 'http://localhost:8787').replace(/\/+$/, '')
export const EXPECTED_CONTRACT = '1.0.0'

/**
 * A deployed preview reaching an http base from an https page is a configuration we should
 * be suspicious of, but NOT one we may refuse on the operator's behalf: Chrome treats
 * http://localhost as a trustworthy origin and lets it through, so the demo laptop running
 * the fixture server behind a Vercel URL can genuinely work. Every other machine, and
 * Safari anywhere, will be blocked before the request leaves the tab.
 *
 * So we try, and we stop hammering when it is clearly not going to answer — see
 * SUSPECT_BACKOFF_MS. null means "nothing suspicious about this base".
 */
export const API_MIXED_ORIGIN: string | null =
  typeof location !== 'undefined'
  && location.protocol === 'https:'
  && API_BASE.startsWith('http://')
    ? `this page is served over https and the API base is ${API_BASE}`
    : null

/** Consecutive failures after which a suspect base is treated as not coming back. */
export const SUSPECT_AFTER_FAILS = 5
/** …and the interval it falls back to. Two requests a minute is a heartbeat, not a storm. */
export const SUSPECT_BACKOFF_MS = 30_000

export class ApiFailure extends Error {
  // Plain fields, not parameter properties: the Vite template compiles with
  // `erasableSyntaxOnly`, which rejects constructor-parameter declarations.
  status: number
  code: string | null
  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Single fetch with a hard 2500ms abort. Throws ApiFailure on anything that is not a 2xx JSON body. */
export async function getJson<T>(path: string, timeoutMs = 2500): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(API_BASE + path, { signal: ctl.signal, headers: { accept: 'application/json' } })
    const text = await res.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error
      throw new ApiFailure(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? null)
    }
    if (body === null) throw new ApiFailure('empty body', res.status, null)
    return body as T
  } catch (e) {
    if (e instanceof ApiFailure) throw e
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiFailure('timeout', 0, 'TIMEOUT')
    throw new ApiFailure(e instanceof Error ? e.message : 'network error', 0, null)
  } finally {
    clearTimeout(timer)
  }
}
