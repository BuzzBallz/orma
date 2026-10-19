/**
 * Presenter: reader snapshot -> the wire shapes in docs/01-API-CONTRACT.md.
 *
 * The contract is FROZEN. This file is the only place allowed to know what the wire
 * looks like, so a shape change is one diff rather than a hunt. Two rules it enforces
 * on every field:
 *
 *   - every monetary value leaves as a decimal STRING, never a JS number
 *   - every numeric field is ALWAYS PRESENT, defaulting to "0"; the frontend is
 *     promised it never has to handle an absent key
 */
import { deriveScoreInputs, buildScore } from './score.mjs'
import { str, num, Decimal, amountText, amountStr } from './num.mjs'

const EXPLORER = 'https://devnet.xrpl.org'
const DISTRESSED = new Set(['overdue', 'impaired', 'defaultable', 'defaulted'])

/** Labels are cosmetic and optional; a vault we were never given a name for shows its id. */
const labels = new Map()

/** A snapshot older than this, in ledger time, is served marked stale rather than as current. */
export const STALE_AFTER_SECONDS = 30

/**
 * How old a snapshot is. When a vault's read fails the reader keeps its last good snapshot; it
 * must then be served with the ledger it came from, not as the reading of the latest tick.
 * @param {{readAt:string, readMs?:number, ledgerIndex:number, closeTimeUsed:number}} snap
 * @param {number|null|undefined} closeTime the reader's latest validated close time
 */
export function freshness(snap, closeTime) {
  const ledgerAge = closeTime == null ? 0 : closeTime - snap.closeTimeUsed
  const wallAge = snap.readMs ? Math.floor((Date.now() - snap.readMs) / 1000) : 0
  const ageSeconds = Math.max(0, ledgerAge, wallAge)
  return { readAt: snap.readAt, readLedgerIndex: snap.ledgerIndex, ageSeconds, stale: ageSeconds > STALE_AFTER_SECONDS }
}
export function setLabel(vaultId, label) { labels.set(vaultId, label) }

/**
 * Trend needs history, which we only have once the reader has ticked twice.
 * Until then "stable" is the honest answer, not a guess.
 */
/**
 * The outlook, from the state of the book alone: a non-performing exposure, or claims the
 * redemption date cannot meet, is deteriorating. Comparing the NAV with the last one this process
 * served said "stable" after every restart, and of a facility with every loan in default.
 * Nothing on the ledger says a facility is improving, so this never claims it.
 */
function trendOf(loans, shortfallPct) {
  return loans.some((l) => DISTRESSED.has(l.status)) || num(shortfallPct).gt(0) ? 'deteriorating' : 'stable'
}

function buildAlerts({ recogLagSeconds, navDivergenceBps, coverShortfall, concentration, projectedShortfall, assetsAvailable, loans, asset }) {
  const alerts = []
  const undeclared = loans.filter((l) => l.status === 'overdue' || l.status === 'defaultable').length
  if (recogLagSeconds > 0) {
    alerts.push({
      code: 'RECOGNITION_LAG',
      severity: recogLagSeconds > 300 ? 'high' : 'medium',
      title: `${undeclared} loan${undeclared === 1 ? '' : 's'} overdue ${Math.round(recogLagSeconds / 60)} minutes, not impaired`,
      detail: 'The broker has not declared impairment. Vault NAV still reports par.',
      sinceAt: null,
    })
  }
  if (navDivergenceBps > 0) {
    alerts.push({
      code: 'NAV_DIVERGENCE',
      severity: navDivergenceBps > 1000 ? 'high' : 'medium',
      title: `Reported NAV overstates recoverable value by ${(navDivergenceBps / 100).toFixed(2)}%`,
      detail: 'AssetsTotal does not net LossUnrealized. Tools reading AssetsTotal alone report par.',
      sinceAt: null,
    })
  }
  if (coverShortfall.gt(0)) {
    alerts.push({
      code: 'COVER_SHORTFALL',
      severity: 'high',
      title: 'First-loss cover is below the broker’s own declared minimum',
      detail: `Short by ${amountText(coverShortfall, asset, 6)}.`,
      sinceAt: null,
    })
  }
  if (concentration.gte(0.75)) {
    alerts.push({
      code: 'CONCENTRATION_HIGH',
      severity: 'medium',
      title: `Largest loan is ${concentration.times(100).toFixed(0)}% of broker debt`,
      detail: 'Cover is keyed to total broker debt, not to the defaulting loan, so a single large default liquidates disproportionately little cover.',
      sinceAt: null,
    })
  }
  if (projectedShortfall.gt(0)) {
    alerts.push({
      code: 'REDEMPTION_SHORTFALL',
      severity: 'critical',
      title: `Projected shortfall of ${amountText(projectedShortfall, asset)} at redemption`,
      detail: 'Claims exceed projected liquidity. Redemption is first-come-first-serve.',
      sinceAt: null,
    })
  }
  if (assetsAvailable.isZero()) {
    alerts.push({
      code: 'LIQUIDITY_EXHAUSTED',
      severity: 'critical',
      title: 'Vault holds zero available cash',
      detail: 'Every withdrawal now fails with tecINSUFFICIENT_FUNDS.',
      sinceAt: null,
    })
  }
  return alerts
}

/**
 * Full detail payload for GET /api/vaults/:vaultId.
 * @param {object} snap reader snapshot
 * @param {{oracle?:object|null, closeTime?:number|null}} [opts]
 */
export function presentVault(snap, opts = {}) {
  const { vault, loans } = snap
  const broker = snap.brokers[0] ?? {
    loanBrokerId: null, owner: vault.owner, pseudoAccount: null,
    debtTotal: num(0), debtMaximum: num(0), coverAvailable: num(0),
    coverRateMinimum: 0, coverRateLiquidation: 0, managementFeeRate: 0, loanSequence: 0,
  }

  const { scoreArgs, broker: bx, cliff } = deriveScoreInputs({
    assetsTotal: vault.assetsTotal,
    assetsAvailable: vault.assetsAvailable,
    lossUnrealized: vault.lossUnrealized,
    sharesOutstanding: vault.sharesOutstanding,
    scale: vault.scale,
    asset: vault.asset,
    broker,
    loans,
    phase: vault.phase,
  })
  const score = buildScore(scoreArgs)
  score.computedAt = snap.readAt

  const debtTotal = num(broker.debtTotal)
  const presentedLoans = loans.map((l) => ({
    loanId: l.loanId,
    borrower: l.borrower,
    status: l.status,
    principalOutstanding: str(l.principalOutstanding),
    totalValueOutstanding: str(l.totalValueOutstanding),
    managementFeeOutstanding: str(l.managementFeeOutstanding),
    periodicPayment: str(l.periodicPayment),
    interestRate: l.interestRate,
    lateInterestRate: l.lateInterestRate,
    paymentInterval: l.paymentInterval,
    gracePeriod: l.gracePeriod,
    paymentRemaining: l.paymentRemaining,
    nextPaymentDueAt: l.nextPaymentDueAt,
    secondsUntilDue: l.secondsUntilDue,
    secondsUntilDefaultable: l.secondsUntilDefaultable,
    shareOfDebtTotal: debtTotal.isZero() ? '0.0000' : num(l.principalOutstanding).div(debtTotal).toFixed(4),
    impairable: l.status === 'overdue' || l.status === 'defaultable',
    // The transaction that last touched the loan: the explorer resolves transactions, and a loan's
    // object index is not one.
    explorerUrl: l.previousTxnId ? `${EXPLORER}/transactions/${l.previousTxnId}` : `${EXPLORER}/accounts/${l.borrower}`,
  }))

  const row = presentRow(snap, opts)

  return {
    vault: {
      ...row,
      shareMptId: vault.shareMptId,
      sharesOutstanding: str(vault.sharesOutstanding),
      scale: vault.scale,
      withdrawalPolicy: vault.withdrawalPolicy,
      isPrivate: vault.isPrivate,
      domainId: vault.domainId ?? null,
      subscriptionAt: vault.subscriptionAt,
      leVersion: vault.leVersion,
      explorerUrl: `${EXPLORER}/accounts/${vault.pseudoAccount}`,
    },
    broker: {
      loanBrokerId: broker.loanBrokerId,
      owner: broker.owner,
      pseudoAccount: broker.pseudoAccount,
      debtTotal: str(broker.debtTotal),
      debtMaximum: str(broker.debtMaximum),
      coverAvailable: str(broker.coverAvailable),
      coverRateMinimum: broker.coverRateMinimum,
      coverRateLiquidation: broker.coverRateLiquidation,
      managementFeeRate: broker.managementFeeRate,
      coverRequired: amountStr(bx.coverRequired, vault.asset),
      coverShortfall: amountStr(bx.coverShortfall, vault.asset),
      maxLiquidatableNow: amountStr(bx.maxLiquidatableNow, vault.asset),
      strandedCoverFraction: bx.strandedCoverFraction.toFixed(4),
    },
    score,
    loans: presentedLoans,
    phaseInfo: {
      ...snap.phaseInfo,
      claimsAtRedemption: amountStr(cliff.claims, vault.asset),
      liquidityAtRedemption: amountStr(cliff.liquidityAtRedemption, vault.asset),
      projectedShortfall: amountStr(cliff.projectedShortfall, vault.asset),
      shortfallPct: cliff.shortfallPct.toFixed(2),
    },
    oracle: opts.oracle ?? null,
    alerts: buildAlerts({
      asset: vault.asset,
      recogLagSeconds: scoreArgs.recogLagSeconds,
      navDivergenceBps: snap.navDivergenceBps,
      coverShortfall: bx.coverShortfall,
      concentration: scoreArgs.concentration,
      projectedShortfall: cliff.projectedShortfall,
      assetsAvailable: num(vault.assetsAvailable),
      loans,
    }),
  }
}

/** Summary row for GET /api/vaults. */
export function presentRow(snap, opts = {}) {
  const { vault, loans } = snap
  const broker = snap.brokers[0] ?? { debtTotal: num(0), coverAvailable: num(0), coverRateMinimum: 0, coverRateLiquidation: 0 }
  const { scoreArgs } = deriveScoreInputs({
    assetsTotal: vault.assetsTotal, assetsAvailable: vault.assetsAvailable,
    lossUnrealized: vault.lossUnrealized, sharesOutstanding: vault.sharesOutstanding, scale: vault.scale, asset: vault.asset,
    broker, loans, phase: vault.phase,
  })
  const score = buildScore(scoreArgs)
  return {
    vaultId: snap.vaultId,
    label: labels.get(snap.vaultId) ?? null,
    owner: vault.owner,
    pseudoAccount: vault.pseudoAccount,
    asset: vault.asset,
    vaultKind: vault.vaultKind,
    phase: vault.phase,
    grade: score.grade,
    gradeNumeric: score.gradeNumeric,
    trend: trendOf(loans, scoreArgs.shortfallPct),
    assetsTotal: str(vault.assetsTotal),
    assetsAvailable: str(vault.assetsAvailable),
    lossUnrealized: str(vault.lossUnrealized),
    navNaive: snap.navNaive,
    navCorrect: snap.navCorrect,
    navDivergenceBps: snap.navDivergenceBps,
    redemptionAt: vault.redemptionAt,
    secondsToRedemption: vault.redemptionRipple === null ? null : Number(vault.redemptionRipple) - snap.closeTimeUsed,
    loanCount: loans.length,
    distressedLoanCount: loans.filter((l) => DISTRESSED.has(l.status)).length,
    oraclePublished: Boolean(opts.oracle?.published),
    freshness: freshness(snap, opts.closeTime),
  }
}
