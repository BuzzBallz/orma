/**
 * Numbers, and the single place where "absent means zero" is handled.
 *
 * Two rules that the whole backend depends on:
 *
 *  1. rippled omits any field whose value equals the type default. A vault with no
 *     unrealised loss has NO `LossUnrealized` key at all, not `"0"`. Every read of a
 *     ledger amount goes through `num()` so that coalescing happens in exactly one
 *     place and cannot be forgotten at a call site.
 *
 *  2. XRPL NUMBER fields carry up to 19 significant digits and may arrive in
 *     scientific notation ("1e17"). `Number()` destroys them silently and
 *     `BigInt("1e17")` throws. Everything monetary is a Decimal internally and a
 *     decimal string on the wire.
 */
import Decimal from 'decimal.js'

// 40 digits is comfortably above the 19 significant digits rippled can emit.
Decimal.set({ precision: 40, toExpNeg: -9e15, toExpPos: 9e15 })

export { Decimal }

/** @typedef {import('decimal.js').Decimal} Dec */

/**
 * Read a ledger amount. Absent, null, empty string and undefined all mean zero.
 * Accepts the scientific notation rippled sometimes emits.
 * @param {unknown} v
 * @returns {Dec}
 */
export function num(v) {
  if (v === undefined || v === null || v === '') return new Decimal(0)
  if (v instanceof Decimal) return v
  if (typeof v === 'object') {
    // MPT and IOU amounts arrive as { value, ... }. XRP arrives as a bare string.
    const inner = /** @type {Record<string, unknown>} */ (v).value
    return inner === undefined ? new Decimal(0) : num(inner)
  }
  try {
    return new Decimal(String(v))
  } catch {
    return new Decimal(0)
  }
}

/**
 * Serialise for the API. Always a plain decimal string, never scientific notation,
 * never a JS number.
 * @param {Dec|string|number|undefined|null} v
 * @returns {string}
 */
export function str(v) {
  return num(v).toFixed()
}

/**
 * Divide guarding against a zero denominator, which happens on an empty vault.
 * @param {Dec} a @param {Dec} b @param {number} [dp]
 * @returns {string}
 */
export function ratio(a, b, dp = 6) {
  return b.isZero() ? new Decimal(0).toFixed(dp) : a.div(b).toFixed(dp)
}

/** Basis points of (a - b) / a, as an integer. Zero when a is zero. */
export function bps(a, b) {
  if (a.isZero()) return 0
  return Number(a.minus(b).div(a).times(10000).toFixed(0))
}

// --- time -------------------------------------------------------------------

export const RIPPLE_EPOCH = 946684800

/** Ripple epoch (uint32) to ISO-8601 UTC. Null-safe: absent stays null. */
export function rippleToIso(t) {
  if (t === undefined || t === null) return null
  return new Date((Number(t) + RIPPLE_EPOCH) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** ISO-8601 or Date to Ripple epoch seconds. */
export function isoToRipple(d) {
  return Math.floor(new Date(d).getTime() / 1000) - RIPPLE_EPOCH
}

// --- flags ------------------------------------------------------------------

/**
 * Loan ledger-object flags. Test by BIT, never by equality: a loan can carry more
 * than one flag and `Flags === 131072` silently stops matching the day it does.
 */
export const LOAN_FLAG = {
  IMPAIRED: 0x20000, // 131072
  DEFAULTED: 0x10000, // 65536
}

export const hasFlag = (flags, bit) => (Number(flags ?? 0) & bit) === bit

// --- rates ------------------------------------------------------------------

/**
 * XLS-66 rate fields (CoverRateMinimum, CoverRateLiquidation, InterestRate,
 * ManagementFeeRate) are in 1e-5 units: 100000 == 100%. Both cover rates are
 * divided by 1e5, which is the mistake that makes the cover formula look 100x
 * larger than it is.
 */
export const RATE_SCALE = 100000
export const rateToDec = (r) => num(r).div(RATE_SCALE)
export const rateToPct = (r) => rateToDec(r).times(100).toFixed(3)
