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
 *
 * VERIFIED END TO END ON DEVNET. A broker with 30 and 10 XRP loans declared the big
 * one first. Reconstructed from ledger history alone: default at DebtTotal 40 XRP
 * consumed 0.40 XRP of cover, default at DebtTotal 10 XRP consumed 0.10, total 0.50
 * against a best-possible 0.70. Fairness 0.0000, reputation E, and the 0.20 XRP
 * difference is depositor money. Nothing about that required privileged access:
 * it is all public ledger state.
 */
import { num, Decimal, amountText, rippleToIso } from './num.mjs'
import { logger } from './log.mjs'
import { readHistory, creates } from './archive.mjs'

const log = logger('history')

export const FLAG = { IMPAIR: 0x20000, UNIMPAIR: 0x40000, DEFAULT: 0x10000 }

/** Pull LoanManage and cover-movement events for one broker out of account history. */
/**
 * What a transaction says it moved. XRP is a drops string; an issued asset or an MPT is an
 * object carrying `value`. Returns null when the field is absent, so a caller can fall back.
 */
function txAmountDrops(amount) {
  if (amount === undefined || amount === null) return null
  if (typeof amount === 'string') return num(amount)
  if (typeof amount === 'object' && amount.value !== undefined) return num(amount.value)
  return null
}

/**
 * A broker's events, oldest first, from account_tx entries (newest first) on the account that
 * owns it. Every LoanManage and cover movement is signed by that owner, so its history holds them all.
 */
export function brokerEvents(txs, brokerId) {
  const events = []

  for (const entry of txs) {
    const tx = entry.tx_json ?? entry.tx ?? {}
    const meta = entry.meta ?? entry.metaData
    if (!meta || meta.TransactionResult !== 'tesSUCCESS') continue

    const nodes = (meta.AffectedNodes ?? []).map((n) => n.ModifiedNode ?? n.DeletedNode).filter(Boolean)
    const brokerNode = nodes
      .find((n) => n.LedgerEntryType === 'LoanBroker' && (n.LedgerIndex === brokerId || n.FinalFields?.index === brokerId))

    // An impairment does NOT touch the LoanBroker object and LoanManage carries no
    // LoanBrokerID -- only LoanID. Matching on the broker node or the transaction field
    // alone therefore drops every impairment on the floor, which matters because
    // reputation() counts impairments to decide whether a default was signalled first.
    // Without this join an honest broker who impairs before defaulting is scored as
    // though they never warned anyone. The Loan node in the same metadata carries
    // FinalFields.LoanBrokerID, so the join costs no extra request.
    const loanNode = nodes.find((n) => n.LedgerEntryType === 'Loan')
    const loanBroker = loanNode?.FinalFields?.LoanBrokerID ?? loanNode?.PreviousFields?.LoanBrokerID
    if (!brokerNode && tx.LoanBrokerID !== brokerId && loanBroker !== brokerId) continue

    const prev = brokerNode?.PreviousFields ?? {}
    const fin = brokerNode?.FinalFields ?? {}
    const at = entry.close_time_iso
      ?? (entry.tx_json?.date ? rippleToIso(entry.tx_json.date) : null)

    // When the broker object was not touched -- an impairment -- its cover and book are
    // genuinely unchanged, but this transaction does not say what they were. Report that
    // as unknown rather than as zero: a zero here would read as "the book was empty".
    const known = Boolean(brokerNode)
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
        source: entry.source ?? 'live',
        brokerStateKnown: known,
        debtBefore, debtAfter,
        coverBefore, coverAfter,
        coverConsumed: Decimal.max(0, coverBefore.minus(coverAfter)),
        principal: Decimal.max(0, debtBefore.minus(debtAfter)),
        // The exposure the action was taken against.
        //
        // On a DEFAULT the ledger deletes PrincipalOutstanding from the loan (finding
        // L9: a defaulted loan drops four required fields), so FinalFields carries
        // nothing and the obvious read returns zero. PreviousFields still holds what it
        // was, and failing that the broker's book shed exactly that principal.
        exposure: (() => {
          const fin = num(loanNode?.FinalFields?.PrincipalOutstanding)
          if (fin.gt(0)) return fin
          const prev = num(loanNode?.PreviousFields?.PrincipalOutstanding)
          if (prev.gt(0)) return prev
          return Decimal.max(0, debtBefore.minus(debtAfter))
        })(),
      })
    } else if (type === 'LoanBrokerCoverDeposit' || type === 'LoanBrokerCoverWithdraw') {
      // FINDING X1, ON OUR OWN CODE, FOR THE SECOND TIME.
      //
      // The amount used to be read as the change in CoverAvailable. On the FIRST cover
      // deposit that difference is always zero: CoverAvailable is not stored on the broker
      // until the first deposit creates it, so PreviousFields has no previous value for it. The
      // fallback on line 82 -- correct for an impairment, which touches nothing -- then
      // sets the before equal to the after and the movement disappears. So the row that
      // says "added first-loss capital" reported adding none, on the exhibit whose entire
      // subject is first-loss capital.
      //
      // The amount is on the TRANSACTION, which states it outright and cannot omit it.
      // The diff is only a fallback now, for a top-up where the field really did move.
      const stated = txAmountDrops(tx.Amount)
      const moved = stated ?? coverAfter.minus(coverBefore).abs()
      const deposit = type === 'LoanBrokerCoverDeposit'
      events.push({
        kind: deposit ? 'cover_deposit' : 'cover_withdraw',
        at,
        hash: entry.hash ?? tx.hash,
        loanId: null,
        ledgerIndex: entry.ledger_index ?? null,
        source: entry.source ?? 'live',
        brokerStateKnown: known,
        debtBefore, debtAfter,
        // Reconstruct the balance the change set could not state, rather than reporting
        // the two as equal.
        coverBefore: stated && coverBefore.eq(coverAfter)
          ? Decimal.max(0, deposit ? coverAfter.minus(stated) : coverAfter.plus(stated))
          : coverBefore,
        coverAfter,
        coverConsumed: new Decimal(0),
        principal: new Decimal(0),
        exposure: new Decimal(0),
        amount: moved,
      })
    }
  }
  // account_tx is newest first; a track record reads forwards.
  return events.reverse()
}

/** The live record only, for a broker just built (the bake and check scripts). */
export async function fetchBrokerHistory(xrpl, ownerAccount, brokerId) {
  return brokerEvents(await xrpl.accountTx(ownerAccount), brokerId)
}

/**
 * The record the API serves: the live history merged with the archive (archive.mjs), and the
 * window it covers. It must reach from the broker's creation to the later of its own last change
 * (defaults, cover movements) and its vault's (impairments touch the Vault and the Loan, never the
 * LoanBroker). Either one unknown, it must reach the current ledger.
 *
 * The vault's last change is a looser bound than the record needs: a withdrawal moves it too. The
 * tight one, the broker's loans, would hold only if every loan read had succeeded, and a loan the
 * reader missed would end the window before an impairment and call it complete. Loose fails safe.
 */
export async function readBrokerHistory(xrpl, broker, vault, opts = {}) {
  const ends = [broker.lastChangeLedger, vault?.lastChangeLedger]
  const { txs, truncated, window } = await readHistory(xrpl, broker.owner, {
    ...opts,
    origin: creates('LoanBroker', broker.loanBrokerId),
    lastChange: ends.every(Number.isInteger) ? Math.max(...ends) : null,
  })
  return { events: brokerEvents(txs, broker.loanBrokerId), truncated, window }
}

/** Why a record that does not reach back to the broker's creation is not graded. */
const INCOMPLETE = 'the retained record does not reach back to the broker’s creation'

/**
 * Total cover consumed for a given ordering of principals.
 * Mirrors the ledger exactly: ceil at each step, base is the remaining book.
 * shortcut: rounds to whole drops for every asset; an issued-currency broker's cover would be
 * rounded to whole units here. Thread the vault's asset in when an IOU broker is tracked.
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
export function analyseOrdering(events, broker, window = null) {
  const defaults = events.filter((e) => e.kind === 'default' && e.principal.gt(0))
  // The sequence is only the sequence if no default is missing from it.
  if (window && !window.complete) return { applicable: false, reason: INCOMPLETE, defaultCount: defaults.length }
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
  // The verdict compares orders, so the chosen one goes through the same back-to-back model as
  // the other two. The ledger's own total includes whatever happened between the defaults (a loan
  // repaid, a new one written), and set against the model it graded a depositor-optimal order as
  // self-serving. actualCoverPaid still reports what the ledger took.
  const chosen = coverForOrder(principals, startingDebt, broker.coverRateMinimum, broker.coverRateLiquidation, startingCover)
  const span = best.minus(worst)

  return {
    applicable: true,
    defaultCount: defaults.length,
    actualCoverPaid: actual.toFixed(0),
    bestPossible: best.toFixed(0),
    worstPossible: worst.toFixed(0),
    // What the chosen sequence cost depositors relative to the LP-optimal one.
    costToDepositors: best.minus(chosen).toFixed(0),
    spread: span.toFixed(0),
    fairness: span.isZero() ? '1.0000' : chosen.minus(worst).div(span).toFixed(4),
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
/**
 * Manager conduct is a points assessment, apart from the internal score and unlike it: it starts at
 * 100 and deducts for each finding, then reads a letter off the total. Published by
 * GET /api/methodology, so the deductions shown are the ones applied.
 */
export const CONDUCT = {
  deductions: { orderingSelfServing: 35, orderingMixed: 15, perDefaultWithoutImpairment: 20, perCoverWithdrawal: 10 },
  grades: [{ atLeast: 90, grade: 'A' }, { atLeast: 75, grade: 'B' }, { atLeast: 55, grade: 'C' }, { atLeast: 35, grade: 'D' }, { atLeast: 0, grade: 'E' }],
}

export function reputation(events, ordering, broker, window = null, asset = null) {
  const defaults = events.filter((e) => e.kind === 'default')
  const impairs = events.filter((e) => e.kind === 'impair')
  const withdrawals = events.filter((e) => e.kind === 'cover_withdraw')
  const captured = window?.archive?.capturedAt?.slice(0, 10)
  const caveat = 'Reconstructed from the public record only: the ledgers Devnet retains'
    + (captured ? `, and the transactions it has pruned as captured on ${captured} in evidence/devnet-tx` : '')
    + '. The grade is withheld when that record does not reach back to the broker’s creation.'

  const observations = (undeclared) => ({
    defaults: defaults.length,
    impairments: impairs.length,
    defaultsWithoutPriorImpairment: undeclared,
    coverWithdrawals: withdrawals.length,
    eventsRetained: events.length,
  })

  // Pruning removes the oldest transactions first, and for a broker those are its defaults: a
  // record with them gone reads "no defaults declared" and scores 100. A record that does not
  // reach back to the broker's creation cannot tell a clean broker from a pruned one, so it is
  // not graded at all.
  if (window && !window.complete) {
    return {
      grade: null,
      score: null,
      withheld: true,
      observations: observations(null),
      findings: [{ code: 'HISTORY_INCOMPLETE', detail: 'Not assessed: the record available does not reach back to the broker’s first action, so an absence of losses here could be an absence of record.' }],
      caveat,
    }
  }

  // Declaring a default with no prior impairment skips the warning entirely: the loss
  // goes straight from invisible to realised, with no window for anyone to react.
  const impairedLoanIds = new Set(impairs.map((e) => e.loanId).filter(Boolean))
  const undeclaredDefaults = defaults.filter((d) => d.loanId && !impairedLoanIds.has(d.loanId)).length

  const findings = []
  let score = 100

  if (ordering.applicable) {
    const f = Number(ordering.fairness)
    if (f < 0.25) { score -= CONDUCT.deductions.orderingSelfServing; findings.push({ code: 'ORDERING_SELF_SERVING', detail: `Declared losses in an order close to the one that minimises their own first-loss contribution (sequence score ${ordering.fairness}). The choice cost investors ${amountText(ordering.costToDepositors, asset, 6)} against the fair order.` }) }
    else if (f < 0.75) { score -= CONDUCT.deductions.orderingMixed; findings.push({ code: 'ORDERING_MIXED', detail: `The sequence sits between the fair and the self-serving one (sequence score ${ordering.fairness}).` }) }
    else findings.push({ code: 'ORDERING_FAIR', detail: `Declared in an order close to the one that maximises first-loss capital applied on investors' behalf (sequence score ${ordering.fairness}).` })
  }

  if (undeclaredDefaults > 0) {
    score -= CONDUCT.deductions.perDefaultWithoutImpairment * undeclaredDefaults
    findings.push({ code: 'DEFAULT_WITHOUT_IMPAIRMENT', detail: `${undeclaredDefaults} exposure${undeclaredDefaults === 1 ? ' was' : 's were'} written off with no prior warning, so the loss was never signalled before it was taken.` })
  }
  if (withdrawals.length > 0) {
    score -= CONDUCT.deductions.perCoverWithdrawal * withdrawals.length
    findings.push({ code: 'COVER_WITHDRAWN', detail: `${withdrawals.length} withdrawal${withdrawals.length === 1 ? '' : 's'} of first-loss capital on record. Cover taken out ahead of a deteriorating book leaves depositors less first-loss protection when they need it most.` })
  }
  if (defaults.length === 0) findings.push({ code: 'NO_DEFAULTS', detail: 'No defaults declared in the retained history.' })

  score = Math.max(0, Math.min(100, score))
  const grade = CONDUCT.grades.find((g) => score >= g.atLeast).grade

  return {
    grade,
    score,
    withheld: false,
    observations: observations(undeclaredDefaults),
    findings,
    caveat,
  }
}
