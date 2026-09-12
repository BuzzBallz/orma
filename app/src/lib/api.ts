export const API_BASE = (import.meta.env.VITE_API_BASE ?? 'http://localhost:8787').replace(/\/+$/, '')
export const EXPECTED_CONTRACT = '1.0.0'

/**
 * A deployed preview cannot reach the operator's laptop. With VITE_API_BASE unset the base
 * falls back to http://localhost:8787, which from an https page is blocked as mixed content
 * before it ever leaves the tab — and polled every 3s that is a failure storm with nothing
 * to show for it. Name the misconfiguration once, stop asking, and let the desk paint its
 * empty slots. Spec §8: the screen always says where it is reading from.
 *
 * null means "go ahead and poll".
 */
export const API_UNREACHABLE: string | null =
  typeof location !== 'undefined'
  && location.protocol === 'https:'
  && API_BASE.startsWith('http://')
    ? `this page is served over https and the API base is ${API_BASE}`
    : null

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
