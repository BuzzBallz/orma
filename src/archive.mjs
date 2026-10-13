/**
 * The ledger history Devnet no longer keeps, read back from evidence/devnet-tx.
 *
 * Devnet prunes in steps, each server on its own schedule: rippled's online_delete drops everything
 * below the server's previous rotation point at once. account_tx states the range it searched, never
 * what it no longer holds, so depending on the server and the day a history comes back whole, cut
 * where a rotation point falls inside it, or empty. Both history routes read account_tx, so the
 * facilities created at the event would lose their NAV series and, worse, their broker's defaults,
 * which a conduct grade would then read as a clean record.
 *
 * evidence/devnet-tx holds those transactions as captured on 2026-10-13, and its _manifest.json
 * declares, per account, the ledger range the capture searched and every hash it returned. This
 * module serves only what that declaration lists. readHistory() merges it into every successful live
 * read, by hash with the live copy winning, and states the window the merged history covers.
 *
 * Captured, not verified. A transaction loads only if it hashes to its id, but its metadata, which
 * the NAV points and the broker events are read from, is the server's copy as served at capture.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { hashes } from 'xrpl'
import { rippleToIso } from './num.mjs'
import { logger } from './log.mjs'

const log = logger('archive')

export const ARCHIVE_DIR = fileURLToPath(new URL('../evidence/devnet-tx/', import.meta.url))

// What a `tx` response in API v1 adds around the signed transaction (see check-evidence.mjs).
const ENVELOPE = ['ctid', 'date', 'hash', 'inLedger', 'ledger_index', 'status', 'validated', 'meta', 'DeliverMax']

const hashOf = (e) => e.hash ?? e.tx_json?.hash ?? e.tx?.hash ?? null
const ledgerOf = (e) => Number(e.ledger_index ?? e.tx_json?.ledger_index ?? e.tx?.ledger_index ?? 0)
const positionOf = (e) => Number((e.meta ?? e.metaData)?.TransactionIndex ?? 0)

/**
 * One capture, as the entry account_tx returns in API v2, so the code reading it cannot tell the
 * two apart: { close_time_iso, hash, ledger_index, meta, tx_json, validated }. Null, logged, when the
 * file is missing or its transaction does not hash to its id.
 */
function readCapture(dir, hash) {
  let t
  try {
    t = JSON.parse(readFileSync(join(dir, `${hash}.json`), 'utf8'))
  } catch (e) {
    log.error('archived transaction unreadable', { hash, err: String(e).slice(0, 120) })
    return null
  }
  const signed = Object.fromEntries(Object.entries(t).filter(([k]) => !ENVELOPE.includes(k)))
  let computed = null
  try { computed = hashes.hashSignedTx(signed) } catch (e) { log.error('archived transaction does not encode', { hash, err: String(e).slice(0, 120) }) }
  if (computed !== hash || t.hash !== hash || t.validated !== true || !t.meta) {
    log.error('archived transaction rejected', { hash, computed })
    return null
  }
  const { meta, hash: _h, inLedger: _i, status: _s, validated: _v, ...tx_json } = t
  return { close_time_iso: rippleToIso(t.date), hash, ledger_index: t.ledger_index, meta, tx_json, validated: true }
}

/**
 * The archive: { capturedAt, capturedFrom, accounts: Map(account -> coverage) }, where a coverage is
 * { ledgerMin, ledgerMax, entries, intact } and `intact` says every declared transaction loaded.
 * Null, logged as an error, when the directory or its declaration is missing: the routes then cover
 * only what Devnet still holds, and say so.
 */
export function loadArchive(dir = ARCHIVE_DIR) {
  const path = join(dir, '_manifest.json')
  if (!existsSync(path)) {
    log.error('no archive, the history routes cover only what Devnet still holds', { dir })
    return null
  }
  let coverage
  try {
    coverage = JSON.parse(readFileSync(path, 'utf8')).coverage
  } catch (e) {
    log.error('archive manifest unreadable', { path, err: String(e).slice(0, 120) })
    return null
  }
  if (!coverage?.vaults) {
    log.error('archive declares no coverage, the history routes cover only what Devnet still holds', { path })
    return null
  }

  const read = new Map()
  const accounts = new Map()
  for (const v of Object.values(coverage.vaults)) {
    for (const c of [v.pseudoAccount, v.owner]) {
      if (!c?.account || !Array.isArray(c.transactions)) continue
      const entries = c.transactions.map((h) => {
        if (!read.has(h)) read.set(h, readCapture(dir, h))
        return read.get(h)
      })
      const declared = {
        ledgerMin: c.ledgerMin, ledgerMax: c.ledgerMax,
        entries: entries.filter(Boolean),
        // A declared transaction that did not load leaves a hole the range would hide.
        intact: entries.every(Boolean),
      }
      // One owner behind two facilities is declared twice. Each declaration lists every transaction
      // in its own range, so together they vouch for the range both cover, and no more.
      const prior = accounts.get(c.account)
      if (prior) {
        declared.ledgerMin = Math.max(prior.ledgerMin, declared.ledgerMin)
        declared.ledgerMax = Math.min(prior.ledgerMax, declared.ledgerMax)
        declared.entries = [...new Map([...prior.entries, ...declared.entries].map((e) => [e.hash, e])).values()]
        declared.intact = prior.intact && declared.intact && declared.ledgerMin <= declared.ledgerMax
      }
      accounts.set(c.account, declared)
    }
  }
  const rejected = [...read.values()].filter((e) => !e).length
  log[rejected ? 'error' : 'info']('archive loaded', {
    capturedAt: coverage.capturedAt, accounts: accounts.size, transactions: read.size - rejected, rejected,
  })
  return { capturedAt: coverage.capturedAt ?? null, capturedFrom: coverage.capturedFrom ?? null, accounts }
}

let shared
/** The archive this process serves, loaded once. */
export function archive() {
  if (shared === undefined) shared = loadArchive()
  return shared
}

/** Live and archived transactions as one list, newest first as account_tx returns them. */
export function mergeHistory(live, archived) {
  const byHash = new Map()
  // A hash in both keeps its live copy: the archive fills what pruning removed, it never overrides.
  for (const e of archived) byHash.set(hashOf(e) ?? Symbol('unhashed'), { ...e, source: 'archive' })
  for (const e of live) byHash.set(hashOf(e) ?? Symbol('unhashed'), { ...e, source: 'live' })
  return [...byHash.values()].sort((a, b) => ledgerOf(b) - ledgerOf(a) || positionOf(b) - positionOf(a))
}

/** A predicate for the transaction that created a ledger object. */
export const creates = (type, id) => (e) => ((e.meta ?? e.metaData)?.AffectedNodes ?? [])
  .some((n) => n.CreatedNode?.LedgerEntryType === type && String(n.CreatedNode.LedgerIndex).toUpperCase() === String(id).toUpperCase())

/** The first ledger from `a` to `b` that none of the ranges covers, or null when they cover it all. */
function firstGap(ranges, a, b) {
  let reach = a - 1
  for (const [lo, hi] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (lo > reach + 1) break
    reach = Math.max(reach, hi)
  }
  return reach >= b ? null : reach + 1
}

/**
 * Whether a merged history holds every transaction from the object's creation to its last change.
 *
 * The live read covers the range the server says it searched. When the page limit stopped it with
 * older transactions left, it covers from the ledger after the oldest one it returned, since that
 * ledger may be cut; when the server states no range, only the span of what it returned. The
 * archive covers its declared range when every declared transaction loaded. The history is complete
 * when the creating transaction is in the merge and the two ranges leave no ledger uncovered from it
 * to the object's last change (PreviousTxnLgrSeq, read from current state), or to the live read's
 * top when that is unknown. Ending at the last change rather than at the current ledger is what
 * keeps a dormant facility complete once the live floor passes the archive's top.
 */
export function historyWindow({ live, coverage, capturedAt, merged, origin, lastChange }) {
  const ledgers = live.transactions.map(ledgerOf)
  const newest = ledgers.length ? Math.max(...ledgers) : null
  const oldest = ledgers.length ? Math.min(...ledgers) : null
  const top = live.ledgerMax ?? newest
  let floor = live.ledgerMin ?? oldest
  if (live.truncated) floor = oldest === null ? null : oldest + 1
  const liveCovers = floor !== null && top !== null && floor <= top

  const ranges = liveCovers ? [[floor, top]] : []
  if (coverage?.intact) ranges.push([coverage.ledgerMin, coverage.ledgerMax])

  const created = merged.find(origin) ?? null
  const from = created ? ledgerOf(created) : null
  const to = lastChange ?? top
  let reason = null
  if (!created) {
    reason = 'the transaction that created it is in neither the live history nor the archive'
  } else if (to === null) {
    reason = 'its last change is unknown, and the live read stated no range'
  } else if (to < from) {
    reason = `its last change (ledger ${to}) is older than its creation (ledger ${from})`
  } else {
    const gap = firstGap(ranges, from, to)
    const liveText = liveCovers ? `the live window (${floor}-${top})` : 'the live read'
    if (gap !== null) reason = `ledger ${gap} is in neither ${liveText} nor the archive`
  }

  return {
    complete: reason === null,
    reason,
    fromLedger: from,
    toLedger: to,
    live: { ledgerMin: floor, ledgerMax: top, transactions: live.transactions.length, truncated: live.truncated },
    archive: coverage
      ? {
        capturedAt,
        ledgerMin: coverage.ledgerMin,
        ledgerMax: coverage.ledgerMax,
        transactions: coverage.entries.length,
        intact: coverage.intact,
        // Archived transactions the live read no longer returned.
        added: merged.filter((e) => e.source === 'archive').length,
      }
      : null,
  }
}

/**
 * One account's history: the live read merged with the archive, newest first like account_tx, and
 * the window the merge covers. Merged on every successful read, not only when the live read is
 * empty, because pruning is partial: a live read missing its oldest transactions looks complete.
 *
 * @param {{accountTxWindow: Function}} xrpl
 * @param {string} account
 * @param {{origin: Function, lastChange?: number|null, archive?: object|null}} opts
 *   `origin` picks the transaction that created the object; `archive` defaults to the shared one.
 */
export async function readHistory(xrpl, account, { origin, lastChange = null, ...opts }) {
  const arc = 'archive' in opts ? opts.archive : archive()
  const live = await xrpl.accountTxWindow(account)
  const coverage = arc?.accounts.get(account) ?? null
  const merged = mergeHistory(live.transactions, coverage?.entries ?? [])
  return {
    txs: merged,
    truncated: live.truncated,
    window: historyWindow({ live, coverage, capturedAt: arc?.capturedAt ?? null, merged, origin, lastChange }),
  }
}
