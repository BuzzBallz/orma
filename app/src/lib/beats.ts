import type { Loan, VaultDetail } from './types'
import { facilityName } from './credit'

/**
 * The forward calendar for one facility, in one place.
 *
 * Both the credit opinion and the calendar desk need to know what falls due next, and a
 * reader who saw two different answers on two tabs would be right to stop trusting either.
 * So the rows are built once, here, and each desk renders as much of the list as it has
 * room for. Every date is a date the calculation agent sent; nothing is projected forward.
 */
export type Beat = {
  when: string | null
  inSeconds: number
  what: string
  who: string
  amount: string | null
  tone: '--bad' | '--warn' | '--fg-dim'
}

const STATUS_TONE: Record<string, '--bad' | '--warn' | '--fg-dim'> = {
  defaulted: '--bad', defaultable: '--bad', impaired: '--bad',
  overdue: '--warn', due_soon: '--warn',
}

function loanBeats(loans: Loan[]): Beat[] {
  return loans.flatMap(l => {
    const rows: Beat[] = []
    if (l.nextPaymentDueAt) {
      rows.push({
        when: l.nextPaymentDueAt, inSeconds: l.secondsUntilDue,
        what: l.secondsUntilDue < 0 ? 'Payment past due' : 'Scheduled payment',
        who: `Exposure ${l.loanId.slice(0, 8)}`,
        amount: l.periodicPayment,
        tone: STATUS_TONE[l.status] ?? '--fg-dim',
      })
    }
    if (l.secondsUntilDefaultable > 0 && l.status !== 'defaulted' && l.status !== 'closed') {
      rows.push({
        when: null, inSeconds: l.secondsUntilDefaultable,
        what: 'Becomes declarable in default',
        who: `Exposure ${l.loanId.slice(0, 8)}`,
        amount: null, tone: '--warn',
      })
    }
    return rows
  })
}

/** Everything on the facility's calendar, soonest first. */
export function beatRows(d: VaultDetail): Beat[] {
  const v = d.vault
  const scheduled: Beat[] = [
    {
      when: d.phaseInfo.nextBoundaryAt, inSeconds: d.phaseInfo.secondsToNextBoundary,
      what: `${v.phase} period ends`, who: facilityName(v), amount: null, tone: '--fg-dim',
    },
    {
      when: v.redemptionAt, inSeconds: v.secondsToRedemption,
      what: 'Redemption date', who: facilityName(v),
      amount: d.phaseInfo.claimsAtRedemption,
      tone: Number(d.phaseInfo.projectedShortfall) > 0 ? '--bad' : '--fg-dim',
    },
  ]
  return [...scheduled, ...loanBeats(d.loans)].sort((a, b) => a.inSeconds - b.inSeconds)
}

/** The soonest one, or null when the facility has no dated obligation on file. */
export function nextBeat(d: VaultDetail): Beat | null {
  return beatRows(d)[0] ?? null
}
