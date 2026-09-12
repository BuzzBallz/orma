/**
 * Broker track record, and the ordering question.
 *
 * THE FINDING THIS EXISTS FOR. Cover consumed on a default is
 *
 *     ceil(LoanBroker.DebtTotal x CoverRateMinimum/1e5 x CoverRateLiquidation/1e5)
 *
 * keyed to the broker's TOTAL debt at that instant, not to the principal of the loan
 * that defaulted (LoanManage.cpp:146-169, and DebtTotal is decremented at line 248).
 * Each default therefore shrinks the base for the next one, so the TOTAL cover paid
 * across a fixed set of defaults depends on the ORDER they are declared in.
 *
 * Measured on Devnet with loans of 30 and 10 XRP at 10%/10%: declaring the big loan
 * first consumed 0.50 XRP of cover, declaring the small one first consumed 0.70 XRP.
 * Same losses, 40% difference in what the first-loss capital actually absorbed, and
 * the difference lands on the depositors.
 *
 * Only the LoanBroker owner may declare (LoanManage.cpp:124-129), and that owner is
 * necessarily the vault owner (LoanBrokerSet.cpp:109). So the party whose capital
 * absorbs the loss also chooses the sequence that sets how much of it is absorbed.
 *
 * By the rearrangement inequality, total cover is MINIMISED largest-first and
 * MAXIMISED smallest-first. Closed form over k defaults with principals p and
 * c = cmin x cliq:
 *
 *     T(order, k) = c x [ k x D0  -  sum over i of (k - i) x p_order(i) ]
 *
 * This module reconstructs what a broker actually did, computes what the best and
 * worst orders would have paid, and places the observed behaviour between them.
 * That serves both audiences: depositors see what the ordering cost them, and an
 * honest broker gets a tool telling them which order is fair.
 */
import { num, Decimal } from './num.mjs'
import { logger } from './log.mjs'

const log = logger('history')
const RIPPLE_EPOCH = 946684800

const FLAG = { IMPAIR: 0x20000, UNIMPAIR: 0x40000, DEFAULT: 0x10000 }

/** Pull LoanManage and cover-movement events for one broker out of account history. */
export async function fetchBrokerHistory(xrpl, ownerAccount, brokerId) {
  const txs = await xrpl.accountTx(ownerAccount)
  const events = []

  for (const entry of txs) {
    const tx = entry.tx_json ?? entry.tx ?? {}
    const meta = entry.meta ?? entry.metaData
    if (!meta || meta.TransactionResult !== 'tesSUCCESS') continue

    const brokerNode = (meta.AffectedNodes ?? [])
      .map((n) => n.ModifiedNode)
      .find((n) => n?.LedgerEntryType === 'LoanBroker' && (n.LedgerIndex === brokerId || n.FinalFields?.index === brokerId))
    if (!brokerNode && tx.LoanBrokerID !== brokerId) continue

    const prev = brokerNode?.PreviousFields ?? {}
    const fin = brokerNode?.FinalFields ?? {}
    const at = entry.close_time_iso
      ?? (entry.tx_json?.date ? new Date((entry.tx_json.date + RIPPLE_EPOCH) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null)

    const coverBefore = prev.CoverAvailable !== undefined ? num(prev.CoverAvailable) : num(fin.CoverAvailable)
    const coverAfter = num(fin.CoverAvailable)
    const debtBefore = prev.DebtTotal !== undefined ? num(prev.DebtTotal) : num(fin.DebtTotal)
    const debtAfter = num(fin.DebtTotal)

    const type = tx.TransactionType
    if (type === 'LoanManage') {
      const flags = Number(tx.Flags ?? 0)
      const kind = flags & FLAG.DEFAULT ? 'default' : flags & FLAG.IMPAIR ? 'impair' : flags & FLAG.UNIMPAIR ? 'unimpair' : 'manage'
      events.push({
        kind,
        at,
        hash: entry.hash ?? tx.hash,
        loanId: tx.LoanID ?? null,
        ledgerIndex: entry.ledger_index ?? null,
        debtBefore, debtAfter,
        coverBefore, coverAfter,
        coverConsumed: Decimal.max(0, coverBefore.minus(coverAfter)),
        principal: Decimal.max(0, debtBefore.minus(debtAfter)),
      })
    } else if (type === 'LoanBrokerCoverDeposit' || type === 'LoanBrokerCoverWithdraw') {
      events.push({
        kind: type === 'LoanBrokerCoverDeposit' ? 'cover_deposit' : 'cover_withdraw',
        at,
        hash: entry.hash ?? tx.hash,
        loanId: null,
        ledgerIndex: entry.ledger_index ?? null,
        debtBefore, debtAfter, coverBefore, coverAfter,
        coverConsumed: new Decimal(0),
        principal: new Decimal(0),
        amount: coverAfter.minus(coverBefore).abs(),
      })
    }
  }
  // account_tx is newest first; a track record reads forwards.
  return events.reverse()
}

/**
 * Total cover consumed for a given ordering of principals.
 * Mirrors the ledger exactly: ceil at each step, base is the remaining book.
 */
export function coverForOrder(principals, startingDebt, cmin, cliq, coverAvailable) {
  const c = num(cmin).div(100000).times(num(cliq).div(100000))
  let debt = num(startingDebt)
  let cover = num(coverAvailable)
  let total = new Decimal(0)
  for (const p of principals) {
    const want = debt.times(c).ceil()
    const paid = Decimal.min(want, num(p), cover)
    total = total.plus(paid)
    cover = cover.minus(paid)
    debt = Decimal.max(0, debt.minus(num(p)))
  }
  return total
}

/**
 * Compare what the broker did against the best and worst orders available to them.
 * `fairness` is 0 when they picked the LP-worst order and 1 when they picked the best.
 */
export function analyseOrdering(events, broker) {
  const defaults = events.filter((e) => e.kind === 'default' && e.principal.gt(0))
  if (defaults.length < 2) {
    return {
      applicable: false,
      reason: defaults.length === 0 ? 'no defaults declared' : 'a single default has no ordering',
      defaultCount: defaults.length,
    }
  }
  const startingDebt = defaults[0].debtBefore
  const startingCover = defaults[0].coverBefore
  const principals = defaults.map((d) => d.principal)
  const actual = defaults.reduce((a, d) => a.plus(d.coverConsumed), new Decimal(0))

  const asc = [...principals].sort((a, b) => a.comparedTo(b))
  const desc = [...asc].reverse()
  const best = coverForOrder(asc, startingDebt, broker.coverRateMinimum, broker.coverRateLiquidation, startingCover)
  const worst = coverForOrder(desc, startingDebt, broker.coverRateMinimum, broker.coverRateLiquidation, startingCover)
  const span = best.minus(worst)

  return {
    applicable: true,
    defaultCount: defaults.length,
    actualCoverPaid: actual.toFixed(0),
    bestPossible: best.toFixed(0),
    worstPossible: worst.toFixed(0),
    // What the chosen sequence cost depositors relative to the LP-optimal one.
    costToDepositors: best.minus(actual).toFixed(0),
    spread: span.toFixed(0),
    fairness: span.isZero() ? '1.0000' : actual.minus(worst).div(span).toFixed(4),
    observedOrder: defaults.map((d) => ({
      loanId: d.loanId, at: d.at, hash: d.hash,
      principal: d.principal.toFixed(0),
      debtBefore: d.debtBefore.toFixed(0),
      coverConsumed: d.coverConsumed.toFixed(0),
    })),
    fairOrder: asc.map((p) => p.toFixed(0)),
  }
}

/**
 * The recommendation an honest broker wants: declare in this order to maximise what
 * the first-loss capital actually absorbs on behalf of depositors.
 */
export function recommendOrder(loans, broker) {
  const candidates = loans
    .filter((l) => ['overdue', 'impaired', 'defaultable'].includes(l.status))
    .map((l) => ({ loanId: l.loanId, principal: num(l.principalOutstanding), status: l.status }))
  if (candidates.length < 2) {
    return { applicable: false, reason: 'fewer than two distressed loans', candidates: candidates.length }
  }
  const asc = [...candidates].sort((a, b) => a.principal.comparedTo(b.principal))
  const desc = [...asc].reverse()
  const debt = num(broker.debtTotal)
  const cover = num(broker.coverAvailable)
  const best = coverForOrder(asc.map((c) => c.principal), debt, broker.coverRateMinimum, broker.coverRateLiquidation, cover)
  const worst = coverForOrder(desc.map((c) => c.principal), debt, broker.coverRateMinimum, broker.coverRateLiquidation, cover)
  return {
    applicable: true,
    recommendedOrder: asc.map((c) => ({ loanId: c.loanId, principal: c.principal.toFixed(0), status: c.status })),
    coverIfFair: best.toFixed(0),
    coverIfSelfServing: worst.toFixed(0),
    atStakeForDepositors: best.minus(worst).toFixed(0),
  }
}

/**
 * Reputation. Ordinal and rule-based like the vault score: a broker is graded on what
 * they did, not on a weighted opinion of it.
 */
export function reputation(events, ordering, broker) {
  const defaults = events.filter((e) => e.kind === 'default')
  const impairs = events.filter((e) => e.kind === 'impair')
  const withdrawals = events.filter((e) => e.kind === 'cover_withdraw')

  // Declaring a default with no prior impairment skips the warning entirely: the loss
  // goes straight from invisible to realised, with no window for anyone to react.
  const impairedLoanIds = new Set(impairs.map((e) => e.loanId).filter(Boolean))
  const undeclaredDefaults = defaults.filter((d) => d.loanId && !impairedLoanIds.has(d.loanId)).length

  const findings = []
  let score = 100

  if (ordering.applicable) {
    const f = Number(ordering.fairness)
    if (f < 0.25) { score -= 35; findings.push({ code: 'ORDERING_SELF_SERVING', detail: `Declared defaults in an order close to the one that minimises their own first-loss contribution (fairness ${ordering.fairness}). Cost depositors ${ordering.costToDepositors} drops versus the fair order.` }) }
    else if (f < 0.75) { score -= 15; findings.push({ code: 'ORDERING_MIXED', detail: `Ordering sits between the fair and the self-serving sequence (fairness ${ordering.fairness}).` }) }
    else findings.push({ code: 'ORDERING_FAIR', detail: `Declared in an order close to the one that maximises cover paid to depositors (fairness ${ordering.fairness}).` })
  }

  if (undeclaredDefaults > 0) {
    score -= 20 * undeclaredDefaults
    findings.push({ code: 'DEFAULT_WITHOUT_IMPAIRMENT', detail: `${undeclaredDefaults} loan(s) went straight to default with no prior impairment, so the loss was never signalled before it was realised.` })
  }
  if (withdrawals.length > 0) {
    score -= 10 * withdrawals.length
    findings.push({ code: 'COVER_WITHDRAWN', detail: `${withdrawals.length} first-loss capital withdrawal(s) on record. Maple's v1 pool cover was drained by stakers ahead of a looming default; this is the same shape.` })
  }
  if (defaults.length === 0) findings.push({ code: 'NO_DEFAULTS', detail: 'No defaults declared in the retained history.' })

  score = Math.max(0, Math.min(100, score))
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'E'

  return {
    grade,
    score,
    observations: {
      defaults: defaults.length,
      impairments: impairs.length,
      defaultsWithoutPriorImpairment: undeclaredDefaults,
      coverWithdrawals: withdrawals.length,
      eventsRetained: events.length,
    },
    findings,
    // Devnet prunes to roughly 29 days, so this is a window rather than a lifetime.
    caveat: 'Computed from retained ledger history only. Devnet retains roughly 29 days.',
  }
}
