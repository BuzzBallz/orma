/**
 * The scoring engine.
 *
 * Moved here VERBATIM from tools/build-fixtures.mjs, which now imports it back. That
 * direction matters: the committed fixtures Dev B built the UI against and the grades
 * the live backend emits come from the same code, so the 21:00 integration cannot
 * surface a grade mismatch. Acceptance test: rebuild the fixtures and
 * `git diff --stat fixtures/` must be empty.
 *
 * Grades are ORDINAL and rule-based, never a weighted sum. We anchor on DEADLINE,
 * because for a fixed-term fund the headline question is "will claims be met at
 * redemption", then notch for the factors that modify confidence in that answer.
 * Every notch is emitted in notchTrace and rendered in the UI, which is the answer
 * to "how did you choose your weights": we do not weight, we notch.
 */
import Decimal from 'decimal.js'

Decimal.set({ precision: 40, toExpNeg: -9e15, toExpPos: 9e15 })

const D = (x) => new Decimal(x ?? 0)

export const LADDER = ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'CCC', 'CC', 'C', 'D']
// Rating convention: a NEGATIVE delta means "notched down" = worse.
// LADDER is ordered best -> worst, so a worse grade is a HIGHER index. Hence minus.
export const notch = (grade, delta) => LADDER[Math.min(LADDER.length - 1, Math.max(0, LADDER.indexOf(grade) - delta))]
export const gradeNumeric = (g) => Math.round((1 - LADDER.indexOf(g) / (LADDER.length - 1)) * 100)

export function baseGradeFromRatio(r, bands) {
  for (const [threshold, grade] of bands) if (D(r).gte(threshold)) return grade
  return 'D'
}

export function buildScore({ liquidityRatio, coverAdequacy, concentration, recogLagSeconds, shortfallPct, phase, realisedLossPct = 0 }) {
  const dims = []
  const trace = []

  const gLiq = baseGradeFromRatio(liquidityRatio, [[0.95, 'AAA'], [0.85, 'A'], [0.7, 'BBB'], [0.5, 'BB'], [0.25, 'B'], [0.05, 'CCC']])
  dims.push({ key: 'LIQUIDITY', label: 'Liquidity cover', value: D(liquidityRatio).toFixed(4), unit: 'ratio', grade: gLiq, notches: 0,
    explain: `AssetsAvailable is ${D(liquidityRatio).times(100).toFixed(2)}% of AssetsTotal.`, worseIsHigher: false })

  const gCov = baseGradeFromRatio(coverAdequacy, [[1, 'AA'], [0.5, 'A-'], [0.2, 'BBB-'], [0.05, 'BB-'], [0.01, 'B-']])
  dims.push({ key: 'COVER', label: 'First-loss adequacy', value: D(coverAdequacy).toFixed(4), unit: 'ratio', grade: gCov, notches: 0,
    explain: 'Cover that can actually be liquidated, after the CoverRateMinimum x CoverRateLiquidation double product, against current exposure.', worseIsHigher: false })

  const gCon = baseGradeFromRatio(D(1).minus(concentration), [[0.8, 'AA'], [0.6, 'A-'], [0.4, 'BBB-'], [0.2, 'BB-']])
  dims.push({ key: 'CONCENT', label: 'Concentration', value: D(concentration).toFixed(4), unit: 'ratio', grade: gCon, notches: 0,
    explain: `Largest loan is ${D(concentration).times(100).toFixed(1)}% of broker debt. Cover is keyed to total debt, so one large default consumes disproportionately little cover.`, worseIsHigher: true })

  const gRec = recogLagSeconds <= 0 ? 'AAA' : recogLagSeconds < 60 ? 'A' : recogLagSeconds < 300 ? 'BBB' : recogLagSeconds < 900 ? 'BB' : 'CCC'
  dims.push({ key: 'RECOG', label: 'Recognition lag', value: String(Math.max(0, recogLagSeconds)), unit: 'seconds', grade: gRec, notches: 0,
    explain: recogLagSeconds > 0
      ? `A loan has been overdue ${Math.round(recogLagSeconds)}s without the broker declaring impairment. Until it does, vault NAV reports par.`
      : 'No unrecognised overdue exposure.', worseIsHigher: true })

  const gDead = baseGradeFromRatio(D(1).minus(D(shortfallPct).div(100)), [[1, 'AAA'], [0.98, 'AA'], [0.9, 'A'], [0.75, 'BBB'], [0.5, 'BB'], [0.25, 'B'], [0.1, 'CCC']])
  dims.push({ key: 'DEADLINE', label: 'Redemption cliff', value: D(shortfallPct).toFixed(2), unit: 'percent', grade: gDead, notches: 0,
    explain: D(shortfallPct).isZero()
      ? 'Performing loans contractually mature before RedemptionDate, so projected liquidity covers claims in full.'
      : `Projected shortfall of claims over liquidity at RedemptionDate is ${D(shortfallPct).toFixed(2)}%. Performing loans must mature before redemption, so this shortfall is the non-performing book net of recoverable cover.`,
    worseIsHigher: true })

  // Anchor on the redemption cliff — for a fixed-term fund the headline question is
  // "will claims be met at RedemptionDate" — then notch for the factors that modify
  // confidence in that answer. No weights are applied anywhere.
  let headline = gDead
  trace.push({ from: gDead, rule: 'anchor on DEADLINE (can claims be met at redemption)', delta: 0, to: gDead })

  // CAPITAL ALREADY DESTROYED.
  //
  // Every other dimension measures current EXPOSURE, and a realised loss leaves none
  // behind: the write-off removes the asset, the provision is released, and the book
  // reads clean. Without this rule a facility that defaulted on four fifths of its
  // loans scores AAA the moment the write-off settles, identically to one that never
  // lost a penny -- and because the book sorts worst-first to surface danger, the most
  // damaged facility sorts last. Observed on Devnet, not hypothesised.
  //
  // This measures what the units are worth against what was paid for them, so it is
  // memory rather than exposure, and it is deliberately the first notch applied.
  const rl = D(realisedLossPct)
  if (rl.gt(0)) {
    // Bands, not a formula: the grade is ordinal and each step has to be defensible on
    // its own rather than emerging from arithmetic nobody can check on a slide.
    const delta = rl.gte(75) ? -14 : rl.gte(50) ? -12 : rl.gte(25) ? -8 : rl.gte(10) ? -5 : rl.gte(2) ? -3 : -1
    const tR = notch(headline, delta)
    trace.push({ from: headline, rule: `${rl.toFixed(1)}% of subscribed capital destroyed and written off`, delta, to: tR })
    headline = tR
  }

  if (recogLagSeconds > 300) { const t = notch(headline, -2); trace.push({ from: headline, rule: 'RECOG lag > 300s: overdue exposure the broker has not declared', delta: -2, to: t }); headline = t }
  else if (recogLagSeconds > 0) { const t = notch(headline, -1); trace.push({ from: headline, rule: 'RECOG lag > 0s: overdue exposure not yet declared', delta: -1, to: t }); headline = t }
  if (D(concentration).gte(0.75)) { const t = notch(headline, -1); trace.push({ from: headline, rule: 'single loan >= 75% of broker debt (cover is keyed to total debt, not loan size)', delta: -1, to: t }); headline = t }
  if (D(coverAdequacy).lt(0.05)) { const t = notch(headline, -1); trace.push({ from: headline, rule: 'liquidatable cover < 5% of the exposure it must absorb', delta: -1, to: t }); headline = t }
  if (LADDER.indexOf(gLiq) >= LADDER.indexOf('B') && phase === 'Redemption') { const t = notch(headline, -2); trace.push({ from: headline, rule: 'in Redemption phase with exhausted liquidity: withdrawals are failing now', delta: -2, to: t }); headline = t }

  dims.push({ key: 'HEADLINE', label: 'Composite', value: headline, unit: 'grade', grade: headline, notches: 0,
    explain: 'Ordinal notching of the five measured dimensions. No weights are applied anywhere.', worseIsHigher: false })

  return { grade: headline, gradeNumeric: gradeNumeric(headline), computedAt: null, methodVersion: '1.0.0', dimensions: dims, notchTrace: trace }
}

// ---------------------------------------------------------------------------
// Derivation: raw vault/broker/loan state -> the five inputs buildScore needs.
// Shared by tools/build-fixtures.mjs and the live backend so a grade can never
// differ between the fixtures Dev B built against and what the API serves.
// Accepts strings or Decimals; D() normalises both.
// ---------------------------------------------------------------------------

const PERFORMING = new Set(['current', 'due_soon'])
const DISTRESSED = new Set(['overdue', 'impaired', 'defaultable'])

/**
 * @param {{assetsTotal:any, assetsAvailable:any, lossUnrealized:any, sharesOutstanding:any,
 *          broker:{debtTotal:any, coverAvailable:any, coverRateMinimum:number, coverRateLiquidation:number},
 *          loans:Array<{status:string, principalOutstanding:any, totalValueOutstanding:any, secondsUntilDue:number}>,
 *          phase:string}} o
 */
export function deriveScoreInputs(o) {
  const assetsTotal = D(o.assetsTotal)
  const assetsAvailable = D(o.assetsAvailable)
  const lossUnrealized = D(o.lossUnrealized)
  const debtTotal = D(o.broker.debtTotal)
  const coverAvailable = D(o.broker.coverAvailable)

  const cmin = D(o.broker.coverRateMinimum).div(100000)
  const cliq = D(o.broker.coverRateLiquidation).div(100000)
  // The DOUBLE PRODUCT. Both rates are 1e-5 units so BOTH are divided by 1e5.
  // Verified on-chain: cover consumed == ceil(DebtTotal * cmin * cliq), keyed to the
  // broker's TOTAL debt at that instant, not to the defaulting loan's principal.
  const maxLiquidatableNow = debtTotal.times(cmin).times(cliq).ceil()
  const coverRequired = debtTotal.times(cmin).ceil()
  const coverShortfall = Decimal.max(0, coverRequired.minus(coverAvailable))
  const strandedCoverFraction = coverAvailable.isZero()
    ? D(0)
    : Decimal.max(0, coverAvailable.minus(maxLiquidatableNow)).div(coverAvailable)

  const largest = o.loans.reduce((m, l) => Decimal.max(m, D(l.principalOutstanding)), D(0))
  const concentration = debtTotal.isZero() ? D(0) : largest.div(debtTotal)
  const recogLagSeconds = Math.max(
    0,
    ...o.loans.filter((l) => l.status === 'overdue' || l.status === 'defaultable').map((l) => -l.secondsUntilDue),
    0,
  )

  // rippled refuses any LoanSet maturing after RedemptionDate, so every PERFORMING loan
  // is contractually repaid before redemption. A projected shortfall is therefore exactly
  // the non-performing book, net of recoverable cover. Being fully lent is not a signal.
  const performingRepayment = o.loans.filter((l) => PERFORMING.has(l.status))
    .reduce((a, l) => a.plus(D(l.totalValueOutstanding)), D(0))
  const distressedPrincipal = o.loans.filter((l) => DISTRESSED.has(l.status))
    .reduce((a, l) => a.plus(D(l.principalOutstanding)), D(0))
  const coverRecovery = Decimal.min(maxLiquidatableNow, coverAvailable)

  const claims = assetsTotal.minus(lossUnrealized)
  const liquidityAtRedemption = assetsAvailable.plus(performingRepayment)
    .plus(distressedPrincipal.isZero() ? D(0) : coverRecovery)
  const projectedShortfall = Decimal.max(0, claims.minus(liquidityAtRedemption))
  const shortfallPct = claims.isZero() ? D(0) : projectedShortfall.div(claims).times(100)

  // Exposure cover must absorb: recognised loss, OR undeclared distressed principal.
  // Using lossUnrealized alone would grade a vault hiding a large overdue loan as
  // perfectly covered. Concealment must never improve the score.
  const coverExposure = Decimal.max(lossUnrealized, distressedPrincipal)
  const coverAdequacy = coverExposure.isZero()
    ? D(1)
    : Decimal.min(maxLiquidatableNow, coverAvailable).div(coverExposure)

  // Capital destroyed, as a share of capital subscribed.
  //
  // Par is 1.0 for a closed-ended vault: subscription closes before any lending, so the
  // first deposit sets the unit value at one and later subscribers join at the same
  // value with no P&L yet accrued. SharesOutstanding is therefore capital subscribed,
  // measured in asset units.
  //
  // Compared against assetsTotal, NOT against assetsTotal minus lossUnrealized. An
  // unrealised loss is a provision against an asset the vault still holds and may still
  // recover; it must NOT be counted here, or an honest manager who writes down early
  // would be punished for the disclosure. Only a write-off, which removes the asset
  // from AssetsTotal outright, is permanent destruction.
  const shares = D(o.sharesOutstanding)
  const realisedLossPct = shares.isZero() || assetsTotal.gte(shares)
    ? D(0)
    : shares.minus(assetsTotal).div(shares).times(100)

  return {
    scoreArgs: {
      liquidityRatio: assetsTotal.isZero() ? D(1) : assetsAvailable.div(assetsTotal),
      coverAdequacy, concentration, recogLagSeconds, shortfallPct, phase: o.phase, realisedLossPct,
    },
    broker: { maxLiquidatableNow, coverRequired, coverShortfall, strandedCoverFraction },
    cliff: { claims, liquidityAtRedemption, projectedShortfall, shortfallPct },
  }
}
