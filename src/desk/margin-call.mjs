/**
 * The margin call of a desk loan (step 20, addendum A11). Orma computes, the desk decides: this module
 * only says, at one ledger, whether an open desk loan breaks the mandate's LTV at withdrawal value, how
 * many share units would restore it, and how the call moves between NONE, ISSUED, CURED and EXPIRED.
 * Nothing here reads the ledger, signs or submits; the step-20 block of src/nyc/index.mjs reads the
 * positions, logs each transition in the chained decision log and pushes it to the Feed.
 *
 * Valued at the withdrawal value only (I1): the LTV is buildPositions' own, floor(principal × 10000 / held),
 * and a share unit is worth what heldValue makes it worth. On an inconsistent snapshot (I7) there is no
 * figure: the previous status stands, with the reason.
 */
import { num, Decimal, wholeShares, rippleToIso, isoToRipple } from '../num.mjs'
import { USD_LABEL } from '../nyc/contracts.mjs'
import { dropsToUsd } from '../ticket/engine.mjs'

/** "53.44 %" for 5344 bps. Not an amount: a ratio, read as the mandate states it. */
export const pct = (bps) => `${new Decimal(bps).div(100).toFixed(2)} %`

/** The value in drops of `units` share units at a withdrawal value per whole share, rounded as heldValue rounds it. */
export function valueOfUnits(units, perShare, scale = 0) {
  return new Decimal(wholeShares(units, scale).times(num(perShare)).toFixed(0))
}

/** buildPositions' LTV at withdrawal value, in bps: floor(principal × 10000 / held). */
const ltvOf = (principal, held) => num(principal).times(10000).div(held).floor()

/**
 * The smallest whole number of share units x whose value, added to `held`, brings the LTV at withdrawal
 * value to `maxLtvBps` or below: floor(P × 10000 / (held + value(x))) ≤ max. `collateralValueDrops` is the
 * value missing: the least whole number of drops that restores the limit. Null when no number of units can
 * (a share worth 0 at the withdrawal value). Pure.
 * @param {{ principalDrops: string, heldDrops: string, perShare: string, scale?: number, maxLtvBps: number }} o
 * @returns {{ sharesToAdd: string, collateralValueDrops: string } | null}
 */
export function sharesToRestore({ principalDrops, heldDrops, perShare, scale = 0, maxLtvBps }) {
  const P = num(principalDrops)
  const H = num(heldDrops)
  const within = (held) => held.gt(0) && ltvOf(P, held).lte(maxLtvBps)
  if (within(H)) return { sharesToAdd: '0', collateralValueDrops: '0' }
  // held + v > P × 10000 / (max + 1), v a whole number of drops: the least v is floor(T − H) + 1
  const T = P.times(10000).div(maxLtvBps + 1)
  const missing = Decimal.max(T.minus(H).floor().plus(1), 1)
  const per = num(perShare)
  if (per.lte(0)) return null
  const unit = new Decimal(10).pow(scale)
  // value(x) = round(x / 10^scale × per) ≥ missing  ⇐  x ≥ (missing − 0.5) × 10^scale / per
  let x = Decimal.max(missing.minus('0.5').times(unit).div(per).ceil(), 0)
  // the estimate, then the exact edge on the rounding actually applied
  while (!within(H.plus(valueOfUnits(x, per, scale)))) x = x.plus(1)
  while (x.gt(0) && within(H.plus(valueOfUnits(x.minus(1), per, scale)))) x = x.minus(1)
  return { sharesToAdd: x.toFixed(0), collateralValueDrops: missing.toFixed(0) }
}

/**
 * The same for a loan in the test dollar (step 21): the smallest whole number of share units x whose value,
 * added to `held`, brings floor(P × 10000 / usd(held + value(x))) to `maxLtvBps` or below, usd being the
 * positions' own conversion (the XRP/USD median of the oracles at that ledger, less the haircut, rounded down to a millionth of
 * a dollar). `collateralValueDrops` is the least whole number of drops of withdrawal value that restores the
 * limit, `collateralValueUsd` the dollars it is worth there. Null when no number of units can. Pure.
 * @param {{ principalUsd: string, heldDrops: string, perShare: string, scale?: number, maxLtvBps: number, xrpUsd: string, fxHaircutBps: number }} o
 * @returns {{ sharesToAdd: string, collateralValueDrops: string, collateralValueUsd: string } | null}
 */
export function sharesToRestoreUsd({ principalUsd, heldDrops, perShare, scale = 0, maxLtvBps, xrpUsd, fxHaircutBps }) {
  const P = num(principalUsd)
  const H = num(heldDrops)
  const within = (held) => {
    const u = dropsToUsd(held, xrpUsd, fxHaircutBps)
    return u.gt(0) && P.times(10000).div(u).floor().lte(maxLtvBps)
  }
  if (within(H)) return { sharesToAdd: '0', collateralValueDrops: '0', collateralValueUsd: '0' }
  const k = num(xrpUsd).times(new Decimal(1).minus(num(fxHaircutBps).div(10000)))
  const per = num(perShare)
  if (k.lte(0) || per.lte(0)) return null
  // usd(held) > P × 10000 / (max + 1): the least such millionth of a dollar, then the least whole drops worth it
  const T = P.times(10000).div(maxLtvBps + 1)
  const leastUsd = T.toDecimalPlaces(6, Decimal.ROUND_DOWN).plus('0.000001')
  let need = Decimal.max(leastUsd.times(1e6).div(k).ceil().minus(H), 1)
  while (!within(H.plus(need))) need = need.plus(1)
  while (need.gt(1) && within(H.plus(need).minus(1))) need = need.minus(1)
  const unit = new Decimal(10).pow(scale)
  let x = Decimal.max(need.minus('0.5').times(unit).div(per).ceil(), 0)
  while (!within(H.plus(valueOfUnits(x, per, scale)))) x = x.plus(1)
  while (x.gt(0) && within(H.plus(valueOfUnits(x.minus(1), per, scale)))) x = x.minus(1)
  return { sharesToAdd: x.toFixed(0), collateralValueDrops: need.toFixed(0), collateralValueUsd: dropsToUsd(H.plus(need), xrpUsd, fxHaircutBps).minus(dropsToUsd(H, xrpUsd, fxHaircutBps)).toFixed(6) }
}

/**
 * One desk loan's margin call at one ledger. Pure.
 *
 * `position` is an item of buildPositions, with `withdrawalValuePerShare` and `shareScale` of its first
 * pledged share (the share a cure pledges more of). `snapshot` is the ledger it was read at; `consistent`
 * false means I7 refused it. `previous` is the call as it stood (the decision log is the memory). `moved`
 * says what the reasons can name: the withdrawal value per share at the previous judgment and the
 * impairment or default the Feed saw on the pledged vault.
 *
 *   NONE → ISSUED     an open loan whose LTV at withdrawal value is above the limit; cureBy = close time + cureSeconds
 *   ISSUED → CURED    back within the limit
 *   ISSUED → EXPIRED  still above it once the close time passes cureBy
 *   CURED → ISSUED    a new breach, a new episode; EXPIRED stays EXPIRED while the breach lasts, and an
 *                     episode that ends after its expiry, or a loan that is no longer open, comes back to NONE
 *
 * @param {{ position: any, policy: import('../nyc/contracts.mjs').MarginPolicy, mandate?: { id: string, desk?: string },
 *   snapshot: { ledgerIndex: number, ledgerHash: string, closeTime: number, consistent?: boolean },
 *   previous?: import('../nyc/contracts.mjs').MarginCall | null,
 *   moved?: { perShareBefore?: string|null, triggerTx?: string|null } }} o
 * @returns {import('../nyc/contracts.mjs').MarginCall}
 */
export function judgeMarginCall({ position, policy, mandate = { id: policy.id }, snapshot, previous = null, moved = {} }) {
  const at = { ledgerIndex: snapshot.ledgerIndex, ledgerHash: snapshot.ledgerHash }
  const prev = previous?.status ?? 'NONE'
  const maxLtvBps = JSON.parse(String(position.usage?.find((u) => u.limit === 'maxLtvBps')?.threshold ?? 'null'))

  // I7: no figure on an inconsistent snapshot; the previous status stands, read where it was read.
  if (snapshot.consistent === false) {
    const reason = `The snapshot read at ledger ${snapshot.ledgerIndex} is inconsistent: no figure, the previous status stands.`
    if (previous) return { ...previous, reasons: [...previous.reasons.filter((r) => !r.startsWith('The snapshot read at ledger')), reason] }
    return { status: 'NONE', loanId: position.loanId, issuedLedger: null, issuedAt: null, cureBy: null, ltvHeldBps: null, maxLtvBps, shortfall: null, reasons: [reason], provenance: 'DECLARED', ...at }
  }

  const ltv = position.ltvHeldBps
  // step 21: a loan in the test dollar, its LTV at withdrawal value in dollars (buildPositions' own)
  const isUsd = position.currency === 'USD'
  // no usable XRP/USD price at this ledger: no dollar figure, so, as on an inconsistent snapshot, the
  // previous status stands, with the reason
  if (isUsd && position.usd?.priceUnavailable) {
    const reason = `No XRP/USD price at ledger ${snapshot.ledgerIndex}: ${position.usd.priceUnavailable} The previous status stands.`
    if (previous) return { ...previous, currency: 'USD', reasons: [...previous.reasons.filter((r) => !r.startsWith('No XRP/USD price at ledger')), reason] }
    return { status: 'NONE', loanId: position.loanId, issuedLedger: null, issuedAt: null, cureBy: null, ltvHeldBps: null, maxLtvBps, shortfall: null, reasons: [reason], provenance: 'DECLARED', ...at, currency: 'USD' }
  }
  const open = num(position.principalOutstanding).gt(0)
  const breach = open && ltv !== null && ltv > maxLtvBps
  const limitLine = `The mandate ${mandate.id} limits the LTV at withdrawal value to ${pct(maxLtvBps)}.`
  const ltvLine = ltv === null ? 'No pledged collateral was read for this loan.' : `The LTV at withdrawal value${isUsd ? `, in USD (${USD_LABEL}),` : ''} is ${pct(ltv)}, ${breach ? 'above' : 'within'} that limit.`
  const perNow = position.withdrawalValuePerShare ?? null
  const movedLines = [
    ...(moved.perShareBefore && perNow && moved.perShareBefore !== perNow ? [`The withdrawal value per share went from ${moved.perShareBefore} to ${perNow}.`] : []),
    ...(moved.triggerTx ? [`The pledged vault recorded an impairment or a default in transaction ${moved.triggerTx}.`] : []),
  ]
  const base = { loanId: position.loanId, ltvHeldBps: ltv, maxLtvBps, provenance: 'DECLARED', ...at, ...(moved.triggerTx && { triggerTx: moved.triggerTx }), ...(isUsd && { currency: 'USD' }) }
  const none = (why = []) => ({ status: 'NONE', ...base, issuedLedger: null, issuedAt: null, cureBy: null, shortfall: null, reasons: [limitLine, ltvLine, ...why] })

  if (!open) return none(prev === 'NONE' ? [] : ['The loan is no longer open: no margin call applies.'])

  if (breach) {
    const price = isUsd ? position.usd?.reference ?? null : null
    const restore = isUsd
      ? (price ? sharesToRestoreUsd({ principalUsd: position.principalOutstanding, heldDrops: position.collateralHeldDrops, perShare: perNow ?? '0', scale: position.shareScale ?? 0, maxLtvBps, xrpUsd: price.value, fxHaircutBps: position.usd.terms.fxHaircutBps }) : null)
      : sharesToRestore({ principalDrops: position.principalOutstanding, heldDrops: position.collateralHeldDrops, perShare: perNow ?? '0', scale: position.shareScale ?? 0, maxLtvBps })
    const shortfall = {
      collateralValueDrops: restore?.collateralValueDrops ?? (isUsd ? '0' : num(position.principalOutstanding).times(10000).div(maxLtvBps + 1).floor().plus(1).minus(num(position.collateralHeldDrops)).toFixed(0)),
      sharesToAdd: restore?.sharesToAdd ?? '0',
      withdrawalValuePerShare: perNow ?? '0',
      ...(isUsd && { collateralValueUsd: restore?.collateralValueUsd ?? '0' }),
    }
    const cannot = restore ? [] : ['The pledged shares are worth 0 at the withdrawal value: no number of them restores the limit.']
    const fresh = prev === 'NONE' || prev === 'CURED'
    const issuedAt = fresh ? rippleToIso(snapshot.closeTime) : previous.issuedAt
    const cureBy = fresh ? rippleToIso(snapshot.closeTime + policy.cureSeconds) : previous.cureBy
    const issued = { ...base, issuedLedger: fresh ? snapshot.ledgerIndex : previous.issuedLedger, issuedAt, cureBy, shortfall }
    const expired = !fresh && (prev === 'EXPIRED' || snapshot.closeTime > isoToRipple(cureBy))
    if (expired) {
      return { status: 'EXPIRED', ...issued, reasons: [limitLine, ltvLine, ...movedLines, `The cure window closed at ${cureBy} with the LTV still above the limit. ${policy.afterExpiry}`, ...cannot] }
    }
    return {
      status: 'ISSUED', ...issued,
      reasons: [limitLine, ltvLine, ...movedLines, `Cure by ${cureBy}: pledge ${shortfall.sharesToAdd} more share units, worth ${shortfall.collateralValueDrops} drops at the withdrawal value${isUsd ? ` (${shortfall.collateralValueUsd} USD, ${USD_LABEL}, at the XRP/USD median of the oracles less the haircut)` : ''}, or the desk may act under its escrow policy.`, ...cannot],
    }
  }

  // within the limit
  if (prev === 'ISSUED' || prev === 'CURED') {
    return { status: 'CURED', ...base, issuedLedger: previous.issuedLedger, issuedAt: previous.issuedAt, cureBy: previous.cureBy, shortfall: null, reasons: [limitLine, ltvLine, ...(prev === 'ISSUED' ? [`Back within the limit at ledger ${snapshot.ledgerIndex}, before ${previous.cureBy}.`] : previous.reasons.slice(2))] }
  }
  if (prev === 'EXPIRED') return none(['Back within the limit after the margin call expired.'])
  return none()
}

/** The transitions the decision log records: a status that changed into ISSUED, CURED or EXPIRED. */
export const isLoggedTransition = (before, after) => after.status !== (before?.status ?? 'NONE') && ['ISSUED', 'CURED', 'EXPIRED'].includes(after.status)
