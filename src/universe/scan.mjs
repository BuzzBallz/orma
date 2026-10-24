/**
 * Universe: the vaults Orma knows (demo/*.json, the Reader's portfolio) and those the ledger showed
 * active since the process started, each measured the same way at one ledger. Not an inventory of
 * Devnet: a full `ledger_data` scan does not fit in a process that serves requests (D-W64), so none is
 * ever sent.
 *
 *   watchVaults(client, { max })         the `transactions` stream: Vault ids seen live, nothing else read
 *   readUniverse({ xrpl, known, live })  orma.universe/1 at the Reader's last validated ledger L
 *   createUniverseCache({ read, ttlMs }) one read at a time, the document kept ttlMs
 *
 * Invariant I7 (§13) before any figure: each XRP vault passes judgeSnapshot on its Vault and its share
 * issuance, read by the same vault_info at L; an inconsistent one gets no number.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { num } from '../num.mjs'
import { Reader } from '../poll.mjs'
import { normaliseVault } from '../xrpl.mjs'
import { logger } from '../log.mjs'
import { judgeSnapshot, MAX_PAGES } from '../ticket/inputs.mjs'

const log = logger('universe')
const HEX64 = /^[A-Fa-f0-9]{64}$/
/** At most this many vaults are read at once. */
const PARALLEL = 4
const KINDS = ['CreatedNode', 'ModifiedNode', 'DeletedNode']

const errorCode = (e) => e?.data?.error ?? e?.code ?? e?.name ?? 'error'
const notFound = (e) => ['entryNotFound', 'objectNotFound'].includes(e?.data?.error ?? e?.message)

/**
 * The Vault ids the `transactions` stream shows, on the Reader's xrpl.js Client. It subscribes now if
 * the client is connected, and again on every `connected` (a reconnection loses the subscription on the
 * server); a subscribe that fails is a `warn` line, never an exception. Of each node of a validated
 * transaction's metadata it reads LedgerEntryType and LedgerIndex only: never PreviousFields,
 * FinalFields nor NewFields; metadata finds an id, never a state. At most `max` ids, the least recently
 * seen leaving first.
 * @param {any} client an xrpl.js Client (EventEmitter, isConnected, request)
 * @param {{ max?: number }} [opts]
 * @returns {{ ids(): string[], liveSinceLedger(): number|null, stop(): void }}
 */
export function watchVaults(client, { max = 200 } = {}) {
  /** id -> true, in order of last sight: the first key is the least recently seen */
  const seen = new Map()
  let since = null

  function subscribe() {
    Promise.resolve()
      .then(() => client.request({ command: 'subscribe', streams: ['transactions'] }))
      .catch((e) => log.warn('transactions stream not subscribed', { err: String(e?.message ?? e).slice(0, 120) }))
  }

  function onTransaction(m) {
    try {
      const L = m?.ledger_index ?? m?.ledger_current_index
      if (since === null && Number.isSafeInteger(L)) since = L
      if (m?.validated !== true) return
      const nodes = m.meta?.AffectedNodes
      if (!Array.isArray(nodes)) throw new TypeError('no AffectedNodes')
      for (const n of nodes) {
        const kind = KINDS.find((k) => n?.[k] !== undefined)
        if (!kind) continue
        const { LedgerEntryType: type, LedgerIndex: index } = n[kind]
        if (type !== 'Vault' || typeof index !== 'string' || !HEX64.test(index)) continue
        const id = index.toUpperCase()
        seen.delete(id) // seen again: to the most recent end
        if (kind === 'DeletedNode') continue
        seen.set(id, true)
        while (seen.size > max) seen.delete(seen.keys().next().value)
      }
    } catch (e) {
      log.debug('malformed transaction message ignored', { err: String(e?.message ?? e).slice(0, 120) })
    }
  }

  client.on('transaction', onTransaction)
  client.on('connected', subscribe)
  if (client.isConnected?.()) subscribe()
  return {
    ids: () => [...seen.keys()],
    liveSinceLedger: () => since,
    stop() {
      client.off?.('transaction', onTransaction)
      client.off?.('connected', subscribe)
    },
  }
}

/** The asset as orma.universe/1 carries it: { currency: 'XRP' }, { currency, issuer } or { mpt_issuance_id }. */
function assetOf(a) {
  if (a?.mpt_issuance_id) return { mpt_issuance_id: String(a.mpt_issuance_id).toUpperCase() }
  if (a?.currency === 'XRP' && !a.issuer) return { currency: 'XRP' }
  return { currency: String(a?.currency ?? ''), issuer: String(a?.issuer ?? '') }
}

/** Every LoanBroker of a vault: its owner's loan_broker objects at L, marker followed, filtered by VaultID. */
async function brokersOf(xrpl, owner, vaultId, L) {
  const brokers = []
  let marker
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await xrpl.req({ command: 'account_objects', account: owner, type: 'loan_broker', ledger_index: L, ...(marker !== undefined && { marker }) })).result
    for (const o of r.account_objects ?? []) if (String(o.VaultID).toUpperCase() === vaultId && o.index) brokers.push(String(o.index).toUpperCase())
    marker = r.marker
    if (marker === undefined || marker === null) return brokers
  }
  throw new RangeError(`the loan brokers of ${owner} run past ${MAX_PAGES} pages at ledger ${L}: the universe is not read at one ledger`)
}

/** One vault at L, measured; null when it is omitted (absent at L, or seen live and unreadable). */
async function readVault(xrpl, id, seen, L, closeTime) {
  let r
  try {
    r = await xrpl.req({ command: 'vault_info', vault_id: id, ledger_index: L })
  } catch (e) {
    if (notFound(e)) {
      log.warn('vault absent at this ledger, omitted', { vaultId: id, ledgerIndex: L, code: errorCode(e) })
      return null
    }
    if (seen === 'live') {
      log.warn('vault seen live could not be read, omitted', { vaultId: id, ledgerIndex: L, code: errorCode(e) })
      return null
    }
    throw e
  }
  const v = r.result.vault
  let brokers
  try {
    brokers = await brokersOf(xrpl, v.Owner, id, L)
  } catch (e) {
    if (seen === 'live' && !(e instanceof RangeError)) {
      log.warn('vault seen live could not be read, omitted', { vaultId: id, ledgerIndex: L, code: errorCode(e) })
      return null
    }
    throw e
  }
  const entry = { vaultId: id, asset: assetOf(v.Asset), brokers, seen }
  const xrp = v.Asset?.currency === 'XRP' && !v.Asset.issuer && !v.Asset.mpt_issuance_id
  if (!xrp) return { ...entry, priced: false, reason: 'not priced' }
  // I7 first: the Vault and its issuance, carried by the one vault_info response at L.
  const judged = judgeSnapshot({ vault: v, issuance: v.shares ?? null, shareMptId: String(v.ShareMPTID ?? ''), ledgerIndex: L, readAt: [r.result.ledger_index] })
  if (!judged.consistent) {
    log.error('inconsistent snapshot, no figure for this vault', { vaultId: id, ledgerIndex: L, rules: judged.violations.map((x) => x.rule).join(','), detail: judged.violations[0]?.detail })
    return { ...entry, priced: false, reason: 'inconsistent snapshot' }
  }
  if (num(v.shares?.OutstandingAmount).isZero()) return { ...entry, priced: false, reason: 'not priced' }
  const nav = Reader.nav(normaliseVault(v, closeTime ?? 0))
  return { ...entry, priced: true, perUnitHeld: nav.navCorrect, perUnitNaive: nav.navNaive }
}

/** fn over items, at most `limit` at once; after a first error none is started, and every one in flight ends before the rejection. */
async function bounded(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  let failure = null
  async function worker() {
    while (failure === null && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i])
      } catch (e) {
        failure ??= { e }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure) throw failure.e
  return out
}

const upperIds = (list) => [...new Set((list ?? []).filter((x) => typeof x === 'string' && HEX64.test(x)).map((x) => x.toUpperCase()))]

/**
 * orma.universe/1 at L = xrpl.lastLedger, with ledgerHash = xrpl.lastLedgerHash, both read together at
 * the start: the last validated ledger read on the Reader's connection. It never calls closeTime(), which
 * would move the Reader's L, and never sends ledger_data. A vault absent at L is omitted; a vault seen
 * only live that cannot be read is omitted; any other failure on a known vault rejects the whole
 * document: a document read by halves is not at one ledger.
 * @param {{ xrpl: any, known: string[], live?: { ids(): string[], liveSinceLedger(): number|null } }} o
 * @returns {Promise<import('../nyc/contracts.mjs').Universe>}
 */
export async function readUniverse({ xrpl, known, live }) {
  const L = xrpl?.lastLedger
  const H = xrpl?.lastLedgerHash
  if (!Number.isSafeInteger(L)) throw new Error('no validated ledger has been read on the Reader connection yet')
  if (typeof H !== 'string' || !HEX64.test(H)) throw new Error(`ledger ${L} has no hash of 64 hex characters`)
  const knownIds = upperIds(known)
  const liveIds = upperIds(live?.ids?.() ?? [])
  const seenAs = new Map(knownIds.map((id) => [id, 'known']))
  for (const id of liveIds) if (!seenAs.has(id)) seenAs.set(id, 'live')
  const read = await bounded([...seenAs], PARALLEL, ([id, seen]) => readVault(xrpl, id, seen, L, xrpl.lastCloseTime))
  const vaults = read.filter(Boolean)
  return {
    schema: 'orma.universe/1',
    ledgerIndex: L,
    ledgerHash: H.toUpperCase(),
    count: vaults.length,
    vaults,
    coverage: { known: knownIds.length, live: liveIds.length, liveSinceLedger: live?.liveSinceLedger?.() ?? null },
    banner: 'not live on mainnet',
  }
}

/**
 * One read at a time (concurrent get() share its promise), the document kept ttlMs after it was read. A
 * rejected read is not kept: the next get() starts another.
 * @param {{ read: () => Promise<any>, ttlMs?: number, now?: () => number }} o
 */
export function createUniverseCache({ read, ttlMs = 60_000, now = Date.now }) {
  let doc = null
  let readAt = 0
  let inflight = null
  return {
    get() {
      if (doc && now() - readAt < ttlMs) return Promise.resolve(doc)
      if (inflight) return inflight
      inflight = Promise.resolve()
        .then(read)
        .then((d) => {
          doc = d
          readAt = now()
          return d
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
  }
}

/**
 * The 64-hex vaultId of every demo/*.json, a retired one included (Calder is still a vault of the ledger),
 * each once. A missing directory is never an exception: none, with a warn line; an unreadable or invalid
 * file is skipped alone, with a warn line that names it.
 * @param {string} [dir]
 * @returns {string[]}
 */
export function demoVaultIds(dir = 'demo') {
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch (e) {
    log.warn('no demo directory: the universe knows the Reader portfolio only', { dir, code: e.code ?? e.name })
    return []
  }
  const ids = []
  for (const f of files) {
    try {
      const id = JSON.parse(readFileSync(join(dir, f), 'utf8'))?.vaultId
      if (typeof id === 'string' && HEX64.test(id)) ids.push(id.toUpperCase())
    } catch (e) {
      log.warn('demo file unreadable, its vault left out of the universe', { file: join(dir, f), code: e.code ?? e.name })
    }
  }
  return [...new Set(ids)]
}
