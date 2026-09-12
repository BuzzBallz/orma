/**
 * The API. Same routes and shapes as tools/fixture-server.mjs, so the frontend
 * never changes a URL: only `health.source` flips from "fixtures" to "devnet".
 *
 * Zero dependencies on purpose. An HTTP framework is one more thing to fail at
 * 02:00, and this serves eight routes.
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { presentVault, presentRow, setLabel } from './present.mjs'
import { findShareEscrows, presentCollateral } from './collateral.mjs'
import { logger } from './log.mjs'

const log = logger('api')
const CONTRACT_VERSION = '1.0.0'

/**
 * @param {import('./poll.mjs').Reader} reader
 * @param {{port?:number, source?:string, demo?:object}} opts
 */
export function createApi(reader, opts = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787)
  const source = opts.source ?? 'devnet'
  /** previous navCorrect per vault, so `trend` is real rather than guessed */
  const prevNav = new Map()

  const stamp = (body) => ({
    serverTime: reader.serverTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ledgerIndex: reader.ledgerIndex ?? 0,
    ...body,
  })

  const health = () => {
    const h = {
      ok: Boolean(reader.serverTime),
      contractVersion: CONTRACT_VERSION,
      source,
      network: 'devnet',
      ledgerIndex: reader.ledgerIndex ?? 0,
      serverTime: reader.serverTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      buildVersion: reader.xrpl?.buildVersion ?? null,
    }
    // Additive per contract 0.0 A3, present only while upstream is unhappy.
    if (reader.degraded) {
      h.degraded = true
      h.lastLedgerAgeSeconds = reader.lastLedgerAgeSeconds ?? 0
    }
    return h
  }

  const rowFor = (snap) =>
    presentRow(snap, {
      prevNavCorrect: prevNav.get(snap.vaultId),
      oracle: opts.oracleFor?.(snap.vaultId) ?? null,
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    const key = `${req.method} ${url.pathname}`
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()

    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body, null, 2))
      if (code >= 400) log.warn('response', { key, code })
    }
    const fail = (code, errCode, message, retryable = false) =>
      send(code, { error: { code: errCode, message, retryable } })

    try {
      if (key === 'GET /api/health') return send(200, health())

      if (key === 'GET /api/vaults') {
        const vaults = reader.all().map(rowFor)
        // Worst first. NOT by divergence: divergence is only non-zero once a loss has
        // been DECLARED, so an undeclared loss reads 0 bps and would sort the most
        // dangerous vault to the bottom. See contract section 2.
        vaults.sort((a, b) => a.gradeNumeric - b.gradeNumeric)
        return send(200, stamp({ vaults }))
      }

      const m = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})$/)
      if (m && req.method === 'GET') {
        const snap = reader.get(m[1].toUpperCase()) ?? reader.get(m[1])
        if (!snap) return fail(404, 'VAULT_NOT_FOUND', 'No vault with that id', false)
        const detail = presentVault(snap, {
          prevNavCorrect: prevNav.get(snap.vaultId),
          oracle: opts.oracleFor?.(snap.vaultId) ?? null,
        })
        prevNav.set(snap.vaultId, snap.navCorrect)
        return send(200, stamp(detail))
      }

      // Collateral: escrowed vault shares, valued both ways. This is the endpoint a
      // second broker would call before lending against a pledge.
      const cm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/collateral$/)
      if (cm && req.method === 'GET') {
        const snap = reader.get(cm[1].toUpperCase()) ?? reader.get(cm[1])
        if (!snap) return fail(404, 'VAULT_NOT_FOUND', 'No vault with that id', false)
        const shareMptId = snap.vault.shareMptId
        if (!shareMptId) return fail(404, 'NO_SHARE_MPT', 'vault has no share issuance', false)
        // No reverse index exists from an MPT issuance to the escrows holding it, so a
        // lender must be told which accounts to look at. Reported as a feedback item.
        const accounts = [
          ...(url.searchParams.get('accounts')?.split(',').filter(Boolean) ?? []),
          ...(opts.watchAccounts ?? []),
          snap.vault.owner,
        ]
        const haircut = Number(url.searchParams.get('haircut') ?? 0)
        const escrows = await findShareEscrows(reader.xrpl, shareMptId, accounts)
        return send(200, stamp(presentCollateral(escrows, snap, haircut)))
      }

      if (key === 'GET /api/indexer-race') {
        const path = 'fixtures/indexer-race.json'
        if (!existsSync(path)) return fail(404, 'NOT_FOUND', 'no capture available', false)
        return send(200, stamp(JSON.parse(readFileSync(path, 'utf8'))))
      }

      if (key === 'GET /api/demo/state') {
        return send(200, stamp({
          bakedVaults: reader.all().map((s) => ({
            vaultId: s.vaultId,
            label: rowFor(s).label,
            phase: s.vault.phase,
            redemptionAt: s.vault.redemptionAt,
          })),
          activeVaultId: reader.vaultIds[0] ?? null,
          phase: reader.all()[0]?.vault.phase ?? null,
        }))
      }

      // Operator routes. Bound to loopback unless a key is set: an endpoint that can
      // default a loan should not be reachable from venue wifi in a room of hackers.
      if (url.pathname.startsWith('/api/demo/') && req.method === 'POST') {
        const allowed = req.socket.remoteAddress?.includes('127.0.0.1')
          || req.socket.remoteAddress === '::1'
          || (process.env.DEMO_KEY && req.headers['x-demo-key'] === process.env.DEMO_KEY)
        if (!allowed) return fail(403, 'FORBIDDEN', 'operator routes are loopback-only', false)
        const action = url.pathname.split('/').pop()
        if (!opts.demo?.[action]) return fail(404, 'NOT_FOUND', `no demo action "${action}"`, false)
        const body = await readBody(req)
        const out = await opts.demo[action](body, reader)
        return send(200, stamp({ ok: true, action, ...out }))
      }

      return fail(404, 'NOT_FOUND', `No route ${key}`, false)
    } catch (e) {
      log.error('unhandled', { key, err: String(e).slice(0, 200) })
      return fail(500, 'INTERNAL', 'unexpected error', true)
    }
  })

  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, () => {
          log.info('api listening', { port, source })
          resolve(port)
        })
      }),
    close: () => new Promise((r) => server.close(r)),
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch { resolve({}) } })
  })
}
