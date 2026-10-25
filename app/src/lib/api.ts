import type { ChangeRow, CollateralAccount, LoanAsset, MarginCall, PositionUsd, SignatureBody, SignerField, ToSign, UsdTerms } from './types'

export const API_BASE = (import.meta.env?.VITE_API_BASE ?? 'http://localhost:8787').replace(/\/+$/, '')

/**
 * A deployed preview reaching an http base from an https page is a configuration we should
 * be suspicious of, but NOT one we may refuse on the operator's behalf: Chrome treats
 * http://localhost as a trustworthy origin and lets it through, so the demo laptop running
 * the fixture server behind a Vercel URL can genuinely work. Every other machine, and
 * Safari anywhere, will be blocked before the request leaves the tab.
 *
 * So we try, and we stop hammering when it is clearly not going to answer — see
 * SUSPECT_BACKOFF_MS. null means "nothing suspicious about this base".
 */
export const API_MIXED_ORIGIN: string | null =
  typeof location !== 'undefined'
  && location.protocol === 'https:'
  && API_BASE.startsWith('http://')
    ? `this page is served over https and the API base is ${API_BASE}`
    : null

/** Consecutive failures after which a suspect base is treated as not coming back. */
export const SUSPECT_AFTER_FAILS = 5
/** …and the interval it falls back to. Two requests a minute is a heartbeat, not a storm. */
export const SUSPECT_BACKOFF_MS = 30_000

export class ApiFailure extends Error {
  // Plain fields, not parameter properties: the Vite template compiles with
  // `erasableSyntaxOnly`, which rejects constructor-parameter declarations.
  status: number
  code: string | null
  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Single fetch with a hard abort. 30s, not less: a slow Devnet read or a cold host outlives a
 * shorter abort, which turned every slow answer into a run of failures. Throws ApiFailure on anything
 * that is not a 2xx JSON body.
 */
export async function getJson<T>(path: string, timeoutMs = 30_000): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(API_BASE + path, { signal: ctl.signal, headers: { accept: 'application/json' } })
    const text = await res.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error
      throw new ApiFailure(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? null)
    }
    if (body === null) throw new ApiFailure('empty body', res.status, null)
    return body as T
  } catch (e) {
    if (e instanceof ApiFailure) throw e
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiFailure('timeout', 0, 'TIMEOUT')
    throw new ApiFailure(e instanceof Error ? e.message : 'network error', 0, null)
  } finally {
    clearTimeout(timer)
  }
}

// --- Orma Desk ------------------------------------------------------------------------------------

/** The desk's plan, served beside the mandate by /api/desk/mandates/desk-1: the browser never reads demo/. */
export interface DeskPlanVault {
  label: string; vaultId: string; shareMptId: string; loanBrokerId: string
  impairL1Tx: string | null; impairL1Hidden: string[] | null; statementTx: string | null
}
export interface DeskPlan {
  plannedLoan: { units: string; principalDrops: string; paymentInterval: number; gracePeriod: number }
  plannedBuy: { share: string; units: string }
  vaults: DeskPlanVault[]
  /** Step 21: the desk's dollar pool, when this server lends the test dollar. */
  usd?: DeskPlanUsd
}
/** The dollar plan of demo/desk-usd.json and the risk officer's terms, served beside the mandate (step 21). */
export interface DeskPlanUsd {
  plannedLoan: { units: string; principalUsd: string; paymentInterval: number; gracePeriod: number }
  loanAsset: LoanAsset
  vaultId: string
  loanBrokerId: string
  terms: UsdTerms
}
export interface PositionCollateral { escrowId: string; shareMptId: string; units: string; account: CollateralAccount; cure?: true }
export interface Position {
  /** principalOutstanding: the loan's PrincipalOutstanding in its asset, drops for XRP, dollars for USD (step 21). */
  loanId: string; loanSetTxHash: string | null; loanSetLedger?: number | null; loanSetTicket?: boolean | null; vaultId: string; borrower: string; principalOutstanding: string
  /** null when no pledged collateral was read, or (USD) no usable price: the server says so, never a zero. */
  collateral: PositionCollateral[]; collateralHeldDrops: string; ltvHeldBps: number | null
  /** value (and, without USD terms, threshold) is null when the server could not state it. */
  usage: { limit: string; value: string | null; threshold: string | null }[]
  /** Step 21: the loan's currency; a USD position's ltvHeldBps is in dollars and it carries usd. */
  currency?: 'XRP' | 'USD'
  usd?: PositionUsd | null
  /** Step 20: the desk's margin call on this loan, judged at the ledger of the answer. */
  marginCall?: MarginCall
}
export interface Positions { ledgerIndex: number; ledgerHash: string; positions: Position[] }

export const deskPlanPath = '/api/desk/mandates/desk-1'

/** Step 21: the currency of the loan the desk is asked for. XRP is the default; the collateral is XRP-vault shares either way. */
export type LoanCurrency = 'XRP' | 'USD'

/** The loan currency an address asks for: `?asset=USD`, else XRP. Read like `facility`, so a copied address carries it. */
export function assetFromSearch(search: string): LoanCurrency {
  return new URLSearchParams(search).get('asset') === 'USD' ? 'USD' : 'XRP'
}

/**
 * The tickets the desk reads for a facility. No facility: Harbor-1. A facility that is no Harbor: no
 * harbor and no pledge ticket, never a silent fall back on Harbor-1, whose L2 may already be in default.
 * Step 21: `asset` USD reads the pledge ticket of the dollar plan (`&asset=USD`, its own units); on a plan
 * without `usd` it is no pledge ticket at all, never the XRP one under a dollar choice. XRP is unchanged.
 */
export function deskTicketPaths(deskPlan: DeskPlan, facility?: string | null, asset: LoanCurrency = 'XRP'): { harbor: DeskPlanVault | null; pledge: string | null; buy: string } {
  const harbors = deskPlan.vaults.filter((v) => v.label.startsWith('harbor-'))
  const harbor = facility
    ? harbors.find((v) => v.vaultId.toUpperCase() === facility.toUpperCase()) ?? null
    : harbors.find((v) => v.label === 'harbor-1') ?? null
  const ticket = (share: string, op: string, units: string) => `/api/tickets?share=${share}&op=${op}&units=${units}&mandate=desk-1`
  const usd = asset === 'USD' ? deskPlan.usd ?? null : null
  const pledge = !harbor ? null
    : asset === 'USD' ? (usd ? `${ticket(harbor.shareMptId, 'pledge', usd.plannedLoan.units)}&asset=USD` : null)
      : ticket(harbor.shareMptId, 'pledge', deskPlan.plannedLoan.units)
  return {
    harbor,
    pledge,
    buy: ticket(deskPlan.plannedBuy.share, 'buy', deskPlan.plannedBuy.units),
  }
}

/**
 * The facility's demo loan: a validated LoanSet whose escrow holds the Harbor's shares, the desk's gated ones first (ticket Memo), then desk vault first, else the first one.
 * Step 21: with `currency`, only the loans in that currency (a position without `currency` is an XRP one).
 */
export function demoLoanFor(positions: Positions | null, deskPlan: DeskPlan, facility?: string | null, currency?: LoanCurrency): Position | null {
  const harbor = deskTicketPaths(deskPlan, facility).harbor
  if (!harbor || !positions) return null
  const backed = positions.positions.filter((p) => /^[0-9A-F]{64}$/i.test(p.loanSetTxHash ?? '')
    && (currency === undefined || (p.currency ?? 'XRP') === currency)
    && p.collateral.some((c) => c.shareMptId.toUpperCase() === harbor.shareMptId.toUpperCase()))
  const desk = deskPlan.vaults.find((v) => v.label === 'desk')
  const pool = backed.some((p) => p.loanSetTicket) ? backed.filter((p) => p.loanSetTicket) : backed
  return pool.find((p) => desk && p.vaultId.toUpperCase() === desk.vaultId.toUpperCase()) ?? pool[0] ?? null
}

// --- step 20, the cure of a margin call ------------------------------------------------------------

/** The pledge ticket a cure rests on: the shortfall's units of the pledged share, under mandate desk-1. */
export function cureTicketPath(share: string, units: string): string {
  return `/api/tickets?share=${share}&op=pledge&units=${units}&mandate=desk-1`
}

/**
 * The lending vault of a desk loan: the plan's label for the loan's vaultId when it is `desk` or `spare`, else null.
 * Step 21: a loan of the dollar pool (`deskPlan.usd.vaultId`) is requested on the vault `desk`, so its pledges are too.
 */
export function lendingVaultOf(deskPlan: DeskPlan, vaultId: string): 'desk' | 'spare' | null {
  if (deskPlan.usd && deskPlan.usd.vaultId.toUpperCase() === vaultId.toUpperCase()) return 'desk'
  const label = deskPlan.vaults.find((v) => v.vaultId.toUpperCase() === vaultId.toUpperCase())?.label
  return label === 'desk' || label === 'spare' ? label : null
}

/** The pledgeEscrow body of a cure: a normal pledge of `units`, plus the loan it cures, so the escrow carries an orma.cure memo. */
export interface CureBody { vault: 'desk' | 'spare'; share: string; ticketId: string; inputsDigest: string; units: string; cureLoanId: string }
export function cureBody(a: { lending: 'desk' | 'spare'; share: string; ticketId: string; inputsDigest: string; units: string; loanId: string }): CureBody {
  return { vault: a.lending, share: a.share, ticketId: a.ticketId, inputsDigest: a.inputsDigest, units: a.units, cureLoanId: a.loanId }
}

export function buildActionRequest(action: string, role: string, runId: string, token: string, body?: object): { url: string; init: RequestInit } {
  const init: RequestInit = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return { url: `${API_BASE}/api/roles/${runId}/${role}/${action}`, init }
}

/** What a role action answered: its status and its envelope, an error included, never thrown. */
export interface ActionAnswer { status: number; body: { actionId?: string; preview?: ActionPreview; state?: string; error?: ActionError; toSign?: ToSign | null } & Record<string, unknown> }
export interface ActionError { code: string; message?: string; requestActionId?: string; breaches?: unknown[]; status?: number }
export interface ActionPreview { engineResult?: string | null; provenance?: string; money?: Record<string, unknown>; schema?: string; rows?: ChangeRow[] }

/** How long a role action may take: an approve waits for the LoanSet to validate, so well past a read's 30 s. */
export const ACTION_TIMEOUT_MS = 90_000

/**
 * One role POST, with a hard abort, so a server that takes the connection and never answers ends the row
 * instead of leaving it on "Previewing…". `onTimeout` is the code the abort stands for: a preview submits
 * nothing (TIMEOUT), a confirm may have been submitted (SUBMIT_UNCONFIRMED: check before trying again).
 */
export async function send(url: string, init: RequestInit, onTimeout: 'TIMEOUT' | 'SUBMIT_UNCONFIRMED' = 'TIMEOUT', timeoutMs = ACTION_TIMEOUT_MS): Promise<ActionAnswer> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  } catch (e: unknown) {
    if (ctl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return { status: 0, body: { error: { code: onTimeout } } }
    return { status: 0, body: { error: { code: 'UNREACHABLE' } } }
  } finally {
    clearTimeout(timer)
  }
}

export function postAction(action: string, role: string, runId: string, token: string, body: object): Promise<ActionAnswer> {
  const { url, init } = buildActionRequest(action, role, runId, token, body)
  return send(url, init, 'TIMEOUT')
}

export function confirmAction(runId: string, token: string, actionId: string): Promise<ActionAnswer> {
  const { init } = buildActionRequest('', '', runId, token)
  return send(`${API_BASE}/api/roles/${runId}/actions/${actionId}/confirm`, init, 'SUBMIT_UNCONFIRMED')
}

// --- addition, demo lab: browser signing ------------------------------------------------------------------

/** The body field that opts a role action into browser signing (/demo only). */
export const BROWSER_SIGNER: SignerField = { signer: 'browser' }

/** How long a signature POST may take: the server answers at once, it never waits for the ledger. */
export const SIGNATURE_TIMEOUT_MS = 30_000

/**
 * POST /api/roles/{runId}/actions/{actionId}/signature with { requestId, txBlob }: the blob signed in this browser,
 * the only thing that leaves it. Under the write policy of every role POST (Origin, operator token, kill switch).
 * A timeout may have been received: the action is read again before anything is signed twice.
 */
export function postSignature(runId: string, token: string, actionId: string, body: SignatureBody): Promise<ActionAnswer> {
  const { init } = buildActionRequest('', '', runId, token, body)
  return send(`${API_BASE}/api/roles/${runId}/actions/${actionId}/signature`, init, 'SUBMIT_UNCONFIRMED', SIGNATURE_TIMEOUT_MS)
}

/** The operator's run, and the two ids a reload between the pre-slot pledge and the live refusal must not lose. */
export interface OperatorSession { runId: string | null; token: string | null; pledgeActionId: string | null; requestActionId: string | null }
const SESSION_KEYS = ['runId', 'token', 'pledgeActionId', 'requestActionId'] as const

export function readOperatorSession(): OperatorSession {
  const empty: OperatorSession = { runId: null, token: null, pledgeActionId: null, requestActionId: null }
  if (typeof sessionStorage === 'undefined') return empty
  for (const k of SESSION_KEYS) empty[k] = sessionStorage.getItem(`orma.desk.${k}`)
  return empty
}

export function writeOperatorSession(s: OperatorSession) {
  if (typeof sessionStorage === 'undefined') return
  for (const k of SESSION_KEYS) {
    const v = s[k]
    if (v === null) sessionStorage.removeItem(`orma.desk.${k}`)
    else sessionStorage.setItem(`orma.desk.${k}`, v)
  }
}

/** A fragment #run=…&token=… starts a new session: the ids of the previous one are dropped. null when the fragment carries none. */
export function sessionFromFragment(hash: string): OperatorSession | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const runId = q.get('run')
  const token = q.get('token')
  return runId && token ? { runId, token, pledgeActionId: null, requestActionId: null } : null
}

/** The sentence a code stands for, for a reader: what happened, and whether anything was sent. */
export function errorSentence(code: string | null): string {
  switch (code) {
    case 'STALE': return 'The ledger has moved since this ticket was read: a figure it rests on changed. Nothing was signed or sent. Preview again on the current ledger.'
    case 'BREACHED': return 'The loan breaches the risk officer\'s mandate at the withdrawal value. Nothing was signed or sent.'
    case 'ESCROW_POLICY': return 'The pledged escrow does not meet the desk\'s escrow policy. Nothing was signed or sent.'
    case 'LOCKED': return 'The kill switch is on: every write is refused until it is lifted. Nothing was sent.'
    case 'NOT_CONFIGURED': return 'Writes are not configured on this server. Nothing was sent.'
    case 'UNAUTHORIZED': return 'This operator session is not valid for the run. Open the operator link again. Nothing was sent.'
    case 'FORBIDDEN': return 'This page is not allowed to write to the desk. Nothing was sent.'
    case 'BAD_REQUEST': return 'The request does not match the desk\'s contract. Nothing was sent.'
    // a 404 names an action, request or pledge the server does not hold: off its list, or no longer waiting (a stale id after a reload)
    case 'NOT_FOUND': return 'Nothing was found to act on: the action, request or pledge this names is not held by the server, or is no longer waiting. Preview again. Nothing was sent.'
    case 'TIMEOUT': return 'The server did not answer in time. Nothing was sent.'
    case 'SEQUENCE_PASSED': return 'The borrower has sent another transaction since signing. Re-request the loan to sign it again. Nothing was sent.'
    case 'INCONSISTENT_SNAPSHOT': return 'The ledger objects read at one ledger do not agree with each other. Nothing was signed or sent. Retry on the next ledger.'
    case 'SUBMIT_UNCONFIRMED': return 'The submission could not be confirmed on the ledger. Check the transaction before trying again.'
    case 'WARMING_UP': return 'The ledger could not be read at one ledger yet. It is retried on its own.'
    case 'BUSY': return 'Too many ledger reads are running. It is retried on its own.'
    // step 21: the XRP/USD median of the oracle sources could not be used at this ledger
    case 'PRICE_UNAVAILABLE': return 'No usable XRP/USD price at this ledger: too few fresh oracle sources, or the sources too far apart. No dollar figure is shown and nothing was signed. It is retried on its own.'
    // demo lab: browser signing
    case 'SIGNATURE_MISMATCH': return 'The signed transaction is not the one the server built, or it was not signed by the account asked for. Nothing was submitted; the request stays open, sign it again with the right key.'
    case 'SIGNATURE_TIMEOUT': return 'No signature arrived before the request expired. Nothing was submitted. Play the step again.'
    default: return 'The server could not answer this request. Nothing was sent.'
  }
}
