// src/lib/format.ts — the ONLY place numbers become strings for display.
// String arithmetic throughout: no Number(), no parseFloat, no precision loss.

function expandExponent(t: string): string {
  const m = /^(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(t)
  if (!m) return t
  const digits = (m[1] || '') + (m[2] || '')
  const point = (m[1] || '').length + Number(m[3])          // Number() on an EXPONENT, never on a value
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return digits.slice(0, point) + '.' + digits.slice(point)
}

function split(s: string): { neg: boolean; int: string; frac: string } {
  let t = (s ?? '0').toString().trim()
  const neg = t.startsWith('-')
  if (neg || t.startsWith('+')) t = t.slice(1)
  if (/[eE]/.test(t)) t = expandExponent(t)
  if (!/^\d*(\.\d*)?$/.test(t) || t === '' || t === '.') return { neg: false, int: '0', frac: '' }
  const [i = '0', f = ''] = t.split('.')
  return { neg, int: i.replace(/^0+(?=\d)/, '') || '0', frac: f }
}

/** Move the decimal point `places` to the right (negative = left). Pure string surgery. */
function shift(s: string, places: number): string {
  const { neg, int, frac } = split(s)
  let digits = int + frac
  let point = int.length + places
  if (point <= 0) { digits = '0'.repeat(1 - point) + digits; point = 1 }
  if (point >= digits.length) digits = digits + '0'.repeat(point - digits.length)
  const head = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0'
  const tail = digits.slice(point)
  return (neg && /[1-9]/.test(digits) ? '-' : '') + head + (tail ? '.' + tail : '')
}

function inc(d: string): string {
  const a = d.split(''); let i = a.length - 1
  for (; i >= 0; i--) { if (a[i] === '9') a[i] = '0'; else { a[i] = String(Number(a[i]) + 1); break } }
  if (i < 0) a.unshift('1')
  return a.join('')
}

/** Force exactly `dp` decimal places, rounding half-up. */
function padDp(s: string, dp: number): string {
  const { neg, int, frac } = split(s)
  const sign = neg ? '-' : ''
  if (frac.length <= dp) return sign + int + (dp ? '.' + frac.padEnd(dp, '0') : '')
  let digits = int + frac.slice(0, dp)
  if (frac.charCodeAt(dp) - 48 >= 5) digits = inc(digits)
  const cut = digits.length - dp
  return sign + (digits.slice(0, cut) || '0') + (dp ? '.' + digits.slice(cut) : '')
}

/** [CONTRACT §6] drops -> XRP. "51000000" -> "51.000000" ; "1" -> "0.000001" */
export function dropsToXrp(drops: string): string { return padDp(shift(drops, -6), 6) }

/** [CONTRACT §6] ratio string -> percent, 2dp. "0.8039" -> "80.39%" */
export function ratioToPct(r: string): string { return padDp(shift(r, 2), 2) + '%' }

/** [CONTRACT §6] 1e-5 rate -> percent, 3dp. 10000 -> "10.000%" ; 1000 -> "1.000%" */
export function rateToPct(rate: number): string { return padDp(shift(String(rate), -3), 3) + '%' }

/** [CONTRACT §6] negative -> "overdue 7m 00s" ; positive -> "in 2m 13s" */
export function formatCountdown(seconds: number): string {
  const late = seconds < 0
  return (late ? 'overdue ' : 'in ') + duration(Math.abs(Math.trunc(seconds)))
}

/** bare duration, no prefix. 86100 -> "23h 55m 00s" ; 742 -> "12m 22s" */
export function duration(absSeconds: number): string {
  const s = Math.abs(Math.trunc(absSeconds))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60), sec = s % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  if (d > 0) return `${d}d ${p2(h)}h ${p2(m)}m`
  if (h > 0) return `${h}h ${p2(m)}m ${p2(sec)}s`
  return `${m}m ${p2(sec)}s`
}

/** A boundary already behind us. NOT contract §6 — do not use it for loan due dates. */
export function formatElapsed(seconds: number): string { return 'passed ' + duration(seconds) + ' ago' }

/** integer basis points -> percent, 2dp. 1961 -> "19.61%" */
export function bpsToPct(bps: number): string { return padDp(shift(String(bps), -2), 2) + '%' }

/** Never renders "Invalid Date". */
export function fmtIso(s: string | null | undefined): string {
  if (!s) return '—'
  const t = Date.parse(s)
  return Number.isNaN(t) ? '—' : new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

export function short(hex: string | null | undefined, n = 8): string {
  return hex ? hex.slice(0, n) + '…' : '—'
}
