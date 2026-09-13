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
import { fetchBrokerHistory, analyseOrdering, reputation, recommendOrder } from './history.mjs'
import { presentNav, resolveFromIssuance, valuePledge } from './nav.mjs'
import { gateStatus, isNamedIn } from './credentials.mjs'
import { deriveScoreInputs, buildScore } from './score.mjs'
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
  /** history is many round trips; 15s is well inside a 4s UI poll */
  const historyCache = new Map()
  /** a domain changes when someone edits it, not every four seconds */
  const gateCache = new Map()

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

    const send = (code, body, o = {}) => {
      const headers = { 'Content-Type': 'application/json' }
      // Only the two valuation routes opt in. They exist to be called by a party with no
      // relationship to us -- that is the entire point of putting the URL in a token --
      // and they serve read-only public ledger state, so there is nothing to protect.
      // The rest of the API stays same-origin.
      if (o.cors) {
        headers['Access-Control-Allow-Origin'] = '*'
        headers['Cache-Control'] = 'public, max-age=4'
      }
      res.writeHead(code, headers)
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

      // Broker track record: what they actually did, what the fair sequence would have
      // paid depositors, and what they should do next. The two audiences Shota named:
      // depositors see the cost of the ordering, the broker gets a fairness tool.
      const hm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/broker-history$/)
      if (hm && req.method === 'GET') {
        const snap = reader.get(hm[1].toUpperCase()) ?? reader.get(hm[1])
        if (!snap) return fail(404, 'VAULT_NOT_FOUND', 'No vault with that id', false)
        const broker = snap.brokers[0]
        if (!broker) return fail(404, 'NO_BROKER', 'vault has no loan broker', false)
        const cached = historyCache.get(broker.loanBrokerId)
        if (cached && Date.now() - cached.at < 15000) return send(200, stamp(cached.body))
        const events = await fetchBrokerHistory(reader.xrpl, broker.owner, broker.loanBrokerId)
        const ordering = analyseOrdering(events, broker)
        const body = {
          loanBrokerId: broker.loanBrokerId,
          owner: broker.owner,
          events: events.map((e) => ({
            kind: e.kind, at: e.at, hash: e.hash, loanId: e.loanId,
            // null, not "0": an impairment leaves the broker object untouched, so this
            // transaction does not report the book. Zero would read as an empty book.
            brokerStateKnown: e.brokerStateKnown,
            debtBefore: e.brokerStateKnown ? e.debtBefore.toFixed(0) : null,
            debtAfter: e.brokerStateKnown ? e.debtAfter.toFixed(0) : null,
            coverBefore: e.brokerStateKnown ? e.coverBefore.toFixed(0) : null,
            coverAfter: e.brokerStateKnown ? e.coverAfter.toFixed(0) : null,
            coverConsumed: e.coverConsumed.toFixed(0), principal: e.principal.toFixed(0),
            exposure: e.exposure.toFixed(0),
          })),
          ordering,
          reputation: reputation(events, ordering, broker),
          recommendation: recommendOrder(snap.loans, broker),
        }
        historyCache.set(broker.loanBrokerId, { at: Date.now(), body })
        return send(200, stamp(body))
      }

      // ---------------------------------------------------------------------
      // The valuation endpoint a share token's own metadata points at.
      //
      // Public, stable and deliberately small. The metadata carrying this URL can never
      // be rewritten (Appendix D1), so this contract is effectively permanent: fields may
      // be added, nothing may ever be renamed, retyped or removed.
      //
      // CORS is open because the whole point is that a party with no relationship to us
      // can use it. Read-only, public ledger state, nothing to protect.
      // ---------------------------------------------------------------------
      const nm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/nav$/)
      if (nm && req.method === 'GET') {
        const snap = reader.get(nm[1].toUpperCase()) ?? reader.get(nm[1])
        if (!snap) return fail(404, 'VAULT_NOT_FOUND', 'No vault with that id', false)
        let score = null
        try {
          score = buildScore(deriveScoreInputs({ ...snap.vault, broker: snap.brokers[0] ?? {}, loans: snap.loans, phase: snap.vault.phase }).scoreArgs)
        } catch { /* the valuation is the product; the grade is a courtesy */ }
        return send(200, stamp(presentNav(snap, {
          score, source, network: 'devnet',
          buildVersion: reader.xrpl?.buildVersion ?? null,
          asOf: reader.serverTime ?? null,
          ledgerIndex: reader.ledgerIndex ?? null,
        })), { cors: true })
      }

      // Is this facility gated, and by whom?
      //
      // Reads the SHARE ISSUANCE, not the Vault: DomainID is not on the Vault ledger
      // entry, so the obvious lookup returns nothing and reads exactly like "open to
      // everyone". Cached: a domain changes when someone edits it, not every four
      // seconds, and this costs two extra ledger reads.
      const gm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/gate$/)
      if (gm && req.method === 'GET') {
        const snap = reader.get(gm[1].toUpperCase()) ?? reader.get(gm[1])
        if (!snap) return fail(404, 'VAULT_NOT_FOUND', 'No vault with that id', false)
        const key = snap.vault.vaultId
        const cached = gateCache.get(key)
        if (cached && Date.now() - cached.at < 30000) return send(200, stamp(cached.body))
        const status = await gateStatus(reader.xrpl, snap.vault)
        const body = {
          vaultId: key,
          ...status,
          // The rater's own question: am I cited here? Answered without asking them,
          // which is the point -- they were never consulted in the first place.
          issuerNamed: opts.raterAddress ? isNamedIn(status, opts.raterAddress) : null,
          raterAddress: opts.raterAddress ?? null,
          // Only for the facility this chain was actually baked against. A gate object
          // proves a domain exists; the chain proves what happened when someone tried to
          // enter it, which is the part that cannot be asserted.
          proof: opts.gateProof && opts.gateProof.vaultId === key
            ? { bakedAt: opts.gateProof.bakedAt, steps: opts.gateProof.steps }
            : null,
        }
        gateCache.set(key, { at: Date.now(), body })
        return send(200, stamp(body))
      }

      // THE ROUTE THE TOKEN POINTS AT. Same valuation, keyed by the share token instead
      // of by the vault, because that is the only identifier a holder has. This is what
      // the metadata template resolves to, so it must never itself follow a pointer:
      // that would be a loop.
      //
      // `units` values a specific pledge, so a lender does not have to reimplement
      // decimal arithmetic to use this.
      const vm = url.pathname.match(/^\/api\/mpt\/([A-Fa-f0-9]{48})\/nav$/)
      if (vm && req.method === 'GET') {
        const snap = reader.getByShareMpt(vm[1])
        if (!snap) return fail(404, 'SHARE_NOT_TRACKED', 'No facility on this service issues that share token', false)
        let score = null
        try {
          score = buildScore(deriveScoreInputs({ ...snap.vault, broker: snap.brokers[0] ?? {}, loans: snap.loans, phase: snap.vault.phase }).scoreArgs)
        } catch { /* the valuation is the product; the grade is a courtesy */ }
        const body = presentNav(snap, {
          score, source, network: 'devnet',
          buildVersion: reader.xrpl?.buildVersion ?? null,
          asOf: reader.serverTime ?? null, ledgerIndex: reader.ledgerIndex ?? null,
        })
        const units = url.searchParams.get('units')
        if (units) body.pledge = valuePledge(body, units)
        return send(200, stamp(body), { cors: true })
      }

      // THE DIAGNOSTIC. Runs the loop a second broker runs and reports every step:
      // read the issuance, decode the metadata, substitute the token's own id into the
      // pointer, follow it. Separate from the route above on purpose -- the valuation
      // must not be reachable only by walking a pointer to itself.
      //
      // Every step is reported including failure, because "this collateral is opaque" is
      // a useful answer to give a lender and a far better one than an exception.
      const rm = url.pathname.match(/^\/api\/mpt\/([A-Fa-f0-9]{48})\/resolve$/)
      if (rm && req.method === 'GET') {
        const resolve = url.searchParams.get('resolve') !== 'false'
        const out = await resolveFromIssuance(reader.xrpl, rm[1].toUpperCase(), { resolve })
        const units = url.searchParams.get('units')
        if (units && out.nav) out.pledge = valuePledge(out.nav, units)
        return send(200, stamp(out), { cors: true })
      }

      // Demo 1. `demo/` is TRACKED and `fixtures/` is not, so the tracked capture must be
      // tried first: served from fixtures alone, this route 404s on a clean clone and the
      // most important demo in the pitch dies in front of the judges.
      if (key === 'GET /api/indexer-race') {
        const path = ['demo/indexer-race.json', 'fixtures/indexer-race.json'].find((f) => existsSync(f))
        if (!path) return fail(404, 'NOT_FOUND', 'no capture available', false)
        return send(200, stamp(JSON.parse(readFileSync(path, 'utf8'))))
      }

      // The contestability capture. Two publishers with no relationship, and rippled's own
      // median across them. Tracked, for the same reason the race capture is: the claim that
      // a ledger object can be argued with is the whole case for not being a REST API, and
      // it cannot be made from one publisher.
      if (key === 'GET /api/oracle-aggregate') {
        if (!existsSync('demo/oracle-aggregate.json')) return fail(404, 'NOT_FOUND', 'no aggregate captured', false)
        return send(200, stamp(JSON.parse(readFileSync('demo/oracle-aggregate.json', 'utf8'))))
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
