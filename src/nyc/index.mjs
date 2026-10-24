/**
 * The NYC modules' single entry into the API. It knows the wire and carries no business logic:
 * every step adds its own block below and one line to the dispatcher in `handle`.
 */
import { accessSync, constants } from 'node:fs'
import { Xrpl, DEVNET_WS } from '../xrpl.mjs'
import { attestationStatus } from '../nav.mjs'
import { verify } from '../mark/verify.mjs'

/**
 * @param {{ reader: import('../poll.mjs').Reader, env: NodeJS.ProcessEnv }} deps
 */
export function createNyc({ reader, env }) {
  const missing = ['ROLES_FILE', 'DESK_SEED', 'ALLOWED_WRITE_ORIGINS', 'PUBLISH_SEED'].filter((k) => !env[k])

  // --- step 2: harness ---
  // A stub: writes answer 503 until the roles file and the desk seed exist. Step 8 replaces the body.
  const rolesReadable = (() => {
    try {
      accessSync(env.ROLES_FILE, constants.R_OK)
      return true
    } catch {
      return false
    }
  })()
  async function handleHarness(req, res, url, { fail }) {
    if (!url.pathname.startsWith('/api/roles/')) return false
    if (req.method === 'POST' && !(rolesReadable && env.DESK_SEED)) {
      fail(503, 'NOT_CONFIGURED', 'Writes are not configured on this server: ROLES_FILE and DESK_SEED are required', false)
    } else {
      fail(404, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`, false)
    }
    return true
  }

  // --- step 6: orma-mark ---
  const MARK_TTL_MS = 15_000
  const MARK_CACHE_MAX = 100
  const MARK_MAX_PARALLEL = 4
  /** mptId -> { at, result }: the promise of one verification, shared by every request inside the TTL, a failure included */
  const marks = new Map()
  let verifying = 0
  async function verifyOnFreshConnection(mptId) {
    const xrpl = new Xrpl(env.XRPL_WS ?? DEVNET_WS)
    try {
      await xrpl.client.connect()
      return await verify(mptId, { xrpl })
    } finally {
      await xrpl.disconnect()
    }
  }
  async function handleOrmaMark(req, res, url, { send, fail, stamp }) {
    const m = /^\/api\/(?:mpt\/([^/]+)\/status|mark\/([^/]+))$/.exec(url.pathname)
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    const id = m[1] ?? m[2]
    if (!/^[A-Fa-f0-9]{48}$/.test(id)) {
      fail(400, 'BAD_REQUEST', 'The share id must be 48 hex characters', false)
      return true
    }
    const mptId = id.toUpperCase()
    if (m[1]) {
      send(200, stamp({ mptId, status: attestationStatus(reader, mptId) }))
      return true
    }
    let hit = marks.get(mptId)
    if (!hit || Date.now() - hit.at >= MARK_TTL_MS) {
      if (verifying >= MARK_MAX_PARALLEL) {
        fail(503, 'BUSY', 'Too many verifications in flight; retry shortly', true)
        return true
      }
      verifying++
      const result = verifyOnFreshConnection(mptId).finally(() => { verifying-- })
      result.catch(() => {})
      hit = { at: Date.now(), result }
      marks.delete(mptId)
      if (marks.size >= MARK_CACHE_MAX) marks.delete(marks.keys().next().value)
      marks.set(mptId, hit)
    }
    try {
      send(200, stamp(await hit.result))
    } catch {
      fail(503, 'BUSY', 'The ledger node could not be reached for this verification; retry shortly', true)
    }
    return true
  }

  return {
    async handle(req, res, url, helpers) {
      if (await handleHarness(req, res, url, helpers)) return true
      if (await handleOrmaMark(req, res, url, helpers)) return true
      return false
    },
    missing,
    demoActions: {},
  }
}
