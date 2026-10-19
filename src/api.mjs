/**
 * The API. Same routes and shapes as tools/fixture-server.mjs, so the frontend
 * never changes a URL: only `health.source` flips from "fixtures" to "devnet".
 *
 * Zero dependencies on purpose. An HTTP framework is one more thing to fail at
 * 02:00, and this serves eight routes.
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { isValidClassicAddress } from 'xrpl'
import { presentVault, presentRow, setLabel } from './present.mjs'
import { findShareEscrows, presentCollateral } from './collateral.mjs'
import { readBrokerHistory, analyseOrdering, reputation, recommendOrder } from './history.mjs'
import { fetchNavHistory } from './navhistory.mjs'
import { presentNav, resolveFromIssuance, valuePledge } from './nav.mjs'
import { gateStatus, isNamedIn } from './credentials.mjs'
import { deriveScoreInputs, buildScore } from './score.mjs'
import { logger } from './log.mjs'

const log = logger('api')
/** A pledge is a whole number of share units. Scientific notation would make Decimal write out every digit. */
const UNITS = /^[0-9]{1,30}$/
/**
 * Collateral and resolve walk the ledger (and resolve, a URL) on the reader's own connection, with
 * no cache. Past this many at once a caller is told to retry, so a flood cannot starve the poll.
 */
const MAX_LEDGER_WALKS = 4
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
  let ledgerWalks = 0

  const stamp = (body) => ({
    serverTime: reader.serverTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ledgerIndex: reader.ledgerIndex ?? 0,
    ...body,
  })

  const health = () => {
    const h = {
      // Not ok while the last pass failed to read a vault: a stale figure is not a healthy one.
      ok: Boolean(reader.serverTime) && !reader.degraded,
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
      closeTime: reader.closeTime,
    })

  const server = createServer(async (req, res) => {
    // Outside the try below, a target such as "//[" threw from this async handler and took the
    // process down with it.
    let url
    try {
      url = new URL(req.url, `http://localhost:${port}`)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'malformed request target', retryable: false } }))
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const key = `${method} ${url.pathname}`
    // Reads are open to any origin. Writes are not: no POST is ever allowed cross-origin.
    if (req.method !== 'POST') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS')
    }
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()

    const send = (code, body, o = {}) => {
      const headers = { 'Content-Type': 'application/json' }
      // Only the two valuation routes opt in. They exist to be called by a party with no
      // relationship to us -- that is the entire point of putting the URL in a token --
      // and they serve read-only public ledger state, so there is nothing to protect.
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
    // Not read yet is not absent: say retry, not "no such vault". Until the reader's first full
    // pass ends, an id may be a vault it has not reached (a reader that counts no passes: until its
    // first snapshot). After it, a vault it tracks but could not read is still on its way, unless the
    // ledger answered that it does not exist. A share id is unknown while any tracked vault is.
    const pending = (v) => Boolean(reader.vaultIds?.includes(v) && !reader.snapshots.has(v) && !reader.missing?.has(v))
    const absent = (errCode, message, vaultId = null) => {
      const firstPass = reader.passes === undefined ? reader.snapshots.size === 0 : reader.passes === 0
      const unread = firstPass || (vaultId ? pending(vaultId.toUpperCase()) : Boolean(reader.vaultIds?.some(pending)))
      return unread
        ? fail(503, 'WARMING_UP', 'Warming up: the reader has not read this vault yet', true)
        : fail(404, errCode, message, false)
    }

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
      if (m && method === 'GET') {
        const snap = reader.get(m[1].toUpperCase()) ?? reader.get(m[1])
        if (!snap) return absent('VAULT_NOT_FOUND', 'No vault with that id', m[1])
        const detail = presentVault(snap, {
          prevNavCorrect: prevNav.get(snap.vaultId),
          oracle: opts.oracleFor?.(snap.vaultId) ?? null,
          closeTime: reader.closeTime,
        })
        prevNav.set(snap.vaultId, snap.navCorrect)
        return send(200, stamp(detail))
      }

      // Collateral: escrowed vault shares, valued both ways. This is the endpoint a
      // second broker would call before lending against a pledge.
      const cm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/collateral$/)
      if (cm && method === 'GET') {
        const snap = reader.get(cm[1].toUpperCase()) ?? reader.get(cm[1])
        if (!snap) return absent('VAULT_NOT_FOUND', 'No vault with that id', cm[1])
        const shareMptId = snap.vault.shareMptId
        if (!shareMptId) return fail(404, 'NO_SHARE_MPT', 'vault has no share issuance', false)
        // No reverse index exists from an MPT issuance to the escrows holding it, so a
        // lender must be told which accounts to look at. Reported as a feedback item.
        // Each account costs a ledger round trip, so a caller names at most ten, and real ones.
        const asked = url.searchParams.get('accounts')?.split(',').filter(Boolean) ?? []
        if (asked.length > 10 || !asked.every(isValidClassicAddress)) {
          return fail(400, 'BAD_ACCOUNTS', 'accounts: at most 10 classic addresses, comma-separated', false)
        }
        const accounts = [...asked, ...(opts.watchAccounts ?? []), snap.vault.owner]
        const haircut = Number(url.searchParams.get('haircut') ?? 0)
        if (!Number.isFinite(haircut) || haircut < 0 || haircut > 100) {
          return fail(400, 'BAD_HAIRCUT', 'haircut: a percentage from 0 to 100', false)
        }
        if (ledgerWalks >= MAX_LEDGER_WALKS) return fail(503, 'BUSY', 'Too many ledger reads in flight; retry shortly', true)
        ledgerWalks++
        try {
          const escrows = await findShareEscrows(reader.xrpl, shareMptId, accounts)
          return send(200, stamp(presentCollateral(escrows, snap, haircut)))
        } finally {
          ledgerWalks--
        }
      }

      // Broker track record: what they actually did, what the fair sequence would have
      // paid depositors, and what they should do next. The two audiences Shota named:
      // depositors see the cost of the ordering, the broker gets a fairness tool.
      const hm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/broker-history$/)
      if (hm && method === 'GET') {
        const snap = reader.get(hm[1].toUpperCase()) ?? reader.get(hm[1])
        if (!snap) return absent('VAULT_NOT_FOUND', 'No vault with that id', hm[1])
        const broker = snap.brokers[0]
        if (!broker) return fail(404, 'NO_BROKER', 'vault has no loan broker', false)
        const cached = historyCache.get(broker.loanBrokerId)
        if (cached && Date.now() - cached.at < 15000) return send(200, stamp(cached.body))
        // Merged with the archive Devnet has pruned, and graded only if the record reaches back to
        // the broker's creation: a pruned record would otherwise read as a clean one.
        const { events, window } = await readBrokerHistory(reader.xrpl, broker, snap.vault)
        const ordering = analyseOrdering(events, broker, window)
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
            // What a cover deposit or withdrawal MOVED. Without it the row that says
            // "added first-loss capital" renders three zeros, on the exhibit whose whole
            // subject is first-loss capital.
            amount: e.amount ? e.amount.toFixed(0) : null,
            source: e.source,
          })),
          ordering,
          reputation: reputation(events, ordering, broker, window, snap.vault.asset),
          recommendation: recommendOrder(snap.loans, broker),
          window,
        }
        historyCache.set(broker.loanBrokerId, { at: Date.now(), body })
        return send(200, stamp(body))
      }

      // The vault's NAV at every transaction that modified it: reported and held, each
      // read from the metadata of that transaction. The chart on the credit opinion.
      const tm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/nav-history$/)
      if (tm && method === 'GET') {
        const snap = reader.get(tm[1].toUpperCase()) ?? reader.get(tm[1])
        if (!snap) return absent('VAULT_NOT_FOUND', 'No vault with that id', tm[1])
        // The promise is cached, so requests that arrive during a miss share one ledger read.
        const key = 'nav:' + snap.vaultId
        let hit = historyCache.get(key)
        if (!hit || Date.now() - hit.at >= 15000) {
          hit = { at: Date.now(), body: fetchNavHistory(reader.xrpl, snap.vault).then((h) => ({ vaultId: snap.vaultId, ...h })) }
          historyCache.set(key, hit)
          hit.body.catch(() => historyCache.delete(key))
        }
        return send(200, stamp(await hit.body))
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
      if (nm && method === 'GET') {
        const snap = reader.get(nm[1].toUpperCase()) ?? reader.get(nm[1])
        if (!snap) return absent('VAULT_NOT_FOUND', 'No vault with that id', nm[1])
        let score = null
        try {
          score = buildScore(deriveScoreInputs({ ...snap.vault, broker: snap.brokers[0] ?? {}, loans: snap.loans, phase: snap.vault.phase }).scoreArgs)
        } catch { /* the valuation is the product; the grade is a courtesy */ }
        return send(200, stamp(presentNav(snap, {
          score, source, network: 'devnet',
          buildVersion: reader.xrpl?.buildVersion ?? null,
          closeTime: reader.closeTime,
        })), { cors: true })
      }

      // Is this facility gated, and by whom?
      //
      // Reads the SHARE ISSUANCE, not the Vault: DomainID is not on the Vault ledger
      // entry, so the obvious lookup returns nothing and reads exactly like "open to
      // everyone". Cached: a domain changes when someone edits it, not every four
      // seconds, and this costs two extra ledger reads.
      const gm = url.pathname.match(/^\/api\/vaults\/([A-Fa-f0-9]{64})\/gate$/)
      if (gm && method === 'GET') {
        const snap = reader.get(gm[1].toUpperCase()) ?? reader.get(gm[1])
        if (!snap) return absent('VAULT_NOT_FOUND', 'No vault with that id', gm[1])
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
      if (vm && method === 'GET') {
        const units = url.searchParams.get('units')
        if (units && !UNITS.test(units)) return fail(400, 'BAD_UNITS', 'units: a whole number of share units, at most 30 digits', false)
        const snap = reader.getByShareMpt(vm[1])
        if (!snap) return absent('SHARE_NOT_TRACKED', 'No facility on this service issues that share token')
        let score = null
        try {
          score = buildScore(deriveScoreInputs({ ...snap.vault, broker: snap.brokers[0] ?? {}, loans: snap.loans, phase: snap.vault.phase }).scoreArgs)
        } catch { /* the valuation is the product; the grade is a courtesy */ }
        const body = presentNav(snap, {
          score, source, network: 'devnet',
          buildVersion: reader.xrpl?.buildVersion ?? null,
          closeTime: reader.closeTime,
        })
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
      if (rm && method === 'GET') {
        const units = url.searchParams.get('units')
        if (units && !UNITS.test(units)) return fail(400, 'BAD_UNITS', 'units: a whole number of share units, at most 30 digits', false)
        if (ledgerWalks >= MAX_LEDGER_WALKS) return fail(503, 'BUSY', 'Too many ledger reads in flight; retry shortly', true)
        ledgerWalks++
        try {
          const resolve = url.searchParams.get('resolve') !== 'false'
          const out = await resolveFromIssuance(reader.xrpl, rm[1].toUpperCase(), { resolve })
          if (units && out.nav) out.pledge = valuePledge(out.nav, units)
          return send(200, stamp(out), { cors: true })
        } finally {
          ledgerWalks--
        }
      }

      // Demo 1. `demo/` is TRACKED and `fixtures/` is not, so the tracked capture must be
      // tried first: served from fixtures alone, this route 404s on a clean clone and the
      // most important demo in the pitch dies in front of the judges.
      if (key === 'GET /api/indexer-race') {
        const path = ['demo/indexer-race.json', 'fixtures/indexer-race.json'].find((f) => existsSync(f))
        if (!path) return fail(404, 'NOT_FOUND', 'no capture available', false)
        return send(200, stamp(JSON.parse(readFileSync(path, 'utf8'))))
      }

      // The contestability capture. Two publishers, and rippled's own median across them. Both
      // accounts were ours (README): it shows that a second publisher needs nobody's permission,
      // not that an independent one exists. Tracked, for the same reason the race capture is: the
      // claim that a ledger object can be argued with cannot be made from one publisher.
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
        // A browser always sends Origin on a POST, an operator's script never does. Without this,
        // any page open on the presenter's machine could post here from loopback.
        if (req.headers.origin) return fail(403, 'FORBIDDEN', 'operator routes refuse browser requests', false)
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
