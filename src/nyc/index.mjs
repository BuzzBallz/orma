/**
 * The NYC modules' single entry into the API. It knows the wire and carries no business logic:
 * every step adds its own block below and one line to the dispatcher in `handle`.
 */
import { accessSync, constants } from 'node:fs'

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

  return {
    async handle(req, res, url, helpers) {
      if (await handleHarness(req, res, url, helpers)) return true
      return false
    },
    missing,
    demoActions: {},
  }
}
