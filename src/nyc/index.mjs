/**
 * The NYC modules' single entry into the API. It knows the wire and carries no business logic:
 * every step adds its own block below and one line to the dispatcher in `handle`.
 */
import { accessSync, constants } from 'node:fs'
import { Xrpl, DEVNET_WS } from '../xrpl.mjs'
import { attestationStatus } from '../nav.mjs'
import { verify } from '../mark/verify.mjs'
import { readFileSync } from 'node:fs'
import { Wallet } from 'xrpl'
import { createRoleEngine } from '../roles/engine.mjs'
import { logger } from '../log.mjs'
import { mandateHash } from './contracts.mjs'
import { readTicketInputs, readPositions, readDemo, SnapshotError, ShareNotTrackedError } from '../ticket/inputs.mjs'
import { buildTicket, buildPositions } from '../ticket/engine.mjs'
import { createSigner, registerDeskActions, withDeskErrors } from '../desk/signer.mjs'
import { watchVaults, readUniverse, createUniverseCache, demoVaultIds } from '../universe/scan.mjs'
import { createFeed, CURSOR } from '../feed/derive.mjs'

/**
 * @param {{ reader: import('../poll.mjs').Reader, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} deps
 */
export function createNyc({ reader, env, fetchImpl = fetch }) {
  const missing = ['ROLES_FILE', 'DESK_SEED', 'ALLOWED_WRITE_ORIGINS', 'PUBLISH_SEED'].filter((k) => !env[k])

  // --- step 2: harness ---
  // --- step 8: role-engine ---
  // The body of the step 2 stub, replaced (the one exception of code rule 10): /api/roles/ goes to the
  // role engine, which answers its own 503 NOT_CONFIGURED after the Origin check.
  function roleWallets() {
    const wallets = {}
    if (env.ROLES_FILE) {
      try {
        for (const [role, a] of Object.entries(JSON.parse(readFileSync(env.ROLES_FILE, 'utf8')).accounts ?? {})) wallets[role] = Wallet.fromSeed(a.seed)
      } catch (e) {
        // Never the error's message: a JSON or seed error may quote the file.
        logger('roles').warn('roles file unreadable, writes not configured', { err: e.code ?? e.name })
        return {}
      }
    }
    // The desk owner signs only with DESK_SEED: the roles file alone never configures the desk.
    delete wallets.deskOwner
    if (env.DESK_SEED) {
      try {
        wallets.deskOwner = Wallet.fromSeed(env.DESK_SEED)
      } catch (e) {
        logger('roles').warn('DESK_SEED unusable, writes not configured', { err: e.name })
      }
    }
    return wallets
  }
  const roleEngine = createRoleEngine({ reader, xrpl: new Xrpl(env.XRPL_WS ?? DEVNET_WS), env, accounts: roleWallets() })
  const demoActions = {
    run: async () => roleEngine.newRun(),
    kill: async () => {
      roleEngine.kill()
      return {}
    },
    unkill: async () => {
      roleEngine.unkill()
      return {}
    },
  }
  async function handleHarness(req, res, url, helpers) {
    return roleEngine.handle(req, res, url, helpers)
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

  // --- step 7: ticket ---
  // GET /api/tickets, /api/desk/mandates/{id}, /api/desk/positions. Each reads one validated ledger and
  // judges I7 before any figure. readTicketInputs is single-flight per (share, ledger), whatever the units,
  // op or mandate; answers are kept 15 s per key while the Reader's last ledger is a number; at most 4 desk
  // ledger walks run at once between tickets and positions, the next one answers 503 BUSY.
  const ticketLog = logger('nyc:ticket')
  const DESK_TTL_MS = 15_000
  const DESK_CACHE_MAX = 200
  const MAX_DESK_WALKS = 4
  const TICKET_DEMO = 'demo'
  let deskWalks = 0
  const deskFlights = new Map() // key -> { at, promise }: one computation per key, a rejection never kept
  class BusyError extends Error {}
  /** One computation per key; kept DESK_TTL_MS when the ledger is known, dropped on rejection. */
  function deskFlight(key, keep, compute) {
    const hit = deskFlights.get(key)
    if (hit && (hit.pending || (keep && Date.now() - hit.at < DESK_TTL_MS))) return hit.promise
    const entry = { at: Date.now(), pending: true, promise: null }
    entry.promise = compute().then(
      (v) => { entry.pending = false; entry.at = Date.now(); if (!keep) deskFlights.delete(key); return v },
      (e) => { deskFlights.delete(key); throw e },
    )
    deskFlights.delete(key)
    if (deskFlights.size >= DESK_CACHE_MAX) deskFlights.delete(deskFlights.keys().next().value)
    deskFlights.set(key, entry)
    return entry.promise
  }
  /** A desk ledger walk, counted against MAX_DESK_WALKS. */
  async function walk(fn) {
    if (deskWalks >= MAX_DESK_WALKS) throw new BusyError()
    deskWalks++
    try {
      return await fn()
    } finally {
      deskWalks--
    }
  }
  const lastLedger = () => reader.xrpl?.lastLedger
  const firstPassDone = () => (reader.passes === undefined ? reader.snapshots.size > 0 : reader.passes > 0)
  /** The mandate on file, its hash recomputed; null for an unknown id. Read on each request. */
  function mandateOf(id) {
    let m
    try {
      m = readDemo('mandate-desk-1', TICKET_DEMO)
    } catch {
      return null
    }
    return m.id === id ? m : null
  }
  function refuseSnapshot(e, fail) {
    ticketLog.error('inconsistent snapshot', { code: e.code, vaultId: e.vaultId, ledgerIndex: e.ledgerIndex, ledgerHash: e.ledgerHash, violations: e.violations })
    fail(409, 'INCONSISTENT_SNAPSHOT', e.message, true)
  }
  async function handleTicket(req, res, url, { send, fail, stamp }) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const path = url.pathname
    const mandateRoute = /^\/api\/desk\/mandates\/([^/]+)$/.exec(path)
    if (path !== '/api/tickets' && path !== '/api/desk/positions' && !mandateRoute) return false

    if (mandateRoute) {
      const id = decodeURIComponent(mandateRoute[1])
      const m = mandateOf(id)
      if (!m) {
        fail(404, 'MANDATE_NOT_FOUND', `No mandate ${JSON.stringify(id)} on this server.`, false)
        return true
      }
      if (mandateHash(m) !== m.hash) {
        ticketLog.error('mandate hash mismatch', { id, hash: m.hash })
        fail(500, 'INTERNAL', `The hash of mandate ${id} does not match its content`, true)
        return true
      }
      let desk
      try {
        desk = readDemo('desk', TICKET_DEMO)
      } catch {
        fail(503, 'NOT_CONFIGURED', 'demo/desk.json is missing: the desk is not baked on this server', true)
        return true
      }
      const vaults = []
      for (const label of ['harbor-1', 'harbor-2', 'harbor-3', 'desk', 'spare']) {
        try {
          const v = readDemo(label, TICKET_DEMO)
          vaults.push({ label, vaultId: v.vaultId, shareMptId: v.shareMptId, loanBrokerId: v.loanBrokerId, impairL1Tx: v.impairL1Tx ?? null, impairL1Hidden: v.impairL1Hidden ?? null, statementTx: v.statementTx ?? null })
        } catch {
          ticketLog.warn('demo file missing for deskPlan', { label })
        }
      }
      send(200, stamp({ ...m, deskPlan: { plannedLoan: desk.plannedLoan, plannedBuy: desk.plannedBuy, vaults } }))
      return true
    }

    if (!reader.xrpl || !firstPassDone()) {
      fail(503, 'WARMING_UP', 'The reader has not finished its first pass over the facilities; retry shortly', true)
      return true
    }

    if (path === '/api/desk/positions') {
      const m = mandateOf('desk-1')
      if (!m) {
        fail(503, 'NOT_CONFIGURED', 'demo/mandate-desk-1.json is missing: the desk is not baked on this server', true)
        return true
      }
      const L = lastLedger()
      try {
        const p = await deskFlight(`positions@${L}`, typeof L === 'number', () => walk(() => readPositions(reader.xrpl, { reader, demoDir: TICKET_DEMO })))
        send(200, stamp(buildPositions(p, m)))
      } catch (e) {
        if (e instanceof BusyError) fail(503, 'BUSY', 'Four desk ledger walks are already running; retry shortly', true)
        else if (e instanceof SnapshotError) refuseSnapshot(e, fail)
        else if (e?.code === 'ENOENT') fail(503, 'NOT_CONFIGURED', 'The desk is not baked on this server (demo/desk.json or demo/spare.json is missing)', true)
        else throw e
      }
      return true
    }

    // /api/tickets
    const q = url.searchParams
    const shareParam = q.get('share') ?? ''
    if (!/^[A-Fa-f0-9]{48}$/.test(shareParam)) {
      fail(400, 'BAD_REQUEST', 'The share must be the 48-hex MPT issuance id of a vault share.', false)
      return true
    }
    const share = shareParam.toUpperCase()
    const op = q.get('op')
    if (op !== 'pledge' && op !== 'buy') {
      fail(400, 'BAD_OP', 'The op must be pledge or buy.', false)
      return true
    }
    const units = q.get('units') ?? ''
    if (!/^[0-9]{1,30}$/.test(units)) {
      fail(400, 'BAD_UNITS', 'The units must be a whole number of share units, at most 30 digits.', false)
      return true
    }
    const mandateId = q.get('mandate') ?? ''
    const m = mandateOf(mandateId)
    if (!m) {
      fail(404, 'MANDATE_NOT_FOUND', `No mandate ${JSON.stringify(mandateId)} on this server.`, false)
      return true
    }
    if (!reader.getByShareMpt(share)) {
      const pending = reader.vaultIds?.some((v) => !reader.snapshots.has(v) && !reader.missing?.has(v))
      if (pending) fail(503, 'WARMING_UP', 'A tracked facility has not been read yet; retry shortly', true)
      else fail(404, 'SHARE_NOT_TRACKED', `No facility on this service issues the share ${share}.`, false)
      return true
    }
    let principalDrops
    if (op === 'pledge') {
      try {
        principalDrops = readDemo('desk', TICKET_DEMO).plannedLoan?.principalDrops
      } catch {
        principalDrops = undefined
      }
      if (principalDrops === undefined) {
        fail(503, 'NOT_CONFIGURED', 'demo/desk.json has no plannedLoan: the desk is not baked on this server', true)
        return true
      }
    }
    const L = lastLedger()
    const keep = typeof L === 'number'
    try {
      const ticket = await deskFlight(`ticket:${share}:${op}:${units}:${m.id}@${L}`, keep, async () => {
        const inputs = await deskFlight(`inputs:${share}@${L}`, keep, () => walk(() => readTicketInputs(reader.xrpl, { shareMptId: share, reader })))
        return buildTicket(inputs, { op, units, mandate: m, principalDrops })
      })
      send(200, stamp(ticket))
    } catch (e) {
      if (e instanceof BusyError) fail(503, 'BUSY', 'Four desk ledger walks are already running; retry shortly', true)
      else if (e instanceof SnapshotError) refuseSnapshot(e, fail)
      else if (e instanceof ShareNotTrackedError) fail(404, 'SHARE_NOT_TRACKED', e.message, false)
      else if (e instanceof RangeError) fail(400, 'BAD_UNITS', `${e.message.replace(/^./, (c) => c.toUpperCase())}.`, false)
      else throw e
    }
    return true
  }

  // --- step 10: desk-signer ---
  // The riskOfficer's approve, decline and rerequest on the role engine: the desk countersigns only after
  // a re-read at the ledger of the confirm (src/desk/signer.mjs), every decision chained in DESK_LOG_PATH.
  // demo/desk.json is read at each approval, never here. A DeskError leaves the engine's handle with its
  // own status (404 during an approval, 503 NOT_CONFIGURED), not the engine's 409. GET /api/desk/decisions.
  const deskWallet = (() => {
    if (!env.DESK_SEED) return null
    try {
      return Wallet.fromSeed(env.DESK_SEED)
    } catch {
      return null
    }
  })()
  const signer = createSigner({
    xrpl: new Xrpl(env.XRPL_WS ?? DEVNET_WS), reader, wallet: deskWallet,
    logPath: env.DESK_LOG_PATH || '.demo/decisions.jsonl', loanSetOf: (actionId) => roleEngine.loanSetOf(actionId),
  })
  roleEngine.handle = withDeskErrors(roleEngine.handle)
  registerDeskActions(roleEngine, { signer, deskAddress: () => deskWallet?.address ?? null, borrower: () => roleWallets().borrower ?? null })
  async function handleDeskSigner(req, res, url, { send, stamp }) {
    if (url.pathname !== '/api/desk/decisions' || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    const journal = signer.decisions()
    send(200, stamp({ entries: journal.entries(), chain: journal.verifyChain() }))
    return true
  }

  // --- step 13: universe ---
  // GET /api/universe: the vaults on file (demo/*.json, then the Reader's portfolio) and those the
  // transactions stream showed since this process started, each read at the Reader's last validated
  // ledger, cached 60 s, one read at a time. The stream is watched only when the Reader has an xrpl.js
  // client: the in-memory APIs of check-mark and check-ticket have none.
  const universeOnFile = demoVaultIds('demo')
  const universeLive = reader.xrpl?.client
    ? watchVaults(reader.xrpl.client)
    : { ids: () => [], liveSinceLedger: () => null, stop() {} }
  const universe = createUniverseCache({
    read: () => readUniverse({ xrpl: reader.xrpl, known: [...universeOnFile, ...(reader.vaultIds ?? [])], live: universeLive }),
  })
  async function handleUniverse(req, res, url, { send, stamp, fail }) {
    if (url.pathname !== '/api/universe' || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    try {
      send(200, stamp(await universe.get()))
    } catch (e) {
      logger('universe').warn('universe not read at one ledger', { ledgerIndex: reader.xrpl?.lastLedger ?? null, err: String(e?.message ?? e).slice(0, 200) })
      fail(503, 'WARMING_UP', 'The universe could not be read at one ledger yet.', true)
    }
    return true
  }

  // --- step 14: feed ---
  // Credit events from full re-reads (src/feed/derive.mjs), polled at /api/feed and pushed on
  // /api/feed/stream; the amendment votes of xrpscan ride along, read at most once a minute.
  const feedLog = logger('feed')
  const escrowAccounts = (() => {
    try {
      const borrower = JSON.parse(readFileSync('demo/desk.json', 'utf8')).collateral?.borrower
      if (borrower) return [borrower]
      feedLog.warn('demo/desk.json names no collateral borrower: the feed reads no escrow')
    } catch (e) {
      feedLog.warn('demo/desk.json unreadable: the feed reads no escrow', { err: e.code ?? e.name })
    }
    return []
  })()
  const feed = (() => {
    if (typeof reader?.subscribe !== 'function') return null
    try {
      return createFeed(reader, { escrowAccounts })
    } catch (e) {
      feedLog.warn('the reader takes no subscriber: the feed stays empty', { err: String(e).slice(0, 120) })
      return null
    }
  })()
  const amendments = createAmendmentsCache({ read: () => readAmendments({ fetchImpl }) })
  const STREAMS_MAX = 100
  const HEARTBEAT_MS = 10_000
  const streams = new Set()
  async function handleFeed(req, res, url, { send, fail, stamp }) {
    const head = req.method === 'HEAD'
    if (req.method !== 'GET' && !head) return false
    if (url.pathname === '/api/feed') {
      const after = url.searchParams.get('after')
      if (after !== null && !CURSOR.test(after)) {
        fail(400, 'BAD_CURSOR', 'after must be a cursor <ledger on 19 digits>-<counter>, as nextCursor gives it', false)
        return true
      }
      const events = feed ? feed.after(after) : []
      send(200, stamp({ events, nextCursor: events.at(-1)?.id ?? after, amendments: await amendments.get() }))
      return true
    }
    if (url.pathname !== '/api/feed/stream') return false
    if (streams.size >= STREAMS_MAX) {
      fail(503, 'BUSY', 'Too many live feeds are open; poll /api/feed or retry shortly', true)
      return true
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    if (head) {
      res.end()
      return true
    }
    const stream = { end: null }
    streams.add(stream)
    // A write the socket cannot take ends the stream: a slow reader never makes the server buffer for it.
    const write = (chunk) => { if (!res.write(chunk)) stream.end() }
    const timer = setInterval(() => write('event: heartbeat\ndata: {}\n\n'), HEARTBEAT_MS)
    const off = feed ? feed.onEvent((ev) => write(`event: credit\ndata: ${JSON.stringify(ev)}\n\n`)) : () => {}
    stream.end = () => {
      if (!streams.delete(stream)) return
      clearInterval(timer)
      off()
      res.end()
    }
    req.on('close', stream.end)
    return true
  }

  return {
    async handle(req, res, url, helpers) {
      if (await handleHarness(req, res, url, helpers)) return true
      if (await handleOrmaMark(req, res, url, helpers)) return true
      if (await handleTicket(req, res, url, helpers)) return true
      if (await handleDeskSigner(req, res, url, helpers)) return true
      if (await handleUniverse(req, res, url, helpers)) return true
      if (await handleFeed(req, res, url, helpers)) return true
      return false
    },
    missing,
    demoActions,
    close: async () => { for (const st of [...streams]) st.end() },
  }
}

// --- step 14: feed ---
const amendmentsLog = logger('feed')

/**
 * The amendment votes, a sourced and timed public fact read from xrpscan. Never an exception: on any
 * failure the status says so and the measurements are unaffected.
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date }} [opts]
 */
export async function readAmendments({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const fetchedAt = now().toISOString()
  try {
    const res = await fetchImpl('https://api.xrpscan.com/api/v1/amendments', { signal: AbortSignal.timeout(5000) })
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    const items = await res.json()
    if (!Array.isArray(items)) throw new Error('the body is not an array')
    return { source: 'xrpscan', fetchedAt, status: 'ok', items }
  } catch (e) {
    amendmentsLog.warn('amendment votes unavailable', { err: String(e?.message ?? e).slice(0, 120) })
    return { source: 'xrpscan', fetchedAt, status: 'unavailable', items: [] }
  }
}

/** One read at a time, kept `ttlMs` whatever it answered: xrpscan sees at most one request a minute. */
export function createAmendmentsCache({ read, ttlMs = 60_000, now = Date.now }) {
  let held = null
  return {
    get() {
      if (!held || now() - held.at >= ttlMs) held = { at: now(), value: read() }
      return held.value
    },
  }
}
