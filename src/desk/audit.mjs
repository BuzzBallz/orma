/**
 * The public rule of the collateral, the agent that applies it and the auditor that checks it, in one
 * file (step 12, part release-agent; blueprint §4 "Règle de l'agent de libération", §13 I1 to I3 and I7).
 *
 *   decideRelease(...)   pure: to-desk, to-borrower or none for a 2-of-3 collateral account at a ledger
 *   guardCosign(tx, ...) pure: the guard of I3b, { ok: true } only for the release Payment of all shares
 *   node --env-file-if-exists=.env src/desk/audit.mjs --release --account <address> [--submit]
 *       the agent: reads at the validated ledger L, prints the decision and its reason and nothing else;
 *       with --submit, builds, guards, multi-signs and submits the release, and chains the decision into
 *       agent-releases.jsonl next to DESK_LOG_PATH
 *   node src/desk/audit.mjs [--api <base>] [--releases <path>]
 *       the auditor: no key, read-only (never ROLES_FILE, a seed, a wallet, submit, submit_multisigned or
 *       sign); exit 0 without violation, 1 on a violation of I1 to I3 or I7 (one line each), 2 when a
 *       read is impossible (the violations found before are printed first)
 *   node src/desk/audit.mjs --self-test [--seed <n>]
 *       offline, on a fake client that records every command
 *
 * Exit codes of the agent CLI (--release): 0 a release decision (to-desk or to-borrower; with --submit,
 * its Payment validated tesSUCCESS), 1 none (the rule, or the guard, refuses), 2 no decision possible
 * (incomplete history, unreadable ledger, configuration).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, hashes, multisign, Wallet } from 'xrpl'
import { num } from '../num.mjs'
import { logger } from '../log.mjs'
import { canonical, sha256Hex, mandateHash, COLLATERAL_STAGES, collateralStageOf, judgeCollateralAccount, judgeCollateralShare } from '../nyc/contracts.mjs'
import { readCollateralAccount, readTicketInputs, readDemo, issuanceIdOf, SnapshotError, ShareNotTrackedError, PageLimitError, MAX_PAGES } from '../ticket/inputs.mjs'
import { buildTicket } from '../ticket/engine.mjs'

const log = logger('desk:audit')

const LSF_LOAN_DEFAULT = 0x00010000 // LedgerFormats.h:205
const LSF_DEPOSIT_AUTH = 0x01000000 // LedgerFormats.h:146
const LSF_DISABLE_MASTER = 0x00100000
const ASF_DISABLE_MASTER = 4
const TF_PARTIAL_PAYMENT = 0x00020000
const TF_INNER_BATCH_TXN = 0x40000000
const TF_FULLY_CANONICAL_SIG = 0x80000000
/** base × (1 + 2) for two signers (Transactor.cpp:473), with a margin of ten. */
const FEE_CEILING_MULTIPLE = 30
/** keylet::fees(): the one FeeSettings object of a ledger. */
const FEE_SETTINGS_INDEX = '4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651'
const MEMO_ESCROW = Buffer.from('orma.escrow', 'utf8').toString('hex').toUpperCase()
const MEMO_TICKET = Buffer.from('orma.ticket', 'utf8').toString('hex').toUpperCase()
const GENESIS = '0'.repeat(64)
export const DEFAULT_API_BASE = 'https://claude-vps.tailf3fd40.ts.net/orma'

/** The fields a release Payment may carry; anything else is not the release (I3b). */
const RELEASE_FIELDS = new Set([
  'TransactionType', 'Account', 'Destination', 'Amount', 'Flags', 'Fee', 'Sequence', 'LastLedgerSequence',
  'SigningPubKey', 'TxnSignature', 'Signers', 'NetworkID', 'Memos', 'SourceTag', 'DestinationTag', 'TicketSequence',
])
/** What rippled adds to tx_json under API v2 (ctid, date, ledger_index), and the v1 envelope (hash, inLedger). */
const ENVELOPE_FIELDS = ['ctid', 'date', 'ledger_index', 'hash', 'inLedger']

// --- small pure helpers ------------------------------------------------------------------------------------

const upper = (v) => (typeof v === 'string' ? v.toUpperCase() : null)
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isMpt = (a) => isPlain(a) && typeof a.mpt_issuance_id === 'string'
/** Ledger flags are a JSON integer; absent reads 0. Not an amount. */
const flagsOf = (v) => (Number.isSafeInteger(v) ? v >>> 0 : 0)
const hasFlag = (v, mask) => (flagsOf(v) & mask) !== 0
/** The transaction of an account_tx or tx entry, API v1 (tx) or v2 (tx_json). */
const txOf = (e) => e?.tx_json ?? e?.tx ?? e ?? {}
const hashOfEntry = (e) => upper(e?.hash ?? txOf(e).hash ?? null)
const ledgerOfEntry = (e) => {
  const v = e?.ledger_index ?? txOf(e).ledger_index
  return Number.isSafeInteger(v) ? v : null
}
const metaOf = (e) => e?.meta ?? e?.metaData ?? null
const resultOf = (e) => metaOf(e)?.TransactionResult ?? null
const nodesOf = (e) => metaOf(e)?.AffectedNodes ?? []
const positionOf = (e) => (Number.isSafeInteger(metaOf(e)?.TransactionIndex) ? metaOf(e).TransactionIndex : 0)
const ascending = (a, b) => (ledgerOfEntry(a) ?? 0) - (ledgerOfEntry(b) ?? 0) || positionOf(a) - positionOf(b)
const memoOf = (t, type) => {
  const m = (Array.isArray(t?.Memos) ? t.Memos : []).map((x) => x?.Memo).find((x) => same(x?.MemoType, type))
  return typeof m?.MemoData === 'string' ? m.MemoData.toUpperCase() : null
}
/** The sequence an EscrowCreate's index is keyed on: its Sequence, or its TicketSequence when Sequence is 0. */
const seqOf = (t) => (Number.isSafeInteger(t?.Sequence) && t.Sequence > 0 ? t.Sequence : Number.isSafeInteger(t?.TicketSequence) ? t.TicketSequence : null)

/** A read that cannot be made: the auditor exits 2 with its sentence, the agent decides nothing. */
export class Unreadable extends Error {
  constructor(message) {
    super(message)
    this.name = 'Unreadable'
  }
}

/**
 * A transaction read from history is not the one that was signed: under API v2 rippled serves a Payment
 * with DeliverMax and no Amount, and puts ctid, date and ledger_index into tx_json. Strip the envelope and
 * set Amount := DeliverMax, so that guardCosign judges what was signed. Pure.
 * @param {Record<string, unknown>} tx
 * @returns {Record<string, unknown>}
 */
export function normaliseHistoryTx(tx) {
  const out = { ...tx }
  for (const k of ENVELOPE_FIELDS) delete out[k]
  if (out.DeliverMax !== undefined) {
    out.Amount = out.DeliverMax
    delete out.DeliverMax
  }
  return out
}

// --- the guard of I3b ----------------------------------------------------------------------------------------

/**
 * The guard of invariant I3 (§13): { ok: true } only for a Payment whose Account is the collateral
 * account, whose Destination is the desk under to-desk or the borrower under to-borrower, whose Amount is
 * an MPT amount of shareMptId equal to sharesHeld (all the shares of the account), with no SendMax,
 * DeliverMin, Paths, tfPartialPayment nor Delegate, Flags 0 or tfFullyCanonicalSig only, a Fee at most 30
 * times baseFee, and no field outside a release Payment. Everything else, and anything under decision
 * none, is { ok: false, reason }. Pure. The third argument is internal to the self-test (a rule disabled to
 * prove it red without it).
 * @param {any} tx
 * @param {{ decision: string, account: string, desk: string, borrower: string, shareMptId: string, sharesHeld: string, baseFee: string|number|null|undefined }} ctx
 * @param {{ disable?: Set<string> }} [internal]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function guardCosign(tx, { decision, account, desk, borrower, shareMptId, sharesHeld, baseFee } = /** @type {any} */ ({}), { disable = new Set() } = {}) {
  const no = (reason) => ({ ok: false, reason })
  const on = (rule) => !disable.has(rule)
  if (!isPlain(tx)) return no('not a transaction')
  if (tx.TransactionType !== 'Payment') return no(`the agent co-signs a release Payment only, never a ${tx.TransactionType ?? 'transaction without a type'}`)
  if (on('delegate') && tx.Delegate !== undefined) return no('the transaction carries Delegate: a delegated transaction escapes the 2-of-3 signer list')
  if (decision !== 'to-desk' && decision !== 'to-borrower') return no(`no release under the decision ${decision ?? 'absent'}`)
  if (on('account') && (typeof account !== 'string' || tx.Account !== account)) return no(`the Account ${tx.Account} is not the collateral account ${account}`)
  const target = decision === 'to-desk' ? desk : borrower
  if (on('destination') && (typeof target !== 'string' || tx.Destination !== target)) return no(`the Destination ${tx.Destination} is not the ${decision === 'to-desk' ? 'desk' : 'borrower'} ${target} the decision ${decision} names`)
  if (on('amount')) {
    if (!isMpt(tx.Amount)) return no('the Amount is not an MPT amount of the pledged share (an XRP payment)')
    if (!same(tx.Amount.mpt_issuance_id, shareMptId)) return no(`the Amount is of the share ${tx.Amount.mpt_issuance_id}, not of the pledged share ${shareMptId}`)
    if (Object.keys(tx.Amount).some((k) => k !== 'mpt_issuance_id' && k !== 'value')) return no('the Amount carries fields other than mpt_issuance_id and value')
    if (!/^\d+$/.test(String(tx.Amount.value)) || !/^\d+$/.test(String(sharesHeld ?? ''))) return no('the Amount or the shares held is not a whole number of share units')
    if (num(sharesHeld).lte(0)) return no('the collateral account holds no shares to release')
    if (!num(tx.Amount.value).eq(num(sharesHeld))) return no(`the Amount ${tx.Amount.value} is not all ${sharesHeld} shares the account holds`)
  }
  if (on('pathing')) for (const f of ['SendMax', 'DeliverMin', 'Paths']) if (tx[f] !== undefined) return no(`the Payment carries ${f}`)
  if (on('flags')) {
    if (tx.Flags !== undefined && !Number.isSafeInteger(tx.Flags)) return no('Flags is not an integer')
    const flags = flagsOf(tx.Flags ?? 0)
    if (flags & TF_PARTIAL_PAYMENT) return no('the Payment carries tfPartialPayment')
    if (flags & TF_INNER_BATCH_TXN) return no('the Payment carries tfInnerBatchTxn: an inner Batch transaction is never co-signed')
    if (flags !== 0 && flags !== TF_FULLY_CANONICAL_SIG) return no(`Flags ${flags} is neither 0 nor tfFullyCanonicalSig`)
  }
  const base = baseFee === undefined || baseFee === null ? null : String(baseFee)
  const baseOk = base !== null && /^\d+$/.test(base) && num(base).gt(0)
  if (on('baseFee') && !baseOk) return no('no base fee was read at the ledger: the fee ceiling cannot be checked')
  if (on('fee') && baseOk) {
    if (!/^\d+$/.test(String(tx.Fee ?? ''))) return no('the Fee is not a whole number of drops')
    if (num(tx.Fee).gt(num(base).times(FEE_CEILING_MULTIPLE))) return no(`the Fee ${tx.Fee} is above ${FEE_CEILING_MULTIPLE} times the base fee ${base}`)
  }
  if (on('fields')) {
    const extra = Object.keys(tx).filter((k) => !RELEASE_FIELDS.has(k))
    if (extra.length) return no(`fields outside a release Payment: ${extra.join(', ')}`)
  }
  return { ok: true }
}

// --- the public rule (§4, points 1 to 6) ---------------------------------------------------------------------

/**
 * The pledge EscrowCreates to the account and the desk LoanSets that name one of them, sorted here: a
 * pledge is a validated tesSUCCESS EscrowCreate from the borrower to the account of an MPT amount of the
 * share; a link is a tesSUCCESS LoanSet that created a Loan (CreatedNode) on a desk LoanBroker and whose
 * orma.escrow Memo names a pledge's index. Everything else is ignored. Pure.
 */
function linkOf({ account, borrower, shareMptId, deskBrokers, escrowCreates, loanSets }) {
  const brokers = new Set([...(deskBrokers ?? [])].map(upper).filter(Boolean))
  /** @type {Map<string, { ledgerIndex: number|null, hash: string|null }>} */
  const pledges = new Map()
  for (const e of escrowCreates ?? []) {
    const t = txOf(e)
    if (t.TransactionType !== 'EscrowCreate' || t.Account !== borrower || t.Destination !== account || resultOf(e) !== 'tesSUCCESS') continue
    if (!isMpt(t.Amount) || !same(t.Amount.mpt_issuance_id, shareMptId)) continue
    const seq = seqOf(t)
    if (seq === null) continue
    pledges.set(hashes.hashEscrow(borrower, seq).toUpperCase(), { ledgerIndex: ledgerOfEntry(e), hash: hashOfEntry(e) })
  }
  const links = []
  const seen = new Set()
  for (const e of loanSets ?? []) {
    const t = txOf(e)
    if (t.TransactionType !== 'LoanSet' || resultOf(e) !== 'tesSUCCESS') continue
    const created = nodesOf(e).map((n) => n?.CreatedNode).find((c) => c?.LedgerEntryType === 'Loan')
    if (!created || !brokers.has(upper(created.NewFields?.LoanBrokerID ?? t.LoanBrokerID))) continue
    const named = memoOf(t, MEMO_ESCROW)
    if (!named || !pledges.has(named)) continue
    const h = hashOfEntry(e)
    if (h && seen.has(h)) continue
    if (h) seen.add(h)
    links.push({ loanId: upper(created.LedgerIndex), escrowIndex: named, txHash: h })
  }
  return { pledges, links }
}

const loanFields = (fields, loanId, where) => {
  if (hasFlag(fields?.Flags, LSF_LOAN_DEFAULT)) return { state: 'defaulted', reason: `the loan ${loanId} carries lsfLoanDefault ${where}` }
  const remaining = num(fields?.PaymentRemaining)
  if (remaining.isZero()) return { state: 'repaid', reason: `the loan ${loanId} is repaid without default ${where}` }
  return { state: 'active', reason: `the loan ${loanId} is active ${where} (${remaining.toFixed(0)} payments remaining, no default)` }
}

/** The state of the linked loan: present at L, else its DeletedNode in a LoanDelete; only the loan the Memo names. */
function loanStateOf({ loan, deletedLoan, loanId }, disable) {
  const named = (id) => disable.has('loanIsNamed') || same(id, loanId)
  if (loan) {
    if ((loan.LedgerEntryType !== undefined && loan.LedgerEntryType !== 'Loan') || !named(loan.index)) {
      return { state: 'other', reason: `the loan read (${loan.index ?? 'no index'}) is not the loan ${loanId} the LoanSet Memo names` }
    }
    return loanFields(loan, loanId, 'at this ledger')
  }
  if (deletedLoan) {
    if (deletedLoan.LedgerEntryType !== 'Loan' || !named(deletedLoan.LedgerIndex)) {
      return { state: 'other', reason: `the deleted loan read (${deletedLoan.LedgerIndex ?? 'no index'}) is not the loan ${loanId} the LoanSet Memo names` }
    }
    return loanFields(deletedLoan.FinalFields ?? {}, loanId, 'in the FinalFields of its LoanDelete')
  }
  return { state: 'missing', reason: `the loan ${loanId} is not on the ledger and no LoanDelete of it was found` }
}

/** Whether the recipient can receive the shares: an MPToken of the share, and deposit authorization for the account. */
function canReceive(recipient, account, shareMptId) {
  if (!recipient?.accountRoot) return false
  if (!recipient.mptoken || !same(recipient.mptoken.MPTokenIssuanceID, shareMptId)) return false
  if (hasFlag(recipient.accountRoot.Flags, LSF_DEPOSIT_AUTH)) {
    const p = recipient.depositPreauth
    if (!p || p.Authorize !== account) return false
  }
  return true
}

/**
 * The agent's public rule (§4, Règle de l'agent de libération, points 1 to 6), at one ledger. Pure.
 * collateral is the account read by readCollateralAccount at the structural state (its signers name the
 * borrower and the desk); escrowCreates every EscrowCreate to the account; loanSets every LoanSet of the
 * borrower's history (sorted here); loan the Loan read at L by the linked id, or null; deletedLoan its
 * DeletedNode found in a LoanDelete, or null; recipient { address, accountRoot, mptoken, depositPreauth }
 * of the party the decision would name; incomplete a sentence when the history is incomplete (point 2).
 * @param {{ account: string, collateral: any, loan?: any, deletedLoan?: any, escrowCreates?: any[], loanSets?: any[], recipient?: any, shareMptId: string, deskBrokers?: Iterable<string>, incomplete?: string|null }} args
 * @param {{ disable?: Set<string> }} [internal]
 * @returns {{ decision: 'to-desk'|'to-borrower'|'none', reason: string, loanId: string|null, escrowIndex: string|null, loanState: string|null }}
 */
export function decideRelease({ account, collateral, loan = null, deletedLoan = null, escrowCreates = [], loanSets = [], recipient = null, shareMptId, deskBrokers = [], incomplete = null }, { disable = new Set() } = {}) {
  const out = (decision, reason, extra = {}) => ({ decision, reason, loanId: null, escrowIndex: null, loanState: null, ...extra })
  if (incomplete) return out('none', incomplete)
  const borrower = collateral?.signers?.borrower
  const desk = collateral?.signers?.desk
  if (!collateral || typeof borrower !== 'string' || typeof desk !== 'string') return out('none', 'the collateral account was not read')
  // (1) no shares, nothing to release
  if (num(collateral.sharesHeld).lte(0)) return out('none', `the collateral account ${account} holds no shares`)
  // (2) the one desk LoanSet that names the account's pledge escrow
  const { links } = linkOf({ account, borrower, shareMptId, deskBrokers, escrowCreates, loanSets })
  if (links.length === 0) return out('none', `no desk LoanSet validated tesSUCCESS names a pledge escrow of ${account}`)
  if (links.length > 1) return out('none', `ambiguous: ${links.length} desk LoanSets name a pledge escrow of ${account}`)
  const { loanId, escrowIndex } = links[0]
  // (3), (4) the loan, present or deleted
  const st = loanStateOf({ loan, deletedLoan, loanId }, disable)
  const extra = { loanId, escrowIndex, loanState: st.state }
  if (st.state !== 'defaulted' && st.state !== 'repaid') return out('none', st.reason, extra)
  // (5) the account conforms in structure
  if (!collateral.conforming) return out('none', `the collateral account does not conform in structure: ${(collateral.reasons ?? []).join('; ') || 'not conforming'}`, extra)
  // (6) the recipient can receive the shares
  const decision = st.state === 'defaulted' ? 'to-desk' : 'to-borrower'
  const target = decision === 'to-desk' ? desk : borrower
  if (recipient && recipient.address !== target) return out('none', `the recipient read (${recipient.address}) is not the party the decision names (${target})`, extra)
  if (!canReceive(recipient, account, shareMptId)) return out('none', 'recipient cannot receive the shares', extra)
  return out(decision, st.reason, extra)
}

// --- reads (every function takes an injected client { req(payload) }) ----------------------------------------

/** A ledger_entry at L, or null when the object is not on that ledger (the private entryAt of src/ticket/inputs.mjs). */
async function entryAt(client, params, L) {
  try {
    return (await client.req({ command: 'ledger_entry', ...params, ledger_index: L })).result.node
  } catch (e) {
    if (e?.data?.error === 'entryNotFound' || e?.data?.error === 'objectNotFound') return null
    throw e
  }
}

/** The header of a ledger: its index, hash and close_time; a ledger the node does not hold is Unreadable. */
export async function headerOf(client, ledgerIndex) {
  let r
  try {
    r = await client.req({ command: 'ledger', ledger_index: ledgerIndex })
  } catch (e) {
    const code = e?.data?.error ?? e?.message ?? String(e)
    throw new Unreadable(`ledger ${ledgerIndex} cannot be read on this node (${String(code).slice(0, 80)})`)
  }
  const raw = r.result.ledger_index ?? r.result.ledger?.ledger_index
  const index = Number.isSafeInteger(raw) ? raw : Number(raw) // a ledger number, not an amount
  return { ledgerIndex: index, ledgerHash: upper(r.result.ledger_hash ?? r.result.ledger?.ledger_hash ?? null), closeTime: r.result.ledger?.close_time ?? null }
}

/** A transaction by hash (the exception of rule 3): its result, or null when the node does not know it. */
async function lookupTx(client, hash) {
  try {
    return (await client.req({ command: 'tx', transaction: hash })).result
  } catch (e) {
    if (e?.data?.error === 'txnNotFound') return null
    throw e
  }
}

/**
 * An account's history up to L, every page (the paging convention of allPages in src/ticket/inputs.mjs,
 * kept here with the range each page says it searched): { txs, ledgerMin, refused }; past MAX_PAGES,
 * refused is the sentence and nothing is decided, unless partialOk (the self-test's rule switch).
 */
async function historyOf(client, account, L, { partialOk = false } = {}) {
  const txs = []
  let marker
  let ledgerMin = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await client.req({ command: 'account_tx', account, ledger_index_min: -1, ledger_index_max: L, limit: 400, ...(marker !== undefined && { marker }) })
    const lo = r.result.ledger_index_min
    if (Number.isSafeInteger(lo)) ledgerMin = Math.max(ledgerMin ?? lo, lo)
    txs.push(...(r.result.transactions ?? []))
    marker = r.result.marker
    if (marker === undefined || marker === null) return { txs, ledgerMin, refused: null }
  }
  if (partialOk) return { txs, ledgerMin, refused: null }
  return { txs, ledgerMin, refused: new PageLimitError(`the history of ${account}`, L).message }
}

/** The DeletedNode of type Loan of a tesSUCCESS LoanDelete in a history, for one loan id. */
function deletedLoanIn(txs, loanId) {
  for (const e of txs) {
    if (resultOf(e) !== 'tesSUCCESS') continue
    const d = nodesOf(e).map((n) => n?.DeletedNode).find((x) => x?.LedgerEntryType === 'Loan' && same(x.LedgerIndex, loanId))
    if (d) return d
  }
  return null
}

/** What the recipient of a release is at L: its AccountRoot, its MPToken of the share, its DepositPreauth for the account. */
async function readRecipient(client, address, account, shareMptId, L) {
  let accountRoot = null
  try {
    accountRoot = (await client.req({ command: 'account_info', account: address, ledger_index: L })).result.account_data
  } catch (e) {
    if (e?.data?.error !== 'actNotFound') throw e
  }
  const mptoken = await entryAt(client, { mptoken: { mpt_issuance_id: upper(shareMptId), account: address } }, L)
  const depositPreauth = await entryAt(client, { deposit_preauth: { owner: address, authorized: account } }, L)
  return { address, accountRoot, mptoken, depositPreauth }
}

/** The base fee of FeeSettings at L, in drops (BaseFeeDrops, or the older hex BaseFee); null when unread. */
export async function readBaseFee(client, L) {
  const node = await entryAt(client, { index: FEE_SETTINGS_INDEX }, L)
  if (!node) return null
  if (node.BaseFeeDrops !== undefined && /^\d+$/.test(String(node.BaseFeeDrops))) return String(node.BaseFeeDrops)
  if (typeof node.BaseFee === 'string' && /^[0-9A-Fa-f]+$/.test(node.BaseFee)) return BigInt(`0x${node.BaseFee}`).toString()
  return null
}

/**
 * Everything the rule reads for a collateral account at one ledger: the account at the structural state
 * (readCollateralAccount with history), its history and the borrower's, each to its last page, the borrower's
 * reaching back to the first pledge EscrowCreate to the account (§4 point 2, else `incomplete`), the linked
 * Loan by index (or its DeletedNode), and the recipient the decision would name.
 * @param {{ req: (p: any) => Promise<any> }} client
 * @param {{ account: string, shareMptId: string, roles: { borrower: string, desk: string, agent: string }, deskBrokers: string[], at: { ledgerIndex: number, ledgerHash: string|null }, partialOk?: boolean }} o
 */
export async function readReleaseState(client, { account, shareMptId, roles, deskBrokers, at, partialOk = false }) {
  const L = at.ledgerIndex
  const { borrower, desk, agent } = roles
  const collateral = await readCollateralAccount(client, { address: account, shareMptId, at, borrower, desk, agent, ...COLLATERAL_STAGES.structural, history: true })
  const ofAccount = await historyOf(client, account, L, { partialOk })
  const ofBorrower = await historyOf(client, borrower, L, { partialOk })
  let incomplete = ofAccount.refused ?? ofBorrower.refused ?? null
  if (incomplete) incomplete = `${incomplete}: no decision on an incomplete history`
  const escrowCreates = ofAccount.txs.filter((e) => txOf(e).TransactionType === 'EscrowCreate' && txOf(e).Destination === account)
  const loanSets = ofBorrower.txs.filter((e) => txOf(e).TransactionType === 'LoanSet')
  const { pledges, links } = linkOf({ account, borrower, shareMptId, deskBrokers, escrowCreates, loanSets })
  if (!incomplete && !partialOk && pledges.size) {
    const first = Math.min(...[...pledges.values()].map((p) => p.ledgerIndex ?? Number.MAX_SAFE_INTEGER))
    if (!Number.isSafeInteger(ofBorrower.ledgerMin) || ofBorrower.ledgerMin > first) {
      incomplete = `the history of the borrower ${borrower} on this node starts at ledger ${ofBorrower.ledgerMin ?? 'unknown'}, after the first pledge EscrowCreate to ${account} (ledger ${first}): no decision on an incomplete history`
    }
  }
  let loan = null
  let deletedLoan = null
  let target = null
  if (links.length === 1) {
    loan = await entryAt(client, { index: links[0].loanId }, L)
    if (!loan) deletedLoan = deletedLoanIn(ofBorrower.txs, links[0].loanId)
    const st = loanStateOf({ loan, deletedLoan, loanId: links[0].loanId }, new Set())
    target = st.state === 'defaulted' ? desk : st.state === 'repaid' ? borrower : null
  }
  const recipient = target ? await readRecipient(client, target, account, shareMptId, L) : null
  return { args: { account, collateral, loan, deletedLoan, escrowCreates, loanSets, recipient, shareMptId, deskBrokers, incomplete }, collateral, target }
}

// --- the chained journals ------------------------------------------------------------------------------------

const parseLines = (text) => String(text).split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => {
  try {
    return JSON.parse(l)
  } catch {
    return null
  }
})

/** The first entry that breaks the chain of src/desk/decision-log.mjs (seq, prevHash, hash), or null. */
function firstBadLink(entries) {
  let prev = GENESIS
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!isPlain(e) || e.seq !== i + 1 || e.prevHash !== prev) return { seq: i + 1, ledger: e?.ledgerIndex ?? null }
    const { hash, ...rest } = e
    if (hash !== sha256Hex(canonical(rest))) return { seq: i + 1, ledger: e.ledgerIndex ?? null }
    prev = hash
  }
  return null
}

/** Append one decision to agent-releases.jsonl, chained as the decision log is (same hash). */
function appendRelease(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  const all = existsSync(path) ? parseLines(readFileSync(path, 'utf8')) : []
  const entry0 = { seq: all.length + 1, prevHash: all.at(-1)?.hash ?? GENESIS, ...body }
  const entry = { ...entry0, hash: sha256Hex(canonical(entry0)) }
  appendFileSync(path, JSON.stringify(entry) + '\n')
  return entry
}

/** agent-releases.jsonl, next to DESK_LOG_PATH. */
export function releasesPathOf(env = process.env) {
  return join(dirname(env.DESK_LOG_PATH ?? '.demo/decisions.jsonl'), 'agent-releases.jsonl')
}

// --- the demo files ------------------------------------------------------------------------------------------

/**
 * The public files the agent and the auditor read: desk, spare, the mandate, the share of each pool of
 * collateral.accounts, and a reader-like lookup share → vault over every demo/*.json that carries both.
 * The dollar pool (step 21) is optional, as the signer reads it: null on a server without desk-usd.json.
 */
export function demoFromFiles(dir = 'demo') {
  const desk = readDemo('desk', dir)
  const spare = readDemo('spare', dir)
  const mandate = readDemo('mandate-desk-1', dir)
  const usd = existsSync(join(dir, 'desk-usd.json')) ? readDemo('desk-usd', dir) : null
  const shares = {}
  for (const key of Object.keys(desk.collateral?.accounts ?? {})) shares[key] = upper(readDemo(key, dir).shareMptId)
  const vaults = new Map()
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const d = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (/^[0-9A-Fa-f]{64}$/.test(d?.vaultId ?? '') && typeof d.shareMptId === 'string') vaults.set(upper(d.shareMptId), d.vaultId)
    } catch {
      // a demo file that is not JSON names no vault
    }
  }
  return { desk, spare, mandate, usd, shares, reader: { getByShareMpt: (id) => (vaults.has(upper(id)) ? { vaultId: vaults.get(upper(id)) } : null) } }
}

const rolesOf = (demo) => ({ borrower: demo.desk.collateral?.borrower, desk: demo.desk.owner, agent: demo.desk.collateral?.agent })
/** Every LoanBroker the desk lends from: desk, spare and, when it is baked, the dollar pool (the signer's set). */
const deskBrokersOf = (demo) => [demo.desk.loanBrokerId, demo.spare.loanBrokerId, demo.usd?.loanBrokerId].filter(Boolean)

/** readTicketInputs reads conduct through accountTxWindow; a bare { req } client gets it here, through req. */
function asXrpl(client) {
  if (typeof client.accountTxWindow === 'function') return client
  return {
    req: (p) => client.req(p),
    async accountTxWindow(account, { limit = 200, maxPages = 5 } = {}) {
      const transactions = []
      let marker
      let ledgerMin = null
      let ledgerMax = null
      for (let page = 0; page < maxPages; page++) {
        const r = await client.req({ command: 'account_tx', account, limit, ledger_index_min: -1, ledger_index_max: -1, ...(marker && { marker }) })
        transactions.push(...(r.result.transactions ?? []))
        const lo = r.result.ledger_index_min
        const hi = r.result.ledger_index_max
        if (Number.isInteger(lo)) ledgerMin = Math.max(ledgerMin ?? lo, lo)
        if (Number.isInteger(hi)) ledgerMax = Math.min(ledgerMax ?? hi, hi)
        marker = r.result.marker
        if (!marker) break
      }
      return { transactions, ledgerMin, ledgerMax, truncated: Boolean(marker) }
    },
  }
}

// --- the agent CLI -------------------------------------------------------------------------------------------

/** The agent's and the counterparty's keys, from ROLES_FILE (the desk falls back to DESK_SEED). --submit only. */
function walletsFromRoles(decision, env = process.env) {
  if (!env.ROLES_FILE) throw new Unreadable('ROLES_FILE is not set; nothing was signed')
  let accounts
  try {
    accounts = JSON.parse(readFileSync(env.ROLES_FILE, 'utf8')).accounts ?? {}
  } catch (e) {
    throw new Unreadable(`ROLES_FILE is unreadable (${e?.code ?? e?.name}); nothing was signed`) // never the message: it may quote the file
  }
  const fromSeed = (seed) => (typeof seed === 'string' ? Wallet.fromSeed(seed) : null)
  const agent = fromSeed(accounts.agent?.seed)
  const counterparty = decision === 'to-desk' ? fromSeed(accounts.deskOwner?.seed ?? env.DESK_SEED) : fromSeed(accounts.borrower?.seed)
  return { agent, counterparty }
}

/** Submit a multi-signed blob, then follow it by hash until validated (60 s). */
async function submitAndWait(client, blob) {
  const txHash = hashes.hashSignedTx(blob)
  const r = await client.req({ command: 'submit', tx_blob: blob })
  const prelim = r.result.engine_result
  if (/^(tem|tef|tel)/.test(prelim)) return { txHash, engineResult: prelim, ledgerIndex: null }
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const v = await lookupTx(client, txHash)
    if (v?.validated) return { txHash, engineResult: v.meta?.TransactionResult ?? null, ledgerIndex: v.ledger_index ?? null }
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`the release ${txHash} was not seen validated within 60 s`)
}

/**
 * The agent, its core with every dependency injected (the self-test runs it on the fake client). Without
 * submit: reads at the validated ledger, prints the decision and its reason and nothing else, writes
 * nothing. With submit: builds the Payment of all shares, autofill(tx, 2), guardCosign, signs with the
 * agent's key and the counterparty's, multisign, submits, and chains the decision (none included) into
 * releasesPath. Returns the exit code.
 * @param {{ client: any, account: string, submit?: boolean, demo: any, releasesPath?: string, autofill?: (tx: any, n: number) => Promise<any>, loadWallets?: (decision: string) => { agent: any, counterparty: any }, submitBlob?: (blob: string) => Promise<{ txHash: string, engineResult: string|null, ledgerIndex: number|null }>, out?: (line: string) => void, log?: any }} o
 * @returns {Promise<0|1|2>}
 */
export async function runRelease({ client, account, submit = false, demo, releasesPath = releasesPathOf(), autofill, loadWallets = walletsFromRoles, submitBlob, out = (l) => console.log(l), log: lg = log }) {
  const roles = rolesOf(demo)
  let L
  let state
  let share = null
  try {
    if (!roles.borrower || !roles.desk || !roles.agent) throw new Unreadable('demo/desk.json names no borrower, desk or agent')
    L = await headerOf(client, 'validated')
    for (const [key, list] of Object.entries(demo.desk.collateral?.accounts ?? {})) if (Array.isArray(list) && list.includes(account)) share = upper(demo.shares[key])
    if (!share) {
      // an account created at the pledge (pool exhausted): its one MPToken names the share
      const r = await client.req({ command: 'account_objects', account, type: 'mptoken', ledger_index: L.ledgerIndex })
      const tokens = (r.result.account_objects ?? []).filter((o) => o.LedgerEntryType === 'MPToken')
      if (tokens.length !== 1) throw new Unreadable(`the share of ${account} cannot be told: it is in no pool of demo/desk.json and holds ${tokens.length} MPTokens`)
      share = upper(tokens[0].MPTokenIssuanceID)
    }
    state = await readReleaseState(client, { account, shareMptId: share, roles, deskBrokers: deskBrokersOf(demo), at: L })
  } catch (e) {
    out(`none: ${e instanceof Unreadable ? e.message : `a read failed (${String(e?.data?.error ?? e?.message ?? e).slice(0, 120)})`}; no decision`)
    return 2
  }
  if (state.args.incomplete) {
    out(`none: ${state.args.incomplete}`)
    return 2
  }
  const d = decideRelease(state.args)
  out(`${d.decision}: ${d.reason}`)
  if (!submit) return d.decision === 'none' ? 1 : 0

  const journal = (decision, txHash) => appendRelease(releasesPath, {
    account, escrowIndex: d.escrowIndex, loanId: d.loanId, loanState: d.loanState, decision, ledgerIndex: L.ledgerIndex, ledgerHash: L.ledgerHash, txHash: txHash ?? null,
  })
  if (d.decision === 'none') {
    journal('none', null)
    return 1
  }
  const target = d.decision === 'to-desk' ? roles.desk : roles.borrower
  autofill ??= (tx, n) => client.client.autofill(tx, n)
  submitBlob ??= (blob) => submitAndWait(client, blob)
  let tx
  let baseFee
  try {
    tx = await autofill({ TransactionType: 'Payment', Account: account, Destination: target, Amount: { mpt_issuance_id: share, value: state.collateral.sharesHeld } }, 2)
    baseFee = await readBaseFee(client, L.ledgerIndex)
  } catch (e) {
    out(`not signed: the release could not be prepared (${String(e?.data?.error ?? e?.message ?? e).slice(0, 120)})`)
    return 2
  }
  const g = guardCosign(tx, { decision: d.decision, account, desk: roles.desk, borrower: roles.borrower, shareMptId: share, sharesHeld: state.collateral.sharesHeld, baseFee })
  if (!g.ok) {
    out(`not signed: the guard refuses the release (${g.reason})`)
    journal(d.decision, null)
    return 1
  }
  let wallets
  try {
    wallets = loadWallets(d.decision)
  } catch (e) {
    out(`not signed: ${e instanceof Unreadable ? e.message : 'the keys could not be loaded'}`)
    return 2
  }
  const counterparty = d.decision === 'to-desk' ? roles.desk : roles.borrower
  if (wallets?.agent?.address !== roles.agent || wallets?.counterparty?.address !== counterparty) {
    out('not signed: the keys loaded are not those of the agent and the counterparty of the signer list')
    return 2
  }
  const blob = multisign([wallets.agent.sign(tx, true).tx_blob, wallets.counterparty.sign(tx, true).tx_blob])
  let sent
  try {
    sent = await submitBlob(blob)
  } catch (e) {
    const txHash = hashes.hashSignedTx(blob)
    journal(d.decision, txHash)
    out(`submitted ${txHash}: not confirmed (${String(e?.message ?? e).slice(0, 120)})`)
    return 2
  }
  journal(d.decision, sent.txHash)
  lg.info('release submitted', { account, decision: d.decision, txHash: sent.txHash, engineResult: sent.engineResult, ledgerIndex: L.ledgerIndex })
  out(`submitted ${sent.txHash}: ${sent.engineResult}`)
  return sent.engineResult === 'tesSUCCESS' ? 0 : 1
}

// --- the auditor ---------------------------------------------------------------------------------------------

async function fetchJsonDefault(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/**
 * The auditor (A4, "verifiable by others"): no key, read-only. Reads the decision log from the API, the
 * collateral accounts of the pools and those the approved entries name, and the ledger, then checks I1 to
 * I3 and I7 (§13). Returns { code, lines, violations, notes, unreadable, stages }; code 0 without
 * violation, 1 on a violation, 2 when a read is impossible.
 * @param {{ client: { req: (p: any) => Promise<any> }, fetchJson?: (url: string) => Promise<any>, demo: any, apiBase?: string, releasesPath?: string|null, readFile?: (p: string) => string, disable?: Set<string> }} o
 */
export async function audit({ client, fetchJson = fetchJsonDefault, demo, apiBase = DEFAULT_API_BASE, releasesPath = null, readFile = (p) => readFileSync(p, 'utf8'), disable = new Set() }) {
  const violations = []
  const notes = []
  const unreadable = []
  const stages = {}
  const off = (rule) => disable.has(rule)
  const violate = (rule, invariant, object, ledger, sentence) => {
    if (!off(rule)) violations.push({ rule, invariant, object, ledger, sentence })
  }
  const note = (object, ledger, sentence) => notes.push({ object, ledger, sentence })
  const cannot = (object, e) => unreadable.push({ object, sentence: e instanceof Unreadable ? e.message : `a read failed: ${String(e?.data?.error ?? e?.message ?? e).slice(0, 160)}` })
  const finish = () => {
    const lines = [
      ...violations.map((v) => `VIOLATION ${v.invariant} ${v.object} ledger ${v.ledger ?? '-'}: ${v.sentence}`),
      ...notes.map((n) => `note ${n.object} ledger ${n.ledger ?? '-'}: ${n.sentence}`),
      ...unreadable.map((u) => `UNREADABLE ${u.object}: ${u.sentence}`),
    ]
    return { code: unreadable.length ? 2 : violations.length ? 1 : 0, lines, violations, notes, unreadable, stages }
  }

  // the log, from the API; its chain recomputed here, never the server's `chain`
  const base = String(apiBase).replace(/\/+$/, '')
  let body
  try {
    body = await fetchJson(`${base}/api/desk/decisions`)
  } catch (e) {
    cannot('decision log', new Unreadable(`GET ${base}/api/desk/decisions failed (${String(e?.message ?? e).slice(0, 120)})`))
    return finish()
  }
  const entries = Array.isArray(body?.entries) ? body.entries : null
  if (!entries) {
    cannot('decision log', new Unreadable(`GET ${base}/api/desk/decisions did not return { entries }`))
    return finish()
  }
  const { desk, spare, mandate, shares, reader, usd = null } = demo
  if (mandateHash(mandate) !== mandate.hash) {
    cannot('mandate', new Unreadable(`the mandate ${mandate.id} does not hash to its own hash; no ticket can be recomputed against it`))
    return finish()
  }
  const roles = rolesOf(demo)
  const deskBrokers = deskBrokersOf(demo)
  const bad = firstBadLink(entries)
  if (bad) violate('chain', 'I2', `decision log seq ${bad.seq}`, bad.ledger, `the decision log chain breaks at entry ${bad.seq}: the entry or the one before it was altered`)

  const headers = new Map()
  const header = async (n) => {
    if (!headers.has(n)) headers.set(n, await headerOf(client, n))
    return headers.get(n)
  }

  /** collateral account → its share */
  const accounts = new Map()
  for (const [key, list] of Object.entries(desk.collateral?.accounts ?? {})) for (const a of list ?? []) accounts.set(a, upper(shares[key]))
  /** the entries judged as approved: { seq, ticketId, txHash, broker, validatedAt } */
  const judged = []
  const escrowUse = new Map()

  async function judgeApproved(e, h, t) {
    const object = `entry seq ${e.seq}`
    if (!t || !t.validated) {
      if (off('approvedTxFound')) return
      throw new Unreadable(`approved entry ${e.seq}: its LoanSet ${e.txHash} is ${t ? 'not validated' : 'not found'} on this node`)
    }
    const tx = txOf(t)
    const V = ledgerOfEntry(t)
    const result = resultOf(t)
    if (tx.TransactionType !== 'LoanSet') {
      violate('loanSetType', 'I2', object, e.ledgerIndex, `the transaction ${e.txHash} is a ${tx.TransactionType}, not a LoanSet`)
      return
    }
    const ticketMemo = memoOf(tx, MEMO_TICKET)
    if (!same(ticketMemo, e.ticketId)) violate('memoTicket', 'I2', object, e.ledgerIndex, `the LoanSet's orma.ticket Memo ${ticketMemo ?? 'is absent and'} does not match the entry's ticketId ${e.ticketId}`)
    judged.push({ seq: e.seq, ticketId: upper(e.ticketId), txHash: upper(e.txHash), broker: upper(tx.LoanBrokerID), validatedAt: V })
    if (e.mandateHash !== mandate.hash) note(object, e.ledgerIndex, `decided under the mandate hash ${e.mandateHash}, not ${mandate.hash}; its ticket is recomputed under the published mandate`)
    if (result !== 'tesSUCCESS') {
      note(object, V, `approved, but its LoanSet ${e.txHash} ended ${result}: no loan was created, the entry is not counted`)
      return
    }
    const escrowIndex = memoOf(tx, MEMO_ESCROW)
    if (!escrowIndex) {
      violate('memoEscrow', 'I2', object, e.ledgerIndex, 'the LoanSet names no escrow in an orma.escrow Memo')
      return
    }
    escrowUse.set(escrowIndex, [...(escrowUse.get(escrowIndex) ?? []), e.seq])
    const L = h.ledgerIndex
    const escrow = await entryAt(client, { index: escrowIndex }, L)
    if (!escrow) {
      violate('escrowExists', 'I2', object, L, `the escrow ${escrowIndex} the LoanSet names did not exist at the ledger of the decision`)
      return
    }
    if (escrow.Account !== tx.Account) violate('escrowOwner', 'I2', object, L, `the escrow ${escrowIndex} belongs to ${escrow.Account}, not to the borrower ${tx.Account}`)
    if (!isMpt(escrow.Amount)) {
      violate('escrowShares', 'I2', object, L, `the escrow ${escrowIndex} does not hold MPT shares`)
      return
    }
    const share = upper(escrow.Amount.mpt_issuance_id)
    const units = String(escrow.Amount.value)
    if (!accounts.has(escrow.Destination)) accounts.set(escrow.Destination, share)
    if (escrow.Condition) violate('escrowCondition', 'I2', object, L, 'escrow carries a crypto-condition')
    // the escrow rule of §4, at the ledger of the decision (the date rule of src/desk/signer.mjs review())
    const policy = mandate.policy
    const close = num(h.closeTime)
    const pi = num(tx.PaymentInterval)
    const gp = num(tx.GracePeriod)
    const total = num(tx.PaymentTotal ?? 1)
    const finishAt = num(escrow.FinishAfter)
    const cancel = num(escrow.CancelAfter)
    if (finishAt.lt(close.plus(pi).plus(gp).plus(policy.approvalSlackSeconds))) violate('dateFloor', 'I2', object, L, 'escrow can be finished before the loan can default')
    if (finishAt.gt(close.plus(pi).plus(gp).plus(policy.finishAfterMarginSeconds))) violate('dateCeiling', 'I2', object, L, 'escrow finishes later than the policy allows')
    if (!cancel.minus(finishAt).eq(policy.cancelAfterOffsetSeconds)) violate('dateOffset', 'I2', object, L, `escrow can be cancelled ${cancel.minus(finishAt).toFixed()} s after FinishAfter, not the policy's ${policy.cancelAfterOffsetSeconds} s`)
    if (cancel.lt(close.plus(pi.times(total)).plus(gp).plus(policy.approvalSlackSeconds))) violate('dateMaturity', 'I2', object, L, 'loan matures after the escrow can be cancelled')
    const read = await readCollateralAccount(client, { address: escrow.Destination, shareMptId: share, at: h, borrower: tx.Account, desk: desk.owner, agent: roles.agent, namedEscrow: escrowIndex })
    if (!read.conforming) violate('entryAccountPledged', 'I2', object, L, `the escrow pays into ${escrow.Destination}, which did not conform as pledged: ${read.reasons.join('; ')}`)
    const tracked = reader.getByShareMpt(share)
    if (!tracked) {
      violate('shareEligible', 'I2', object, L, `the pledged share ${share} is not a share of a vault the desk tracks`)
      return
    }
    const vault = (await client.req({ command: 'vault_info', vault_id: tracked.vaultId, ledger_index: L })).result.vault
    const issuance = await entryAt(client, { mpt_issuance: share }, L)
    const mptoken = await entryAt(client, { mptoken: { mpt_issuance_id: share, account: tx.Account } }, L)
    const eligible = judgeCollateralShare({ vault, issuance, mptoken })
    if (!eligible.eligible) violate('shareEligible', 'I2', object, L, `the pledged share is not eligible as collateral: ${eligible.reasons.join('; ')}`)
    // step 21: a dollar loan's PrincipalRequested is dollars, not drops; this auditor reads no XRP/USD oracle,
    // so it says the dollar ticket was not recomputed rather than pass it on a figure in the wrong unit
    if (usd?.loanBrokerId && same(tx.LoanBrokerID, usd.loanBrokerId)) {
      note(object, L, `USD loan on the dollar pool's LoanBroker ${upper(usd.loanBrokerId)}: its dollar ticket is not recomputed by this auditor (no XRP/USD oracle read), so ticketPass is not judged`)
      return
    }
    try {
      const inputs = await readTicketInputs(asXrpl(client), { shareMptId: share, reader, at: h })
      const ticket = buildTicket(inputs, { op: 'pledge', units, mandate, principalDrops: String(tx.PrincipalRequested) })
      if (ticket.verdict.status !== 'PASS') {
        violate('ticketPass', 'I2', object, L, `the ticket recomputed at this ledger is ${ticket.verdict.status} under the mandate ${mandate.id} (${(ticket.verdict.breaches ?? []).map((b) => `${b.limit} ${b.value} over ${b.threshold}`).join('; ')})`)
      }
    } catch (err) {
      if (err instanceof SnapshotError) violate('snapshot', 'I7', object, L, `the snapshot read at this ledger is inconsistent (${err.violations.map((v) => `${v.rule}: ${v.detail}`).join('; ')})`)
      else if (err instanceof ShareNotTrackedError) violate('shareEligible', 'I2', object, L, err.message)
      else throw err
    }
  }

  for (const e of entries) {
    const object = `entry seq ${e?.seq}`
    try {
      if (!isPlain(e) || !Number.isSafeInteger(e.ledgerIndex)) throw new Unreadable('the entry carries no ledgerIndex')
      const h = await header(e.ledgerIndex)
      if (!same(h.ledgerHash, e.ledgerHash)) violate('ledgerHash', 'I1', object, e.ledgerIndex, `the entry's ledgerHash ${e.ledgerHash} is not the hash ${h.ledgerHash} of ledger ${e.ledgerIndex}`)
      if (e.decision === 'approved') await judgeApproved(e, h, await lookupTx(client, e.txHash))
      else if (e.decision === 'refused' && e.code === 'SUBMIT_UNCONFIRMED' && e.txHash) {
        const t = await lookupTx(client, e.txHash)
        if (t?.validated) {
          if (!off('unconfirmedJudged')) await judgeApproved(e, h, t)
        } else if (off('unconfirmedNote')) throw new Unreadable(`refused SUBMIT_UNCONFIRMED: its LoanSet ${e.txHash} is not found`)
        else note(object, e.ledgerIndex, `refused SUBMIT_UNCONFIRMED: its LoanSet ${e.txHash} is not on a validated ledger of this node, nothing was countersigned on the ledger`)
      }
    } catch (err) {
      cannot(object, err)
    }
  }

  // no escrow backs two approved entries (I2, the link 1:0..1)
  for (const [index, seqs] of escrowUse) {
    if (seqs.length > 1) violate('escrowUnique', 'I2', `escrow ${index}`, null, `the escrow backs ${seqs.length} approved entries (seq ${seqs.join(', ')}): the link 1:0..1 is broken`)
  }

  // no countersignature outside the log (I2): every validated LoanSet on a broker the log names, in its window
  if (judged.length) {
    const from = entries[0]?.ledgerIndex
    const to = Math.max(...judged.map((j) => j.validatedAt).filter(Number.isSafeInteger))
    const ticketIds = new Set(entries.filter((x) => x?.decision === 'approved').map((x) => upper(x.ticketId)).concat(judged.map((j) => j.ticketId)))
    const txHashes = new Set(entries.filter((x) => x?.decision === 'approved').map((x) => upper(x.txHash)).concat(judged.map((j) => j.txHash)))
    const ownerOf = new Map([[upper(desk.loanBrokerId), desk.owner], [upper(spare.loanBrokerId), spare.owner], ...(usd?.loanBrokerId && usd.owner ? [[upper(usd.loanBrokerId), usd.owner]] : [])])
    for (const broker of new Set(judged.map((j) => j.broker).filter(Boolean))) {
      try {
        let owner = ownerOf.get(broker)
        if (!owner) {
          const node = await entryAt(client, { index: broker }, to)
          if (!node?.Owner) throw new Unreadable(`the LoanBroker ${broker} cannot be read at ledger ${to}`)
          owner = node.Owner
        }
        const hist = await historyOf(client, owner, to)
        if (hist.refused) throw new Unreadable(hist.refused)
        if (!Number.isSafeInteger(hist.ledgerMin) || hist.ledgerMin > from) throw new Unreadable(`the history of ${owner} on this node starts at ledger ${hist.ledgerMin ?? 'unknown'}, after the first entry's ledger ${from}`)
        for (const x of hist.txs) {
          const t = txOf(x)
          const V = ledgerOfEntry(x)
          if (t.TransactionType !== 'LoanSet' || !same(t.LoanBrokerID, broker) || V === null || V < from || V > to || x.validated === false) continue
          const hash = hashOfEntry(x)
          const memo = memoOf(t, MEMO_TICKET)
          if (txHashes.has(hash) || (memo && ticketIds.has(memo))) continue
          violate('coverage', 'I2', `LoanSet ${hash}`, V, `a LoanSet on the desk's LoanBroker ${broker} has no approved entry of its ticketId ${memo ?? '(no orma.ticket Memo)'}: a countersignature outside the log`)
        }
      } catch (err) {
        cannot(`LoanBroker ${broker}`, err)
      }
    }
  }

  // every collateral account: conformity at its state, and its whole history since its creation (I3)
  async function auditAccount(address, share, tip) {
    const object = `collateral account ${address}`
    const { borrower, desk: deskAddress, agent } = roles
    const hist = await historyOf(client, address, tip.ledgerIndex)
    if (hist.refused) throw new Unreadable(hist.refused)
    const read = await readCollateralAccount(client, { address, shareMptId: share, at: tip, borrower, desk: deskAddress, agent, ...COLLATERAL_STAGES.structural, history: true })
    const stage = collateralStageOf({ escrows: read.raw.escrows, mptoken: read.raw.mptoken, pledges: read.pledges ?? [] }, { borrower, shareMptId: share })
    stages[address] = stage.stage
    const judgedNow = judgeCollateralAccount(read.raw, { borrower, desk: deskAddress, agent, shareMptId: share, ...COLLATERAL_STAGES[stage.stage], namedEscrow: stage.namedEscrow })
    if (!judgedNow.conforming) violate('accountConforms', 'I3', object, tip.ledgerIndex, `at the last validated ledger the account does not conform as ${stage.stage}: ${judgedNow.reasons.join('; ')}`)
    const txs = [...hist.txs].sort(ascending)
    const creator = txs.find((x) => resultOf(x) === 'tesSUCCESS' && nodesOf(x).some((n) => n?.CreatedNode?.LedgerEntryType === 'AccountRoot' && n.CreatedNode.NewFields?.Account === address))
    if (!creator) {
      if (!off('creatorPayment')) throw new Unreadable(`the history of ${address} on this node (from ledger ${hist.ledgerMin ?? 'unknown'}) does not reach back to the Payment that created it`)
    } else {
      const ct = txOf(creator)
      if (ct.TransactionType !== 'Payment' || ct.Account !== deskAddress) violate('creatorFromDesk', 'I3', object, ledgerOfEntry(creator), `the account was created by a ${ct.TransactionType} from ${ct.Account}, not by a Payment from the desk owner ${deskAddress}`)
    }
    let disabled = false
    for (const x of txs) {
      const t = txOf(x)
      if (t.Account !== address) continue
      const V = ledgerOfEntry(x)
      const hash = hashOfEntry(x)
      const disables = t.TransactionType === 'AccountSet' && t.SetFlag === ASF_DISABLE_MASTER && t.ClearFlag === undefined
      if (!disabled) {
        if (!(t.TransactionType === 'SignerListSet' || t.TransactionType === 'MPTokenAuthorize' || disables)) {
          violate('beforeDisable', 'I3', object, V, `before its master key was disabled, the account signed a ${t.TransactionType} (${hash}); only SignerListSet, MPTokenAuthorize and the AccountSet asfDisableMaster are allowed`)
        }
        if (disables && resultOf(x) === 'tesSUCCESS') disabled = true
        continue
      }
      const signers = (Array.isArray(t.Signers) ? t.Signers : []).map((s) => s?.Signer?.Account).filter(Boolean)
      if (signers.includes(agent)) {
        await judgeAgentCosigned({ address, share, t, V, hash, object })
      } else if (signers.length && !off('consentedNote')) {
        note(object, V, `consented exit by desk and borrower: the ${t.TransactionType} ${hash}, signed by ${signers.join(', ')} without the Orma agent`)
      } else {
        violate('afterDisable', 'I3', object, V, signers.length
          ? `after its master key was disabled, the account signed a ${t.TransactionType} (${hash}) without the agent, which the guard does not accept`
          : `after its master key was disabled, the account is the Account of a ${t.TransactionType} (${hash}) its signer list did not sign`)
      }
    }
  }

  async function judgeAgentCosigned({ address, share, t, V, hash, object }) {
    const ntx = off('normaliseV2') ? { ...t } : normaliseHistoryTx(t)
    const ctx = { account: address, desk: roles.desk, borrower: roles.borrower, shareMptId: share }
    if (ntx.TransactionType !== 'Payment') {
      const g = guardCosign(ntx, { ...ctx, decision: 'none', sharesHeld: '0', baseFee: null })
      violate('agentCosign', 'I3', object, V, `the Orma agent co-signed a ${ntx.TransactionType} (${hash}): ${g.ok ? 'accepted' : g.reason}`)
      return
    }
    if (!Number.isSafeInteger(V) || V < 2) throw new Unreadable(`the release ${hash} has no validation ledger`)
    const prev = await header(V - 1)
    const state = await readReleaseState(client, { account: address, shareMptId: share, roles, deskBrokers, at: prev, partialOk: off('releaseHistory') })
    if (state.args.incomplete) throw new Unreadable(`the release ${hash} at ledger ${V} cannot be judged: ${state.args.incomplete}`)
    const d = decideRelease(state.args)
    const baseFee = await readBaseFee(client, V - 1)
    const g = guardCosign(ntx, { ...ctx, decision: d.decision, sharesHeld: state.collateral.sharesHeld, baseFee })
    if (!g.ok) violate('agentCosign', 'I3', object, V, `the Orma agent co-signed the Payment ${hash}, which the guard refuses under the decision ${d.decision} at ledger ${V - 1} (${d.reason}): ${g.reason}`)
  }

  let tip = null
  try {
    tip = await headerOf(client, 'validated')
  } catch (err) {
    cannot('validated ledger', err)
  }
  if (tip) {
    for (const [address, share] of accounts) {
      try {
        await auditAccount(address, share, tip)
      } catch (err) {
        cannot(`collateral account ${address}`, err)
      }
    }
  }

  if (releasesPath) {
    try {
      const lines = parseLines(readFile(releasesPath))
      const broken = firstBadLink(lines)
      if (broken) violate('releasesChain', 'I3', `agent-releases seq ${broken.seq}`, broken.ledger, `the agent-releases.jsonl chain breaks at entry ${broken.seq}`)
    } catch (err) {
      cannot(`releases ${releasesPath}`, err instanceof Unreadable ? err : new Unreadable(`${releasesPath} cannot be read (${err?.code ?? err?.name})`))
    }
  }
  return finish()
}

// =============================================================================================================
// --- self-test (offline, fake client) ------------------------------------------------------------------------
// =============================================================================================================

/** Every fake ledger of the self-test, so that the last check reads all their commands. */
const FAKES = []
const CT = 846200000
const closeOf = (n) => CT + n * 4
const hashOfLedger = (n) => n.toString(16).toUpperCase().padStart(64, '0')
const hex64 = (s) => s.repeat(64).slice(0, 64).toUpperCase()
const hexText = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
let txCounter = 0
const nextTxHash = () => (0xf00000 + ++txCounter).toString(16).toUpperCase().padStart(64, '0')

/** An account_tx or tx entry in the API v2 shape: Payment with DeliverMax, ctid, date and ledger_index in tx_json. */
function entryV2({ hash, ledger, index = 0, tx, result = 'tesSUCCESS', nodes = [] }) {
  const t = { ...tx }
  if (t.TransactionType === 'Payment' && t.Amount !== undefined) {
    t.DeliverMax = t.Amount
    delete t.Amount
  }
  const ctid = `C${ledger.toString(16).padStart(7, '0')}${index.toString(16).padStart(4, '0')}0002`.toUpperCase()
  return {
    hash, ledger_index: ledger, validated: true, close_time_iso: new Date((closeOf(ledger) + 946684800) * 1000).toISOString(),
    meta: { TransactionIndex: index, TransactionResult: result, AffectedNodes: nodes },
    tx_json: { ...t, ctid, date: closeOf(ledger), ledger_index: ledger },
  }
}

/**
 * A fake rippled with versioned objects (each key holds versions from a ledger on; a null node is
 * deleted), a transaction list served by account_tx and tx in the v2 shape, ledgers that can be missing,
 * per-account history floors and page sizes. Every command is recorded; submit, submit_multisigned and
 * sign are refused (and recorded, which the last check reads).
 */
function fakeLedger(tip = 300) {
  const err = (error) => Object.assign(new Error(error), { data: { error } })
  const f = {
    tip, commands: [], versions: new Map(), txs: [], loanSeq: new Map(), missing: new Set(), floors: new Map(), pageSize: new Map(), unvalidated: new Set(), perLedger: new Map(),
    put(key, from, node, owners = []) {
      const list = f.versions.get(key) ?? []
      list.push({ from, node, owners })
      list.sort((a, b) => a.from - b.from)
      f.versions.set(key, list)
    },
    version(key, L) {
      let v = null
      for (const x of f.versions.get(key) ?? []) if (x.from <= L) v = x
      return v
    },
    node: (key, L) => f.version(key, L)?.node ?? null,
    addTx({ ledger, tx, result = 'tesSUCCESS', nodes = [], accounts }) {
      const index = f.perLedger.get(ledger) ?? 0
      f.perLedger.set(ledger, index + 1)
      const hash = nextTxHash()
      f.txs.push({ hash, ledger, index, tx, result, nodes, accounts })
      return hash
    },
    async req(p) {
      f.commands.push(p.command)
      if (['submit', 'submit_multisigned', 'sign', 'sign_for'].includes(p.command)) throw new Error(`fake rippled refuses ${p.command}`)
      const at = p.ledger_index === undefined || p.ledger_index === 'validated' || p.ledger_index === 'current' ? f.tip : p.ledger_index
      const gone = (L) => {
        if (f.missing.has(L)) throw err('lgrNotFound')
      }
      switch (p.command) {
        case 'ledger':
          gone(at)
          return { result: { ledger_index: at, ledger_hash: hashOfLedger(at), validated: true, ledger: { ledger_index: at, ledger_hash: hashOfLedger(at), close_time: closeOf(at) } } }
        case 'ledger_entry': {
          gone(at)
          let key = null
          if (p.index) key = `idx:${upper(p.index)}`
          else if (p.mptoken) key = `mpt:${upper(p.mptoken.mpt_issuance_id)}:${p.mptoken.account}`
          else if (p.mpt_issuance) key = `iss:${upper(p.mpt_issuance)}`
          else if (p.deposit_preauth) key = `preauth:${p.deposit_preauth.owner}:${p.deposit_preauth.authorized}`
          else if (p.loan) {
            const id = f.loanSeq.get(`${upper(p.loan.loan_broker_id)}:${p.loan.loan_seq}`)
            key = id ? `idx:${id}` : null
          }
          const node = key ? f.node(key, at) : null
          if (!node) throw err('entryNotFound')
          return { result: { node, index: node.index, ledger_index: at, validated: true } }
        }
        case 'account_info': {
          gone(at)
          const root = f.node(`root:${p.account}`, at)
          if (!root) throw err('actNotFound')
          const sl = f.node(`signers:${p.account}`, at)
          return { result: { account_data: root, ...(p.signer_lists && { signer_lists: sl ? [sl] : [] }), ledger_index: at, validated: true } }
        }
        case 'account_objects': {
          gone(at)
          const types = { loan_broker: 'LoanBroker', mptoken: 'MPToken', escrow: 'Escrow' }
          const list = []
          for (const key of f.versions.keys()) {
            const v = f.version(key, at)
            if (!v?.node || !v.owners.includes(p.account)) continue
            if (p.type && v.node.LedgerEntryType !== types[p.type]) continue
            list.push(v.node)
          }
          return { result: { account: p.account, account_objects: list, ledger_index: at, validated: true } }
        }
        case 'vault_info': {
          gone(at)
          const v = f.node(`vault:${upper(p.vault_id)}`, at)
          if (!v) throw err('entryNotFound')
          return { result: { vault: { ...v, shares: f.node(`iss:${upper(v.ShareMPTID)}`, at) }, ledger_index: at, validated: true } }
        }
        case 'account_tx': {
          const floor = f.floors.get(p.account) ?? 1
          const max = p.ledger_index_max === undefined || p.ledger_index_max === -1 ? f.tip : p.ledger_index_max
          const min = p.ledger_index_min === undefined || p.ledger_index_min === -1 ? floor : Math.max(floor, p.ledger_index_min)
          const list = f.txs.filter((r) => r.accounts.includes(p.account) && r.ledger >= min && r.ledger <= max)
            .sort((a, b) => b.ledger - a.ledger || b.index - a.index).map((r) => entryV2(r))
          const size = f.pageSize.get(p.account) ?? 200
          const start = p.marker?.start ?? 0
          return { result: { account: p.account, ledger_index_min: min, ledger_index_max: max, transactions: list.slice(start, start + size), ...(start + size < list.length && { marker: { start: start + size } }), validated: true } }
        }
        case 'tx': {
          const r = f.txs.find((x) => same(x.hash, p.transaction))
          if (!r) throw err('txnNotFound')
          return { result: { ...entryV2(r), validated: !f.unvalidated.has(r.hash) } }
        }
        default:
          throw new Error(`fake rippled: no ${p.command}`)
      }
    },
  }
  FAKES.push(f)
  return f
}

/** The fixed cast and objects of the self-test, built once. */
function fixtures() {
  const wallets = Object.fromEntries(['borrower', 'deskOwner', 'agent', 'brokerOwner', 'stranger', 'F1', 'F2', 'P', 'S', 'R', 'X'].map((r) => [r, Wallet.generate()]))
  const A = Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.address]))
  const PSEUDO = Wallet.generate().address
  const SHARE = issuanceIdOf({ Issuer: PSEUDO, Sequence: 1 })
  const OTHER_SHARE = issuanceIdOf({ Issuer: PSEUDO, Sequence: 2 })
  const POLICY = { escrowFinish: 'only-after-default', finishAfterMarginSeconds: 14400, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 }
  const mandateOf = (maxLtvBps) => {
    const m = { schema: 'orma.mandate/1', id: 'desk-1', desk: 'Test desk (fictional)', riskOfficer: A.stranger, limits: { maxLtvBps, maxSingleLoanDrops: '4000000', maxN2LossDrops: '100000000', maxLockupDays: 3650 }, policy: POLICY, issuedAt: '2026-10-24T14:00:00Z' }
    return { ...m, hash: mandateHash(m), anchorTx: hex64('8') }
  }
  return {
    wallets, A, PSEUDO, SHARE, OTHER_SHARE, POLICY,
    VAULT: hex64('A'), HARBOR_BROKER: hex64('B'), DESK_BROKER: hex64('D'), SPARE_BROKER: hex64('E'), OWN_BROKER: hex64('F'), HARBOR_LOAN: hex64('1'),
    LOAN_P: hex64('21'), LOAN_P2: hex64('22'), LOAN_R: hex64('23'), LOAN_X: hex64('24'), LOAN_Z: hex64('25'),
    T_P: hex64('31'), T_P2: hex64('32'), T_R: hex64('33'), T_X: hex64('34'), T_Z: hex64('35'), T_WRONG: hex64('36'),
    UNITS: '5000000', PI: 86400, GP: 3600, PASSING: mandateOf(6000), TIGHT: mandateOf(4000),
  }
}

/**
 * A conforming world: pool accounts F1 and F2 never used (free); S, whose pledge escrow was finished and
 * which holds the shares (structural); P, pledged and approved at 210 (its LoanSet on spare at 211);
 * R, pledged and approved at 230 (its LoanSet on desk at 231), its escrow finished at 240, its loan
 * defaulted at 250, its shares released to the desk at 260 by the agent and the desk. Options alter it.
 */
function world(T, o = {}) {
  const { A, SHARE, UNITS, PI, GP, POLICY } = T
  const f = fakeLedger(300)
  const mandate = o.mandate ?? T.PASSING
  const vault = { index: T.VAULT, LedgerEntryType: 'Vault', Account: T.PSEUDO, Owner: A.brokerOwner, ShareMPTID: SHARE, Asset: { currency: 'XRP' }, VaultKind: 1, LEVersion: 1, AssetsTotal: '50000000', AssetsAvailable: '35000000', LossUnrealized: '10000000', Scale: 0, RedemptionDate: CT + 30 * 86400 }
  f.put(`vault:${T.VAULT}`, 0, vault)
  if (o.i7) {
    f.put(`vault:${T.VAULT}`, 210, { ...vault, LossUnrealized: '15000001' })
    f.put(`vault:${T.VAULT}`, 211, vault)
  }
  f.put(`iss:${SHARE}`, 0, { LedgerEntryType: 'MPTokenIssuance', Issuer: T.PSEUDO, Sequence: 1, mpt_issuance_id: SHARE, OutstandingAmount: '50000000', Flags: 0x38 })
  f.put(`idx:${T.HARBOR_BROKER}`, 0, { LedgerEntryType: 'LoanBroker', index: T.HARBOR_BROKER, VaultID: T.VAULT, Owner: A.brokerOwner, LoanSequence: 2, DebtTotal: '15000000', CoverAvailable: '3000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000 }, [A.brokerOwner])
  f.loanSeq.set(`${T.HARBOR_BROKER}:1`, T.HARBOR_LOAN)
  f.put(`idx:${T.HARBOR_LOAN}`, 0, { LedgerEntryType: 'Loan', index: T.HARBOR_LOAN, LoanBrokerID: T.HARBOR_BROKER, LoanSequence: 1, Borrower: A.stranger, PrincipalOutstanding: '10000000', TotalValueOutstanding: '10000000', Flags: 0x00020000, NextPaymentDueDate: CT - 600, GracePeriod: 60 })
  f.put(`idx:${FEE_SETTINGS_INDEX}`, 0, { LedgerEntryType: 'FeeSettings', index: FEE_SETTINGS_INDEX, BaseFeeDrops: '10' })
  for (const who of ['deskOwner', 'borrower']) {
    f.put(`root:${A[who]}`, 0, { LedgerEntryType: 'AccountRoot', Account: A[who], Flags: 0, OwnerCount: 5, Sequence: 40 })
    f.put(`mpt:${SHARE}:${A[who]}`, 0, { LedgerEntryType: 'MPToken', Account: A[who], MPTokenIssuanceID: SHARE, MPTAmount: who === 'borrower' ? '30000000' : '0', Flags: 0 }, [A[who]])
  }
  const masterSigned = { Fee: '12', SigningPubKey: 'ED00', TxnSignature: 'AB' }
  const signerList = { LedgerEntryType: 'SignerList', SignerQuorum: 2, SignerEntries: [A.borrower, A.deskOwner, A.agent].map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })) }
  const multiSigned = (signers) => ({ Fee: '30', SigningPubKey: '', Signers: signers.map((a) => ({ Signer: { Account: a, SigningPubKey: 'ED00', TxnSignature: 'AB' } })) })
  const setShares = (addr, from, amount) => {
    const cur = f.version(`mpt:${SHARE}:${addr}`, from)
    f.put(`mpt:${SHARE}:${addr}`, from, { ...cur.node, MPTAmount: amount }, cur.owners)
  }
  const openAccount = (key, { at = 100, creator = A.deskOwner, disableAt = at + 3 } = {}) => {
    const addr = A[key]
    f.addTx({ ledger: at, tx: { TransactionType: 'Payment', Account: creator, Destination: addr, Amount: '2000000', Sequence: 1, ...masterSigned }, nodes: [{ CreatedNode: { LedgerEntryType: 'AccountRoot', LedgerIndex: hex64('0'), NewFields: { Account: addr, Balance: '2000000' } } }], accounts: [creator, addr] })
    const root = { LedgerEntryType: 'AccountRoot', Account: addr, Flags: 0, OwnerCount: 2, Sequence: 4, Balance: '2000000' }
    f.put(`root:${addr}`, at, root)
    f.put(`root:${addr}`, disableAt, { ...root, Flags: LSF_DISABLE_MASTER })
    f.put(`signers:${addr}`, at + 1, { ...signerList, index: hex64('5') }, [addr])
    f.addTx({ ledger: at + 1, tx: { TransactionType: 'SignerListSet', Account: addr, SignerQuorum: 2, SignerEntries: signerList.SignerEntries, Sequence: 1, ...masterSigned }, accounts: [addr] })
    f.put(`mpt:${SHARE}:${addr}`, at + 2, { LedgerEntryType: 'MPToken', index: hex64('6'), Account: addr, MPTokenIssuanceID: SHARE, MPTAmount: '0', Flags: 0 }, [addr])
    f.addTx({ ledger: at + 2, tx: { TransactionType: 'MPTokenAuthorize', Account: addr, MPTokenIssuanceID: SHARE, Sequence: 2, ...masterSigned }, accounts: [addr] })
    f.addTx({ ledger: disableAt, tx: { TransactionType: 'AccountSet', Account: addr, SetFlag: ASF_DISABLE_MASTER, Sequence: 3, ...masterSigned }, accounts: [addr] })
  }
  const pledge = (key, { at, seq, entryAt, owner = A.borrower, finishAfter, cancelAfter, condition }) => {
    const acct = A[key]
    const c = closeOf(entryAt)
    const FA = finishAfter ?? c - 60 + PI + GP + POLICY.finishAfterMarginSeconds
    const CA = cancelAfter ?? FA + POLICY.cancelAfterOffsetSeconds
    const index = hashes.hashEscrow(owner, seq).toUpperCase()
    const fields = { Account: owner, Destination: acct, Amount: { mpt_issuance_id: SHARE, value: UNITS }, FinishAfter: FA, CancelAfter: CA, ...(condition && { Condition: condition }) }
    f.addTx({ ledger: at, tx: { TransactionType: 'EscrowCreate', Sequence: seq, ...fields, ...masterSigned }, nodes: [{ CreatedNode: { LedgerEntryType: 'Escrow', LedgerIndex: index, NewFields: fields } }], accounts: [owner, acct] })
    f.put(`idx:${index}`, at, { LedgerEntryType: 'Escrow', index, ...fields }, [owner, acct])
    return index
  }
  const finishEscrow = (key, index, at) => {
    const cur = f.version(`idx:${index}`, at)
    f.put(`idx:${index}`, at, null, cur.owners)
    f.addTx({ ledger: at, tx: { TransactionType: 'EscrowFinish', Account: A.deskOwner, Owner: A.borrower, OfferSequence: 1, Sequence: 60, ...masterSigned }, nodes: [{ DeletedNode: { LedgerEntryType: 'Escrow', LedgerIndex: index } }], accounts: [A.borrower, A[key], A.deskOwner] })
    setShares(A[key], at, UNITS)
  }
  const loanSet = ({ at, broker, escrowIndex, ticketId, result = 'tesSUCCESS', loanId, paymentTotal = 1 }) => {
    const tes = result === 'tesSUCCESS'
    const tx = {
      TransactionType: 'LoanSet', Account: A.borrower, LoanBrokerID: broker, Counterparty: A.deskOwner, PrincipalRequested: '2000000', PaymentInterval: PI, GracePeriod: GP, PaymentTotal: paymentTotal,
      Memos: [{ Memo: { MemoType: hexText('orma.ticket'), MemoData: ticketId } }, { Memo: { MemoType: hexText('orma.escrow'), MemoData: escrowIndex } }], Sequence: 41, ...masterSigned,
    }
    const hash = f.addTx({ ledger: at, tx, result, nodes: tes ? [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: loanId, NewFields: { LoanBrokerID: broker, Borrower: A.borrower } } }] : [], accounts: [A.borrower, A.deskOwner] })
    if (tes) f.put(`idx:${loanId}`, at, { LedgerEntryType: 'Loan', index: loanId, LoanBrokerID: broker, Borrower: A.borrower, Flags: 0, PaymentRemaining: 1, PrincipalOutstanding: '2000000' })
    return hash
  }
  const multisignedBy = (key, at, tx, signers) => f.addTx({ ledger: at, tx: { Account: A[key], Sequence: 4, ...tx, ...multiSigned(signers) }, accounts: [A[key]] })

  const pool = ['F1', 'F2', 'P', 'S', 'R']
  for (const k of pool) openAccount(k, { creator: o.creator?.[k], disableAt: o.disableAt?.[k] })
  if (o.borrowerFiller) for (let i = 0; i < 55; i++) f.addTx({ ledger: 105 + i, tx: { TransactionType: 'Payment', Account: A.borrower, Destination: A.stranger, Amount: '1', Sequence: 100 + i, ...masterSigned }, accounts: [A.borrower, A.stranger] })
  // S: a pledge escrow finished at 160, the shares in the account
  finishEscrow('S', pledge('S', { at: 150, seq: 50, entryAt: 150 }), 160)
  // P: pledged at 200, approved at 210, its LoanSet on spare at 211
  const eP = pledge('P', { at: 200, seq: 60, entryAt: 210, owner: o.escrowOwnerP ? A.stranger : A.borrower, condition: o.conditionP, finishAfter: o.datesP?.(closeOf(210))?.finishAfter, cancelAfter: o.datesP?.(closeOf(210))?.cancelAfter })
  const lsP = loanSet({ at: 211, broker: T.SPARE_BROKER, escrowIndex: eP, ticketId: o.memoTicketP ?? T.T_P, result: o.tecP ? 'tecINSUFFICIENT_FUNDS' : 'tesSUCCESS', loanId: T.LOAN_P, paymentTotal: o.paymentTotalP ?? 1 })
  const bodies = [{ ticketId: hex64('41'), mandateHash: mandate.hash, decision: 'refused', code: 'BREACHED', ledgerIndex: 205, ledgerHash: hashOfLedger(205) }]
  bodies.push(o.unconfirmedP
    ? { ticketId: T.T_P, mandateHash: mandate.hash, decision: 'refused', code: 'SUBMIT_UNCONFIRMED', txHash: lsP, ledgerIndex: 210, ledgerHash: hashOfLedger(210) }
    : { ticketId: T.T_P, mandateHash: mandate.hash, decision: 'approved', txHash: o.pTxHash ?? lsP, ledgerIndex: 210, ledgerHash: hashOfLedger(210) })
  if (o.doubleEscrow) {
    const ls2 = loanSet({ at: 213, broker: T.SPARE_BROKER, escrowIndex: eP, ticketId: T.T_P2, loanId: T.LOAN_P2 })
    bodies.push({ ticketId: T.T_P2, mandateHash: mandate.hash, decision: 'approved', txHash: ls2, ledgerIndex: 212, ledgerHash: hashOfLedger(212) })
  }
  bodies.push({ ticketId: hex64('43'), mandateHash: mandate.hash, decision: 'declined', ledgerIndex: 215, ledgerHash: hashOfLedger(215) })
  if (o.extraUnconfirmed) bodies.push({ ticketId: hex64('44'), mandateHash: mandate.hash, decision: 'refused', code: 'SUBMIT_UNCONFIRMED', txHash: hex64('9'), ledgerIndex: 216, ledgerHash: hashOfLedger(216) })
  // R: pledged at 220, approved at 230, its LoanSet on desk at 231, finished at 240, defaulted at 250, released at 260
  const eR = pledge('R', { at: 220, seq: 70, entryAt: 230 })
  const lsR = loanSet({ at: 231, broker: T.DESK_BROKER, escrowIndex: eR, ticketId: T.T_R, loanId: T.LOAN_R })
  bodies.push({ ticketId: T.T_R, mandateHash: mandate.hash, decision: 'approved', txHash: lsR, ledgerIndex: 230, ledgerHash: hashOfLedger(230) })
  finishEscrow('R', eR, 240)
  if (!o.noDefault) {
    const loan = f.node(`idx:${T.LOAN_R}`, 240)
    f.put(`idx:${T.LOAN_R}`, 250, { ...loan, Flags: LSF_LOAN_DEFAULT })
    f.addTx({ ledger: 250, tx: { TransactionType: 'LoanManage', Account: A.deskOwner, LoanID: T.LOAN_R, Flags: 0x00010000, Sequence: 61, ...masterSigned }, accounts: [A.deskOwner, A.borrower] })
  }
  if (o.released !== false) {
    multisignedBy('R', 260, { TransactionType: 'Payment', Destination: A.deskOwner, Amount: { mpt_issuance_id: SHARE, value: UNITS }, Flags: 0 }, o.releaseSigners ?? [A.agent, A.deskOwner])
    f.txs.at(-1).accounts.push(A.deskOwner)
    setShares(A.R, 260, '0')
  }
  if (o.deskLoanSetNoEntry) loanSet({ at: 208, broker: T.SPARE_BROKER, escrowIndex: hex64('7'), ticketId: T.T_Z, loanId: T.LOAN_Z })
  if (o.delegateBeforeF1) f.addTx({ ledger: 102, tx: { TransactionType: 'DelegateSet', Account: A.F1, Authorize: A.stranger, Permissions: [{ Permission: { PermissionValue: 'Payment' } }], Sequence: 9, ...masterSigned }, accounts: [A.F1, A.stranger] })
  if (o.signerListAfterF2) multisignedBy('F2', 280, { TransactionType: 'SignerListSet', SignerQuorum: 1, SignerEntries: [{ SignerEntry: { Account: A.deskOwner, SignerWeight: 1 } }] }, [A.agent, A.deskOwner])
  if (o.outsider) {
    openAccount('X', { at: 270 })
    const eX = pledge('X', { at: 275, seq: 80, entryAt: 280 })
    const lsX = loanSet({ at: 281, broker: T.SPARE_BROKER, escrowIndex: eX, ticketId: T.T_X, loanId: T.LOAN_X })
    bodies.push({ ticketId: T.T_X, mandateHash: mandate.hash, decision: 'approved', txHash: lsX, ledgerIndex: 280, ledgerHash: hashOfLedger(280) })
    multisignedBy('X', 290, { TransactionType: 'SignerListSet', SignerQuorum: 1, SignerEntries: [{ SignerEntry: { Account: A.deskOwner, SignerWeight: 1 } }] }, [A.agent, A.deskOwner])
  }

  const demo = {
    desk: { owner: A.deskOwner, loanBrokerId: T.DESK_BROKER, collateral: { borrower: A.borrower, desk: A.deskOwner, agent: A.agent, quorum: 2, accounts: { 'harbor-1': pool.map((k) => A[k]) } } },
    spare: { owner: A.deskOwner, loanBrokerId: T.SPARE_BROKER },
    mandate, shares: { 'harbor-1': SHARE },
    reader: { getByShareMpt: (id) => (same(id, SHARE) ? { vaultId: T.VAULT } : null) },
  }
  const w = {
    f, demo, bodies, ids: { eP, eR, lsP, lsR }, apiDown: false, tamper: null,
    entries() {
      let prev = GENESIS
      let out = w.bodies.map((b, i) => {
        const body = { seq: i + 1, prevHash: prev, ...b }
        const e = { ...body, hash: sha256Hex(canonical(body)) }
        prev = e.hash
        return e
      })
      if (w.tamper) out = w.tamper(out)
      return out
    },
    async fetchJson(url) {
      if (w.apiDown) throw new Error('connect ECONNREFUSED')
      if (!url.endsWith('/api/desk/decisions')) throw new Error(`fake API: no ${url}`)
      return { entries: w.entries(), chain: { ok: true } } // the server's chain is always "ok": never trusted
    },
    audit: (opts = {}) => audit({ client: f, fetchJson: (u) => w.fetchJson(u), demo, apiBase: 'http://fake-api', ...opts }),
  }
  return w
}

/** The self-test: the cases of decideRelease, guardCosign, the auditor and the CLI, then R1 to R4. */
async function selfTest(argv) {
  const { forAll, seedFrom } = await import('../dev/property.mjs')
  const codec = await import('ripple-binary-codec')
  const TYPES = [...(codec.TRANSACTION_TYPES ?? codec.default?.TRANSACTION_TYPES ?? [])]
  const required = ['Payment', 'DelegateSet', 'EscrowCreate', 'Batch', 'CheckCreate', 'TicketCreate']
  if (!required.every((n) => TYPES.includes(n))) {
    console.log(`  FAIL TRANSACTION_TYPES lacks one of ${required.join(', ')}`)
    return 1
  }
  const seed = seedFrom(argv)
  console.log(`audit.mjs --self-test, seed ${seed} (replay: --seed ${seed})`)
  let bad = 0
  let count = 0
  const eq = (name, got, want) => {
    count++
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
    return ok
  }
  const T = fixtures()
  const { A, SHARE, OTHER_SHARE, UNITS } = T
  const DESK_BROKERS = [T.DESK_BROKER, T.SPARE_BROKER]
  const memos = (escrowIndex) => [{ Memo: { MemoType: hexText('orma.ticket'), MemoData: T.T_R } }, { Memo: { MemoType: hexText('orma.escrow'), MemoData: escrowIndex } }]

  // --- decideRelease, pure ---------------------------------------------------------------------------------
  console.log('decideRelease (§4, the agent\'s public rule)')
  const PA = A.R
  const escrowCreate = ({ from = A.borrower, seq = 70, amount = { mpt_issuance_id: SHARE, value: UNITS }, result = 'tesSUCCESS', ledger = 220 } = {}) => entryV2({ hash: nextTxHash(), ledger, tx: { TransactionType: 'EscrowCreate', Account: from, Sequence: seq, Destination: PA, Amount: amount }, result })
  const E70 = hashes.hashEscrow(A.borrower, 70).toUpperCase()
  const loanSetEntry = ({ broker = T.DESK_BROKER, escrow = E70, result = 'tesSUCCESS', loanId = T.LOAN_R, ledger = 231 } = {}) => entryV2({
    hash: nextTxHash(), ledger, tx: { TransactionType: 'LoanSet', Account: A.borrower, LoanBrokerID: broker, Memos: memos(escrow) }, result,
    nodes: result === 'tesSUCCESS' ? [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: loanId, NewFields: { LoanBrokerID: broker } } }] : [],
  })
  const loanNode = ({ id = T.LOAN_R, flags = LSF_LOAN_DEFAULT, remaining = 0 } = {}) => ({ LedgerEntryType: 'Loan', index: id, Flags: flags, PaymentRemaining: remaining })
  const deletedNode = ({ id = T.LOAN_R, flags = LSF_LOAN_DEFAULT, remaining = 0 } = {}) => ({ LedgerEntryType: 'Loan', LedgerIndex: id, FinalFields: { Flags: flags, PaymentRemaining: remaining } })
  const recipientOf = (address, { noToken = false, depositAuth = false, preauth = false } = {}) => ({
    address, accountRoot: { Account: address, Flags: depositAuth ? LSF_DEPOSIT_AUTH : 0 },
    mptoken: noToken ? null : { LedgerEntryType: 'MPToken', Account: address, MPTokenIssuanceID: SHARE, MPTAmount: '0' },
    depositPreauth: preauth ? { LedgerEntryType: 'DepositPreauth', Account: address, Authorize: PA } : null,
  })
  const collateralOf = ({ shares = UNITS, conforming = true } = {}) => ({ address: PA, signers: { borrower: A.borrower, desk: A.deskOwner, agent: A.agent }, sharesHeld: shares, conforming, reasons: conforming ? [] : ['master key enabled'] })
  const args = (o = {}) => ({
    account: PA, collateral: collateralOf(o), loan: 'loan' in o ? o.loan : loanNode(), deletedLoan: o.deletedLoan ?? null,
    escrowCreates: o.escrowCreates ?? [escrowCreate()], loanSets: o.loanSets ?? [loanSetEntry()], recipient: 'recipient' in o ? o.recipient : recipientOf(A.deskOwner), shareMptId: SHARE, deskBrokers: DESK_BROKERS,
  })
  const decide = (o, internal) => decideRelease(args(o), internal).decision
  eq('1  a defaulted loan, present → to-desk', decide({}), 'to-desk')
  eq('2  a defaulted loan, deleted (its DeletedNode carries lsfLoanDefault) → to-desk', decide({ loan: null, deletedLoan: deletedNode() }), 'to-desk')
  eq('3  a loan repaid, present → to-borrower', decide({ loan: loanNode({ flags: 0, remaining: 0 }), recipient: recipientOf(A.borrower) }), 'to-borrower')
  eq('4  a loan repaid, deleted → to-borrower', decide({ loan: null, deletedLoan: deletedNode({ flags: 0, remaining: 0 }), recipient: recipientOf(A.borrower) }), 'to-borrower')
  eq('5  an active loan → none', decide({ loan: loanNode({ flags: 0, remaining: 3 }) }), 'none')
  eq('6  an account that holds no shares → none', decide({ shares: '0' }), 'none')
  eq('7  an XRP escrow the borrower created to the account after the default → to-desk, the foreign escrow ignored', decide({ escrowCreates: [escrowCreate(), escrowCreate({ seq: 90, amount: '1', ledger: 255 })] }), 'to-desk')
  eq('8  a tesSUCCESS LoanSet on the borrower\'s own LoanBroker naming the escrow → to-desk, ignored', decide({ loanSets: [loanSetEntry(), loanSetEntry({ broker: T.OWN_BROKER, loanId: T.LOAN_Z })] }), 'to-desk')
  eq('9  a desk LoanSet ended tec naming the escrow, beside the one that created the loan → to-desk, ignored', decide({ loanSets: [loanSetEntry({ result: 'tecNO_ENTRY' }), loanSetEntry()] }), 'to-desk')
  eq('10 two desk tesSUCCESS LoanSets naming its escrow → none (ambiguous)', [decide({ loanSets: [loanSetEntry(), loanSetEntry({ broker: T.SPARE_BROKER, loanId: T.LOAN_P })] }), decideRelease(args({ loanSets: [loanSetEntry(), loanSetEntry({ loanId: T.LOAN_P })] })).reason.startsWith('ambiguous')], ['none', true])
  eq('11 a non-conforming account → none', decide({ conforming: false }), 'none')
  eq('12 a recipient without an MPToken of the share → none, "recipient cannot receive the shares"', [decide({ recipient: recipientOf(A.deskOwner, { noToken: true }) }), decideRelease(args({ recipient: recipientOf(A.deskOwner, { noToken: true }) })).reason], ['none', 'recipient cannot receive the shares'])
  {
    const w = world(T, { released: false })
    const before = w.f.commands.length
    const state = await readReleaseState(w.f, { account: A.R, shareMptId: SHARE, roles: rolesOf(w.demo), deskBrokers: deskBrokersOf(w.demo), at: await headerOf(w.f, 'validated') })
    const read = w.f.commands.slice(before)
    eq('13 an account after EscrowFinish, no escrow, all the shares, loan defaulted, read through readCollateralAccount at the structural state on the fake client → to-desk (M1)',
      [decideRelease(state.args).decision, state.collateral.conforming, state.collateral.sharesHeld, state.collateral.escrowCount, read.includes('account_info') && read.includes('account_objects')], ['to-desk', true, UNITS, 0, true])
  }
  eq('   a recipient with lsfDepositAuth and no DepositPreauth of the account → none; with it → to-desk', [decide({ recipient: recipientOf(A.deskOwner, { depositAuth: true }) }), decide({ recipient: recipientOf(A.deskOwner, { depositAuth: true, preauth: true }) })], ['none', 'to-desk'])
  {
    // step 21: a loan in the test dollar is lent from the dollar pool's own LoanBroker (demo/desk-usd.json)
    const USD_BROKER = hex64('C')
    const withUsd = { desk: { loanBrokerId: T.DESK_BROKER }, spare: { loanBrokerId: T.SPARE_BROKER }, usd: { loanBrokerId: USD_BROKER } }
    const onUsd = { ...args({ loanSets: [loanSetEntry({ broker: USD_BROKER })] }), deskBrokers: deskBrokersOf(withUsd) }
    eq("   a defaulted loan lent on the dollar pool's LoanBroker → to-desk (the dollar pool is a desk LoanBroker); without desk-usd.json → none",
      [deskBrokersOf(withUsd).includes(USD_BROKER), decideRelease(onUsd).decision, decideRelease({ ...onUsd, deskBrokers: deskBrokersOf({ ...withUsd, usd: null }) }).decision], [true, 'to-desk', 'none'])
  }
  eq('   an incomplete history → none, whatever the loan', decideRelease({ ...args(), incomplete: 'the history runs past 50 pages' }).decision, 'none')
  {
    const other = { loan: loanNode({ id: T.LOAN_Z }) } // defaulted, but not the loan the Memo names
    const dead = { loan: null, deletedLoan: deletedNode({ id: T.LOAN_Z }) }
    eq('   a defaulted loan that is not the one the Memo names, present or deleted → never to-desk', [decide(other), decide(dead)], ['none', 'none'])
    eq('   ... red without its rule (loanIsNamed off): to-desk', [decide(other, { disable: new Set(['loanIsNamed']) }), decide(dead, { disable: new Set(['loanIsNamed']) })], ['to-desk', 'to-desk'])
  }

  // --- guardCosign, pure -----------------------------------------------------------------------------------
  console.log('guardCosign (I3b)')
  const ctxDesk = { decision: 'to-desk', account: PA, desk: A.deskOwner, borrower: A.borrower, shareMptId: SHARE, sharesHeld: UNITS, baseFee: '10' }
  const ctxBorrower = { ...ctxDesk, decision: 'to-borrower' }
  const release = (o = {}) => ({ TransactionType: 'Payment', Account: PA, Destination: A.deskOwner, Amount: { mpt_issuance_id: SHARE, value: UNITS }, Fee: '30', Flags: 0, Sequence: 4, LastLedgerSequence: 320, SigningPubKey: '', ...o })
  const g = (tx, ctx = ctxDesk, internal) => guardCosign(tx, ctx, internal).ok
  eq('the release Payment of all shares to the desk under to-desk: accepted', g(release()), true)
  eq('the release Payment of all shares to the borrower under to-borrower: accepted', g(release({ Destination: A.borrower }), ctxBorrower), true)
  const refusedTypes = [
    ['SignerListSet', { TransactionType: 'SignerListSet', Account: PA, SignerQuorum: 1, SignerEntries: [], Fee: '30', Flags: 0, Sequence: 4 }],
    ['AccountSet', { TransactionType: 'AccountSet', Account: PA, ClearFlag: 4, Fee: '30', Flags: 0, Sequence: 4 }],
    ['SetRegularKey', { TransactionType: 'SetRegularKey', Account: PA, RegularKey: A.deskOwner, Fee: '30', Sequence: 4 }],
    ['AccountDelete', { TransactionType: 'AccountDelete', Account: PA, Destination: A.deskOwner, Fee: '30', Sequence: 4 }],
    ['MPTokenAuthorize', { TransactionType: 'MPTokenAuthorize', Account: PA, MPTokenIssuanceID: SHARE, Flags: 1, Fee: '30', Sequence: 4 }],
    ['DelegateSet', { TransactionType: 'DelegateSet', Account: PA, Authorize: A.deskOwner, Permissions: [], Fee: '30', Sequence: 4 }],
    ['an EscrowCreate of the shares to the desk', { TransactionType: 'EscrowCreate', Account: PA, Destination: A.deskOwner, Amount: { mpt_issuance_id: SHARE, value: UNITS }, FinishAfter: CT, Fee: '30', Sequence: 4 }],
    ['an XRP payment', release({ Amount: '5000000' })],
    ['a payment of half the shares', release({ Amount: { mpt_issuance_id: SHARE, value: '2500000' } })],
    ['a payment to a third party', release({ Destination: A.stranger })],
    ['a payment of another share', release({ Amount: { mpt_issuance_id: OTHER_SHARE, value: UNITS } })],
    ['the release Payment carrying Delegate', release({ Delegate: A.stranger })],
    ['the release Payment with tfInnerBatchTxn', release({ Flags: TF_INNER_BATCH_TXN })],
    ['the release Payment whose Fee is above 30 × the base fee', release({ Fee: '301' })],
  ]
  for (const [name, tx] of refusedTypes) eq(`refused: ${name}`, g(tx), false)
  eq('refused: the payment to the desk under decision none', g(release(), { ...ctxDesk, decision: 'none' }), false)
  eq('refused: SendMax, DeliverMin, Paths, tfPartialPayment', [g(release({ SendMax: release().Amount })), g(release({ DeliverMin: release().Amount })), g(release({ Paths: [[{ account: A.stranger }]] })), g(release({ Flags: TF_PARTIAL_PAYMENT }))], [false, false, false, false])
  eq('accepted: Flags tfFullyCanonicalSig; Fee exactly 30 × base', [g(release({ Flags: TF_FULLY_CANONICAL_SIG })), g(release({ Fee: '300' }))], [true, true])
  for (const [name, tx, ctx, rule] of [
    ['a foreign Account', release({ Account: A.stranger }), ctxDesk, 'account'],
    ['Flags other than 0 or tfFullyCanonicalSig (tfNoRippleDirect)', release({ Flags: 0x00010000 }), ctxDesk, 'flags'],
    ['no baseFee', release(), { ...ctxDesk, baseFee: undefined }, 'baseFee'],
  ]) {
    eq(`refused: ${name}; red without its rule (${rule} off): accepted`, [g(tx, ctx), g(tx, ctx, { disable: new Set([rule]) })], [false, true])
  }

  // --- the auditor -----------------------------------------------------------------------------------------
  console.log('the auditor (I1, I2, I3, I7)')
  const run = async (o, opts) => world(T, o).audit(opts)
  const has = (r, rule) => r.violations.some((v) => v.rule === rule)
  {
    const r = await run({})
    eq('an intact, conforming log; pool accounts never used (free), an account after EscrowFinish holding its shares (structural) → 0 (M1)',
      [r.code, r.stages[A.F1], r.stages[A.F2], r.stages[A.S], r.stages[A.P], r.stages[A.R]], [0, 'free', 'free', 'structural', 'pledged', 'structural'])
    if (r.code !== 0) console.log(`         ${r.lines.join('\n         ')}`)
  }
  {
    // step 21: an approved entry on the dollar pool's LoanBroker; its PrincipalRequested is dollars, never drops
    const w = world(T)
    w.demo.usd = { owner: A.deskOwner, loanBrokerId: T.DESK_BROKER }
    const r = await w.audit()
    eq("an approved entry on the dollar pool's LoanBroker → its dollar ticket is named as not recomputed, never passed on drops",
      [r.code, r.notes.some((n) => n.sentence.includes('its dollar ticket is not recomputed by this auditor'))], [0, true])
  }
  {
    const w = world(T)
    w.f.floors.set(A.P, 205) // the node lacks the pledge (200) and the creation (100) of P; its escrow lives
    const r = await w.audit()
    eq('a pledged account whose node lacks the history of the pledge, its escrow alive → pledged (R2D-m5), and exit 2: no history back to the Payment that created it', [r.stages[A.P], r.code, r.unreadable.some((u) => u.object.includes(A.P))], ['pledged', 2, true])
  }
  {
    const r = await run({ tecP: true })
    eq('an approved entry whose LoanSet ended tec → 0, named on its own line (PC2-m2)', [r.code, r.notes.some((n) => n.sentence.includes('tecINSUFFICIENT_FUNDS'))], [0, true])
  }
  {
    const r = await run({ outsider: true })
    eq('an account created at the pledge, outside collateral.accounts, named by an approved entry, that signed a SignerListSet after disabling its master key → 1 (I3, PC2-m4)', [r.code, has(r, 'agentCosign'), r.violations.every((v) => v.object.includes(A.X))], [1, true, true])
  }
  {
    const r = await run({ doubleEscrow: true })
    eq('two approved entries whose LoanSets name the same escrow → 1 (I2, PC1-M1)', [r.code, r.violations.map((v) => v.rule)], [1, ['escrowUnique']])
  }
  {
    const r = await run({ delegateBeforeF1: true })
    eq('a collateral account that signed a DelegateSet before disabling its master key → 1 (I3, PC1-M3)', [r.code, r.violations.map((v) => `${v.invariant} ${v.rule}`)], [1, ['I3 beforeDisable']])
  }
  {
    const w = world(T)
    w.tamper = (es) => es.map((e) => (e.seq === 1 ? { ...e, code: 'BREACHEE' } : e)) // one byte, the hash kept
    const r = await w.audit()
    eq('an entry altered by one byte → 1 (I2), the server\'s chain {ok: true} not trusted', [r.code, r.violations.map((v) => `${v.invariant} ${v.rule}`)], [1, ['I2 chain']])
  }
  {
    const w = world(T)
    w.bodies[1].ledgerHash = hashOfLedger(211) // rechained: the chain holds, the hash is not the ledger's
    const r = await w.audit()
    eq('a ledgerHash that is not the ledger\'s → 1 (I1)', [r.code, r.violations.map((v) => `${v.invariant} ${v.rule}`)], [1, ['I1 ledgerHash']])
  }
  {
    const r = await run({ disableAt: { P: 215 } })
    eq('an approved entry whose escrow paid into an account with its master key enabled → 1 (I2)', [r.code, r.violations.map((v) => `${v.invariant} ${v.rule}`), r.violations[0]?.sentence.includes('master key enabled')], [1, ['I2 entryAccountPledged'], true])
  }
  {
    const r = await run({ mandate: T.TIGHT })
    eq('approved entries whose recomputed ticket is BREACHED → 1 (I2)', [r.code, r.violations.map((v) => v.rule)], [1, ['ticketPass', 'ticketPass']])
  }
  {
    const r = await run({ deskLoanSetNoEntry: true })
    eq('a desk LoanSet with no approved entry → 1 (I2)', [r.code, r.violations.map((v) => v.rule)], [1, ['coverage']])
  }
  {
    const r = await run({ signerListAfterF2: true })
    eq('a pool account that signed a SignerListSet with the agent after disabling its master key → 1 (I3)', [r.code, r.violations.map((v) => `${v.invariant} ${v.rule}`)], [1, ['I3 agentCosign']])
  }
  {
    const r = await run({ noDefault: true })
    eq('a Payment of the shares to the desk while the loan is not in default → 1 (I3)', [r.code, r.violations.map((v) => `${v.invariant} ${v.rule}`), r.violations[0]?.sentence.includes('decision none')], [1, ['I3 agentCosign'], true])
  }
  {
    const r = await run({ i7: true })
    eq('an approved entry whose snapshot at its ledger violates I7 → 1 (I7)', [r.code, r.violations.map((v) => `${v.invariant} ${v.rule}`)], [1, ['I7 snapshot']])
  }
  {
    const w = world(T)
    w.f.missing.add(210)
    const r = await w.audit()
    eq('a historical ledger the node does not hold → 2', [r.code, r.unreadable.some((u) => u.sentence.includes('ledger 210'))], [2, true])
  }
  {
    const w = world(T)
    w.apiDown = true
    eq('the API unreachable → 2', (await w.audit()).code, 2)
  }

  console.log('one negative case per auditor rule, each red without its rule')
  const flip = async (name, o, rule, want, { mutate, isolated = true } = {}) => {
    const make = () => {
      const w = world(T, o)
      mutate?.(w)
      return w
    }
    const on = await make().audit()
    const offR = await make().audit({ disable: new Set([rule]) })
    const red = on.code === want && (want !== 1 || has(on, rule))
    // without its rule the outcome flips: to 0 for a rule that reds (1 or 2), away from 0 for a rule that keeps green
    const green = !isolated ? !has(offR, rule) : want === 0 ? offR.code !== 0 : offR.code === 0
    eq(`${name} → ${want}; without its rule (${rule}) → ${!isolated ? `no ${rule} line` : want === 0 ? 'not 0' : '0'}`, [red, green], [true, true])
    if (!red || !green) console.log(`         with: ${on.code} ${on.lines.join(' | ')}\n         without: ${offR.code} ${offR.lines.join(' | ')}`)
    return { on, off: offR }
  }
  await flip('a history that does not reach back to the creating Payment', {}, 'creatorPayment', 2, { mutate: (w) => w.f.floors.set(A.F1, 101) })
  await flip('a creating Payment that does not come from deskOwner', { creator: { F1: A.stranger } }, 'creatorFromDesk', 1)
  await flip('an account that does not conform at the last validated ledger', {}, 'accountConforms', 1, { mutate: (w) => w.f.put(`root:${A.F1}`, 299, { ...w.f.node(`root:${A.F1}`, 298), RegularKey: A.stranger }) })
  await flip('a Memo ticketId that does not match the entry', { memoTicketP: T.T_WRONG }, 'memoTicket', 1)
  await flip('an escrow that is not the borrower\'s', { escrowOwnerP: true }, 'escrowOwner', 1, { isolated: false })
  await flip('an escrow with a Condition', { conditionP: 'A0258020' + 'E3'.repeat(32) + '810100' }, 'escrowCondition', 1)
  const floor = (c) => c + T.PI + T.GP + T.POLICY.approvalSlackSeconds
  await flip('date rule: FinishAfter a second under its floor', { datesP: (c) => ({ finishAfter: floor(c) - 1 }) }, 'dateFloor', 1)
  await flip('date rule: FinishAfter a second above its ceiling', { datesP: (c) => ({ finishAfter: c + T.PI + T.GP + T.POLICY.finishAfterMarginSeconds + 1 }) }, 'dateCeiling', 1)
  await flip('date rule: CancelAfter − FinishAfter not the policy\'s offset', { datesP: (c) => { const fa = c - 60 + T.PI + T.GP + T.POLICY.finishAfterMarginSeconds; return { finishAfter: fa, cancelAfter: fa + 3600 } } }, 'dateOffset', 1)
  await flip('date rule: a LoanSet of PaymentTotal 3, its last payment after CancelAfter', { paymentTotalP: 3 }, 'dateMaturity', 1)
  const paged = await flip('a release history not read to its last page (the borrower\'s account_tx past 50 pages)', { borrowerFiller: true }, 'releaseHistory', 2, { mutate: (w) => w.f.pageSize.set(A.borrower, 1) })
  eq('   ... its sentence names the page limit', paged.on.unreadable.some((u) => u.sentence.includes('runs past 50 pages')), true)
  const short = await flip('a release history where the borrower\'s does not reach back to the first pledge EscrowCreate', {}, 'releaseHistory', 2, { mutate: (w) => w.f.floors.set(A.borrower, 221) })
  eq('   ... its sentence names the first pledge EscrowCreate', short.on.unreadable.some((u) => u.sentence.includes('first pledge EscrowCreate')), true)
  {
    const { on } = await flip('a Payment of the shares signed by the desk and the borrower without the agent', { releaseSigners: [A.borrower, A.deskOwner] }, 'consentedNote', 0)
    eq('   ... → 0, named on a note line "consented exit by desk and borrower"', [on.code, on.notes.some((n) => n.sentence.startsWith('consented exit by desk and borrower'))], [0, true])
  }
  {
    // the conforming release case, served in the v2 shape: it fails without the normalisation
    const w = world(T)
    const served = await w.f.req({ command: 'tx', transaction: w.f.txs.find((x) => x.ledger === 260).hash })
    eq('the fake client serves the release in the v2 shape: DeliverMax, no Amount, ctid, date and ledger_index in tx_json', [served.result.tx_json.Amount === undefined, Boolean(served.result.tx_json.DeliverMax), ['ctid', 'date', 'ledger_index'].every((k) => k in served.result.tx_json)], [true, true, true])
    const on = await w.audit()
    const offN = await world(T).audit({ disable: new Set(['normaliseV2']) })
    eq('the conforming release → 0 with the v2 normalisation; 1 without it (agentCosign)', [on.code, offN.code, has(offN, 'agentCosign')], [0, 1, true])
  }
  {
    // judged as approved: a conforming one passes (0); one whose escrow carries a Condition is caught (1),
    // and without the rule it is never judged (0)
    const r = await run({ unconfirmedP: true })
    const caught = await run({ unconfirmedP: true, conditionP: 'A0258020' + 'E3'.repeat(32) + '810100' })
    const offU = await run({ unconfirmedP: true, conditionP: 'A0258020' + 'E3'.repeat(32) + '810100' }, { disable: new Set(['unconfirmedJudged']) })
    eq('a refused SUBMIT_UNCONFIRMED entry whose LoanSet is found validated → judged as approved: conforming 0, its escrow at fault 1; without the rule (unconfirmedJudged) never judged, 0',
      [r.code, caught.code, caught.violations.map((v) => `${v.object} ${v.rule}`), offU.code], [0, 1, ['entry seq 2 escrowCondition'], 0])
  }
  await flip('a refused SUBMIT_UNCONFIRMED entry whose LoanSet is not found after the window → 0 with a note', { extraUnconfirmed: true }, 'unconfirmedNote', 0).then(async ({ on }) => {
    eq('   ... the note names the entry; without its rule it is unreadable (2)', [on.notes.some((n) => n.sentence.startsWith('refused SUBMIT_UNCONFIRMED')), (await run({ extraUnconfirmed: true }, { disable: new Set(['unconfirmedNote']) })).code], [true, 2])
  })
  await flip('an approved entry whose txHash is not found', { pTxHash: hex64('9') }, 'approvedTxFound', 2)
  await flip('an approved entry whose LoanSet is not validated', {}, 'approvedTxFound', 2, { mutate: (w) => w.f.unvalidated.add(w.ids.lsP) })
  {
    const w = world(T)
    w.bodies[1].ledgerHash = hashOfLedger(211)
    w.f.missing.add(230)
    const r = await w.audit()
    eq('violations followed by an impossible read → the violations printed, then exit 2', [r.code, r.lines[0]?.startsWith('VIOLATION I1'), r.lines.at(-1)?.startsWith('UNREADABLE')], [2, true, true])
  }

  // --- the agent CLI, on the fake client -------------------------------------------------------------------
  console.log('the agent CLI (--release), on the fake client')
  const dir = mkdtempSync(join(tmpdir(), 'orma-audit-'))
  const cli = async (o, { submit = false, mutate, inject = {} } = {}) => {
    const w = world(T, { released: false, ...o })
    mutate?.(w)
    const lines = []
    const path = join(dir, `agent-releases-${++txCounter}.jsonl`)
    const code = await runRelease({ client: w.f, account: A.R, submit, demo: w.demo, releasesPath: path, out: (l) => lines.push(l), log: { info() {} }, ...inject })
    return { code, lines, written: existsSync(path), path, w }
  }
  {
    const r0 = await cli({})
    const r1 = await cli({ noDefault: true })
    const r2 = await cli({ borrowerFiller: true }, { mutate: (w) => w.f.pageSize.set(A.borrower, 1) })
    eq('exit 0 on a release decision (to-desk), exit 1 on none (an active loan), exit 2 on an incomplete history', [r0.code, r1.code, r2.code], [0, 1, 2])
    eq('without --submit it prints the decision and its reason and nothing else, and writes nothing to agent-releases.jsonl', [r0.lines.length, r0.lines[0]?.startsWith('to-desk: the loan'), r1.lines[0]?.startsWith('none: the loan'), r2.lines[0]?.startsWith('none: '), r0.written || r1.written || r2.written], [1, true, true, true, false])
  }
  {
    // an incomplete history with --submit: refused before anything is built or signed
    let built = 0
    let keys = 0
    const inject = { autofill: async (tx) => { built++; return tx }, loadWallets: () => { keys++; return {} }, submitBlob: async () => { throw new Error('never') } }
    const a = await cli({ borrowerFiller: true }, { submit: true, inject, mutate: (w) => w.f.pageSize.set(A.borrower, 1) })
    const b = await cli({}, { submit: true, inject, mutate: (w) => w.f.floors.set(A.borrower, 221) })
    eq('an incomplete release history (pages, then the borrower\'s floor) with --submit: exit 2, nothing built, no key loaded, nothing journaled', [a.code, b.code, built, keys, a.written || b.written], [2, 2, 0, 0, false])
  }
  {
    // --submit end to end on the fake client, the submission injected (the fake ledger never sees submit)
    const blobs = []
    const inject = {
      autofill: async (tx, n) => ({ ...tx, Flags: 0, Sequence: 4, Fee: String(10 * (1 + n)), LastLedgerSequence: 320, SigningPubKey: '' }),
      loadWallets: () => ({ agent: T.wallets.agent, counterparty: T.wallets.deskOwner }),
      submitBlob: async (blob) => { blobs.push(blob); return { txHash: hashes.hashSignedTx(blob), engineResult: 'tesSUCCESS', ledgerIndex: 301 } },
    }
    const r = await cli({}, { submit: true, inject })
    const sent = blobs[0] ? decode(blobs[0]) : {}
    const journal = r.written ? parseLines(readFileSync(r.path, 'utf8')) : []
    eq('--submit: the guarded release, multi-signed by the agent and the desk, submitted once, journaled with its hash', [r.code, blobs.length, sent.TransactionType, sent.Destination, sent.Amount?.value, (sent.Signers ?? []).map((s) => s.Signer.Account).sort(), journal.map((e) => [e.decision, e.txHash, e.loanId])],
      [0, 1, 'Payment', A.deskOwner, UNITS, [A.agent, A.deskOwner].sort(), [['to-desk', blobs[0] ? hashes.hashSignedTx(blobs[0]) : null, T.LOAN_R]]])
    const none = await cli({ noDefault: true }, { submit: true, inject })
    eq('--submit on none: nothing built nor signed, the none decision journaled', [none.code, blobs.length, parseLines(readFileSync(none.path, 'utf8')).map((e) => [e.decision, e.txHash])], [1, 1, [['none', null]]])
    const audited = await r.w.audit({ releasesPath: r.path })
    eq('the auditor recomputes the chain of agent-releases.jsonl (--releases): intact → 0', audited.code, 0)
    const altered = await r.w.audit({ releasesPath: r.path, readFile: (p) => readFileSync(p, 'utf8').replace('"to-desk"', '"to-borrower"') })
    eq('... altered → 1 (releasesChain)', [altered.code, has(altered, 'releasesChain')], [1, true])
  }

  // --- the properties R1 to R4 (A4b) ------------------------------------------------------------------------
  console.log('properties R1 to R4 (A4b), 2 000 cases each')
  const STRANGER_RECIPIENT = A.stranger
  const who = { desk: A.deskOwner, borrower: A.borrower, stranger: STRANGER_RECIPIENT }
  const loanIdOf = (i) => (0x700 + i).toString(16).toUpperCase().padStart(64, '0')
  const gen = (rand) => {
    const pick = (arr) => arr[Math.floor(rand() * arr.length)]
    const nE = pick([0, 1, 1, 2])
    const escrows = Array.from({ length: nE }, (_, i) => ({ kind: pick(['pledge', 'pledge', 'pledge', 'xrp', 'third', 'pledgeTec']), seq: 100 + i }))
    const nL = pick([0, 1, 1, 2])
    const loanSets = Array.from({ length: nL }, () => ({ broker: pick(['desk', 'spare', 'desk', 'own']), result: rand() < 0.75 ? 'tesSUCCESS' : 'tecNO_ENTRY', names: nE && rand() < 0.9 ? Math.floor(rand() * nE) : -1 }))
    const kind = pick(['default', 'repaid', 'active'])
    const right = kind === 'default' ? 'desk' : kind === 'repaid' ? 'borrower' : pick(['desk', 'borrower'])
    const payment = rand() < 0.6
    return {
      escrows, loanSets, kind, presence: pick(['present', 'present', 'deleted', 'missing']), named: rand() < 0.85, conforming: rand() < 0.75, shares: rand() < 0.85 ? UNITS : '0',
      recipient: { who: rand() < 0.75 ? right : pick(['desk', 'borrower', 'stranger']), can: pick(['ok', 'ok', 'ok', 'noToken', 'depositAuth', 'preauth']) },
      cand: payment
        ? { type: 'Payment', account: rand() < 0.9 ? 'A' : 'stranger', dest: rand() < 0.6 ? right : pick(['desk', 'borrower', 'stranger']), amount: pick(['all', 'all', 'all', 'half', 'otherShare', 'xrp']), extra: rand() < 0.5 ? null : pick(['SendMax', 'DeliverMin', 'Paths', 'partial', 'Delegate', 'fee', 'innerBatch', 'canonical', 'flagsOther']) }
        : { type: pick(TYPES) },
    }
  }
  const build = (c) => {
    const ownerOfEscrow = (e) => (e.kind === 'third' ? A.stranger : A.borrower)
    // a shrunk case may drop the escrow a LoanSet names: that LoanSet then names an index nobody created
    const indexOf = (i) => (i >= 0 && i < c.escrows.length ? hashes.hashEscrow(ownerOfEscrow(c.escrows[i]), c.escrows[i].seq).toUpperCase() : hex64('7'))
    const escrowCreates = c.escrows.map((e) => entryV2({
      hash: hashOfLedger(0x900 + e.seq), ledger: 220, tx: { TransactionType: 'EscrowCreate', Account: ownerOfEscrow(e), Sequence: e.seq, Destination: PA, Amount: e.kind === 'xrp' ? '1000' : { mpt_issuance_id: SHARE, value: UNITS } }, result: e.kind === 'pledgeTec' ? 'tecNO_PERMISSION' : 'tesSUCCESS',
    }))
    const brokerOf = (b) => (b === 'desk' ? T.DESK_BROKER : b === 'spare' ? T.SPARE_BROKER : T.OWN_BROKER)
    const loanSets = c.loanSets.map((l, i) => entryV2({
      hash: hashOfLedger(0xa00 + i), ledger: 231, tx: { TransactionType: 'LoanSet', Account: A.borrower, LoanBrokerID: brokerOf(l.broker), Memos: memos(l.names >= 0 ? indexOf(l.names) : hex64('7')) }, result: l.result,
      nodes: l.result === 'tesSUCCESS' ? [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: loanIdOf(i), NewFields: { LoanBrokerID: brokerOf(l.broker) } } }] : [],
    }))
    // the oracle's own reading of the rule, from the descriptor
    const pledgeIndexes = new Set(c.escrows.flatMap((e, i) => (e.kind === 'pledge' ? [indexOf(i)] : [])))
    const links = c.loanSets.flatMap((l, i) => (l.broker !== 'own' && l.result === 'tesSUCCESS' && l.names >= 0 && pledgeIndexes.has(indexOf(l.names)) ? [loanIdOf(i)] : []))
    const linked = links.length === 1 ? links[0] : null
    const nodeId = c.named && linked ? linked : loanIdOf(15)
    const flags = c.kind === 'default' ? LSF_LOAN_DEFAULT : 0
    const remaining = c.kind === 'active' ? 3 : 0
    const address = who[c.recipient.who]
    const recipient = {
      address, accountRoot: { Account: address, Flags: c.recipient.can === 'depositAuth' || c.recipient.can === 'preauth' ? LSF_DEPOSIT_AUTH : 0 },
      mptoken: c.recipient.can === 'noToken' ? null : { MPTokenIssuanceID: SHARE, Account: address, MPTAmount: '0' },
      depositPreauth: c.recipient.can === 'preauth' ? { Account: address, Authorize: PA } : null,
    }
    const a = {
      account: PA, collateral: collateralOf({ shares: c.shares, conforming: c.conforming }), shareMptId: SHARE, deskBrokers: DESK_BROKERS, escrowCreates, loanSets, recipient,
      loan: c.presence === 'present' ? { LedgerEntryType: 'Loan', index: nodeId, Flags: flags, PaymentRemaining: remaining } : null,
      deletedLoan: c.presence === 'deleted' ? { LedgerEntryType: 'Loan', LedgerIndex: nodeId, FinalFields: { Flags: flags, PaymentRemaining: remaining } } : null,
    }
    const proven = (k) => linked !== null && c.named && c.presence !== 'missing' && c.kind === k
    const ready = (party) => c.conforming && num(c.shares).gt(0) && c.recipient.who === party && ['ok', 'preauth'].includes(c.recipient.can)
    return { a, toDesk: proven('default') && ready('desk'), toBorrower: proven('repaid') && ready('borrower') }
  }
  const CLEAN = new Set(['TransactionType', 'Account', 'Destination', 'Amount', 'Fee', 'Flags', 'Sequence', 'SigningPubKey'])
  const exactRelease = (tx, ctx) => ctx.decision !== 'none' && tx.TransactionType === 'Payment' && tx.Account === ctx.account
    && tx.Destination === (ctx.decision === 'to-desk' ? ctx.desk : ctx.borrower) && isMpt(tx.Amount) && same(tx.Amount.mpt_issuance_id, ctx.shareMptId)
    && tx.Amount.value === ctx.sharesHeld && num(ctx.sharesHeld).gt(0) && !['SendMax', 'DeliverMin', 'Paths', 'Delegate'].some((k) => k in tx)
    && [undefined, 0, TF_FULLY_CANONICAL_SIG].includes(tx.Flags) && num(tx.Fee).lte(num(ctx.baseFee).times(30)) && Object.keys(tx).every((k) => CLEAN.has(k))
  const ctxOf = (c, d) => ({ decision: d.decision, account: PA, desk: A.deskOwner, borrower: A.borrower, shareMptId: SHARE, sharesHeld: c.shares, baseFee: '10' })
  const releaseTo = (ctx, dest) => ({ TransactionType: 'Payment', Account: PA, Destination: dest, Amount: { mpt_issuance_id: SHARE, value: ctx.sharesHeld }, Fee: '30', Flags: 0, Sequence: 9, SigningPubKey: '' })
  const candidate = (c, ctx) => {
    if (c.cand.type !== 'Payment') return { TransactionType: c.cand.type, Account: PA, Destination: A.deskOwner, Amount: { mpt_issuance_id: SHARE, value: ctx.sharesHeld }, Fee: '30', Flags: 0, Sequence: 9, SigningPubKey: '' }
    const amounts = { all: { mpt_issuance_id: SHARE, value: ctx.sharesHeld }, half: { mpt_issuance_id: SHARE, value: num(ctx.sharesHeld).div(2).floor().toFixed(0) }, otherShare: { mpt_issuance_id: OTHER_SHARE, value: ctx.sharesHeld }, xrp: ctx.sharesHeld }
    const tx = { TransactionType: 'Payment', Account: c.cand.account === 'A' ? PA : A.stranger, Destination: who[c.cand.dest], Amount: amounts[c.cand.amount], Fee: '30', Flags: 0, Sequence: 9, SigningPubKey: '' }
    const extras = {
      SendMax: () => { tx.SendMax = tx.Amount }, DeliverMin: () => { tx.DeliverMin = tx.Amount }, Paths: () => { tx.Paths = [[{ account: A.stranger }]] }, partial: () => { tx.Flags = TF_PARTIAL_PAYMENT },
      Delegate: () => { tx.Delegate = A.stranger }, fee: () => { tx.Fee = '301' }, innerBatch: () => { tx.Flags = TF_INNER_BATCH_TXN }, canonical: () => { tx.Flags = TF_FULLY_CANONICAL_SIG }, flagsOther: () => { tx.Flags = 0x00010000 },
    }
    if (c.cand.extra) extras[c.cand.extra]()
    return tx
  }
  const props = [
    ['R1 to-desk iff the default is proven, the account conforms in structure, one desk LoanSet names its pledge, shares held, a recipient that can receive', (c) => {
      const { a, toDesk } = build(c)
      const d = decideRelease(a)
      return (d.decision === 'to-desk') === toDesk || `decision ${d.decision} (${d.reason}), oracle to-desk ${toDesk}`
    }],
    ['R2 to-borrower iff the loan is repaid without default, present or deleted, on the same conditions', (c) => {
      const { a, toBorrower } = build(c)
      const d = decideRelease(a)
      return (d.decision === 'to-borrower') === toBorrower || `decision ${d.decision} (${d.reason}), oracle to-borrower ${toBorrower}`
    }],
    ['R3 never both: on one state guardCosign never accepts a payment to the desk and one to the borrower', (c) => {
      const { a } = build(c)
      const ctx = ctxOf(c, decideRelease(a))
      return !(guardCosign(releaseTo(ctx, A.deskOwner), ctx).ok && guardCosign(releaseTo(ctx, A.borrower), ctx).ok) || 'both accepted'
    }],
    ['R4 guardCosign accepts only the Payment of all the shares to the party the decision names (and accepts it)', (c) => {
      const { a } = build(c)
      const d = decideRelease(a)
      const ctx = ctxOf(c, d)
      const tx = candidate(c, ctx)
      const r = guardCosign(tx, ctx)
      if (r.ok && !exactRelease(tx, ctx)) return `accepted ${JSON.stringify(tx)} under ${d.decision}`
      if (d.decision !== 'none' && !guardCosign(releaseTo(ctx, d.decision === 'to-desk' ? A.deskOwner : A.borrower), ctx).ok) return `the exact release refused under ${d.decision}`
      return true
    }],
  ]
  for (const [name, prop] of props) {
    count++
    if (!forAll({ name, seed, cases: 2000, gen, prop })) bad++
  }
  {
    // R3 holds while the destination rule names one party; without that rule it goes red
    const both = (internal) => guardCosign(release(), ctxDesk, internal).ok && guardCosign(release({ Destination: A.borrower }), ctxDesk, internal).ok
    eq('   R3 red without its rule (destination off): a payment to the desk and one to the borrower both accepted', [both(), both({ disable: new Set(['destination']) })], [false, true])
  }

  // --- the auditor never signs nor submits ---------------------------------------------------------------------
  const forbidden = FAKES.flatMap((f) => f.commands.filter((c) => ['submit', 'submit_multisigned', 'sign', 'sign_for'].includes(c)))
  eq(`no submit, submit_multisigned nor sign on any of the ${FAKES.length} fake clients, in any case`, forbidden, [])
  const source = [audit, readReleaseState, headerOf, readBaseFee].map((fn) => fn.toString()).join('\n')
  eq('the auditor\'s source names no ROLES_FILE, seed loader, wallet, signature nor submission', ['ROLES_FILE', 'fromSeed', 'Wallet', '.sign(', 'multisign(', "'submit'", 'submit_multisigned', 'walletsFromRoles'].filter((t) => source.includes(t)), [])

  console.log(bad ? `\n  ${bad} of ${count} FAILED (seed ${seed})` : `\n  all ${count} ok (seed ${seed})`)
  return bad ? 1 : 0
}

// --- CLI (at the end: every declaration above is initialised) ------------------------------------------------

const isMain = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1] ?? '').toLowerCase()
  } catch {
    return false
  }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--self-test')) {
    process.exitCode = await selfTest(argv)
  } else {
    let demo = null
    try {
      demo = demoFromFiles()
    } catch (e) {
      console.log(`UNREADABLE demo files: ${e?.code ?? e?.message ?? e}`)
      process.exitCode = 2
    }
    if (demo) {
      const { Xrpl, DEVNET_WS } = await import('../xrpl.mjs')
      const xrpl = new Xrpl(process.env.XRPL_WS ?? DEVNET_WS) // req() connects on demand, with bounded retries
      try {
        if (argv.includes('--release')) {
          const account = arg('--account')
          if (!account) {
            console.log('usage: node --env-file-if-exists=.env src/desk/audit.mjs --release --account <address> [--submit]')
            process.exitCode = 2
          } else {
            process.exitCode = await runRelease({ client: xrpl, account, submit: argv.includes('--submit'), demo })
          }
        } else {
          const r = await audit({ client: xrpl, demo, apiBase: arg('--api') ?? process.env.API_BASE ?? DEFAULT_API_BASE, releasesPath: arg('--releases') ?? null })
          for (const line of r.lines) console.log(line)
          console.log(`audit: ${r.violations.length} violations, ${r.notes.length} notes, ${r.unreadable.length} unreadable`)
          if (r.unreadable.length) log.error('audit could not read everything', { unreadable: r.unreadable.length })
          process.exitCode = r.code
        }
      } catch (e) {
        console.log(`UNREADABLE: ${String(e?.data?.error ?? e?.message ?? e).slice(0, 200)}`)
        process.exitCode = 2
      } finally {
        await xrpl.disconnect()
      }
    }
  }
}
