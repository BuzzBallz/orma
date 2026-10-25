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
import { clientKeyOf } from '../api.mjs'
import { judgeMarginCall, isLoggedTransition, pct } from '../desk/margin-call.mjs'
import { marginPolicyHash, MARGIN_FEED_TYPES } from './contracts.mjs'
import { Reader } from '../poll.mjs'
import { normaliseVault } from '../xrpl.mjs'
import { createFeed, CURSOR } from '../feed/derive.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMAS, usdTermsHash } from './contracts.mjs'
import { readXrpUsd, PriceUnavailableError } from '../fx/price.mjs'

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
    } catch (e) {
      // the cause is logged: an unreachable node and a fault of verify answer the same 503, never silently
      logger('mark').warn('verification failed', { mptId, err: String(e?.message ?? e).slice(0, 160) })
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
  /**
   * The mandate on file, its hash recomputed; null for an unknown id. Read on each request. A mandate whose
   * content no longer hashes to its anchored hash is never used: it throws, and the route answers 500 INTERNAL
   * (the mandate route, `verify: false`, says so in its own sentence).
   */
  function mandateOf(id, { verify = true } = {}) {
    let m
    try {
      m = readDemo('mandate-desk-1', TICKET_DEMO)
    } catch {
      return null
    }
    if (m.id !== id) return null
    if (verify && mandateHash(m) !== m.hash) {
      ticketLog.error('mandate hash mismatch: the mandate is not used', { id, hash: m.hash })
      throw new Error(`The hash of mandate ${id} does not match its content`)
    }
    return m
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
      // a malformed percent-escape names no mandate: 404, never a URIError's 500
      let id
      try {
        id = decodeURIComponent(mandateRoute[1])
      } catch {
        fail(404, 'MANDATE_NOT_FOUND', 'No mandate with that id on this server.', false)
        return true
      }
      const m = mandateOf(id, { verify: false })
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
      // the ticket itself is single-flight only (buildTicket is pure): the free-form units never fill the cache kept
      // for the ledger walks, whose inputs stay kept 15 s
      const ticket = await deskFlight(`ticket:${share}:${op}:${units}:${m.id}@${L}`, false, async () => {
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
    // the headers and a first comment go out now: the client sees the stream open, not at the first heartbeat
    res.flushHeaders()
    res.write(': connected\n\n')
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

  // --- step 15: hardening ---
  // A part per client under the global caps (D-A5), keyed by clientKeyOf of src/api.mjs: at most 2
  // /api/mark verifications in flight (cap 4, step 6) and 4 open /api/feed/stream (cap 100, step 14) per
  // non-null key, each refused by 503 BUSY and given back when the verification ends or the stream
  // closes. The loopback without x-forwarded-for (key null) has the global caps only. The handlers of
  // steps 6 and 14 are wrapped, not rewritten.
  function perClient(handler, { matches, max, sentence, keeps }) {
    const held = new Map()
    const give = (key) => {
      const n = (held.get(key) ?? 1) - 1
      if (n <= 0) held.delete(key)
      else held.set(key, n)
    }
    return async (req, res, url, helpers) => {
      const key = clientKeyOf(req)
      if (key === null || !matches(req, url)) return handler(req, res, url, helpers)
      if ((held.get(key) ?? 0) >= max) {
        helpers.fail(503, 'BUSY', sentence, true)
        return true
      }
      held.set(key, (held.get(key) ?? 0) + 1)
      let kept = false
      try {
        const out = await handler(req, res, url, helpers)
        kept = keeps(res)
        if (kept) res.once('close', () => give(key))
        return out
      } finally {
        if (!kept) give(key)
      }
    }
  }
  const isRead = (req) => req.method === 'GET' || req.method === 'HEAD'
  handleOrmaMark = perClient(handleOrmaMark, {
    matches: (req, url) => isRead(req) && /^\/api\/mark\/[^/]+$/.test(url.pathname),
    max: 2,
    sentence: 'This client already has two verifications in flight; retry shortly',
    keeps: () => false,
  })
  handleFeed = perClient(handleFeed, {
    matches: (req, url) => isRead(req) && url.pathname === '/api/feed/stream',
    max: 4,
    sentence: 'This client already has four live feeds open; poll /api/feed or retry shortly',
    keeps: (res) => res.statusCode === 200 && !res.writableEnded,
  })

  // --- step 20: margin-call ---
  // Orma computes, the desk decides (addendum A11). On the Reader's ledgers, at most once per
  // MARGIN_EVERY_MS, the desk's positions are judged against the risk officer's declared margin policy
  // (demo/margin-policy-desk-1.json) by judgeMarginCall. A transition into ISSUED, CURED or EXPIRED is read
  // again at the same ledger (I2) before it is appended to the chained decision log, which is the memory: a
  // restart re-reads it and never writes a duplicate. Each logged transition goes to the Feed as a DECLARED
  // event. GET /api/desk/margin-calls answers the calls at L; each position of /api/desk/positions gains its
  // marginCall. Reads go through step 7's cache and its cap of four desk ledger walks.
  const marginLog = logger('desk:margin')
  const MARGIN_EVERY_MS = 15_000
  function marginPolicy() {
    try {
      return readDemo('margin-policy-desk-1', TICKET_DEMO)
    } catch {
      return null
    }
  }
  /** loan id -> the call as it stands; the withdrawal value per share last seen, for the reasons */
  const marginCalls = new Map()
  const perShareSeen = new Map()
  try {
    for (const e of signer.decisions().entries()) {
      if (e?.kind !== 'margin-call' || typeof e.loanId !== 'string') continue
      marginCalls.set(e.loanId.toUpperCase(), {
        status: e.status, loanId: e.loanId, issuedLedger: e.issuedLedger, issuedAt: e.issuedAt, cureBy: e.cureBy,
        ltvHeldBps: e.ltvHeldBps, maxLtvBps: e.maxLtvBps, shortfall: e.shortfall ?? null, reasons: [], provenance: 'DECLARED',
        ledgerIndex: e.ledgerIndex, ledgerHash: e.ledgerHash, entryHash: e.hash,
      })
    }
  } catch (e) {
    marginLog.warn('decision log unreadable at start: margin calls start from none', { err: String(e?.message ?? e).slice(0, 120) })
  }
  const lender = (m) => m.desk ?? 'The desk'
  const bpsText = (b) => (b === null || b === undefined ? 'unknown' : pct(b))
  function whyOf(call, m) {
    if (call.status === 'ISSUED') return `${lender(m)} issued a margin call: LTV at withdrawal value ${bpsText(call.ltvHeldBps)} against the mandate's ${pct(call.maxLtvBps)}; cure by ${call.cureBy}: pledge ${call.shortfall?.sharesToAdd ?? '0'} more share units.`
    if (call.status === 'CURED') return `${lender(m)} recorded its margin call as cured: LTV at withdrawal value ${bpsText(call.ltvHeldBps)}, back within the mandate's ${pct(call.maxLtvBps)}.`
    return `The cure window of the margin call of ${lender(m)} closed at ${call.cureBy} with the LTV at withdrawal value at ${bpsText(call.ltvHeldBps)}, above the mandate's ${pct(call.maxLtvBps)}.`
  }
  /** Every desk loan of a positions read, judged at its ledger. */
  function judgeAll(p, m, policy) {
    const doc = buildPositions(p, m)
    return doc.positions.map((pos, i) => {
      const ti = p.loans[i]?.collateral?.[0]?.ticketInputs ?? null
      const perShare = ti ? Reader.nav(normaliseVault(ti.vault.raw, ti.closeTime)).navCorrect : null
      const scale = Number.isSafeInteger(ti?.vault.fields.Scale) ? ti.vault.fields.Scale : 0
      const id = pos.loanId.toUpperCase()
      const trigger = ti && feed
        ? feed.after(null).filter((e) => (e.type === 'IMPAIRMENT' || e.type === 'DEFAULT') && e.vaultId === ti.vault.id && e.txHash).at(-1)?.txHash ?? null
        : null
      const call = judgeMarginCall({
        position: { ...pos, withdrawalValuePerShare: perShare, shareScale: scale }, policy, mandate: m,
        snapshot: { ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, closeTime: p.closeTime },
        previous: marginCalls.get(id) ?? null, moved: { perShareBefore: perShareSeen.get(id) ?? null, triggerTx: trigger },
      })
      return { id, pos, call, perShare }
    })
  }
  let marginRun = null
  /** One judgment at a time: the calls at the ledger read, each transition re-read, logged and pushed; null without a policy. */
  function judgeMargins() {
    marginRun ??= (async () => {
      const policy = marginPolicy()
      const m = mandateOf('desk-1')
      if (!policy || !m) return null
      if (policy.hash !== marginPolicyHash(policy) || policy.mandateHash !== m.hash) {
        marginLog.error('margin policy refused: it does not hash to its own hash, or names another mandate', { id: policy.id, hash: policy.hash })
        return null
      }
      const L = lastLedger()
      const p = await deskFlight(`positions@${L}`, typeof L === 'number', () => walk(() => readPositions(reader.xrpl, { reader, demoDir: TICKET_DEMO })))
      const judged = judgeAll(p, m, policy)
      for (const j of judged) {
        const before = marginCalls.get(j.id) ?? null
        let call = j.call
        if (isLoggedTransition(before, call)) {
          // I2: the same ledger read again; only what the second read confirms is the desk's decision
          const at = { ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, closeTime: p.closeTime }
          const again = judgeAll(await walk(() => readPositions(reader.xrpl, { reader, demoDir: TICKET_DEMO, at })), m, policy).find((x) => x.id === j.id)
          if (again?.call.status !== call.status) {
            marginLog.warn('margin call not logged: the re-read at the same ledger disagrees', { loanId: j.id, ledgerIndex: p.ledgerIndex, first: call.status, second: again?.call.status ?? null })
            // nothing decided: the status as it stood, or none, saying why
            const why = `A second read of ledger ${p.ledgerIndex} disagreed with the first: no margin-call decision was taken.`
            // the status kept is served at this ledger, as SCHEMAS.marginCalls requires of every call of the document
            marginCalls.set(j.id, before
              ? { ...before, ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, reasons: [...before.reasons.filter((x) => !x.startsWith('A second read of ledger')), why] }
              : { ...call, status: 'NONE', issuedLedger: null, issuedAt: null, cureBy: null, shortfall: null, reasons: [...call.reasons.slice(0, 2), why] })
            continue
          }
          const entry = signer.decisions().appendMarginCall({
            status: call.status, loanId: j.id, mandateHash: m.hash, policyHash: policy.hash, issuedLedger: call.issuedLedger,
            issuedAt: call.issuedAt, cureBy: call.cureBy, ltvHeldBps: call.ltvHeldBps, maxLtvBps: call.maxLtvBps,
            ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, shortfall: call.shortfall,
          })
          call = { ...call, entryHash: entry.hash }
          marginLog.info(`margin call ${call.status}`, { loanId: j.id, ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, entry: entry.hash })
          feed?.push({
            type: MARGIN_FEED_TYPES[call.status], provenance: 'DECLARED', vaultId: j.pos.vaultId, loanId: j.id,
            ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, entryHash: entry.hash, ...(call.triggerTx && { txHash: call.triggerTx }),
            why: whyOf(call, m), moneyEffect: null,
            receipts: [{ object: 'Position', field: 'ltvHeldBps', before: before?.ltvHeldBps ?? null, after: call.ltvHeldBps }],
          })
        } else if (call.status !== 'NONE' && before?.entryHash) {
          call = { ...call, entryHash: before.entryHash }
        }
        marginCalls.set(j.id, call)
        if (j.perShare) perShareSeen.set(j.id, j.perShare)
      }
      return { ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, policy, marginCalls: judged.map((j) => marginCalls.get(j.id)) }
    })().finally(() => {
      marginRun = null
    })
    return marginRun
  }
  let marginLast = 0
  if (typeof reader?.subscribe === 'function') {
    reader.subscribe(() => {
      if (marginRun || Date.now() - marginLast < MARGIN_EVERY_MS || !marginPolicy()) return
      marginLast = Date.now()
      judgeMargins().catch((e) => {
        if (!(e instanceof BusyError)) marginLog.warn('margin calls not judged on this ledger', { ledgerIndex: lastLedger() ?? null, err: String(e?.message ?? e).slice(0, 160) })
      })
    })
  }
  /** A position the judgment did not reach (no policy, or the walks were busy): NONE, saying why. */
  const unjudged = (p, body, why) => ({
    status: 'NONE', loanId: p.loanId, issuedLedger: null, issuedAt: null, cureBy: null, ltvHeldBps: p.ltvHeldBps,
    maxLtvBps: JSON.parse(String(p.usage?.find((u) => u.limit === 'maxLtvBps')?.threshold ?? '0')), shortfall: null,
    reasons: [why], provenance: 'DECLARED', ledgerIndex: body.ledgerIndex, ledgerHash: body.ledgerHash,
  })
  // /api/desk/positions: step 7's route, each position given its margin call (an addition).
  const positionsRoute = handleTicket
  handleTicket = async (req, res, url, helpers) => {
    if (url.pathname !== '/api/desk/positions') return positionsRoute(req, res, url, helpers)
    const configured = Boolean(marginPolicy())
    const judged = configured ? await judgeMargins().catch(() => null) : null
    const byId = new Map((judged?.marginCalls ?? []).map((c) => [c.loanId.toUpperCase(), c]))
    const send = (code, body) => helpers.send(code, code === 200 && Array.isArray(body?.positions)
      ? { ...body, positions: body.positions.map((p) => ({ ...p, marginCall: byId.get(p.loanId.toUpperCase()) ?? unjudged(p, body, configured ? 'No margin call could be judged at this ledger; retry shortly.' : 'No margin policy is on this server.') })) }
      : body)
    return positionsRoute(req, res, url, { ...helpers, send })
  }
  async function handleMarginCalls(req, res, url, { send, fail, stamp }) {
    if (url.pathname !== '/api/desk/margin-calls' || (req.method !== 'GET' && req.method !== 'HEAD')) return false
    if (!firstPassDone()) {
      fail(503, 'WARMING_UP', 'The reader has not finished its first pass over the facilities; retry shortly', true)
      return true
    }
    try {
      const out = await judgeMargins()
      if (!out) fail(503, 'NOT_CONFIGURED', 'Margin calls are not configured on this server: demo/margin-policy-desk-1.json is missing, does not hash to its own hash, or names another mandate', true)
      else send(200, stamp(out))
    } catch (e) {
      if (e instanceof BusyError) fail(503, 'BUSY', 'Four desk ledger walks are already running; retry shortly', true)
      else if (e instanceof SnapshotError) refuseSnapshot(e, fail)
      else if (e?.code === 'ENOENT') fail(503, 'NOT_CONFIGURED', 'The desk is not baked on this server (demo/desk.json or demo/spare.json is missing)', true)
      else throw e
    }
    return true
  }

  // --- step 21: usd-loans ---
  // A loan in the test dollar, against the same shares of XRP vaults (addendum A11). handleUsdLoans answers
  // GET /api/tickets when it carries an asset other than XRP: USD, on a pledge only, builds the ticket on the
  // risk officer's terms (demo/usd-terms-desk-1.json, hashed and anchored) for the dollar plan of
  // demo/desk-usd.json, at the XRP/USD median of the oracle documents the terms name, read at the ticket's own
  // ledger (src/fx/price.mjs); no usable price is 409 PRICE_UNAVAILABLE, no figure; any other asset is 400.
  // Without asset, or with XRP, the request goes on to step 7's route unchanged. It also answers, through step
  // 7's handler and with that handler's own reads, the desk's plan (which gains the dollar pool and its terms)
  // and the positions (where a dollar position's margin call names its currency). Reads go through step 7's
  // cache and its cap of four desk ledger walks.
  const usdLog = logger('nyc:usd')
  /** The dollar pool and its terms, checked against the mandate; or, when they cannot be used, why. */
  function usdLending(m) {
    let pool
    try {
      pool = readDemo('desk-usd', TICKET_DEMO)
    } catch {
      return { why: 'The desk lends no test dollar on this server: demo/desk-usd.json is missing.' }
    }
    let terms
    try {
      terms = readDemo('usd-terms-desk-1', TICKET_DEMO)
    } catch {
      return { why: 'demo/usd-terms-desk-1.json is missing: the desk has no declared terms for loans in the test dollar.' }
    }
    if (SCHEMAS.usdTerms(terms).length || usdTermsHash(terms) !== terms.hash || terms.mandateHash !== m.hash) {
      usdLog.error('usd terms refused: they do not hash to their own hash, or name another mandate', { id: terms?.id ?? null, hash: terms?.hash ?? null })
      return { why: 'demo/usd-terms-desk-1.json does not hash to its own hash, or names another mandate.' }
    }
    if (!pool.plannedLoan?.principalUsd || !pool.plannedLoan?.units) return { why: 'demo/desk-usd.json carries no plannedLoan in dollars.' }
    return { pool, terms }
  }
  async function handleUsdLoans(req, res, url, helpers) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (url.pathname === '/api/desk/positions') {
      // the margin call of a dollar position names its currency, judged or not
      const send = (code, body) => helpers.send(code, code === 200 && Array.isArray(body?.positions)
        ? { ...body, positions: body.positions.map((p) => (p.currency === 'USD' && p.marginCall && !p.marginCall.currency ? { ...p, marginCall: { ...p.marginCall, currency: 'USD' } } : p)) }
        : body)
      return handleTicket(req, res, url, { ...helpers, send })
    }
    if (/^\/api\/desk\/mandates\/[^/]+$/.test(url.pathname)) {
      // the desk's plan gains its dollar pool and the terms, when this server lends the test dollar
      const send = (code, body) => {
        const usd = code === 200 && body?.deskPlan && typeof body.hash === 'string' && existsSync(join(TICKET_DEMO, 'desk-usd.json')) ? usdLending(body) : null
        if (!usd?.pool) return helpers.send(code, body)
        const { units, principalUsd, paymentInterval, gracePeriod } = usd.pool.plannedLoan
        return helpers.send(code, {
          ...body,
          deskPlan: { ...body.deskPlan, usd: { plannedLoan: { units, principalUsd, paymentInterval, gracePeriod }, loanAsset: usd.pool.asset, vaultId: usd.pool.usdVaultId, loanBrokerId: usd.pool.loanBrokerId, terms: usd.terms } },
        })
      }
      return handleTicket(req, res, url, { ...helpers, send })
    }
    if (url.pathname !== '/api/tickets') return false
    const asset = url.searchParams.get('asset')
    if (asset === null || asset === 'XRP') return false
    const { send, fail, stamp } = helpers
    if (asset !== 'USD') {
      fail(400, 'BAD_REQUEST', 'The asset must be XRP or USD.', false)
      return true
    }
    if (!reader.xrpl || !firstPassDone()) {
      fail(503, 'WARMING_UP', 'The reader has not finished its first pass over the facilities; retry shortly', true)
      return true
    }
    const q = url.searchParams
    const shareParam = q.get('share') ?? ''
    if (!/^[A-Fa-f0-9]{48}$/.test(shareParam)) {
      fail(400, 'BAD_REQUEST', 'The share must be the 48-hex MPT issuance id of a vault share.', false)
      return true
    }
    const share = shareParam.toUpperCase()
    if (q.get('op') !== 'pledge') {
      fail(400, 'BAD_OP', 'A loan in the test dollar is a pledge: asset USD takes op pledge.', false)
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
    const usd = usdLending(m)
    if (usd.why) {
      fail(503, 'NOT_CONFIGURED', usd.why, true)
      return true
    }
    const L = lastLedger()
    const keep = typeof L === 'number'
    try {
      // single-flight only, as step 7: the units never evict the kept ledger walks
      const ticket = await deskFlight(`ticket:${share}:pledge:${units}:${m.id}:USD:${usd.terms.hash}@${L}`, false, async () => {
        const inputs = await deskFlight(`inputs:${share}@${L}`, keep, () => walk(() => readTicketInputs(reader.xrpl, { shareMptId: share, reader })))
        const price = await readXrpUsd(reader.xrpl, usd.terms, { ledgerIndex: inputs.ledgerIndex, ledgerHash: inputs.ledgerHash, closeTime: inputs.closeTime })
        return buildTicket(inputs, { op: 'pledge', units, mandate: m, usd: { terms: usd.terms, principalUsd: usd.pool.plannedLoan.principalUsd, price } })
      })
      send(200, stamp(ticket))
    } catch (e) {
      if (e instanceof BusyError) fail(503, 'BUSY', 'Four desk ledger walks are already running; retry shortly', true)
      else if (e instanceof PriceUnavailableError) {
        usdLog.warn('no usable XRP/USD price', { ledgerIndex: e.ledgerIndex, reason: e.message.slice(0, 160) })
        fail(409, 'PRICE_UNAVAILABLE', e.message, true)
      }
      else if (e instanceof SnapshotError) refuseSnapshot(e, fail)
      else if (e instanceof ShareNotTrackedError) fail(404, 'SHARE_NOT_TRACKED', e.message, false)
      else if (e instanceof RangeError) fail(400, 'BAD_UNITS', `${e.message.replace(/^./, (c) => c.toUpperCase())}.`, false)
      else throw e
    }
    return true
  }

  return {
    async handle(req, res, url, helpers) {
      if (await handleHarness(req, res, url, helpers)) return true
      if (await handleOrmaMark(req, res, url, helpers)) return true
      if (await handleUsdLoans(req, res, url, helpers)) return true
      if (await handleTicket(req, res, url, helpers)) return true
      if (await handleDeskSigner(req, res, url, helpers)) return true
      if (await handleUniverse(req, res, url, helpers)) return true
      if (await handleFeed(req, res, url, helpers)) return true
      if (await handleMarginCalls(req, res, url, helpers)) return true
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

/**
 * One read at a time, kept `ttlMs` whatever it answered: xrpscan sees at most one request a minute. Once a
 * read has settled, a get never waits: past `ttlMs` it answers the last value and refreshes behind it, so a
 * slow xrpscan never holds the Feed; only the very first get waits for its read.
 */
export function createAmendmentsCache({ read, ttlMs = 60_000, now = Date.now }) {
  let startedAt = -Infinity
  let pending = null
  let settled = null
  return {
    get() {
      if (!pending && now() - startedAt >= ttlMs) {
        startedAt = now()
        pending = Promise.resolve(read())
          .then((value) => { settled = { value } }, (e) => {
            amendmentsLog.warn('amendment votes not refreshed', { err: String(e?.message ?? e).slice(0, 120) })
            settled ??= { value: { source: 'xrpscan', fetchedAt: new Date(now()).toISOString(), status: 'unavailable', items: [] } }
          })
          .finally(() => { pending = null })
      }
      return settled ? Promise.resolve(settled.value) : pending.then(() => settled.value)
    },
  }
}
