// Captures, while Devnet still holds it, the whole history the two history routes read for every
// facility baked into demo/: account_tx on each vault's pseudo-account (nav-history) and on the
// account that owns the vault and its loan brokers (broker-history).
//
// Every transaction not already in evidence/devnet-tx is saved in the same two forms as the others:
// the `tx` response in API v1 JSON, and the same request with binary: true. Then _manifest.json gets a
// `coverage` section stating, per vault and per account, the ledger range account_tx searched and every
// hash it returned. src/archive.mjs serves only what that section declares, so the archive covers a
// window it can name, rather than one that happens to be complete.
//
// A run only ever extends a declaration (see extendDeclaration), and refuses to write one that no
// longer holds the transaction creating its vault or broker: run after Devnet has pruned the event,
// a fresh listing would otherwise replace the archive's coverage with what is left.
//
// Live and read-only: no key, nothing submitted.
//   node src/dev/capture-history.mjs [--dry-run]
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DIR = join(ROOT, 'evidence/devnet-tx')
const RPC = process.env.XRPL_RPC ?? 'https://s.devnet.rippletest.net:51234'
// 200 a page: four pages is more history than any facility here has. A marker left after the last
// page means the listing is partial, and a partial listing cannot be declared as coverage.
const PAGES = 4
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A later listing merged into what is already declared for the same account. It may only extend the
 * declaration: by the time it runs, Devnet may have pruned what the earlier one holds. Throws when
 * the new listing starts after the declared range ends (a declaration is one range and cannot hold a
 * gap), or when it misses a declared transaction inside its own range (one of the two is wrong).
 * `where(hash)` gives [ledger, position in ledger] for a captured transaction.
 */
export function extendDeclaration(prior, fresh, where, what) {
  if (!prior) return fresh
  if (prior.account !== fresh.account) throw new Error(`${what}: declared for ${prior.account}, listed for ${fresh.account}`)
  if (fresh.ledgerMin > prior.ledgerMax + 1) {
    throw new Error(`${what}: the new listing starts at ledger ${fresh.ledgerMin}, after the declared range ends at ${prior.ledgerMax}; a declaration cannot hold a gap`)
  }
  const inside = (h) => where(h)[0] >= fresh.ledgerMin && where(h)[0] <= fresh.ledgerMax
  const lost = prior.transactions.filter((h) => inside(h) && !fresh.transactions.includes(h))
  if (lost.length) throw new Error(`${what}: the new listing misses ${lost.length} declared transaction(s) inside its own range: ${lost.join(', ')}`)
  const order = (a, b) => where(a)[0] - where(b)[0] || where(a)[1] - where(b)[1]
  return {
    ...prior,
    ...fresh,
    ledgerMin: Math.min(prior.ledgerMin, fresh.ledgerMin),
    ledgerMax: Math.max(prior.ledgerMax, fresh.ledgerMax),
    transactions: [...new Set([...prior.transactions, ...fresh.transactions])].sort(order),
  }
}

async function rpc(method, params) {
  let last
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const { result } = await r.json()
      if (result?.status !== 'success') throw Object.assign(new Error(`${method}: ${result?.error ?? 'no result'}`), { answer: true })
      return result
    } catch (e) {
      // The server answering "no" is an answer; only the transport is worth retrying.
      if (e.answer) throw e
      last = e
      console.error(`  retry ${method} in ${2 ** i}s: ${e.message}`)
      await sleep(1000 * 2 ** i)
    }
  }
  throw last
}

/** The facilities the reader serves, found the way src/index.mjs finds them. */
function facilities() {
  const out = new Map()
  for (const f of readdirSync(join(ROOT, 'demo')).filter((n) => n.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(join(ROOT, 'demo', f), 'utf8'))
    if (typeof j.vaultId !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(j.vaultId)) continue
    const id = j.vaultId.toUpperCase()
    if (!out.has(id)) out.set(id, j.label ?? null)
  }
  return out
}

/** Every hash account_tx returns for an account, oldest first, with the range it searched. */
async function listing(account) {
  const entries = []
  let marker, ledgerMin = 0, ledgerMax = Infinity
  for (let page = 0; page < PAGES; page++) {
    const r = await rpc('account_tx', { api_version: 2, account, limit: 200, ledger_index_min: -1, ledger_index_max: -1, ...(marker && { marker }) })
    // Each page states the range it searched. Keep the narrowest, so the claim holds for all of them.
    ledgerMin = Math.max(ledgerMin, r.ledger_index_min)
    ledgerMax = Math.min(ledgerMax, r.ledger_index_max)
    for (const e of r.transactions) {
      if (e.validated !== true) throw new Error(`${account}: ${e.hash} is not validated`)
      entries.push({ hash: e.hash, ledger: e.ledger_index, index: e.meta.TransactionIndex })
    }
    marker = r.marker
    if (!marker) break
  }
  if (marker) throw new Error(`${account}: more than ${PAGES * 200} transactions, the listing is partial`)
  entries.sort((a, b) => a.ledger - b.ledger || a.index - b.index)
  return { account, ledgerMin, ledgerMax, transactions: entries.map((e) => e.hash) }
}

async function main(dryRun) {
  // Transactions read this run, so a dry run can check what it would declare without writing.
  const fetched = new Map()
  const load = (h) => fetched.get(h) ?? JSON.parse(readFileSync(join(DIR, `${h}.json`), 'utf8'))
  const where = (h) => { const t = load(h); return [t.ledger_index, t.meta.TransactionIndex] }
  const creates = (hashes, type, id) => hashes.some((h) => (load(h).meta.AffectedNodes ?? [])
    .some((n) => n.CreatedNode?.LedgerEntryType === type && n.CreatedNode.LedgerIndex === id))

  /** Save one transaction in the two forms check:evidence verifies, unless it is already here. */
  const capture = async (hash) => {
    if (existsSync(join(DIR, `${hash}.json`)) && existsSync(join(DIR, `${hash}.bin.json`))) return false
    const json = await rpc('tx', { api_version: 1, transaction: hash })
    const bin = await rpc('tx', { api_version: 1, transaction: hash, binary: true })
    if (json.validated !== true || bin.validated !== true) throw new Error(`${hash}: not validated`)
    fetched.set(hash, json)
    if (dryRun) return true
    writeFileSync(join(DIR, `${hash}.json`), JSON.stringify(json, null, 2))
    writeFileSync(join(DIR, `${hash}.bin.json`), JSON.stringify({
      hash: bin.hash, ledger_index: bin.ledger_index, date: bin.date, tx_blob: bin.tx, meta_blob: bin.meta, validated: bin.validated,
    }, null, 2))
    return true
  }

  const server = (await rpc('server_info', {})).info
  console.log(`  ${RPC}  rippled ${server.build_version}  complete_ledgers ${server.complete_ledgers}${dryRun ? '  (dry run)' : ''}\n`)

  const manifestPath = join(DIR, '_manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.coverage?.vaults ?? {}
  const vaults = { ...declared }
  let added = 0
  for (const [vaultId, label] of facilities()) {
    const v = (await rpc('vault_info', { vault_id: vaultId })).vault
    const objects = await rpc('account_objects', { account: v.Owner, type: 'loan_broker', limit: 400 })
    if (objects.marker) throw new Error(`${v.Owner}: more loan brokers than one page`)
    const brokers = objects.account_objects.filter((b) => b.VaultID === vaultId).map((b) => b.index)

    const freshPseudo = await listing(v.Account)
    const freshOwner = await listing(v.Owner)
    for (const h of new Set([...freshPseudo.transactions, ...freshOwner.transactions])) if (await capture(h)) added++

    const prior = declared[vaultId]
    const pseudoAccount = extendDeclaration(prior?.pseudoAccount, freshPseudo, where, `${label} pseudo-account`)
    const owner = extendDeclaration(prior?.owner, freshOwner, where, `${label} owner`)
    owner.loanBrokerIds = [...new Set([...(prior?.owner?.loanBrokerIds ?? []), ...brokers])]

    // The archive can only call a history complete from the transaction that created its object.
    if (!creates(pseudoAccount.transactions, 'Vault', vaultId)) throw new Error(`${label}: the VaultCreate is not in the pseudo-account's declaration`)
    for (const b of owner.loanBrokerIds) {
      if (!creates(owner.transactions, 'LoanBroker', b)) throw new Error(`${label}: the LoanBrokerSet creating ${b} is not in the owner's declaration`)
    }
    vaults[vaultId] = { label, pseudoAccount, owner }
    console.log(`  ${vaultId.slice(0, 8)} ${label}`)
    console.log(`    pseudo-account ${pseudoAccount.account}  ${pseudoAccount.transactions.length} tx  ledgers ${pseudoAccount.ledgerMin}-${pseudoAccount.ledgerMax}`)
    console.log(`    owner          ${owner.account}  ${owner.transactions.length} tx  brokers ${owner.loanBrokerIds.length}`)
  }

  if (dryRun) {
    console.log(`\n  dry run: ${added} transaction(s) would be captured; nothing written.`)
    return
  }
  manifest.count = readdirSync(DIR).filter((f) => f.endsWith('.bin.json')).length
  manifest.coverage = {
    capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    capturedFrom: RPC,
    server: server.build_version,
    method: 'account_tx with ledger_index_min and ledger_index_max -1, every page; then tx, in API v1 JSON and with binary: true, for each hash not already captured',
    vaults,
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`\n  ${added} new capture(s); ${manifest.count} in total. Coverage written to evidence/devnet-tx/_manifest.json.`)
  console.log('  Next: npm run check:evidence')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await main(process.argv.includes('--dry-run'))
