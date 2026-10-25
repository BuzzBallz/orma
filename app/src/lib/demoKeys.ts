import type { Wallet } from 'xrpl'
import type { ToSign } from './types'

/**
 * The demo lab's signing keys (/demo only, Devnet only): the borrower, the vault manager (role broker) and the
 * desk owner, loaded by the human at runtime from a file or a paste. They live in this module's memory, and in
 * sessionStorage only when "keep for this tab" is ticked (cleared when the tab closes). A seed is never put in
 * a URL, a log, a network request or React state: only the signed blob leaves this module.
 *
 * xrpl is reached through a dynamic import() and only from here, so no page but /demo carries it.
 */

export type KeyRole = 'borrower' | 'broker' | 'deskOwner'
export const KEY_ROLES: KeyRole[] = ['borrower', 'broker', 'deskOwner']

/** Who holds each key, in the demo's words. The institutions are fictional. */
export const KEY_LABEL: Record<KeyRole, { name: string; role: string }> = {
  borrower: { name: 'Tidewater Payments (fictional)', role: 'Borrower' },
  broker: { name: 'Harbor vault manager', role: 'Vault manager (broker)' },
  deskOwner: { name: 'Harbor Credit Desk (fictional)', role: 'Lender, desk owner key' },
}

/** A loaded key as the page may show it: its role and address, never its seed. */
export interface LoadedKey { role: KeyRole; address: string }

/** A seed per role, as read from a file or a paste; absent roles are not loaded. */
export type Seeds = Partial<Record<KeyRole, string>>

type XrplModule = typeof import('xrpl')
let xrplModule: Promise<XrplModule> | null = null
/** The one entry to xrpl: loaded on first use, then shared. */
export function loadXrpl(): Promise<XrplModule> {
  xrplModule ??= import('xrpl')
  return xrplModule
}

const STORE_KEY = 'orma.demo.keys'
const wallets = new Map<KeyRole, Wallet>()
/** Whether this tab keeps the keys: true when an earlier load in this tab asked for it (read once, at module load). */
let keep = (() => {
  try {
    return sessionStorage.getItem(STORE_KEY) !== null
  } catch {
    return false // no sessionStorage (server render, blocked storage): nothing is kept
  }
})()
const listeners = new Set<() => void>()
let snapshot: LoadedKey[] = []
const EMPTY: LoadedKey[] = []

function publish() {
  snapshot = KEY_ROLES.flatMap((role) => {
    const w = wallets.get(role)
    return w ? [{ role, address: w.classicAddress }] : []
  })
  for (const l of listeners) l()
}

/** For useSyncExternalStore: the loaded keys, a new array only when they change. */
export const keyStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
  get: (): LoadedKey[] => snapshot,
  server: (): LoadedKey[] => EMPTY,
}

export class KeyError extends Error {
  code: 'BAD_FILE' | 'BAD_SEED' | 'NO_KEY' | 'WRONG_KEY' | 'BAD_REQUEST' | 'SIGNING_FAILED'
  constructor(code: KeyError['code'], message: string) {
    super(message)
    this.code = code
  }
}

const isSeedLike = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0

/**
 * The roles file shape, { accounts: { borrower: { seed }, broker: { seed }, deskOwner: { seed } } }, as the bake
 * writes it: one file loads the three keys of the demo. The desk owner's own field still overrides it, and the
 * page refuses a key whose address is not the account the server asks a signature from.
 * Pure: it never echoes the file's content in an error.
 */
export function parseRolesFile(text: string): Seeds {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new KeyError('BAD_FILE', 'The file is not JSON. Load the roles file, shaped { "accounts": { "borrower": { "seed": … }, "broker": { "seed": … } } }.')
  }
  const accounts = (doc as { accounts?: unknown } | null)?.accounts
  if (!accounts || typeof accounts !== 'object') throw new KeyError('BAD_FILE', 'The file carries no "accounts" object.')
  const out: Seeds = {}
  for (const role of ['borrower', 'broker', 'deskOwner'] as const) {
    const seed = (accounts as Record<string, { seed?: unknown } | undefined>)[role]?.seed
    if (isSeedLike(seed)) out[role] = seed.trim()
  }
  if (!out.borrower && !out.broker) throw new KeyError('BAD_FILE', 'The file names no borrower or broker seed.')
  return out
}

function persist() {
  try {
    if (!keep) {
      sessionStorage.removeItem(STORE_KEY)
      return
    }
    const seeds: Seeds = {}
    for (const [role, w] of wallets) if (w.seed) seeds[role] = w.seed
    sessionStorage.setItem(STORE_KEY, JSON.stringify(seeds))
  } catch {
    // sessionStorage blocked or full: the keys stay in memory for this page only, which is the default anyway
  }
}

/**
 * Derives each seed's wallet in this browser and keeps it in memory. A seed that is not an XRPL seed is refused
 * by its role, never quoted. Returns the roles loaded by this call.
 */
export async function loadSeeds(seeds: Seeds): Promise<KeyRole[]> {
  const { Wallet: W } = await loadXrpl()
  const derived: [KeyRole, Wallet][] = []
  for (const role of KEY_ROLES) {
    const seed = seeds[role]
    if (!isSeedLike(seed)) continue
    try {
      derived.push([role, W.fromSeed(seed.trim())])
    } catch {
      throw new KeyError('BAD_SEED', `The ${KEY_LABEL[role].role.toLowerCase()} seed could not be read as an XRPL seed. Nothing was loaded.`)
    }
  }
  for (const [role, w] of derived) wallets.set(role, w)
  persist()
  publish()
  return derived.map(([role]) => role)
}

/** Keep the loaded keys in sessionStorage for this tab, or drop them from it. */
export function setKeep(on: boolean) {
  keep = on
  persist()
}
export const keeping = () => keep

/** Forget every key: memory and sessionStorage. */
export function forgetKeys() {
  wallets.clear()
  keep = false
  try { sessionStorage.removeItem(STORE_KEY) } catch { /* blocked storage holds nothing to forget */ }
  publish()
}

/** On page load: the keys kept for this tab, if any. True when some were restored. */
export async function restoreKept(): Promise<boolean> {
  let raw: string | null = null
  try { raw = sessionStorage.getItem(STORE_KEY) } catch { return false }
  if (!raw) return false
  let seeds: Seeds
  try {
    seeds = JSON.parse(raw) as Seeds
  } catch {
    try { sessionStorage.removeItem(STORE_KEY) } catch { /* nothing to clean */ }
    return false
  }
  keep = true
  try {
    return (await loadSeeds(seeds)).length > 0
  } catch {
    forgetKeys()
    return false
  }
}

/** The key the server names by its role: deskOwner, desk and riskOfficer all mean the desk owner's countersigning key. */
export function keyRoleOf(role: string): KeyRole | null {
  if (role === 'borrower') return 'borrower'
  if (role === 'broker') return 'broker'
  if (role === 'deskOwner' || role === 'desk' || role === 'riskOfficer') return 'deskOwner'
  return null
}

/** The name of a role for a sentence: the server's role name when the page does not know it. */
export function roleName(role: string): string {
  const k = keyRoleOf(role)
  return k ? `${KEY_LABEL[k].name}, ${KEY_LABEL[k].role.toLowerCase()}` : role
}

/**
 * Which loaded key would sign a request, or why none: the key of the request's role must be loaded and its
 * address must be the request's account, otherwise "wrong key loaded for <role>".
 */
export function keyFor(t: Pick<ToSign, 'role' | 'account'>, loaded: LoadedKey[] = snapshot): { ok: true; key: LoadedKey } | { ok: false; code: 'NO_KEY' | 'WRONG_KEY'; message: string } {
  const role = keyRoleOf(t.role)
  const byRole = role ? loaded.find((k) => k.role === role) : undefined
  const byAddress = loaded.find((k) => k.address === t.account)
  if (byRole && byRole.address === t.account) return { ok: true, key: byRole }
  if (!role && byAddress) return { ok: true, key: byAddress }
  if (byRole) return { ok: false, code: 'WRONG_KEY', message: `Wrong key loaded for ${roleName(t.role)}: the loaded key is ${byRole.address}, the transaction must be signed by ${t.account}. Nothing was signed.` }
  return { ok: false, code: 'NO_KEY', message: `No key loaded for ${roleName(t.role)}. Load it in the signing keys panel above. Nothing was signed.` }
}

/**
 * Signs one request of the server in this browser and returns the blob to post back, with its hash. `sign`: the
 * autofilled transaction, as is, by the request's account. `countersign`: the borrower-signed LoanSet blob, by the
 * desk owner's key as counterparty. The address check runs first; nothing is signed on a mismatch.
 */
export async function signRequest(t: ToSign): Promise<{ txBlob: string; hash: string }> {
  const found = keyFor(t)
  if (!found.ok) throw new KeyError(found.code, found.message)
  const wallet = wallets.get(found.key.role)
  if (!wallet) throw new KeyError('NO_KEY', `No key loaded for ${roleName(t.role)}. Nothing was signed.`)
  const x = await loadXrpl()
  try {
    if (t.kind === 'sign') {
      if (!t.txJson || typeof t.txJson !== 'object') throw new KeyError('BAD_REQUEST', 'The request carries no transaction to sign. Nothing was signed.')
      if (t.txJson.Account !== t.account) throw new KeyError('BAD_REQUEST', `The transaction's account ${String(t.txJson.Account)} is not the account asked to sign, ${t.account}. Nothing was signed.`)
      const r = wallet.sign(structuredClone(t.txJson) as unknown as Parameters<Wallet['sign']>[0])
      return { txBlob: r.tx_blob, hash: r.hash }
    }
    if (t.kind === 'countersign') {
      if (typeof t.txBlob !== 'string' || !/^[0-9A-Fa-f]+$/.test(t.txBlob)) throw new KeyError('BAD_REQUEST', 'The request carries no signed LoanSet to countersign. Nothing was signed.')
      const r = x.signLoanSetByCounterparty(wallet, t.txBlob)
      return { txBlob: r.tx_blob, hash: r.hash }
    }
    throw new KeyError('BAD_REQUEST', 'The request is neither a signature nor a countersignature. Nothing was signed.')
  } catch (e: unknown) {
    if (e instanceof KeyError) throw e
    // xrpl's own validation message names a field, never a key
    throw new KeyError('SIGNING_FAILED', `The transaction could not be signed in this browser: ${e instanceof Error ? e.message : 'unknown error'}. Nothing was sent.`)
  }
}

/** The transaction inside a blob (a countersign request's LoanSet), decoded in this browser. */
export async function decodeBlob(blob: string): Promise<Record<string, unknown>> {
  const x = await loadXrpl()
  return x.decode(blob) as Record<string, unknown>
}
