// The NYC contract in executable form: the orma.*/1 documents Orma Desk serves, the closed table of
// formulas a Figure may carry, the fifteen NYC routes, and the pure judges that later steps import
// (manager statements in Vault.Data, the 2-of-3 collateral account, the pledged share). Frozen at
// step 1: later steps add to this file, they never change a field's type or meaning. The reference
// text is the "§0.0 NYC" section of docs/01-API-CONTRACT.md; the TypeScript mirrors are at the end of
// app/src/lib/types.ts. Proved offline by node src/dev/check-nyc-contracts.mjs.

/**
 * @typedef {'REAL'|'DECLARED'|'MODELLED'|'SIMULATED'} Provenance
 * @typedef {{ name: string, value: string, object: string, field: string, id: string, ledgerIndex: number, ledgerHash: string }} FigureInput
 * @typedef {'heldValue'|'naiveValue'|'n1Overpayment'|'cover'|'heldPerUnitIfDefault'|'lossAfterCover'|'maxLoan'|'maxUnits'|'requested'|'ltvHeld'|'lender1to1'|'cashAvailable'|'claim'|'lockedUntil'|'collateralHeldUsd'|'maxLoanUsd'|'requestedUsd'|'ltvHeldUsd'|'lender1to1Usd'|'priceAge'} FormulaId
 * @typedef {{ value: string, unit: 'drops'|'share-units'|'ratio'|'seconds'|'bps'|'usd', meaning: string, formula: string, formulaId: FormulaId, inputs: FigureInput[], provenance: Provenance }} Figure
 * @typedef {{ loanId: string, label: string, scenario: string, lossAfterCover: Figure, cover: Figure, heldPerUnitIfDefault: Figure, alreadyInHeld: boolean }} N2Entry
 * @typedef {{
 *   schema: 'orma.ticket/1', ticketId: string, inputsDigest: string, asOf: string, ledgerIndex: number, ledgerHash: string,
 *   op: 'pledge'|'buy',
 *   share: { mptId: string, vaultId: string, units: string, shareScale: number },
 *   mandate: { id: string, hash: string, anchorTx: string },
 *   figures: { heldValue: Figure, naiveValue: Figure, n1Overpayment: Figure, n2: N2Entry[],
 *              n3: { lockedUntil: Figure, redemptionAt: string, cashAvailable: Figure, claim: Figure },
 *              maxLoan?: Figure, maxUnits?: Figure, requested?: Figure, ltvHeld?: Figure, lender1to1?: Figure,
 *              maxLoanUsd?: Figure, requestedUsd?: Figure, collateralHeldUsd?: Figure, ltvHeldUsd?: Figure, lender1to1Usd?: Figure, priceAge?: Figure },
 *   conduct: { recognitionLagSeconds: string[], defaultsWithoutImpairment: number, coverOrderCostDrops: string },
 *   escrowPolicy: { finishAfter: string, cancelAfter: string, text: string },
 *   statement: Statement|null,
 *   verdict: { status: 'PASS'|'BREACHED', breaches: { limit: string, value: string, threshold: string }[] },
 *   verdict1to1?: { status: 'PASS'|'BREACHED', breaches: { limit: string, value: string, threshold: string }[] },
 *   usd?: TicketUsd
 * }} Ticket
 * @typedef {{ object: { type: string, index: string }, field: string, before: unknown, after: unknown,
 *   admitted: 'YES'|'HIDDEN', rule: { source: 'rippled 3.4.1', file: string, line: number },
 *   moneyEffect: { value: string, unit: string } | null, verdict?: 'MATCH'|'MISMATCH' }} ChangeRow
 * @typedef {{
 *   schema: 'orma.change/1', txType: string, txJson: object,
 *   simulatedAt: { ledgerIndex: number, ledgerHash: string }, engineResult: string,
 *   rows: ChangeRow[], hiddenCount: number, provenance: 'SIMULATED',
 *   realised?: { txHash: string, ledgerIndex: number, ledgerHash: string, rows: ChangeRow[] }
 * }} Change
 * @typedef {{
 *   schema: 'orma.mandate/1', id: string, desk: string, riskOfficer: string,
 *   limits: { maxLtvBps: number, maxSingleLoanDrops: string, maxN2LossDrops: string, maxLockupDays: number },
 *   policy: { escrowFinish: 'only-after-default', finishAfterMarginSeconds: number, approvalSlackSeconds: number, cancelAfterOffsetSeconds: number },
 *   issuedAt: string, hash: string, anchorTx: string
 * }} Mandate
 * @typedef {{
 *   schema: 'orma.mark/1', shareMptId: string, verdict: 'agree'|'disagree',
 *   reason?: 'SPOOFED'|'RECOMPUTE_MISMATCH'|'ORACLE_MISMATCH'|'UNREACHABLE',
 *   tolerance: string, steps: { step: string, ok: boolean, detail: string }[],
 *   ledgerIndex: number, ledgerHash: string, node: string
 * }} Mark
 * @typedef {{ s: 'orma.stmt/1', loan?: string, kind: 'impaired'|'defaulted'|'repaid'|'note', text: string, at: number }} StatementDoc
 * @typedef {{ status: 'CONSISTENT'|'INCONSISTENT'|'NOT_CHECKABLE'|'UNPARSEABLE', detail: string, provenance: 'REAL', ledgerIndex: number, ledgerHash: string }} StatementCheck
 * @typedef {{ provenance: 'DECLARED', raw: string, owner: string, doc: StatementDoc|null, consistency: StatementCheck }} Statement
 * @typedef {{
 *   address: string, signers: { borrower: string, desk: string, agent: string }, quorum: number,
 *   masterDisabled: boolean, regularKey: string|null, depositAuth: boolean, mptAuthorized: boolean, sharesHeld: string, escrowCount: number, ownerCount: number, pledges?: { account: string, sequence: number, index: string, txHash: string, ledgerIndex: number }[],
 *   conforming: boolean, reasons: string[], provenance: 'REAL', ledgerIndex: number, ledgerHash: string
 * }} CollateralAccount
 * @typedef {{
 *   id: string, type: 'LOAN_LATE'|'IMPAIRMENT'|'DEFAULT'|'COVER_DRAWN'|'SHARES_PLEDGED'|'LOAN_ORIGINATED'|'STATEMENT',
 *   provenance: 'REAL'|'DECLARED',
 *   vaultId: string, loanId?: string, ledgerIndex: number, ledgerHash: string, txHash?: string,
 *   why: string, moneyEffect: { value: string, unit: string }|null,
 *   receipts: { object: string, field: string, before: unknown, after: unknown }[],
 *   statement?: Statement
 * }} FeedEvent
 * @typedef {{
 *   schema: 'orma.universe/1', ledgerIndex: number, ledgerHash: string, count: number,
 *   vaults: { vaultId: string, asset: { currency: 'XRP' } | { currency: string, issuer: string } | { mpt_issuance_id: string }, brokers: string[], priced: boolean, perUnitHeld?: string, perUnitNaive?: string, reason?: string, seen: 'known'|'live' }[],
 *   coverage: { known: number, live: number, liveSinceLedger: number|null },
 *   banner: 'not live on mainnet'
 * }} Universe
 * @typedef {{
 *   seq: number, prevHash: string, ticketId: string, mandateHash: string,
 *   decision: 'approved'|'refused'|'declined', code?: string, txHash?: string, ledgerIndex: number, ledgerHash: string, hash: string
 * }} Decision
 */

import { createHash } from 'node:crypto'
import { num } from '../num.mjs'

// --- routes ----------------------------------------------------------------------------------------

/** The fifteen NYC routes, OpenAPI path templates; `kill` and `unkill` count as two. */
export const NYC_ROUTES = Object.freeze([
  { method: 'GET', path: '/api/mpt/{mptId}/status' },
  { method: 'GET', path: '/api/mark/{mptId}' },
  { method: 'GET', path: '/api/tickets' },
  { method: 'GET', path: '/api/desk/mandates/{id}' },
  { method: 'POST', path: '/api/roles/{runId}/{role}/{action}' },
  { method: 'POST', path: '/api/roles/{runId}/actions/{actionId}/confirm' },
  { method: 'GET', path: '/api/roles/{runId}/actions/{actionId}' },
  { method: 'POST', path: '/api/demo/run' },
  { method: 'POST', path: '/api/demo/kill' },
  { method: 'POST', path: '/api/demo/unkill' },
  { method: 'GET', path: '/api/desk/positions' },
  { method: 'GET', path: '/api/desk/decisions' },
  { method: 'GET', path: '/api/universe' },
  { method: 'GET', path: '/api/feed' },
  { method: 'GET', path: '/api/feed/stream' },
  { method: 'GET', path: '/api/desk/margin-calls' }, // step 20, addendum A11
].map((r) => Object.freeze(r)))

/**
 * The error codes NYC routes add to the existing ones, with their status and whether a retry can
 * help. `BUSY` already exists; the NYC routes raise it too (four desk ledger walks on /api/tickets
 * and /api/desk/positions together, 100 open streams on /api/feed/stream).
 */
export const NYC_ERRORS = Object.freeze({
  NOT_CONFIGURED: { status: 503, retryable: true },
  UNAUTHORIZED: { status: 401, retryable: false },
  LOCKED: { status: 423, retryable: false },
  STALE: { status: 409, retryable: true },
  PRICE_UNAVAILABLE: { status: 409, retryable: true }, // step 21: no usable XRP/USD price at this ledger, no dollar figure
  BREACHED: { status: 409, retryable: false },
  ESCROW_POLICY: { status: 409, retryable: false },
  BAD_OP: { status: 400, retryable: false },
  BAD_CURSOR: { status: 400, retryable: false },
  MANDATE_NOT_FOUND: { status: 404, retryable: false },
  SEQUENCE_PASSED: { status: 409, retryable: false },
  INCONSISTENT_SNAPSHOT: { status: 409, retryable: true },
  BUSY: { status: 503, retryable: true },
})

/** The codes that existed before NYC, unchanged. */
export const EXISTING_ERRORS = Object.freeze({
  WARMING_UP: { status: 503, retryable: true },
  VAULT_NOT_FOUND: { status: 404, retryable: false },
  NO_SHARE_MPT: { status: 404, retryable: false },
  NO_BROKER: { status: 404, retryable: false },
  SHARE_NOT_TRACKED: { status: 404, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  BAD_REQUEST: { status: 400, retryable: false },
  BAD_ACCOUNTS: { status: 400, retryable: false },
  BAD_HAIRCUT: { status: 400, retryable: false },
  BAD_UNITS: { status: 400, retryable: false },
  BUSY: { status: 503, retryable: true },
  INTERNAL: { status: 500, retryable: true },
})

/**
 * Every state a role action can be in. `previewing` is internal and never served (a requestLoan sits
 * there before its autofill); `approving` is a request during the confirm of its approve.
 */
export const ACTION_STATES = Object.freeze(['previewing', 'previewed', 'pending-approval', 'approving', 'queued', 'submitted', 'validated', 'failed', 'refused'])

/**
 * Codes a `refused` decision is known to carry. The set is open (any other refusal keeps its own
 * code); `SUBMIT_UNCONFIRMED` is a submission that threw and that the 60 s re-read did not find, and
 * it always carries the txHash that was sent.
 */
export const DECISION_CODES = Object.freeze(['ESCROW_POLICY', 'INCONSISTENT_SNAPSHOT', 'STALE', 'BREACHED', 'SEQUENCE_PASSED', 'SUBMIT_UNCONFIRMED'])

/** The six steps of an orma.mark/1, in order. A SPOOFED `fetch nav` stops after the first three. */
export const MARK_STEPS = Object.freeze(['read MPTokenIssuance', 'decode metadata', 'fetch nav', 'anti-spoof', 'recompute', 'oracle cross-check'])

// --- formulas --------------------------------------------------------------------------------------

const HELD_INPUTS = ['AssetsTotal', 'LossUnrealized', 'OutstandingAmount', 'Scale', 'units']
const COVER_INPUTS = ['DebtTotal', 'CoverRateMinimum', 'CoverRateLiquidation', 'CoverAvailable', 'LEVersion', 'PrincipalOutstanding', 'TotalValueOutstanding', 'ManagementFeeOutstanding']
const IF_DEFAULT_INPUTS = [...HELD_INPUTS.filter((n) => n !== 'units'), ...COVER_INPUTS, 'Flags']
const USD_HELD_INPUTS = [...HELD_INPUTS, 'xrpUsd', 'fxHaircutBps']

// Notation: s = wholeShares(OutstandingAmount, Scale); u = wholeShares(units, Scale);
// perUnit(x) = (x / s).toFixed(6) ROUND_HALF_UP, as Reader.nav; value(p) = (u × p).toFixed(0)
// ROUND_HALF_UP, as valuePledge; floor(x) = x.toFixed(0, ROUND_DOWN); exp = PrincipalOutstanding when
// LEVersion is 1, else TotalValueOutstanding − ManagementFeeOutstanding (absent fields read as '0').
const PER_UNIT = 'perUnit: (x / s).toFixed(6), ROUND_HALF_UP'
const VALUE = 'value: (u × perUnit).toFixed(0), ROUND_HALF_UP'
const USD = 'usd: (drops / 10^6 × xrpUsd × (1 − fxHaircutBps / 10000)).toFixed(6), ROUND_DOWN'

/**
 * The closed set of formulas a Figure may carry: its input names, its rounding and its text. Data,
 * not code: buildTicket (step 7) applies them, and RECOMPUTE in the browser (step 9) replays them.
 * A recomputation agrees if and only if new Decimal(result).eq(figure.value).
 * @type {Readonly<Record<FormulaId, { unit: Figure['unit'], inputs: readonly string[], rounding: string, text: string }>>}
 */
export const FORMULAS = deepFreeze({
  heldValue: { unit: 'drops', inputs: HELD_INPUTS, rounding: `${PER_UNIT}; ${VALUE}`, text: 'value(perUnit(AssetsTotal − LossUnrealized))' },
  naiveValue: { unit: 'drops', inputs: ['AssetsTotal', 'OutstandingAmount', 'Scale', 'units'], rounding: `${PER_UNIT}; ${VALUE}`, text: 'value(perUnit(AssetsTotal))' },
  n1Overpayment: { unit: 'drops', inputs: HELD_INPUTS, rounding: 'exact, on the two rounded values', text: 'naiveValue − heldValue' },
  cover: { unit: 'drops', inputs: COVER_INPUTS, rounding: 'ceil to a whole drop, then exact', text: 'min(ceil(DebtTotal × CoverRateMinimum/1e5 × CoverRateLiquidation/1e5), exp, CoverAvailable)' },
  heldPerUnitIfDefault: { unit: 'ratio', inputs: IF_DEFAULT_INPUTS, rounding: PER_UNIT, text: 'perUnit(AssetsTotal − (exp − cover) − (LossUnrealized − (lsfLoanImpaired ? exp : 0)))' },
  lossAfterCover: { unit: 'drops', inputs: [...IF_DEFAULT_INPUTS, 'units'], rounding: `exact, on ${VALUE}`, text: '0 if lsfLoanImpaired, else heldValue − value(heldPerUnitIfDefault)' },
  maxLoan: { unit: 'drops', inputs: [...HELD_INPUTS, 'maxLtvBps'], rounding: 'floor: toFixed(0), ROUND_DOWN', text: 'floor(maxLtvBps × heldValue / 10000)' },
  maxUnits: { unit: 'share-units', inputs: ['AssetsTotal', 'LossUnrealized', 'OutstandingAmount', 'Scale', 'maxSingleLoanDrops'], rounding: `${PER_UNIT}; floor: toFixed(0), ROUND_DOWN`, text: 'floor(maxSingleLoanDrops × 10^Scale / perUnit(AssetsTotal − LossUnrealized))' },
  requested: { unit: 'drops', inputs: ['principalDrops'], rounding: 'exact', text: 'principalDrops' },
  ltvHeld: { unit: 'bps', inputs: [...HELD_INPUTS, 'principalDrops'], rounding: 'floor: toFixed(0), ROUND_DOWN', text: 'floor(principalDrops × 10000 / heldValue)' },
  lender1to1: { unit: 'bps', inputs: ['principalDrops', 'units', 'Scale'], rounding: 'floor: toFixed(0), ROUND_DOWN', text: 'floor(principalDrops × 10000 / (units / 10^Scale))' },
  cashAvailable: { unit: 'drops', inputs: ['AssetsAvailable'], rounding: 'exact', text: 'AssetsAvailable' },
  claim: { unit: 'drops', inputs: HELD_INPUTS, rounding: `${PER_UNIT}; ${VALUE}`, text: 'value(perUnit(AssetsTotal − LossUnrealized)), as heldValue' },
  lockedUntil: { unit: 'seconds', inputs: ['RedemptionDate', 'close_time'], rounding: 'exact (two Ripple times)', text: 'RedemptionDate − close_time' },
  // step 21 (addendum A11): a loan in the test dollar against the same shares; usd(d) = (d / 10^6 × xrpUsd ×
  // (1 − fxHaircutBps / 10000)).toFixed(6), ROUND_DOWN, on a whole number of drops d
  collateralHeldUsd: { unit: 'usd', inputs: USD_HELD_INPUTS, rounding: `${PER_UNIT}; ${VALUE}; ${USD}`, text: 'usd(heldValue)' },
  maxLoanUsd: { unit: 'usd', inputs: [...USD_HELD_INPUTS, 'maxLtvBps'], rounding: `${PER_UNIT}; ${VALUE}; ${USD}; (maxLtvBps × collateralHeldUsd / 10000).toFixed(6), ROUND_DOWN`, text: 'maxLtvBps × usd(heldValue) / 10000' },
  requestedUsd: { unit: 'usd', inputs: ['principalUsd'], rounding: 'exact', text: 'principalUsd' },
  ltvHeldUsd: { unit: 'bps', inputs: [...USD_HELD_INPUTS, 'principalUsd'], rounding: `${PER_UNIT}; ${VALUE}; ${USD}; floor: toFixed(0), ROUND_DOWN`, text: 'floor(principalUsd × 10000 / usd(heldValue))' },
  lender1to1Usd: { unit: 'bps', inputs: ['principalUsd', 'units', 'Scale', 'xrpUsd', 'fxHaircutBps'], rounding: `${USD}; floor: toFixed(0), ROUND_DOWN`, text: 'floor(principalUsd × 10000 / usd(units / 10^Scale))' },
  priceAge: { unit: 'seconds', inputs: ['close_time', 'priceAsOf'], rounding: 'exact (two Ripple times)', text: 'close_time − priceAsOf' },
})

/**
 * Keys whose value is an amount: a decimal string (or, for moneyEffect, null or { value, unit }),
 * never a JSON number, at any depth of an NYC document.
 */
export const AMOUNT_FIELDS = Object.freeze([
  'value', 'units', 'tolerance', 'perUnitHeld', 'perUnitNaive', 'maxSingleLoanDrops', 'maxN2LossDrops',
  'coverOrderCostDrops', 'sharesHeld', 'principalDrops', 'principalOutstanding', 'collateralHeldDrops',
  'threshold', 'moneyEffect',
  // step 21
  'requestedUsd', 'collateralHeldUsd', 'maxSingleLoanUsd', 'principalOutstandingUsd', 'collateralValueUsd',
])

// --- canonical form and hashes -----------------------------------------------------------------------

/**
 * JSON with keys sorted recursively and no spaces: the form every orma hash is taken over. Keys whose
 * value is undefined are left out, as JSON.stringify does; a value with toJSON (a Decimal) is read
 * through it.
 * @param {unknown} v
 * @returns {string}
 */
export function canonical(v) {
  if (v !== null && typeof v === 'object' && typeof (/** @type {any} */ (v).toJSON) === 'function') return canonical(/** @type {any} */ (v).toJSON())
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new TypeError(`canonical: a ${typeof v} has no JSON form`)
  if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError(`canonical: ${v} has no JSON form`)
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`
  const o = /** @type {Record<string, unknown>} */ (v)
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

/**
 * @param {string} str
 * @returns {string} lowercase hex
 */
export function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex')
}

const MANDATE_KEYS = ['schema', 'id', 'desk', 'riskOfficer', 'limits', 'policy', 'issuedAt']

/**
 * The hash of a mandate: over its orma.mandate/1 keys only, without hash, anchorTx, the envelope
 * (serverTime, ledgerIndex) or the deskPlan sister key.
 * @param {Partial<Mandate>} m
 * @returns {string}
 */
export function mandateHash(m) {
  return sha256Hex(canonical(Object.fromEntries(MANDATE_KEYS.map((k) => [k, /** @type {any} */ (m)[k]]))))
}

/**
 * The hash of a decision log entry: over the entry without its hash.
 * @param {Partial<Decision>} entry
 * @returns {string}
 */
export function decisionHash(entry) {
  const { hash: _ignored, ...rest } = /** @type {any} */ (entry)
  void _ignored
  return sha256Hex(canonical(rest))
}

// --- margin calls (step 20, addendum A11) -------------------------------------------------------------

/**
 * @typedef {{
 *   schema: 'orma.marginpolicy/1', id: string, mandateHash: string, trigger: 'maxLtvBps', cureSeconds: number,
 *   realWorldNote: string, cureAction: 'pledgeEscrow', afterExpiry: string, issuedAt: string, hash: string, anchorTx: string
 * }} MarginPolicy
 * @typedef {{
 *   status: 'NONE'|'ISSUED'|'CURED'|'EXPIRED', loanId: string,
 *   issuedLedger: number|null, issuedAt: string|null, cureBy: string|null,
 *   ltvHeldBps: number|null, maxLtvBps: number,
 *   shortfall: { collateralValueDrops: string, sharesToAdd: string, withdrawalValuePerShare: string }|null,
 *   reasons: string[], provenance: 'DECLARED', ledgerIndex: number, ledgerHash: string,
 *   entryHash?: string, triggerTx?: string
 * }} MarginCall
 * @typedef {{
 *   seq: number, prevHash: string, kind: 'margin-call', status: 'ISSUED'|'CURED'|'EXPIRED', loanId: string,
 *   mandateHash: string, policyHash: string, issuedLedger: number, issuedAt: string, cureBy: string, ltvHeldBps: number|null, maxLtvBps: number,
 *   ledgerIndex: number, ledgerHash: string, hash: string, shortfall?: MarginCall['shortfall']
 * }} MarginCallEntry
 */

export const MARGIN_STATUSES = Object.freeze(['NONE', 'ISSUED', 'CURED', 'EXPIRED'])
/** The three Feed types a margin call adds to the closed set: DECLARED, one per logged transition. */
export const MARGIN_FEED_TYPES = Object.freeze({ ISSUED: 'MARGIN_CALL_ISSUED', CURED: 'MARGIN_CALL_CURED', EXPIRED: 'MARGIN_CALL_EXPIRED' })

const MARGIN_POLICY_KEYS = ['schema', 'id', 'mandateHash', 'trigger', 'cureSeconds', 'realWorldNote', 'cureAction', 'afterExpiry', 'issuedAt']

/**
 * The hash of a margin policy, as for the mandate: over its orma.marginpolicy/1 keys only, without hash,
 * anchorTx or an envelope.
 * @param {Partial<MarginPolicy>} p
 * @returns {string}
 */
export function marginPolicyHash(p) {
  return sha256Hex(canonical(Object.fromEntries(MARGIN_POLICY_KEYS.map((k) => [k, /** @type {any} */ (p)[k]]))))
}

// --- USD loans (step 21, addendum A11) ---------------------------------------------------------------

/**
 * The risk officer declares which price sources the desk trusts and how it uses them, never a price: the
 * XRP/USD price is the median of the XLS-47 Oracle documents the terms name, read at the ledger of the
 * decision, fresh ones only, and the ledger's own get_aggregate_price over the same documents at that
 * ledger must agree (src/fx/price.mjs). On Devnet the documents are relayed from public exchange quotes by a
 * test account of the desk, standing in for independent oracle providers; on mainnet the terms name those
 * providers and no code changes.
 * @typedef {{ currency: 'USD', issuer: string, label: string }} LoanAsset
 * @typedef {{ account: string, documentId: number, provider: string, uri: string }} OracleSource
 * @typedef {{
 *   baseAsset: 'XRP', quoteAsset: 'USD', sources: OracleSource[], aggregation: 'median',
 *   minSources: number, maxAgeSeconds: number, maxSpreadBps: number, note: string
 * }} XrpUsdOracle
 * @typedef {{
 *   schema: 'orma.usdterms/1', id: string, mandateHash: string, loanAsset: LoanAsset, xrpUsdOracle: XrpUsdOracle,
 *   fxHaircutBps: number, maxSingleLoanUsd: string, issuedAt: string, hash: string, anchorTx: string
 * }} UsdTerms
 * @typedef {OracleSource & { price: string|null, lastUpdateTime: string|null, ageSeconds: string|null, fresh: boolean, used: boolean, ledgerIndex: number, ledgerHash: string }} OracleRead
 * @typedef {{
 *   value: string, provenance: 'REAL', method: string, asOf: string, ageSeconds: string, sources: OracleRead[],
 *   spreadBps: number, maxSpreadBps: number, minSources: number, maxAgeSeconds: number,
 *   ledgerAggregate: { median: string, size: number, ledgerIndex: number, ledgerHash: string }, note: string
 * }} UsdReference
 * @typedef {{ id: string, hash: string, anchorTx: string, fxHaircutBps: number, maxSingleLoanUsd: string }} UsdTermsRef
 * @typedef {{
 *   loanAsset: LoanAsset, requestedUsd: string, collateralHeldUsd: string, ltvHeldBps: number,
 *   reference: UsdReference, terms: UsdTermsRef, collateralRule: string
 * }} TicketUsd
 * @typedef {{
 *   loanAsset: LoanAsset|null, principalOutstandingUsd: string, collateralHeldUsd: string|null, ltvHeldBps: number|null,
 *   reference: UsdReference|null, terms: UsdTermsRef|null, priceUnavailable?: string
 * }} PositionUsd
 */

/** XLS-47 LastUpdateTime is UNIX seconds; a ledger's close_time is Ripple seconds, this many later. */
export const RIPPLE_EPOCH_OFFSET = 946684800

/** The words every surface puts on the dollar, whole: it is never called RLUSD alone. */
export const USD_LABEL = 'test dollar, stands in for RLUSD (Devnet)'
/** The line a USD ticket carries: the loan's currency changes, never the collateral (I4). */
export const USD_COLLATERAL_RULE = 'Collateral: shares of XRP vaults only. An issued asset can be clawed back or frozen by its issuer.'
/** The six figures a USD pledge ticket carries instead of maxLoan, requested, ltvHeld and lender1to1. */
export const USD_FIGURES = Object.freeze(['maxLoanUsd', 'requestedUsd', 'collateralHeldUsd', 'ltvHeldUsd', 'lender1to1Usd', 'priceAge'])
const XRP_LOAN_FIGURES = ['maxLoan', 'requested', 'ltvHeld', 'lender1to1']

const USD_TERMS_KEYS = ['schema', 'id', 'mandateHash', 'loanAsset', 'xrpUsdOracle', 'fxHaircutBps', 'maxSingleLoanUsd', 'issuedAt']

/**
 * The median of a set of decimal prices, exact: the middle one, or the mean of the two middle ones, as
 * get_aggregate_price computes it. Pure.
 * @param {string[]} prices
 * @returns {string}
 */
export function medianOf(prices) {
  const s = prices.map((p) => num(p)).sort((a, b) => a.cmp(b))
  if (s.length === 0) throw new RangeError('no price: no median')
  const mid = Math.floor(s.length / 2)
  return (s.length % 2 ? s[mid] : s[mid - 1].plus(s[mid]).div(2)).toFixed()
}

/** The spread of a set of prices around their median, in whole bps, rounded up: ceil((max − min) × 10000 / median). */
export function spreadBpsOf(prices) {
  const s = prices.map((p) => num(p)).sort((a, b) => a.cmp(b))
  const m = num(medianOf(prices))
  return m.isZero() ? Infinity : JSON.parse(s.at(-1).minus(s[0]).times(10000).div(m).ceil().toFixed(0))
}

/**
 * The hash of the USD terms, as for the mandate: over their orma.usdterms/1 keys only, without hash,
 * anchorTx or an envelope.
 * @param {Partial<UsdTerms>} t
 * @returns {string}
 */
export function usdTermsHash(t) {
  return sha256Hex(canonical(Object.fromEntries(USD_TERMS_KEYS.map((k) => [k, /** @type {any} */ (t)[k]]))))
}

/**
 * An issued-currency amount as rippled reads it: the currency, its issuer and the value as a decimal
 * string. A number, an exponent or an empty value is refused, never coerced.
 * @param {string} value
 * @param {string} issuer
 * @returns {{ currency: 'USD', issuer: string, value: string }}
 */
export function usdAmount(value, issuer) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new TypeError(`a USD amount is a decimal string, not ${JSON.stringify(value)}`)
  if (typeof issuer !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer)) throw new TypeError(`a USD amount names its issuer, not ${JSON.stringify(issuer)}`)
  return { currency: 'USD', issuer, value }
}

// --- manager statements (orma.stmt/1 in Vault.Data) ----------------------------------------------------

export const STATEMENT_SCHEMA = 'orma.stmt/1'
export const STATEMENT_KINDS = Object.freeze(['impaired', 'defaulted', 'repaid', 'note'])
export const STATEMENT_MAX_TEXT = 120
export const STATEMENT_MAX_BYTES = 256 // VaultSet.cpp:35-41, Protocol.h:302 kMaxDataPayloadLength
const LSF_LOAN_DEFAULT = 0x00010000 // LedgerFormats.h:205
const LSF_LOAN_IMPAIRED = 0x00020000 // LedgerFormats.h:206

const HEX64 = /^[0-9A-Fa-f]{64}$/
const HEX48 = /^[0-9A-Fa-f]{48}$/

/**
 * The problems of a statement document, empty when it is a valid orma.stmt/1.
 * @param {unknown} doc
 * @returns {string[]}
 */
function stmtProblems(doc) {
  if (!isPlainObject(doc)) return ['the statement is not an object']
  const d = /** @type {Record<string, unknown>} */ (doc)
  const out = []
  for (const k of Object.keys(d)) if (!['s', 'loan', 'kind', 'text', 'at'].includes(k)) out.push(`unknown key ${k}`)
  if (d.s !== STATEMENT_SCHEMA) out.push(`s is not ${STATEMENT_SCHEMA}`)
  if (!STATEMENT_KINDS.includes(/** @type {string} */ (d.kind))) out.push(`kind is not one of ${STATEMENT_KINDS.join(', ')}`)
  if ('loan' in d && !(typeof d.loan === 'string' && HEX64.test(d.loan))) out.push('loan is not 64 hex characters')
  const chars = typeof d.text === 'string' ? [...d.text].length : 0
  if (typeof d.text !== 'string' || chars === 0) out.push('text is empty')
  else if (chars > STATEMENT_MAX_TEXT) out.push(`text has ${chars} characters, more than ${STATEMENT_MAX_TEXT}`)
  if (!Number.isSafeInteger(d.at) || /** @type {number} */ (d.at) < 0) out.push('at is not a whole number of Ripple seconds')
  return out
}

/** The document in its encoding order: s, loan, kind, text, at. */
function orderedStatement(/** @type {any} */ d) {
  return { s: d.s, ...('loan' in d ? { loan: d.loan } : {}), kind: d.kind, text: d.text, at: d.at }
}

/**
 * Encode a manager statement for Vault.Data: compact UTF-8 JSON in the order s, loan, kind, text, at,
 * then uppercase hex. Throws on a document Vault.Data would refuse or orma.stmt/1 does not admit.
 * @param {StatementDoc} doc
 * @returns {string}
 */
export function encodeStatement(doc) {
  const problems = stmtProblems(doc)
  if (problems.length) throw new RangeError(`not an ${STATEMENT_SCHEMA} document: ${problems.join('; ')}`)
  const bytes = Buffer.from(JSON.stringify(orderedStatement(doc)), 'utf8')
  if (bytes.length > STATEMENT_MAX_BYTES) throw new RangeError(`the statement is ${bytes.length} bytes, more than the ${STATEMENT_MAX_BYTES} Vault.Data holds`)
  return bytes.toString('hex').toUpperCase()
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Decode Vault.Data. Null for anything that is not a valid orma.stmt/1 (bad hex, bad UTF-8, bad JSON,
 * bad fields, too long): a statement is either readable or UNPARSEABLE, never half-read.
 * @param {unknown} hex
 * @returns {StatementDoc|null}
 */
export function parseStatement(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length > STATEMENT_MAX_BYTES * 2 || !/^(?:[0-9A-Fa-f]{2})+$/.test(hex)) return null
  let doc
  try {
    doc = JSON.parse(UTF8.decode(Buffer.from(hex, 'hex')))
  } catch {
    return null
  }
  return stmtProblems(doc).length ? null : /** @type {StatementDoc} */ (orderedStatement(doc))
}

/** A loan as the Reader normalises it ({ loanId, flags, paymentRemaining }) or as the ledger has it. */
function loanFacts(/** @type {any} */ l) {
  const id = String(l?.loanId ?? l?.index ?? l?.LedgerIndex ?? '').toUpperCase()
  const flags = Number(l?.flags ?? l?.Flags ?? 0) >>> 0
  const remaining = num(l?.paymentRemaining ?? l?.PaymentRemaining)
  return { id, flags, remaining, label: typeof l?.label === 'string' ? l.label : `loan ${id.slice(0, 8)}…` }
}

/**
 * Judge a statement against the loans of its vault read at one ledger. Pure. A note, a statement that
 * names no loan, or a repaid loan already deleted cannot be checked; an unreadable Data is UNPARSEABLE.
 * @param {StatementDoc|null} doc
 * @param {readonly unknown[]} loans the loans under this vault at `at`
 * @param {{ ledgerIndex: number, ledgerHash: string }} at
 * @returns {StatementCheck}
 */
export function statementConsistency(doc, loans, at) {
  const out = (/** @type {StatementCheck['status']} */ status, /** @type {string} */ detail) => ({ status, detail, provenance: /** @type {const} */ ('REAL'), ledgerIndex: at.ledgerIndex, ledgerHash: at.ledgerHash })
  if (doc === null || doc === undefined || stmtProblems(doc).length) return out('UNPARSEABLE', 'Vault.Data is not a valid orma.stmt/1 document')
  if (doc.kind === 'note') return out('NOT_CHECKABLE', 'a note asserts nothing the ledger can check')
  if (!doc.loan) return out('NOT_CHECKABLE', 'the statement names no loan')
  const want = doc.loan.toUpperCase()
  const loan = (loans ?? []).map(loanFacts).find((l) => l.id === want)
  const L = at.ledgerIndex
  if (doc.kind === 'impaired' || doc.kind === 'defaulted') {
    const [flag, name] = doc.kind === 'impaired' ? [LSF_LOAN_IMPAIRED, 'lsfLoanImpaired'] : [LSF_LOAN_DEFAULT, 'lsfLoanDefault']
    if (!loan) return out('INCONSISTENT', `loan ${want.slice(0, 8)}… is not under this vault at ledger ${L}`)
    return (loan.flags & flag) !== 0
      ? out('CONSISTENT', `${loan.label} carries ${name} at ledger ${L}`)
      : out('INCONSISTENT', `${loan.label} does not carry ${name} at ledger ${L}`)
  }
  // repaid
  if (!loan) return out('NOT_CHECKABLE', `loan ${want.slice(0, 8)}… is no longer on the ledger at ${L}: a LoanDelete removes repaid and defaulted loans alike`)
  if ((loan.flags & LSF_LOAN_DEFAULT) !== 0) return out('INCONSISTENT', `${loan.label} carries lsfLoanDefault at ledger ${L}`)
  return loan.remaining.isZero()
    ? out('CONSISTENT', `${loan.label} has no payment remaining and no default at ledger ${L}`)
    : out('INCONSISTENT', `${loan.label} still has ${loan.remaining.toFixed(0)} payments remaining at ledger ${L}`)
}

// --- the 2-of-3 collateral account ---------------------------------------------------------------------

export const COLLATERAL_POLICY = deepFreeze({ quorum: 2, weight: 1, roles: ['borrower', 'desk', 'agent'] })

/**
 * The states a collateral account is judged in, counting pledge escrows only (Account = the borrower,
 * Amount an MPT amount of the pledged share): free (pool, before a pledge), pledged (exactly one pledge
 * escrow, the named one, shares still with the borrower), structural (the structure alone, after the
 * escrow was finished or cancelled).
 */
export const COLLATERAL_STAGES = deepFreeze({
  free: { expectEscrows: 0, expectShares: 'none' },
  pledged: { expectEscrows: 'named', expectShares: 'none' },
  structural: { expectEscrows: 'any', expectShares: 'any' },
})

const LSF_DISABLE_MASTER = 0x00100000
const LSF_DEPOSIT_AUTH = 0x01000000 // LedgerFormats.h:146

const hasFlag = (/** @type {unknown} */ flags, /** @type {number} */ mask) => ((Number(flags ?? 0) >>> 0) & mask) !== 0
const sameId = (/** @type {unknown} */ a, /** @type {unknown} */ b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()

/** An escrow is a pledge when the borrower created it and it holds the pledged share. */
function isPledgeEscrow(/** @type {any} */ e, /** @type {string} */ borrower, /** @type {string} */ shareMptId) {
  return e?.Account === borrower && isPlainObject(e?.Amount) && sameId(e.Amount.mpt_issuance_id, shareMptId)
}

/**
 * Derive a collateral account's state from its live objects first: a live pledge escrow → pledged
 * (its index named; several → pledged and none named, which the judge refuses); else shares held, or
 * a pledge EscrowCreate in its history → structural; else free. A third party's escrow counts for
 * nothing. Pure.
 * @param {{ escrows?: readonly any[], mptoken?: any, pledges?: readonly { account: string }[] }} objects
 * @param {{ borrower: string, shareMptId: string }} who
 * @returns {{ stage: 'free'|'pledged'|'structural', namedEscrow: string|null }}
 */
export function collateralStageOf({ escrows = [], mptoken = null, pledges = [] }, { borrower, shareMptId }) {
  const live = escrows.filter((e) => isPledgeEscrow(e, borrower, shareMptId))
  if (live.length === 1) return { stage: 'pledged', namedEscrow: String(live[0].index) }
  if (live.length > 1) return { stage: 'pledged', namedEscrow: null }
  if (num(mptoken?.MPTAmount).gt(0)) return { stage: 'structural', namedEscrow: null }
  if (pledges.some((p) => p?.account === borrower)) return { stage: 'structural', namedEscrow: null }
  return { stage: 'free', namedEscrow: null }
}

/**
 * Judge a 2-of-3 collateral account read at one ledger: its structure always (master key disabled, no
 * regular key, quorum 2, signers {borrower, desk, agent} of weight 1, an MPToken of the pledged share,
 * OwnerCount 2, no lsfDepositAuth), and its use in the expected state, counting pledge escrows only.
 * One English reason per departure. Pure.
 * @param {{ accountRoot: any, signerList: any, mptoken: any, escrows?: readonly any[] }} objects
 * @param {{ borrower: string, desk: string, agent: string, shareMptId: string, expectEscrows: 0|'named'|'any', expectShares: 'none'|'any', namedEscrow?: string|null }} expect
 * @returns {{ conforming: boolean, reasons: string[] }}
 */
export function judgeCollateralAccount({ accountRoot, signerList, mptoken, escrows = [] }, { borrower, desk, agent, shareMptId, expectEscrows, expectShares, namedEscrow = null }) {
  if (![0, 'named', 'any'].includes(/** @type {any} */ (expectEscrows))) throw new TypeError(`expectEscrows must be 0, 'named' or 'any', got ${JSON.stringify(expectEscrows)}`)
  if (!['none', 'any'].includes(expectShares)) throw new TypeError(`expectShares must be 'none' or 'any', got ${JSON.stringify(expectShares)}`)
  if (!accountRoot) return { conforming: false, reasons: ['collateral account not found'] }
  const reasons = []
  if (!hasFlag(accountRoot.Flags, LSF_DISABLE_MASTER)) reasons.push('master key enabled')
  if (accountRoot.RegularKey) reasons.push('regular key set')
  if (Number(signerList?.SignerQuorum ?? 0) !== COLLATERAL_POLICY.quorum) reasons.push('quorum is not 2')
  const entries = (signerList?.SignerEntries ?? []).map((/** @type {any} */ e) => e?.SignerEntry ?? e)
  const accounts = entries.map((/** @type {any} */ e) => e?.Account)
  const want = [borrower, desk, agent]
  if (accounts.length !== 3 || new Set(accounts).size !== 3 || !want.every((a) => typeof a === 'string' && accounts.includes(a))) reasons.push('signers are not {borrower, desk, Orma agent}')
  if (entries.some((/** @type {any} */ e) => Number(e?.SignerWeight) !== COLLATERAL_POLICY.weight)) reasons.push('signer weight is not 1')
  if (!mptoken || !sameId(mptoken.MPTokenIssuanceID, shareMptId) || (mptoken.Account && mptoken.Account !== accountRoot.Account)) reasons.push('no MPToken for the pledged share')
  if (Number(accountRoot.OwnerCount ?? 0) !== 2) reasons.push('account holds other ledger objects (delegate, ticket, …)')
  const pledges = escrows.filter((e) => isPledgeEscrow(e, borrower, shareMptId))
  if (expectEscrows === 0 && pledges.length > 0) reasons.push('account already used by another pledge')
  if (expectEscrows === 'named' && (pledges.length !== 1 || (namedEscrow && !sameId(pledges[0].index, namedEscrow)))) reasons.push('account already used by another pledge')
  if (expectShares === 'none' && num(mptoken?.MPTAmount).gt(0)) reasons.push('collateral account already holds shares')
  if (hasFlag(accountRoot.Flags, LSF_DEPOSIT_AUTH)) reasons.push('deposit authorization enabled')
  return { conforming: reasons.length === 0, reasons }
}

// --- the pledged share (the seam table, honest refusal) -----------------------------------------------

const LSF_MPT_LOCKED = 0x00000001
const LSF_MPT_CAN_LOCK = 0x00000002
const LSF_MPT_CAN_CLAWBACK = 0x00000040
/** lsfMPTCanEscrow | lsfMPTCanTrade | lsfMPTCanTransfer: what VaultCreate.cpp:212-214 sets on a public vault with transferable shares. */
export const PROVEN_SHARE_FLAGS = 0x00000038

/**
 * Whether the desk accepts a share as collateral. An acceptance list, not a refusal list: the share is
 * eligible only if it ticks every proven line of the seam table (an XRP vault, closed-ended, issuance
 * flags exactly 0x38 outside the lock and clawback bits, nothing locked); anything else is refused with
 * its reason, never tried. Pure.
 * @param {{ vault: any, issuance: any, mptoken: any }} objects
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
export function judgeCollateralShare({ vault, issuance, mptoken }) {
  const reasons = []
  const asset = vault?.Asset
  const xrp = isPlainObject(asset) && asset.currency === 'XRP' && asset.issuer === undefined && asset.mpt_issuance_id === undefined
  if (!xrp) reasons.push('vault asset is not XRP: its issuer can claw it back or freeze it')
  const flags = Number(issuance?.Flags ?? 0) >>> 0
  if (flags & LSF_MPT_LOCKED) reasons.push('share issuance is locked')
  if (hasFlag(mptoken?.Flags, LSF_MPT_LOCKED)) reasons.push('pledged shares are locked')
  if (flags & (LSF_MPT_CAN_LOCK | LSF_MPT_CAN_CLAWBACK)) reasons.push('share issuance can be locked or clawed back')
  if ((flags & ~(LSF_MPT_LOCKED | LSF_MPT_CAN_LOCK | LSF_MPT_CAN_CLAWBACK)) >>> 0 !== PROVEN_SHARE_FLAGS) reasons.push('share issuance flags are outside the proven set')
  if (Number(vault?.VaultKind ?? 0) !== 1) reasons.push('vault is not closed-ended')
  return { eligible: reasons.length === 0, reasons }
}

// --- validators ------------------------------------------------------------------------------------

const DEC = /^-?\d+(?:\.\d+)?$/
const UINT = /^\d+$/
const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/
const CURSOR = /^(\d{19})-(\d+)$/

/** @returns {value is Record<string, any>} */
function isPlainObject(/** @type {unknown} */ value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The rules that hold at any depth of every NYC document: no `grade` key, and no amount typed as a
 * JSON number.
 */
function deepProblems(/** @type {unknown} */ v, /** @type {string} */ path, /** @type {string[]} */ out) {
  if (Array.isArray(v)) v.forEach((x, i) => deepProblems(x, `${path}[${i}]`, out))
  else if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k
      if (k === 'grade') out.push(`${p}: a grade key is not allowed in an NYC document`)
      if (AMOUNT_FIELDS.includes(k) && typeof x === 'number') out.push(`${p} is a number: amounts are decimal strings`)
      deepProblems(x, p, out)
    }
  }
}

/** A small rule writer over one document. */
function rules(/** @type {string[]} */ out) {
  const at = (/** @type {string} */ path, /** @type {string} */ what) => out.push(`${path || 'document'} ${what}`)
  return {
    obj(/** @type {unknown} */ v, /** @type {string} */ p) { if (!isPlainObject(v)) { at(p, 'is not an object'); return false } return true },
    arr(/** @type {unknown} */ v, /** @type {string} */ p) { if (!Array.isArray(v)) { at(p, 'is not an array'); return false } return true },
    str(/** @type {unknown} */ v, /** @type {string} */ p) { if (typeof v !== 'string' || v.length === 0) at(p, 'is not a non-empty string') },
    bool(/** @type {unknown} */ v, /** @type {string} */ p) { if (typeof v !== 'boolean') at(p, 'is not a boolean') },
    int(/** @type {unknown} */ v, /** @type {string} */ p) { if (!Number.isSafeInteger(v) || /** @type {number} */ (v) < 0) at(p, 'is not a whole number') },
    re(/** @type {unknown} */ v, /** @type {RegExp} */ r, /** @type {string} */ p, /** @type {string} */ what) { if (typeof v !== 'string' || !r.test(v)) at(p, `is not ${what}`) },
    dec(/** @type {unknown} */ v, /** @type {string} */ p) { if (typeof v !== 'string' || !DEC.test(v)) at(p, 'is not a decimal string') },
    oneOf(/** @type {unknown} */ v, /** @type {readonly unknown[]} */ set, /** @type {string} */ p) { if (!set.includes(v)) at(p, `is not one of ${set.join(', ')}`) },
    eq(/** @type {unknown} */ v, /** @type {unknown} */ want, /** @type {string} */ p) { if (v !== want) at(p, `is not ${JSON.stringify(want)}`) },
    absent(/** @type {any} */ o, /** @type {string} */ k, /** @type {string} */ p, /** @type {string} */ why) { if (isPlainObject(o) && k in o) at(p ? `${p}.${k}` : k, `must be absent ${why}`) },
    fail(/** @type {string} */ p, /** @type {string} */ what) { at(p, what) },
  }
}

const hex64 = (/** @type {ReturnType<typeof rules>} */ r, /** @type {unknown} */ v, /** @type {string} */ p) => r.re(v, HEX64, p, '64 hex characters')
const ledgerAt = (/** @type {ReturnType<typeof rules>} */ r, /** @type {any} */ o, /** @type {string} */ p) => {
  r.int(o?.ledgerIndex, `${p ? `${p}.` : ''}ledgerIndex`)
  hex64(r, o?.ledgerHash, `${p ? `${p}.` : ''}ledgerHash`)
}

/**
 * A Figure: a decimal value in its formula's unit, a formula from FORMULAS, and exactly that formula's
 * inputs, each read at one ledger (the document's, when one is given).
 */
function figureInto(/** @type {string[]} */ out, /** @type {any} */ f, /** @type {string} */ p, /** @type {{ ledgerIndex: number, ledgerHash: string }|null} */ L = null) {
  const r = rules(out)
  if (!r.obj(f, p)) return
  if (typeof f.value === 'number') r.fail(`${p}.value`, 'is a number: amounts are decimal strings')
  else r.dec(f.value, `${p}.value`)
  r.oneOf(f.unit, ['drops', 'share-units', 'ratio', 'seconds', 'bps', 'usd'], `${p}.unit`)
  r.str(f.meaning, `${p}.meaning`)
  r.str(f.formula, `${p}.formula`)
  r.oneOf(f.provenance, ['REAL', 'DECLARED', 'MODELLED', 'SIMULATED'], `${p}.provenance`)
  const formula = Object.hasOwn(FORMULAS, f.formulaId) ? FORMULAS[/** @type {FormulaId} */ (f.formulaId)] : null
  if (!formula) r.fail(`${p}.formulaId`, 'is not a key of FORMULAS')
  else if (f.unit !== formula.unit) r.fail(`${p}.unit`, `is not ${formula.unit}, the unit of ${f.formulaId}`)
  if (!r.arr(f.inputs, `${p}.inputs`)) return
  if (f.inputs.length === 0) r.fail(`${p}.inputs`, 'is empty')
  f.inputs.forEach((/** @type {any} */ x, /** @type {number} */ i) => {
    const q = `${p}.inputs[${i}]`
    if (!r.obj(x, q)) return
    r.str(x.name, `${q}.name`)
    if (typeof x.value !== 'string') r.fail(`${q}.value`, 'is not a string')
    r.str(x.object, `${q}.object`)
    r.str(x.field, `${q}.field`)
    r.str(x.id, `${q}.id`)
    ledgerAt(r, x, q)
    if (L && (x.ledgerIndex !== L.ledgerIndex || x.ledgerHash !== L.ledgerHash)) r.fail(q, `is not read at the document's ledger ${L.ledgerIndex}`)
    if (formula && !formula.inputs.includes(x.name)) r.fail(`${q}.name`, `${JSON.stringify(x.name)} is not an input of ${f.formulaId}`)
  })
  if (formula) for (const name of formula.inputs) if (!f.inputs.some((/** @type {any} */ x) => x?.name === name)) r.fail(`${p}.inputs`, `lacks ${name}, an input of ${f.formulaId}`)
}

function verdictInto(/** @type {string[]} */ out, /** @type {any} */ v, /** @type {string} */ p) {
  const r = rules(out)
  if (!r.obj(v, p)) return
  r.oneOf(v.status, ['PASS', 'BREACHED'], `${p}.status`)
  if (!r.arr(v.breaches, `${p}.breaches`)) return
  v.breaches.forEach((/** @type {any} */ b, /** @type {number} */ i) => {
    if (!r.obj(b, `${p}.breaches[${i}]`)) return
    r.str(b.limit, `${p}.breaches[${i}].limit`)
    r.dec(b.value, `${p}.breaches[${i}].value`)
    r.dec(b.threshold, `${p}.breaches[${i}].threshold`)
  })
  if ((v.status === 'PASS') !== (v.breaches.length === 0)) r.fail(`${p}.status`, 'disagrees with its breaches')
}

function moneyEffectInto(/** @type {string[]} */ out, /** @type {any} */ m, /** @type {string} */ p) {
  const r = rules(out)
  if (m === null) return
  if (!r.obj(m, p)) return
  r.dec(m.value, `${p}.value`)
  r.str(m.unit, `${p}.unit`)
}

function statementInto(/** @type {string[]} */ out, /** @type {any} */ s, /** @type {string} */ p) {
  const r = rules(out)
  if (!r.obj(s, p)) return
  r.eq(s.provenance, 'DECLARED', `${p}.provenance`)
  r.re(s.raw, /^(?:[0-9A-Fa-f]{2})+$/, `${p}.raw`, 'hex')
  r.re(s.owner, ADDRESS, `${p}.owner`, 'a classic address')
  if (s.doc !== null) {
    for (const x of stmtProblems(s.doc)) r.fail(`${p}.doc`, x)
    const parsed = parseStatement(s.raw)
    if (parsed && canonical(parsed) !== canonical(s.doc)) r.fail(`${p}.doc`, 'is not what raw decodes to')
    if (!parsed) r.fail(`${p}.raw`, 'does not decode to an orma.stmt/1 although doc is given')
  }
  const c = s.consistency
  if (!r.obj(c, `${p}.consistency`)) return
  r.oneOf(c.status, ['CONSISTENT', 'INCONSISTENT', 'NOT_CHECKABLE', 'UNPARSEABLE'], `${p}.consistency.status`)
  r.str(c.detail, `${p}.consistency.detail`)
  r.eq(c.provenance, 'REAL', `${p}.consistency.provenance`)
  ledgerAt(r, c, `${p}.consistency`)
  if (s.doc === null && c.status !== 'UNPARSEABLE') r.fail(`${p}.consistency.status`, 'is not UNPARSEABLE although doc is null')
}

function changeRowsInto(/** @type {string[]} */ out, /** @type {any} */ rows, /** @type {string} */ p, /** @type {boolean} */ realised) {
  const r = rules(out)
  if (!r.arr(rows, p)) return
  rows.forEach((/** @type {any} */ row, /** @type {number} */ i) => {
    const q = `${p}[${i}]`
    if (!r.obj(row, q)) return
    if (r.obj(row.object, `${q}.object`)) {
      r.str(row.object.type, `${q}.object.type`)
      hex64(r, row.object.index, `${q}.object.index`)
    }
    r.str(row.field, `${q}.field`)
    r.oneOf(row.admitted, ['YES', 'HIDDEN'], `${q}.admitted`)
    if (r.obj(row.rule, `${q}.rule`)) {
      r.eq(row.rule.source, 'rippled 3.4.1', `${q}.rule.source`)
      r.re(row.rule.file, /^[^/\\]+$/, `${q}.rule.file`, 'a base file name')
      if (!Number.isSafeInteger(row.rule.line) || row.rule.line < 1) r.fail(`${q}.rule.line`, 'is not a line number')
    }
    moneyEffectInto(out, row.moneyEffect, `${q}.moneyEffect`)
    if (realised) r.oneOf(row.verdict, ['MATCH', 'MISMATCH'], `${q}.verdict`)
    else if ('verdict' in row) r.oneOf(row.verdict, ['MATCH', 'MISMATCH'], `${q}.verdict`)
  })
}

/** @param {unknown} doc @returns {string[]} */
function validateTicket(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const t = /** @type {any} */ (doc)
  r.eq(t.schema, 'orma.ticket/1', 'schema')
  hex64(r, t.ticketId, 'ticketId')
  hex64(r, t.inputsDigest, 'inputsDigest')
  r.str(t.asOf, 'asOf')
  ledgerAt(r, t, '')
  r.oneOf(t.op, ['pledge', 'buy'], 'op')
  if (r.obj(t.share, 'share')) {
    r.re(t.share.mptId, HEX48, 'share.mptId', '48 hex characters')
    hex64(r, t.share.vaultId, 'share.vaultId')
    r.re(t.share.units, UINT, 'share.units', 'a whole number string')
    r.int(t.share.shareScale, 'share.shareScale')
  }
  if (r.obj(t.mandate, 'mandate')) {
    r.str(t.mandate.id, 'mandate.id')
    hex64(r, t.mandate.hash, 'mandate.hash')
    hex64(r, t.mandate.anchorTx, 'mandate.anchorTx')
  }
  const L = { ledgerIndex: t.ledgerIndex, ledgerHash: t.ledgerHash }
  const f = t.figures
  if (r.obj(f, 'figures')) {
    for (const k of ['heldValue', 'naiveValue', 'n1Overpayment']) figureInto(out, f[k], `figures.${k}`, L)
    if (r.arr(f.n2, 'figures.n2')) {
      f.n2.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
        const q = `figures.n2[${i}]`
        if (!r.obj(e, q)) return
        hex64(r, e.loanId, `${q}.loanId`)
        r.str(e.label, `${q}.label`)
        r.str(e.scenario, `${q}.scenario`)
        for (const k of ['lossAfterCover', 'cover', 'heldPerUnitIfDefault']) figureInto(out, e[k], `${q}.${k}`, L)
        r.bool(e.alreadyInHeld, `${q}.alreadyInHeld`)
        if (e.alreadyInHeld === true && e.lossAfterCover?.value !== '0') r.fail(`${q}.lossAfterCover.value`, 'is not 0 although the loss is already in the withdrawal value')
      })
    }
    if (r.obj(f.n3, 'figures.n3')) {
      for (const k of ['lockedUntil', 'cashAvailable', 'claim']) figureInto(out, f.n3[k], `figures.n3.${k}`, L)
      r.str(f.n3.redemptionAt, 'figures.n3.redemptionAt')
    }
    if (t.op === 'pledge' && 'usd' in t) {
      // step 21: a loan in the test dollar, its loan figures in dollars
      for (const k of USD_FIGURES) figureInto(out, f[k], `figures.${k}`, L)
      for (const k of XRP_LOAN_FIGURES) r.absent(f, k, 'figures', 'on a USD ticket: its loan figures are in dollars')
      r.absent(f, 'maxUnits', 'figures', 'on a pledge ticket')
    } else if (t.op === 'pledge') {
      for (const k of XRP_LOAN_FIGURES) figureInto(out, f[k], `figures.${k}`, L)
      for (const k of USD_FIGURES) r.absent(f, k, 'figures', 'on an XRP ticket')
      r.absent(f, 'maxUnits', 'figures', 'on a pledge ticket')
    }
    if (t.op === 'buy') {
      figureInto(out, f.maxUnits, 'figures.maxUnits', L)
      for (const k of [...XRP_LOAN_FIGURES, ...USD_FIGURES]) r.absent(f, k, 'figures', 'on a buy ticket: the 1:1 column measures a loan')
    }
  }
  if (r.obj(t.conduct, 'conduct')) {
    if (r.arr(t.conduct.recognitionLagSeconds, 'conduct.recognitionLagSeconds')) t.conduct.recognitionLagSeconds.forEach((/** @type {unknown} */ s, /** @type {number} */ i) => r.dec(s, `conduct.recognitionLagSeconds[${i}]`))
    r.int(t.conduct.defaultsWithoutImpairment, 'conduct.defaultsWithoutImpairment')
    r.dec(t.conduct.coverOrderCostDrops, 'conduct.coverOrderCostDrops')
  }
  if (r.obj(t.escrowPolicy, 'escrowPolicy')) for (const k of ['finishAfter', 'cancelAfter', 'text']) r.str(t.escrowPolicy[k], `escrowPolicy.${k}`)
  if (t.statement !== null) statementInto(out, t.statement, 'statement')
  verdictInto(out, t.verdict, 'verdict')
  if (t.op === 'pledge') verdictInto(out, t.verdict1to1, 'verdict1to1')
  if (t.op === 'buy') r.absent(t, 'verdict1to1', '', 'on a buy ticket')
  if ('usd' in t) {
    if (t.op !== 'pledge') r.fail('usd', 'is a loan in dollars: a buy ticket carries none')
    else usdInto(out, t.usd, 'usd', f, L)
  }
  return out
}

/** The usd block of a USD ticket, each number the value of its figure, its price read at the ticket's ledger. */
function usdInto(/** @type {string[]} */ out, /** @type {any} */ u, /** @type {string} */ p, /** @type {any} */ figures, /** @type {{ ledgerIndex: number, ledgerHash: string }|null} */ L = null) {
  const r = rules(out)
  if (!r.obj(u, p)) return
  loanAssetInto(out, u.loanAsset, `${p}.loanAsset`)
  r.dec(u.requestedUsd, `${p}.requestedUsd`)
  r.dec(u.collateralHeldUsd, `${p}.collateralHeldUsd`)
  r.int(u.ltvHeldBps, `${p}.ltvHeldBps`)
  usdReferenceInto(out, u.reference, `${p}.reference`, L)
  usdTermsRefInto(out, u.terms, `${p}.terms`)
  r.eq(u.collateralRule, USD_COLLATERAL_RULE, `${p}.collateralRule`)
  const same = (/** @type {string} */ k, /** @type {unknown} */ v, /** @type {string} */ fig) => {
    if (figures?.[fig] && String(v) !== figures[fig].value) r.fail(`${p}.${k}`, `is not the value of figures.${fig}`)
  }
  same('requestedUsd', u.requestedUsd, 'requestedUsd')
  same('collateralHeldUsd', u.collateralHeldUsd, 'collateralHeldUsd')
  same('ltvHeldBps', u.ltvHeldBps, 'ltvHeldUsd')
  same('reference.ageSeconds', u.reference?.ageSeconds, 'priceAge')
  const xrpUsd = figures?.collateralHeldUsd?.inputs?.find((/** @type {any} */ i) => i?.name === 'xrpUsd')
  if (xrpUsd && u.reference && xrpUsd.value !== u.reference.value) r.fail(`${p}.reference.value`, 'is not the xrpUsd input of the dollar figures')
}

function loanAssetInto(/** @type {string[]} */ out, /** @type {any} */ a, /** @type {string} */ p) {
  const r = rules(out)
  if (!r.obj(a, p)) return
  r.eq(a.currency, 'USD', `${p}.currency`)
  r.re(a.issuer, ADDRESS, `${p}.issuer`, 'a classic address')
  r.eq(a.label, USD_LABEL, `${p}.label`)
}

function oracleSourceInto(/** @type {string[]} */ out, /** @type {any} */ s, /** @type {string} */ p) {
  const r = rules(out)
  if (!r.obj(s, p)) return
  r.re(s.account, ADDRESS, `${p}.account`, 'a classic address')
  r.int(s.documentId, `${p}.documentId`)
  r.str(s.provider, `${p}.provider`)
  r.str(s.uri, `${p}.uri`)
}

/**
 * The XRP/USD price of a dollar figure: REAL, the median of the used sources, each read at one ledger (the
 * document's, when one is given), every used source fresh, at least minSources of them, their spread within
 * maxSpreadBps, and the ledger's get_aggregate_price over them agreeing at that ledger.
 */
function usdReferenceInto(/** @type {string[]} */ out, /** @type {any} */ x, /** @type {string} */ p, /** @type {{ ledgerIndex: number, ledgerHash: string }|null} */ L = null) {
  const r = rules(out)
  if (!r.obj(x, p)) return
  r.dec(x.value, `${p}.value`)
  if (DEC.test(x.value ?? '') && !num(x.value).gt(0)) r.fail(`${p}.value`, 'is not above 0')
  r.eq(x.provenance, 'REAL', `${p}.provenance`)
  r.str(x.method, `${p}.method`)
  r.re(x.asOf, ISO, `${p}.asOf`, 'an ISO 8601 UTC time')
  r.dec(x.ageSeconds, `${p}.ageSeconds`)
  r.int(x.spreadBps, `${p}.spreadBps`)
  r.int(x.maxSpreadBps, `${p}.maxSpreadBps`)
  r.int(x.minSources, `${p}.minSources`)
  r.int(x.maxAgeSeconds, `${p}.maxAgeSeconds`)
  r.str(x.note, `${p}.note`)
  if (!r.arr(x.sources, `${p}.sources`)) return
  x.sources.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    const q = `${p}.sources[${i}]`
    oracleSourceInto(out, s, q)
    r.bool(s?.fresh, `${q}.fresh`)
    r.bool(s?.used, `${q}.used`)
    ledgerAt(r, s, q)
    if (L && (s?.ledgerIndex !== L.ledgerIndex || s?.ledgerHash !== L.ledgerHash)) r.fail(q, `is not read at the document's ledger ${L.ledgerIndex}`)
    if (s?.price !== null) r.dec(s?.price, `${q}.price`)
    if (s?.used && !s?.fresh) r.fail(`${q}.used`, 'is a stale source')
    if (s?.used && (s.price === null || !DEC.test(s.ageSeconds ?? '') || num(s.ageSeconds).gt(x.maxAgeSeconds ?? 0) || num(s.ageSeconds).lt(0))) r.fail(`${q}.ageSeconds`, 'is older than maxAgeSeconds, or dated after the ledger, on a used source')
  })
  const used = x.sources.filter((/** @type {any} */ s) => s?.used && DEC.test(s?.price ?? ''))
  if (Number.isSafeInteger(x.minSources) && used.length < x.minSources) r.fail(`${p}.sources`, `uses ${used.length} sources, fewer than minSources ${x.minSources}`)
  if (used.length) {
    if (DEC.test(x.value ?? '') && !num(medianOf(used.map((/** @type {any} */ s) => s.price))).eq(x.value)) r.fail(`${p}.value`, 'is not the median of the used sources')
    if (Number.isSafeInteger(x.spreadBps) && spreadBpsOf(used.map((/** @type {any} */ s) => s.price)) !== x.spreadBps) r.fail(`${p}.spreadBps`, 'is not the spread of the used sources')
    const oldest = used.map((/** @type {any} */ s) => s.lastUpdateTime).sort()[0]
    if (x.asOf !== oldest) r.fail(`${p}.asOf`, 'is not the oldest update of the used sources')
  }
  if (Number.isSafeInteger(x.spreadBps) && Number.isSafeInteger(x.maxSpreadBps) && x.spreadBps > x.maxSpreadBps) r.fail(`${p}.spreadBps`, 'is above maxSpreadBps')
  const a = x.ledgerAggregate
  if (r.obj(a, `${p}.ledgerAggregate`)) {
    r.dec(a.median, `${p}.ledgerAggregate.median`)
    r.int(a.size, `${p}.ledgerAggregate.size`)
    ledgerAt(r, a, `${p}.ledgerAggregate`)
    if (DEC.test(a.median ?? '') && DEC.test(x.value ?? '') && !num(a.median).eq(x.value)) r.fail(`${p}.ledgerAggregate.median`, 'disagrees with the median read from the sources')
    if (L && a.ledgerIndex !== L.ledgerIndex) r.fail(`${p}.ledgerAggregate`, `is not read at the document's ledger ${L.ledgerIndex}`)
    if (Number.isSafeInteger(a.size) && a.size !== used.length) r.fail(`${p}.ledgerAggregate.size`, 'is not the number of used sources')
  }
}

function usdTermsRefInto(/** @type {string[]} */ out, /** @type {any} */ t, /** @type {string} */ p) {
  const r = rules(out)
  if (!r.obj(t, p)) return
  r.str(t.id, `${p}.id`)
  hex64(r, t.hash, `${p}.hash`)
  hex64(r, t.anchorTx, `${p}.anchorTx`)
  r.int(t.fxHaircutBps, `${p}.fxHaircutBps`)
  if (Number.isSafeInteger(t.fxHaircutBps) && t.fxHaircutBps >= 10000) r.fail(`${p}.fxHaircutBps`, 'leaves the collateral worth nothing')
  r.dec(t.maxSingleLoanUsd, `${p}.maxSingleLoanUsd`)
}

/** @param {unknown} doc @returns {string[]} */
function validateChange(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const c = /** @type {any} */ (doc)
  r.eq(c.schema, 'orma.change/1', 'schema')
  r.str(c.txType, 'txType')
  if (r.obj(c.txJson, 'txJson') && c.txJson.TransactionType !== c.txType) r.fail('txJson.TransactionType', 'is not txType')
  if (r.obj(c.simulatedAt, 'simulatedAt')) ledgerAt(r, c.simulatedAt, 'simulatedAt')
  r.str(c.engineResult, 'engineResult')
  changeRowsInto(out, c.rows, 'rows', false)
  if (Array.isArray(c.rows) && c.hiddenCount !== c.rows.filter((/** @type {any} */ x) => x?.admitted === 'HIDDEN').length) r.fail('hiddenCount', 'is not the number of HIDDEN rows')
  r.eq(c.provenance, 'SIMULATED', 'provenance')
  if ('realised' in c && r.obj(c.realised, 'realised')) {
    hex64(r, c.realised.txHash, 'realised.txHash')
    ledgerAt(r, c.realised, 'realised')
    changeRowsInto(out, c.realised.rows, 'realised.rows', true)
  }
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateMandate(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const m = /** @type {any} */ (doc)
  r.eq(m.schema, 'orma.mandate/1', 'schema')
  r.str(m.id, 'id')
  r.str(m.desk, 'desk')
  if (typeof m.desk === 'string' && !m.desk.includes('(fictional)')) r.fail('desk', 'does not say it is fictional')
  r.re(m.riskOfficer, ADDRESS, 'riskOfficer', 'a classic address')
  if (r.obj(m.limits, 'limits')) {
    r.int(m.limits.maxLtvBps, 'limits.maxLtvBps')
    if (m.limits.maxLtvBps > 10000) r.fail('limits.maxLtvBps', 'is above 10000 bps')
    r.re(m.limits.maxSingleLoanDrops, UINT, 'limits.maxSingleLoanDrops', 'a whole number of drops')
    r.re(m.limits.maxN2LossDrops, UINT, 'limits.maxN2LossDrops', 'a whole number of drops')
    r.int(m.limits.maxLockupDays, 'limits.maxLockupDays')
  }
  if (r.obj(m.policy, 'policy')) {
    r.eq(m.policy.escrowFinish, 'only-after-default', 'policy.escrowFinish')
    for (const k of ['finishAfterMarginSeconds', 'approvalSlackSeconds', 'cancelAfterOffsetSeconds']) r.int(m.policy[k], `policy.${k}`)
  }
  r.str(m.issuedAt, 'issuedAt')
  hex64(r, m.hash, 'hash')
  hex64(r, m.anchorTx, 'anchorTx')
  if (out.length === 0 && m.hash !== mandateHash(m)) r.fail('hash', 'is not sha256Hex(canonical(mandate without hash and anchorTx))')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateMark(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const m = /** @type {any} */ (doc)
  r.eq(m.schema, 'orma.mark/1', 'schema')
  r.re(m.shareMptId, HEX48, 'shareMptId', '48 hex characters')
  r.oneOf(m.verdict, ['agree', 'disagree'], 'verdict')
  if (m.verdict === 'disagree') r.oneOf(m.reason, ['SPOOFED', 'RECOMPUTE_MISMATCH', 'ORACLE_MISMATCH', 'UNREACHABLE'], 'reason')
  if (m.verdict === 'agree') r.absent(m, 'reason', '', 'when the verdict is agree')
  r.dec(m.tolerance, 'tolerance')
  if (r.arr(m.steps, 'steps')) {
    m.steps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      if (!r.obj(s, `steps[${i}]`)) return
      r.bool(s.ok, `steps[${i}].ok`)
      if (typeof s.detail !== 'string') r.fail(`steps[${i}].detail`, 'is not a string')
    })
    const names = m.steps.map((/** @type {any} */ s) => s?.step)
    const all = names.length === MARK_STEPS.length && names.every((/** @type {string} */ n, /** @type {number} */ i) => n === MARK_STEPS[i])
    const spoofedAtFetch = names.length === 3 && names.every((/** @type {string} */ n, /** @type {number} */ i) => n === MARK_STEPS[i]) && m.reason === 'SPOOFED' && m.steps[2]?.ok === false
    if (!all && !spoofedAtFetch) r.fail('steps', 'are not the six MARK_STEPS in order, nor the first three on a SPOOFED fetch nav')
  }
  ledgerAt(r, m, '')
  r.str(m.node, 'node')
  return out
}

const MARGIN_TYPES = Object.values(MARGIN_FEED_TYPES)
const FEED_TYPES = ['LOAN_LATE', 'IMPAIRMENT', 'DEFAULT', 'COVER_DRAWN', 'SHARES_PLEDGED', 'LOAN_ORIGINATED', 'STATEMENT', ...MARGIN_TYPES]

/** @param {unknown} doc @returns {string[]} */
function validateFeedEvent(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const e = /** @type {any} */ (doc)
  const cursor = typeof e.id === 'string' ? CURSOR.exec(e.id) : null
  if (!cursor) r.fail('id', 'is not a cursor <ledger on 19 digits>-<counter>')
  else if (Number(cursor[1]) !== e.ledgerIndex) r.fail('id', 'does not start with the event ledger')
  r.oneOf(e.type, FEED_TYPES, 'type')
  const margin = MARGIN_TYPES.includes(e.type)
  r.eq(e.provenance, e.type === 'STATEMENT' || margin ? 'DECLARED' : 'REAL', 'provenance')
  hex64(r, e.vaultId, 'vaultId')
  if ('loanId' in e || margin) hex64(r, e.loanId, 'loanId')
  ledgerAt(r, e, '')
  if ('txHash' in e) hex64(r, e.txHash, 'txHash')
  r.str(e.why, 'why')
  if (margin) {
    // a desk decision: no money moved, the decision-log entry that records it
    r.eq(e.moneyEffect, null, 'moneyEffect')
    hex64(r, e.entryHash, 'entryHash')
    r.absent(e, 'statement', '', 'outside a STATEMENT event')
  } else if (e.type === 'STATEMENT') {
    r.eq(e.moneyEffect, null, 'moneyEffect')
    statementInto(out, e.statement, 'statement')
  } else {
    moneyEffectInto(out, e.moneyEffect, 'moneyEffect')
    r.absent(e, 'statement', '', 'outside a STATEMENT event')
  }
  if (r.arr(e.receipts, 'receipts')) {
    e.receipts.forEach((/** @type {any} */ x, /** @type {number} */ i) => {
      if (!r.obj(x, `receipts[${i}]`)) return
      r.str(x.object, `receipts[${i}].object`)
      r.str(x.field, `receipts[${i}].field`)
      if (!('before' in x) || !('after' in x)) r.fail(`receipts[${i}]`, 'lacks before or after')
    })
    if (e.type === 'STATEMENT' && !e.receipts.some((/** @type {any} */ x) => x?.object === 'Vault' && x?.field === 'Data')) r.fail('receipts', 'lack the Vault.Data receipt of a STATEMENT')
  }
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateUniverse(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const u = /** @type {any} */ (doc)
  r.eq(u.schema, 'orma.universe/1', 'schema')
  ledgerAt(r, u, '')
  if (r.arr(u.vaults, 'vaults')) {
    if (u.count !== u.vaults.length) r.fail('count', 'is not vaults.length')
    u.vaults.forEach((/** @type {any} */ v, /** @type {number} */ i) => {
      const q = `vaults[${i}]`
      if (!r.obj(v, q)) return
      hex64(r, v.vaultId, `${q}.vaultId`)
      const a = v.asset
      const assetOk = isPlainObject(a) && ((a.currency === 'XRP' && Object.keys(a).length === 1)
        || (typeof a.currency === 'string' && a.currency !== 'XRP' && typeof a.issuer === 'string' && Object.keys(a).length === 2)
        || (typeof a.mpt_issuance_id === 'string' && HEX48.test(a.mpt_issuance_id) && Object.keys(a).length === 1))
      if (!assetOk) r.fail(`${q}.asset`, 'is not { currency: XRP }, { currency, issuer } or { mpt_issuance_id }')
      if (r.arr(v.brokers, `${q}.brokers`)) v.brokers.forEach((/** @type {unknown} */ b, /** @type {number} */ j) => hex64(r, b, `${q}.brokers[${j}]`))
      r.bool(v.priced, `${q}.priced`)
      if (v.priced === true) {
        r.dec(v.perUnitHeld, `${q}.perUnitHeld`)
        r.dec(v.perUnitNaive, `${q}.perUnitNaive`)
        r.absent(v, 'reason', q, 'on a priced vault')
      }
      if (v.priced === false) {
        r.oneOf(v.reason, ['not priced', 'inconsistent snapshot'], `${q}.reason`)
        r.absent(v, 'perUnitHeld', q, 'on a vault that is not priced')
        r.absent(v, 'perUnitNaive', q, 'on a vault that is not priced')
      }
      r.oneOf(v.seen, ['known', 'live'], `${q}.seen`)
    })
  }
  if (r.obj(u.coverage, 'coverage')) {
    r.int(u.coverage.known, 'coverage.known')
    r.int(u.coverage.live, 'coverage.live')
    if (u.coverage.liveSinceLedger !== null) r.int(u.coverage.liveSinceLedger, 'coverage.liveSinceLedger')
  }
  r.eq(u.banner, 'not live on mainnet', 'banner')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateDecision(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const d = /** @type {any} */ (doc)
  // The second kind of entry of the same log (step 20): its own rules, the same chain.
  if (d.kind === 'margin-call') return validateMarginCallEntry(doc)
  if (!Number.isSafeInteger(d.seq) || d.seq < 1) r.fail('seq', 'is not 1, 2, …')
  hex64(r, d.prevHash, 'prevHash')
  if (d.seq === 1 && d.prevHash !== '0'.repeat(64)) r.fail('prevHash', 'of the first entry is not 64 zeros')
  hex64(r, d.ticketId, 'ticketId')
  hex64(r, d.mandateHash, 'mandateHash')
  r.oneOf(d.decision, ['approved', 'refused', 'declined'], 'decision')
  if (d.decision === 'refused') r.re(d.code, /^[A-Z][A-Z0-9_]*$/, 'code', 'an error code')
  else if ('code' in d) r.re(d.code, /^[A-Z][A-Z0-9_]*$/, 'code', 'an error code')
  if (d.decision === 'approved' || d.code === 'SUBMIT_UNCONFIRMED') hex64(r, d.txHash, 'txHash')
  else if ('txHash' in d) hex64(r, d.txHash, 'txHash')
  ledgerAt(r, d, '')
  hex64(r, d.hash, 'hash')
  if (out.length === 0 && d.hash !== decisionHash(d)) r.fail('hash', 'is not sha256Hex(canonical(entry without hash))')
  return out
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

/** @param {unknown} doc @returns {string[]} */
function validateMarginPolicy(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const p = /** @type {any} */ (doc)
  r.eq(p.schema, 'orma.marginpolicy/1', 'schema')
  r.str(p.id, 'id')
  hex64(r, p.mandateHash, 'mandateHash')
  r.eq(p.trigger, 'maxLtvBps', 'trigger')
  if (!Number.isSafeInteger(p.cureSeconds) || p.cureSeconds < 1) r.fail('cureSeconds', 'is not a whole number of seconds')
  r.str(p.realWorldNote, 'realWorldNote')
  r.eq(p.cureAction, 'pledgeEscrow', 'cureAction')
  r.str(p.afterExpiry, 'afterExpiry')
  r.re(p.issuedAt, ISO, 'issuedAt', 'an ISO 8601 UTC time')
  hex64(r, p.hash, 'hash')
  hex64(r, p.anchorTx, 'anchorTx')
  if (out.length === 0 && p.hash !== marginPolicyHash(p)) r.fail('hash', 'is not sha256Hex(canonical(policy without hash and anchorTx))')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateUsdTerms(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const t = /** @type {any} */ (doc)
  r.eq(t.schema, 'orma.usdterms/1', 'schema')
  r.str(t.id, 'id')
  hex64(r, t.mandateHash, 'mandateHash')
  loanAssetInto(out, t.loanAsset, 'loanAsset')
  if (r.obj(t.xrpUsdOracle, 'xrpUsdOracle')) {
    const o = t.xrpUsdOracle
    r.eq(o.baseAsset, 'XRP', 'xrpUsdOracle.baseAsset')
    r.eq(o.quoteAsset, 'USD', 'xrpUsdOracle.quoteAsset')
    r.eq(o.aggregation, 'median', 'xrpUsdOracle.aggregation')
    if (r.arr(o.sources, 'xrpUsdOracle.sources')) {
      o.sources.forEach((/** @type {any} */ s, /** @type {number} */ i) => oracleSourceInto(out, s, `xrpUsdOracle.sources[${i}]`))
      const keys = o.sources.map((/** @type {any} */ s) => `${s?.account}/${s?.documentId}`)
      if (new Set(keys).size !== keys.length) r.fail('xrpUsdOracle.sources', 'names one document twice')
      if (Number.isSafeInteger(o.minSources) && o.minSources > o.sources.length) r.fail('xrpUsdOracle.minSources', 'is more than the sources named')
    }
    if (!Number.isSafeInteger(o.minSources) || o.minSources < 1) r.fail('xrpUsdOracle.minSources', 'is not a whole number of sources, at least 1')
    if (!Number.isSafeInteger(o.maxAgeSeconds) || o.maxAgeSeconds < 1 || o.maxAgeSeconds > 300) r.fail('xrpUsdOracle.maxAgeSeconds', 'is not 1 to 300 seconds')
    r.int(o.maxSpreadBps, 'xrpUsdOracle.maxSpreadBps')
    r.str(o.note, 'xrpUsdOracle.note')
  }
  r.int(t.fxHaircutBps, 'fxHaircutBps')
  if (Number.isSafeInteger(t.fxHaircutBps) && t.fxHaircutBps >= 10000) r.fail('fxHaircutBps', 'leaves the collateral worth nothing')
  r.dec(t.maxSingleLoanUsd, 'maxSingleLoanUsd')
  r.re(t.issuedAt, ISO, 'issuedAt', 'an ISO 8601 UTC time')
  hex64(r, t.hash, 'hash')
  hex64(r, t.anchorTx, 'anchorTx')
  if (out.length === 0 && t.hash !== usdTermsHash(t)) r.fail('hash', 'is not sha256Hex(canonical(terms without hash and anchorTx))')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateMarginCall(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const c = /** @type {any} */ (doc)
  r.oneOf(c.status, MARGIN_STATUSES, 'status')
  hex64(r, c.loanId, 'loanId')
  if (c.ltvHeldBps !== null) r.int(c.ltvHeldBps, 'ltvHeldBps')
  r.int(c.maxLtvBps, 'maxLtvBps')
  r.eq(c.provenance, 'DECLARED', 'provenance')
  ledgerAt(r, c, '')
  if (r.arr(c.reasons, 'reasons')) c.reasons.forEach((/** @type {unknown} */ x, /** @type {number} */ i) => r.str(x, `reasons[${i}]`))
  if (c.status === 'NONE') {
    for (const k of ['issuedLedger', 'issuedAt', 'cureBy', 'shortfall']) if (c[k] !== null) r.fail(k, 'is not null without a margin call')
    r.absent(c, 'entryHash', '', 'without a margin call')
  } else {
    r.int(c.issuedLedger, 'issuedLedger')
    r.re(c.issuedAt, ISO, 'issuedAt', 'an ISO 8601 UTC time')
    r.re(c.cureBy, ISO, 'cureBy', 'an ISO 8601 UTC time')
    if (ISO.test(c.issuedAt ?? '') && ISO.test(c.cureBy ?? '') && !(Date.parse(c.cureBy) > Date.parse(c.issuedAt))) r.fail('cureBy', 'is not after issuedAt')
    hex64(r, c.entryHash, 'entryHash')
    if (c.status === 'CURED') {
      if (c.shortfall !== null) r.fail('shortfall', 'is not null on a cured call')
    } else if (r.obj(c.shortfall, 'shortfall')) {
      r.re(c.shortfall.collateralValueDrops, UINT, 'shortfall.collateralValueDrops', 'a whole number of drops')
      r.re(c.shortfall.sharesToAdd, UINT, 'shortfall.sharesToAdd', 'a whole number of share units')
      r.dec(c.shortfall.withdrawalValuePerShare, 'shortfall.withdrawalValuePerShare')
      if ('collateralValueUsd' in c.shortfall || c.currency === 'USD') r.dec(c.shortfall.collateralValueUsd, 'shortfall.collateralValueUsd')
    }
  }
  if ('currency' in c) r.oneOf(c.currency, ['XRP', 'USD'], 'currency')
  if ('triggerTx' in c) hex64(r, c.triggerTx, 'triggerTx')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateMarginCallEntry(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const e = /** @type {any} */ (doc)
  if (!Number.isSafeInteger(e.seq) || e.seq < 1) r.fail('seq', 'is not 1, 2, …')
  hex64(r, e.prevHash, 'prevHash')
  if (e.seq === 1 && e.prevHash !== '0'.repeat(64)) r.fail('prevHash', 'of the first entry is not 64 zeros')
  r.eq(e.kind, 'margin-call', 'kind')
  r.oneOf(e.status, ['ISSUED', 'CURED', 'EXPIRED'], 'status')
  hex64(r, e.loanId, 'loanId')
  hex64(r, e.mandateHash, 'mandateHash')
  hex64(r, e.policyHash, 'policyHash')
  r.int(e.issuedLedger, 'issuedLedger')
  r.re(e.issuedAt, ISO, 'issuedAt', 'an ISO 8601 UTC time')
  r.re(e.cureBy, ISO, 'cureBy', 'an ISO 8601 UTC time')
  if (e.ltvHeldBps !== null) r.int(e.ltvHeldBps, 'ltvHeldBps')
  r.int(e.maxLtvBps, 'maxLtvBps')
  r.absent(e, 'decision', '', 'on a margin-call entry')
  // the shortfall the call demanded, so a restart serves the call whole (on ISSUED and EXPIRED)
  if ('shortfall' in e) {
    if (e.status === 'CURED') r.fail('shortfall', 'is kept on a cured call')
    else if (r.obj(e.shortfall, 'shortfall')) {
      r.re(e.shortfall.collateralValueDrops, UINT, 'shortfall.collateralValueDrops', 'a whole number of drops')
      r.re(e.shortfall.sharesToAdd, UINT, 'shortfall.sharesToAdd', 'a whole number of share units')
      r.dec(e.shortfall.withdrawalValuePerShare, 'shortfall.withdrawalValuePerShare')
      if ('collateralValueUsd' in e.shortfall) r.dec(e.shortfall.collateralValueUsd, 'shortfall.collateralValueUsd')
    }
  }
  ledgerAt(r, e, '')
  hex64(r, e.hash, 'hash')
  if (out.length === 0 && e.hash !== decisionHash(e)) r.fail('hash', 'is not sha256Hex(canonical(entry without hash))')
  return out
}

/** GET /api/desk/margin-calls: the policy and one call per desk loan, all at the document's ledger. */
function validateMarginCalls(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const d = /** @type {any} */ (doc)
  ledgerAt(r, d, '')
  out.push(...validateMarginPolicy(d.policy).map((p) => `policy.${p}`))
  if (r.arr(d.marginCalls, 'marginCalls')) {
    d.marginCalls.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      out.push(...validateMarginCall(c).map((p) => `marginCalls[${i}].${p}`))
      if (c?.ledgerIndex !== d.ledgerIndex) r.fail(`marginCalls[${i}].ledgerIndex`, "is not the document's ledger")
    })
  }
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateStatement(doc) {
  const out = []
  deepProblems(doc, '', out)
  statementInto(out, doc, '')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateStmt(doc) {
  const out = []
  deepProblems(doc, '', out)
  out.push(...stmtProblems(doc))
  if (out.length === 0) {
    const bytes = Buffer.byteLength(JSON.stringify(orderedStatement(doc)), 'utf8')
    if (bytes > STATEMENT_MAX_BYTES) out.push(`the statement is ${bytes} bytes, more than ${STATEMENT_MAX_BYTES}`)
  }
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateFigure(doc) {
  const out = []
  deepProblems(doc, '', out)
  figureInto(out, doc, 'figure')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateCollateralAccount(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const a = /** @type {any} */ (doc)
  r.re(a.address, ADDRESS, 'address', 'a classic address')
  if (r.obj(a.signers, 'signers')) for (const k of COLLATERAL_POLICY.roles) r.re(a.signers[k], ADDRESS, `signers.${k}`, 'a classic address')
  r.int(a.quorum, 'quorum')
  r.bool(a.masterDisabled, 'masterDisabled')
  if (a.regularKey !== null) r.re(a.regularKey, ADDRESS, 'regularKey', 'a classic address or null')
  r.bool(a.depositAuth, 'depositAuth')
  r.bool(a.mptAuthorized, 'mptAuthorized')
  r.re(a.sharesHeld, UINT, 'sharesHeld', 'a whole number of share units')
  r.int(a.escrowCount, 'escrowCount')
  r.int(a.ownerCount, 'ownerCount')
  if ('pledges' in a && r.arr(a.pledges, 'pledges')) {
    a.pledges.forEach((/** @type {any} */ x, /** @type {number} */ i) => {
      const q = `pledges[${i}]`
      if (!r.obj(x, q)) return
      r.re(x.account, ADDRESS, `${q}.account`, 'a classic address')
      r.int(x.sequence, `${q}.sequence`)
      hex64(r, x.index, `${q}.index`)
      hex64(r, x.txHash, `${q}.txHash`)
      r.int(x.ledgerIndex, `${q}.ledgerIndex`)
    })
  }
  r.bool(a.conforming, 'conforming')
  if (r.arr(a.reasons, 'reasons')) {
    a.reasons.forEach((/** @type {unknown} */ x, /** @type {number} */ i) => r.str(x, `reasons[${i}]`))
    if (a.conforming !== (a.reasons.length === 0)) r.fail('conforming', 'disagrees with its reasons')
  }
  r.eq(a.provenance, 'REAL', 'provenance')
  ledgerAt(r, a, '')
  return out
}

/** @param {unknown} doc @returns {string[]} */
function validateAction(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '')) return out
  const a = /** @type {any} */ (doc)
  for (const k of ['actionId', 'runId', 'role', 'action']) r.str(a[k], k)
  r.oneOf(a.state, ACTION_STATES, 'state')
  if (a.state === 'previewing') r.fail('state', 'previewing is internal and never served')
  if (a.state === 'validated') for (const k of ['txHash', 'engineResult']) if (!(k in a)) r.fail(k, 'is missing on a validated action')
  if ('txHash' in a) hex64(r, a.txHash, 'txHash')
  return out
}

const ALL_ERRORS = { ...EXISTING_ERRORS, ...NYC_ERRORS }

/** @param {unknown} doc @returns {string[]} */
function validateError(doc) {
  const out = []
  deepProblems(doc, '', out)
  const r = rules(out)
  if (!r.obj(doc, '') || !r.obj(/** @type {any} */ (doc).error, 'error')) return out
  const e = /** @type {any} */ (doc).error
  r.oneOf(e.code, Object.keys(ALL_ERRORS), 'error.code')
  r.str(e.message, 'error.message')
  r.bool(e.retryable, 'error.retryable')
  if (Object.hasOwn(ALL_ERRORS, e.code) && e.retryable !== ALL_ERRORS[/** @type {keyof typeof ALL_ERRORS} */ (e.code)].retryable) r.fail('error.retryable', `is not ${ALL_ERRORS[/** @type {keyof typeof ALL_ERRORS} */ (e.code)].retryable} for ${e.code}`)
  return out
}

/**
 * One hand-written validator per NYC shape: `SCHEMAS[name](doc) → string[]`, the list of departures,
 * empty when the document conforms. Extra keys are allowed (a served document carries its envelope),
 * except `grade` at any depth; an amount is never a JSON number.
 */
export const SCHEMAS = Object.freeze({
  ticket: validateTicket,
  change: validateChange,
  mandate: validateMandate,
  mark: validateMark,
  feedEvent: validateFeedEvent,
  universe: validateUniverse,
  decision: validateDecision,
  statement: validateStatement,
  stmt: validateStmt,
  figure: validateFigure,
  collateralAccount: validateCollateralAccount,
  action: validateAction,
  error: validateError,
  marginPolicy: validateMarginPolicy, // step 20
  marginCall: validateMarginCall,
  marginCallEntry: validateMarginCallEntry,
  marginCalls: validateMarginCalls,
  usdTerms: validateUsdTerms, // step 21
})

// --- examples --------------------------------------------------------------------------------------

// One fictional vault read at one ledger: a Meridian-like book (51 XRP in, 10 XRP impaired on L1,
// L2 performing), valued for a pledge of 1,000,000 share units.
const L = 6333080
const H = 'A1F0C3D2B4E5968778695A4B3C2D1E0F1A2B3C4D5E6F708192A3B4C5D6E7F801'
const VAULT = '5E3A0B1C2D3E4F5061728394A5B6C7D8E9F00112233445566778899AABBCCDDE'
const SHARE = '0000000A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E'
const BROKER = '7B2C9D0E1F2031425364758697A8B9CADBECFD0E1F2031425364758697A8B9C0'
const LOAN1 = '1C9F8E7D6C5B4A3928170F1E2D3C4B5A69788796A5B4C3D2E1F00F1E2D3C4B5A'
const LOAN2 = '2D0A9B8C7D6E5F4031221F0E1D2C3B4A59687786A4B3C2D1E0FF0E1D2C3B4A59'
const TX = '9E8D7C6B5A4938271605F4E3D2C1B0A99887766554433221100FFEEDDCCBBAA9'
const ANCHOR = '3F4E5D6C7B8A99887766554433221100FFEEDDCCBBAA99887766554433221100'
const BORROWER = 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv'
const DESK = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const AGENT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const RISK = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh'
const OWNER = 'rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo'
const COLLATERAL = 'rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1'

/** Where each formula input lives on the ledger (or off it), for the examples. */
const SOURCES = {
  AssetsTotal: { object: 'Vault', field: 'AssetsTotal', id: VAULT, value: '51000000' },
  LossUnrealized: { object: 'Vault', field: 'LossUnrealized', id: VAULT, value: '10000000' },
  AssetsAvailable: { object: 'Vault', field: 'AssetsAvailable', id: VAULT, value: '36000000' },
  Scale: { object: 'Vault', field: 'Scale', id: VAULT, value: '0' },
  LEVersion: { object: 'Vault', field: 'LEVersion', id: VAULT, value: '1' },
  RedemptionDate: { object: 'Vault', field: 'RedemptionDate', id: VAULT, value: '846388800' },
  OutstandingAmount: { object: 'MPTokenIssuance', field: 'OutstandingAmount', id: SHARE, value: '51000000' },
  DebtTotal: { object: 'LoanBroker', field: 'DebtTotal', id: BROKER, value: '15000000' },
  CoverRateMinimum: { object: 'LoanBroker', field: 'CoverRateMinimum', id: BROKER, value: '10000' },
  CoverRateLiquidation: { object: 'LoanBroker', field: 'CoverRateLiquidation', id: BROKER, value: '10000' },
  CoverAvailable: { object: 'LoanBroker', field: 'CoverAvailable', id: BROKER, value: '2000000' },
  units: { object: 'Request', field: 'units', id: SHARE, value: '1000000' },
  principalDrops: { object: 'Plan', field: 'plannedLoan.principalDrops', id: 'desk-1', value: '300000' },
  maxLtvBps: { object: 'Mandate', field: 'limits.maxLtvBps', id: 'desk-1', value: '5000' },
  maxSingleLoanDrops: { object: 'Mandate', field: 'limits.maxSingleLoanDrops', id: 'desk-1', value: '1000000' },
  close_time: { object: 'Ledger', field: 'close_time', id: String(L), value: '846200000' },
  // step 21: the risk officer's USD terms and the dollar plan
  xrpUsd: { object: 'OracleAggregate', field: 'median', id: 'desk-1', value: '1.29' },
  fxHaircutBps: { object: 'UsdTerms', field: 'fxHaircutBps', id: 'desk-1', value: '1000' },
  priceAsOf: { object: 'OracleAggregate', field: 'asOf', id: 'desk-1', value: '846199950' },
  principalUsd: { object: 'Plan', field: 'plannedLoan.principalUsd', id: 'desk-usd', value: '0.3483' },
}
const LOANS = {
  [LOAN1]: { PrincipalOutstanding: '10000000', TotalValueOutstanding: '10100000', ManagementFeeOutstanding: '0', Flags: String(LSF_LOAN_IMPAIRED) },
  [LOAN2]: { PrincipalOutstanding: '5000000', TotalValueOutstanding: '5050000', ManagementFeeOutstanding: '0', Flags: '0' },
}

/**
 * An example Figure, its inputs taken from SOURCES (and from one loan's fields for the n2 formulas).
 * @returns {Figure}
 */
function fig(/** @type {FormulaId} */ formulaId, /** @type {string} */ value, /** @type {Provenance} */ provenance, /** @type {string} */ meaning, /** @type {string|null} */ loanId = null) {
  const inputs = FORMULAS[formulaId].inputs.map((name) => {
    const loanField = loanId && /** @type {any} */ (LOANS[loanId])[name]
    const src = loanField !== undefined && loanField !== null && loanField !== false
      ? { object: 'Loan', field: name, id: /** @type {string} */ (loanId), value: loanField }
      : /** @type {any} */ (SOURCES)[name]
    return { name, value: src.value, object: src.object, field: src.field, id: src.id, ledgerIndex: L, ledgerHash: H }
  })
  return { value, unit: FORMULAS[formulaId].unit, meaning, formula: FORMULAS[formulaId].text, formulaId, inputs, provenance }
}

const STATEMENT_DOC = /** @type {StatementDoc} */ ({ s: 'orma.stmt/1', loan: LOAN1, kind: 'impaired', text: 'L1 missed its payment; impaired at full principal while we work out a schedule.', at: 846199000 })
const STATEMENT = {
  provenance: /** @type {const} */ ('DECLARED'),
  raw: encodeStatement(STATEMENT_DOC),
  owner: OWNER,
  doc: STATEMENT_DOC,
  consistency: statementConsistency(STATEMENT_DOC, [{ loanId: LOAN1, label: 'L1', flags: LSF_LOAN_IMPAIRED, paymentRemaining: 1 }], { ledgerIndex: L, ledgerHash: H }),
}

const MANDATE_BODY = {
  schema: /** @type {const} */ ('orma.mandate/1'),
  id: 'desk-1',
  desk: 'Hudson Credit Desk (fictional)',
  riskOfficer: RISK,
  limits: { maxLtvBps: 5000, maxSingleLoanDrops: '1000000', maxN2LossDrops: '200000', maxLockupDays: 7 },
  policy: { escrowFinish: /** @type {const} */ ('only-after-default'), finishAfterMarginSeconds: 14400, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 },
  issuedAt: '2026-10-24T14:00:00.000Z',
}
const MANDATE = { ...MANDATE_BODY, hash: mandateHash(MANDATE_BODY), anchorTx: ANCHOR }

const DECISION_BODY = {
  seq: 1, prevHash: '0'.repeat(64), ticketId: 'C'.repeat(64), mandateHash: MANDATE.hash,
  decision: /** @type {const} */ ('approved'), txHash: TX, ledgerIndex: L, ledgerHash: H,
}

// Step 20: the risk officer's margin policy and an open call on L1 of the desk, issued two ledgers ago.
const MARGIN_POLICY_BODY = {
  schema: /** @type {const} */ ('orma.marginpolicy/1'), id: 'desk-1', mandateHash: MANDATE.hash,
  trigger: /** @type {const} */ ('maxLtvBps'), cureSeconds: 600,
  realWorldNote: 'Institutional desks usually give 12 to 24 hours; 600 seconds on Devnet so a full cycle can be shown.',
  cureAction: /** @type {const} */ ('pledgeEscrow'),
  afterExpiry: 'The desk may act under its escrow policy (finish only after a default). No automatic seizure.',
  issuedAt: '2026-10-24T21:00:00.000Z',
}
const MARGIN_POLICY = { ...MARGIN_POLICY_BODY, hash: marginPolicyHash(MARGIN_POLICY_BODY), anchorTx: ANCHOR }
const MARGIN_ENTRY_BODY = {
  seq: 2, prevHash: 'D'.repeat(64), kind: /** @type {const} */ ('margin-call'), status: /** @type {const} */ ('ISSUED'), loanId: LOAN1,
  mandateHash: MANDATE.hash, policyHash: MARGIN_POLICY.hash, issuedLedger: L - 2, issuedAt: '2026-10-25T14:00:00Z', cureBy: '2026-10-25T14:10:00Z',
  ltvHeldBps: 6100, maxLtvBps: 5000, ledgerIndex: L - 2, ledgerHash: H,
}
const MARGIN_ENTRY = { ...MARGIN_ENTRY_BODY, hash: decisionHash(MARGIN_ENTRY_BODY) }
const MARGIN_CALL = {
  status: /** @type {const} */ ('ISSUED'), loanId: LOAN1, issuedLedger: L - 2, issuedAt: '2026-10-25T14:00:00Z', cureBy: '2026-10-25T14:10:00Z',
  ltvHeldBps: 6100, maxLtvBps: 5000,
  shortfall: { collateralValueDrops: '178525', sharesToAdd: '222068', withdrawalValuePerShare: '0.803922' },
  reasons: [
    'The mandate desk-1 limits the LTV at withdrawal value to 50.00 %.',
    'The LTV at withdrawal value is 61.00 %, above it.',
  ],
  provenance: /** @type {const} */ ('DECLARED'), ledgerIndex: L, ledgerHash: H, entryHash: MARGIN_ENTRY.hash,
}

// Step 21: the risk officer's USD terms, and the same open call on a loan in the test dollar.
const USD_ISSUER = 'rUSDw1nGKbkLj9hTjHmBPbVSVcXCoVhQe7'
const RELAY = 'rRe1ayXRPUSDfeedsDevnetQvTnkGqh5u'
const ORACLE_SOURCES = [
  { account: RELAY, documentId: 1, provider: 'kraken', uri: 'https://api.kraken.com/0/public/Ticker?pair=XRPUSD' },
  { account: RELAY, documentId: 2, provider: 'bitstamp', uri: 'https://www.bitstamp.net/api/v2/ticker/xrpusd/' },
  { account: RELAY, documentId: 3, provider: 'coinbase', uri: 'https://api.exchange.coinbase.com/products/XRP-USD/ticker' },
]
const ORACLE_NOTE = 'Example: three XLS-47 documents relayed from exchange quotes; on mainnet, independent oracle providers.'
const USD_TERMS_BODY = {
  schema: /** @type {const} */ ('orma.usdterms/1'), id: 'desk-1', mandateHash: MANDATE.hash,
  loanAsset: { currency: /** @type {const} */ ('USD'), issuer: USD_ISSUER, label: USD_LABEL },
  xrpUsdOracle: { baseAsset: /** @type {const} */ ('XRP'), quoteAsset: /** @type {const} */ ('USD'), sources: ORACLE_SOURCES, aggregation: /** @type {const} */ ('median'), minSources: 2, maxAgeSeconds: 300, maxSpreadBps: 100, note: ORACLE_NOTE },
  fxHaircutBps: 1000, maxSingleLoanUsd: '10',
  issuedAt: '2026-10-24T12:05:00.000Z',
}
// the three documents read at the ticket's ledger L (close 23:33:20 UTC), 30 to 50 s old, median 1.29
const ORACLE_READS = [['1.2899', '2026-10-24T23:32:40Z', '40'], ['1.29', '2026-10-24T23:32:30Z', '50'], ['1.2902', '2026-10-24T23:32:50Z', '30']]
  .map(([price, lastUpdateTime, ageSeconds], i) => ({ ...ORACLE_SOURCES[i], price, lastUpdateTime, ageSeconds, fresh: true, used: true, ledgerIndex: L, ledgerHash: H }))
const USD_TERMS = { ...USD_TERMS_BODY, hash: usdTermsHash(USD_TERMS_BODY), anchorTx: ANCHOR }
const MARGIN_CALL_USD = {
  ...MARGIN_CALL,
  currency: /** @type {const} */ ('USD'),
  shortfall: { ...MARGIN_CALL.shortfall, collateralValueUsd: '0.207267' },
  reasons: [
    'The mandate desk-1 limits the LTV at withdrawal value to 50.00 %.',
    `The LTV at withdrawal value, in USD (${USD_LABEL}), is 61.00 %, above that limit.`,
  ],
}

const pad19 = (/** @type {number} */ n) => String(n).padStart(19, '0')

/** A pledge ticket on that book. */
const TICKET = {
  schema: 'orma.ticket/1',
  ticketId: 'C'.repeat(64),
  inputsDigest: 'D'.repeat(64),
  asOf: '2026-10-24T18:13:20.000Z',
  ledgerIndex: L,
  ledgerHash: H,
  op: 'pledge',
  share: { mptId: SHARE, vaultId: VAULT, units: '1000000', shareScale: 0 },
  mandate: { id: 'desk-1', hash: MANDATE.hash, anchorTx: ANCHOR },
  figures: {
    heldValue: fig('heldValue', '803922', 'MODELLED', 'What the pledged shares are worth at the XLS-65 withdraw rate'),
    naiveValue: fig('naiveValue', '1000000', 'MODELLED', 'What the same shares look worth to anyone who reads AssetsTotal / shares'),
    n1Overpayment: fig('n1Overpayment', '196078', 'MODELLED', 'How much a lender would overpay by valuing the shares at the value read by all'),
    n2: [
      {
        loanId: LOAN1, label: 'L1', scenario: 'if L1 defaults alone', alreadyInHeld: true,
        lossAfterCover: fig('lossAfterCover', '0', 'MODELLED', 'Already in the withdrawal value (impaired)', LOAN1),
        cover: fig('cover', '150000', 'MODELLED', 'First-loss cover the vault would liquidate on this default', LOAN1),
        heldPerUnitIfDefault: fig('heldPerUnitIfDefault', '0.806863', 'MODELLED', 'Withdrawal value per share after this default alone', LOAN1),
      },
      {
        loanId: LOAN2, label: 'L2', scenario: 'if L2 defaults alone', alreadyInHeld: false,
        lossAfterCover: fig('lossAfterCover', '95098', 'MODELLED', 'What the pledged shares would lose if L2 defaults alone', LOAN2),
        cover: fig('cover', '150000', 'MODELLED', 'First-loss cover the vault would liquidate on this default', LOAN2),
        heldPerUnitIfDefault: fig('heldPerUnitIfDefault', '0.708824', 'MODELLED', 'Withdrawal value per share after this default alone', LOAN2),
      },
    ],
    n3: {
      lockedUntil: fig('lockedUntil', '188800', 'REAL', 'Seconds until the vault lets anyone redeem'),
      redemptionAt: '2026-10-27T04:00:00.000Z',
      cashAvailable: fig('cashAvailable', '36000000', 'REAL', 'Cash the vault holds today'),
      claim: fig('claim', '803922', 'MODELLED', 'What the shares claim at redemption, at the withdrawal value'),
    },
    maxLoan: fig('maxLoan', '401961', 'MODELLED', 'The largest loan the mandate allows against these shares'),
    requested: fig('requested', '300000', 'DECLARED', 'The principal the borrower asks for'),
    ltvHeld: fig('ltvHeld', '3731', 'MODELLED', 'LTV at withdrawal value'),
    lender1to1: fig('lender1to1', '3000', 'MODELLED', 'The same LTV for a lender at 1:1'),
  },
  conduct: { recognitionLagSeconds: ['101'], defaultsWithoutImpairment: 0, coverOrderCostDrops: '0' },
  escrowPolicy: {
    finishAfter: '846304000',
    cancelAfter: '846390400',
    text: "anyone may finish the escrow between FinishAfter and CancelAfter; the shares then sit in a 2-of-3 collateral account {borrower, desk, Orma agent} whose master key is disabled, so no single party can move them; the Orma agent's published rule: it co-signs their transfer to the desk only if the loan is in default, back to the borrower only if it is repaid without default, and nothing otherwise; borrower and desk together can always move them",
  },
  statement: STATEMENT,
  verdict: { status: 'PASS', breaches: [] },
  verdict1to1: { status: 'PASS', breaches: [] },
}

/** The same book, read for an OTC buy: maxUnits instead of the loan figures, and no 1:1 column. */
function buyTicket(/** @type {any} */ t) {
  const { maxLoan: _m, requested: _r, ltvHeld: _l, lender1to1: _p, ...figures } = t.figures
  void [_m, _r, _l, _p]
  const { verdict1to1: _v, ...rest } = t
  void _v
  return {
    ...rest,
    ticketId: 'E'.repeat(64),
    op: 'buy',
    figures: { ...figures, maxUnits: fig('maxUnits', '1243901', 'MODELLED', 'The most share units the mandate lets the desk buy at the withdrawal value') },
  }
}

/** The same book, for a loan in the test dollar: the six dollar figures instead of the four in drops, and the usd block. */
function usdTicket(/** @type {any} */ t) {
  const { maxLoan: _m, requested: _r, ltvHeld: _l, lender1to1: _p, ...figures } = t.figures
  void [_m, _r, _l, _p]
  return {
    ...t,
    ticketId: 'F'.repeat(64),
    figures: {
      ...figures,
      maxLoanUsd: fig('maxLoanUsd', '0.466676', 'MODELLED', 'The largest dollar loan the mandate allows against these shares'),
      requestedUsd: fig('requestedUsd', '0.3483', 'DECLARED', 'The dollars the planned loan asks for'),
      collateralHeldUsd: fig('collateralHeldUsd', '0.933353', 'MODELLED', 'Withdrawal value of these shares in dollars, at the declared reference price, less the haircut'),
      ltvHeldUsd: fig('ltvHeldUsd', '3731', 'MODELLED', 'LTV at withdrawal value, in dollars'),
      lender1to1Usd: fig('lender1to1Usd', '3000', 'MODELLED', 'The same dollar LTV for a lender at 1:1'),
      priceAge: fig('priceAge', '50', 'MODELLED', 'Seconds since the oldest XRP/USD source used was updated'),
    },
    verdict: { status: 'PASS', breaches: [] },
    verdict1to1: { status: 'PASS', breaches: [] },
    usd: {
      loanAsset: { currency: 'USD', issuer: USD_ISSUER, label: USD_LABEL },
      requestedUsd: '0.3483',
      collateralHeldUsd: '0.933353',
      ltvHeldBps: 3731,
      reference: {
        value: '1.29', provenance: 'REAL', method: 'median of the fresh XLS-47 oracle documents the terms name, each read at the ledger of the ticket',
        asOf: '2026-10-24T23:32:30Z', ageSeconds: '50', sources: ORACLE_READS, spreadBps: 3, maxSpreadBps: 100, minSources: 2, maxAgeSeconds: 300,
        ledgerAggregate: { median: '1.29', size: 3, ledgerIndex: L, ledgerHash: H }, note: ORACLE_NOTE,
      },
      terms: { id: USD_TERMS.id, hash: USD_TERMS.hash, anchorTx: USD_TERMS.anchorTx, fxHaircutBps: 1000, maxSingleLoanUsd: '10' },
      collateralRule: USD_COLLATERAL_RULE,
    },
  }
}

/** One valid example per shape; the ticket and the feed event have two each. */
export const EXAMPLES = deepFreeze({
  ticket: TICKET,
  ticketBuy: buyTicket(TICKET),
  change: {
    schema: 'orma.change/1',
    txType: 'LoanManage',
    txJson: { TransactionType: 'LoanManage', Account: OWNER, LoanID: LOAN1, Flags: LSF_LOAN_IMPAIRED },
    simulatedAt: { ledgerIndex: L, ledgerHash: H },
    engineResult: 'tesSUCCESS',
    rows: [
      { object: { type: 'Vault', index: VAULT }, field: 'LossUnrealized', before: null, after: '10000000', admitted: 'HIDDEN', rule: { source: 'rippled 3.4.1', file: 'LoanManage.cpp', line: 311 }, moneyEffect: { value: '-10000000', unit: 'drops' } },
      { object: { type: 'Loan', index: LOAN1 }, field: 'Flags', before: 0, after: LSF_LOAN_IMPAIRED, admitted: 'YES', rule: { source: 'rippled 3.4.1', file: 'LoanManage.cpp', line: 311 }, moneyEffect: null },
    ],
    hiddenCount: 1,
    provenance: 'SIMULATED',
    realised: {
      txHash: TX, ledgerIndex: L + 2, ledgerHash: 'B'.repeat(64),
      rows: [
        { object: { type: 'Vault', index: VAULT }, field: 'LossUnrealized', before: null, after: '10000000', admitted: 'HIDDEN', rule: { source: 'rippled 3.4.1', file: 'LoanManage.cpp', line: 311 }, moneyEffect: { value: '-10000000', unit: 'drops' }, verdict: 'MATCH' },
        { object: { type: 'Loan', index: LOAN1 }, field: 'Flags', before: 0, after: LSF_LOAN_IMPAIRED, admitted: 'YES', rule: { source: 'rippled 3.4.1', file: 'LoanManage.cpp', line: 311 }, moneyEffect: null, verdict: 'MATCH' },
      ],
    },
  },
  mandate: MANDATE,
  mark: {
    schema: 'orma.mark/1', shareMptId: SHARE, verdict: 'agree', tolerance: '0.000001',
    steps: MARK_STEPS.map((step) => ({ step, ok: true, detail: `${step}: ok` })),
    ledgerIndex: L, ledgerHash: H, node: 'wss://s.devnet.rippletest.net:51233',
  },
  feedEvent: {
    id: `${pad19(L)}-0`, type: 'IMPAIRMENT', provenance: 'REAL',
    vaultId: VAULT, loanId: LOAN1, ledgerIndex: L, ledgerHash: H, txHash: TX,
    why: 'The manager impaired L1: the vault now carries its loss in LossUnrealized',
    moneyEffect: { value: '-10000000', unit: 'drops' },
    receipts: [{ object: 'Vault', field: 'LossUnrealized', before: null, after: '10000000' }],
  },
  feedEventStatement: {
    id: `${pad19(L)}-1`, type: 'STATEMENT', provenance: 'DECLARED',
    vaultId: VAULT, loanId: LOAN1, ledgerIndex: L, ledgerHash: H, txHash: TX,
    why: 'The manager declared L1 impaired in Vault.Data; the ledger agrees',
    moneyEffect: null,
    receipts: [{ object: 'Vault', field: 'Data', before: null, after: STATEMENT.raw }],
    statement: STATEMENT,
  },
  universe: {
    schema: 'orma.universe/1', ledgerIndex: L, ledgerHash: H, count: 3,
    vaults: [
      { vaultId: VAULT, asset: { currency: 'XRP' }, brokers: [BROKER], priced: true, perUnitHeld: '0.803922', perUnitNaive: '1.000000', seen: 'known' },
      { vaultId: 'E'.repeat(64), asset: { currency: 'USD', issuer: OWNER }, brokers: [], priced: false, reason: 'not priced', seen: 'live' },
      { vaultId: 'F'.repeat(64), asset: { currency: 'XRP' }, brokers: [], priced: false, reason: 'inconsistent snapshot', seen: 'known' },
    ],
    coverage: { known: 2, live: 1, liveSinceLedger: L - 400 },
    banner: 'not live on mainnet',
  },
  decision: { ...DECISION_BODY, hash: decisionHash(DECISION_BODY) },
  statement: STATEMENT,
  stmt: STATEMENT_DOC,
  figure: fig('heldValue', '803922', 'MODELLED', 'What the pledged shares are worth at the XLS-65 withdraw rate'),
  collateralAccount: {
    address: COLLATERAL, signers: { borrower: BORROWER, desk: DESK, agent: AGENT }, quorum: 2,
    masterDisabled: true, regularKey: null, depositAuth: false, mptAuthorized: true, sharesHeld: '0', escrowCount: 1, ownerCount: 2,
    pledges: [{ account: BORROWER, sequence: 41, index: 'A'.repeat(64), txHash: TX, ledgerIndex: L - 10 }],
    conforming: true, reasons: [], provenance: 'REAL', ledgerIndex: L, ledgerHash: H,
  },
  action: { actionId: 'act-3', runId: 'run-1', role: 'riskOfficer', action: 'approve', vault: 'desk', state: 'approving' },
  error: { error: { code: 'BUSY', message: 'Four desk ledger walks are already running; retry shortly.', retryable: true } },
  marginPolicy: MARGIN_POLICY,
  marginCall: MARGIN_CALL,
  marginCallEntry: MARGIN_ENTRY,
  marginCalls: { ledgerIndex: L, ledgerHash: H, policy: MARGIN_POLICY, marginCalls: [MARGIN_CALL] },
  feedEventMarginCall: {
    id: `${pad19(L - 2)}-0`, type: 'MARGIN_CALL_ISSUED', provenance: 'DECLARED',
    vaultId: VAULT, loanId: LOAN1, ledgerIndex: L - 2, ledgerHash: H, entryHash: MARGIN_ENTRY.hash,
    why: 'Hudson Credit Desk (fictional) issued a margin call: LTV at withdrawal value 61.00 % against the mandate\'s 50.00 %; cure by 2026-10-25T14:10:00Z.',
    moneyEffect: null,
    receipts: [{ object: 'Position', field: 'ltvHeldBps', before: null, after: 6100 }],
  },
  usdTerms: USD_TERMS, // step 21
  ticketUsd: usdTicket(TICKET),
  marginCallUsd: MARGIN_CALL_USD,
})

/** Which schema validates each example (the two tickets share one, as do the three feed events). */
export const EXAMPLE_SCHEMA = Object.freeze(Object.fromEntries(Object.keys(EXAMPLES).map((k) => [k, ({ feedEventStatement: 'feedEvent', feedEventMarginCall: 'feedEvent', ticketBuy: 'ticket', ticketUsd: 'ticket', marginCallUsd: 'marginCall' })[k] ?? k])))

/** @template T @param {T} o @returns {T} */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}
