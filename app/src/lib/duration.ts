import Decimal from 'decimal.js'

/**
 * Step 22 (addendum A12): the one duration formatter of the payment record, used by every line that says how
 * late a loan is or how long its impairment took. From a decimal string of seconds, in whole units only:
 *   under 1 min  "45 s"
 *   under 1 h    "12 min 05 s"
 *   under 1 day  "19 h 12 min"
 *   from 1 day   "3 d 4 h"
 * Never a fractional day: each unit is the floor of what is left. A count of seconds is a time, not an amount,
 * but it arrives as a decimal string and is read with decimal.js, never Number(). A string that is not a
 * decimal number is a dash, never a zero.
 */

const DECIMAL = /^-?\d+(\.\d+)?$/
const two = (d: Decimal) => d.toFixed(0).padStart(2, '0')

export function durationText(seconds: string | null | undefined): string {
  if (seconds === null || seconds === undefined || !DECIMAL.test(seconds)) return '—'
  const all = new Decimal(seconds)
  const s = all.abs().floor()
  const sign = all.isNeg() && !s.isZero() ? '-' : ''
  const days = s.divToInt(86400)
  const hours = s.mod(86400).divToInt(3600)
  const minutes = s.mod(3600).divToInt(60)
  const rest = s.mod(60)
  if (days.gt(0)) return `${sign}${days.toFixed(0)} d ${hours.toFixed(0)} h`
  if (hours.gt(0)) return `${sign}${hours.toFixed(0)} h ${two(minutes)} min`
  if (minutes.gt(0)) return `${sign}${minutes.toFixed(0)} min ${two(rest)} s`
  return `${sign}${rest.toFixed(0)} s`
}
