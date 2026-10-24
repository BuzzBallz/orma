import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Decimal from 'decimal.js'
import type { FeedEvent, NavPoint } from '../lib/types'
import { formatXrp } from './Ledger'

// Inline SVG, no chart library. Amounts stay decimal strings; `num` is used for geometry only, never for a value shown.
// Colour carries no status here: ink, grey and a hatch (the Verdict component is the only user of status colours).

const D = (x: Decimal.Value) => new Decimal(x)
const num = (x: Decimal) => x.toNumber()
const frac = (x: Decimal.Value, lo: Decimal.Value, hi: Decimal.Value) => {
  const span = D(hi).minus(lo)
  return span.isZero() ? 0 : Math.min(1, Math.max(0, num(D(x).minus(lo).div(span))))
}

/** The pixel width of the box, so every label is drawn at its real size and never scaled down. */
function useWidth(initial = 720): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(initial)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function Hatch({ id }: { id: string }) {
  return (
    <pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="7" height="7" fill="var(--color-bg-raised)" />
      <line x1="0" y1="0" x2="0" y2="7" stroke="var(--color-text-2)" strokeWidth="2" />
    </pattern>
  )
}

function Chart({ label, height, children }: { label: string; height: number; children: (w: number, hatch: string) => ReactNode }) {
  const [ref, w] = useWidth()
  const hatch = useId().replace(/:/g, '') + 'h'
  return (
    <div className="chart" ref={ref}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label}>
        <defs><Hatch id={hatch} /></defs>
        {children(w, hatch)}
      </svg>
    </div>
  )
}

// --- three prices as three bars, the overpayment hatched -------------------------------------

export function PriceBars({ held, naive, par }: { held: string; naive: string; par: string }) {
  const max = Decimal.max(D(held), D(naive), D(par))
  const rows = [
    { k: 'Value read by all', v: naive, solid: false },
    { k: 'Par value (lender at 1:1)', v: par, solid: false },
    { k: 'Withdrawal value', v: held, solid: true },
  ]
  const gapText = formatXrp(D(naive).minus(held).toFixed(0))
  const label = `Three prices for the pledged shares: ${rows.map((r) => `${r.k} ${formatXrp(r.v)} XRP`).join('; ')}. The overpayment is ${gapText} XRP.`
  return (
    <Chart label={label} height={186}>
      {(w, hatch) => {
        const x0 = 196, x1 = w - 110, bw = x1 - x0
        const px = (v: string) => x0 + bw * frac(v, 0, max)
        return (
          <g className="ch">
            {rows.map((r, i) => {
              const y = 12 + i * 46
              return (
                <g key={r.k}>
                  <text x={x0 - 12} y={y + 21} textAnchor="end" className="ch-label">{r.k}</text>
                  <rect x={x0} y={y} width={Math.max(1, px(r.v) - x0)} height={30} className={r.solid ? 'ch-bar-solid' : 'ch-bar-open'} />
                  {r.solid && D(naive).gt(held) && <rect x={px(held)} y={y} width={Math.max(0, px(naive) - px(held))} height={30} style={{ fill: `url(#${hatch})` }} className="ch-gap" />}
                  <text x={w - 4} y={y + 21} textAnchor="end" className="ch-value">{formatXrp(r.v)}</text>
                </g>
              )
            })}
            {D(naive).gt(held) && <text x={(px(held) + px(naive)) / 2} y={12 + 2 * 46 + 54} textAnchor="middle" className="ch-note">{`overpayment ${gapText} XRP`}</text>}
          </g>
        )
      }}
    </Chart>
  )
}

// --- LTV against the mandate's limit, both readings on one scale -----------------------------

export function LtvGauge({ ltvBps, parBps, limitBps }: { ltvBps: string | null; parBps: string; limitBps?: string }) {
  const rows = [
    { k: 'At withdrawal value', v: ltvBps, solid: true },
    { k: 'Lender at 1:1', v: parBps, solid: false },
  ]
  const fmt = (b: string | null) => (b === null ? 'n/a' : `${D(b).div(100).toFixed(2)}%`)
  const label = `Loan-to-value${limitBps ? ` against the limit of ${fmt(limitBps)}` : ''}: ${rows.map((r) => `${r.k} ${fmt(r.v)}`).join('; ')}.`
  return (
    <Chart label={label} height={limitBps ? 112 : 80}>
      {(w) => {
        const x0 = 146, x1 = w - 72, bw = x1 - x0
        const px = (b: Decimal.Value) => x0 + bw * frac(b, 0, 10000)
        return (
          <g className="ch">
            {rows.map((r, i) => {
              const y = (limitBps ? 30 : 4) + i * 36
              return (
                <g key={r.k}>
                  <text x={x0 - 10} y={y + 17} textAnchor="end" className="ch-label">{r.k}</text>
                  <rect x={x0} y={y} width={bw} height={24} className="ch-track" />
                  {r.v !== null && <rect x={x0} y={y} width={Math.max(1, px(r.v) - x0)} height={24} className={r.solid ? 'ch-bar-solid' : 'ch-bar-open'} />}
                  <text x={w - 2} y={y + 17} textAnchor="end" className="ch-value">{fmt(r.v)}</text>
                </g>
              )
            })}
            {limitBps && <>
              <line x1={px(limitBps)} x2={px(limitBps)} y1={20} y2={96} className="ch-limit" />
              <text x={px(limitBps)} y={13} textAnchor="middle" className="ch-note">{`limit ${fmt(limitBps)}`}</text>
            </>}
          </g>
        )
      }}
    </Chart>
  )
}

// --- the same share's value now, and if each late loan defaults alone ------------------------

export function DefaultDots({ now, rows }: { now: string; rows: { label: string; value: string; impaired: boolean }[] }) {
  const all = [now, ...rows.map((r) => r.value)]
  const lo = Decimal.min(...all.map(D)).minus('0.05').toDecimalPlaces(1, Decimal.ROUND_FLOOR)
  const hi = Decimal.max(...all.map(D)).plus('0.05').toDecimalPlaces(1, Decimal.ROUND_CEIL)
  const label = `Withdrawal value per share now ${now}; ${rows.map((r) => `${r.label} ${r.value}`).join('; ')}.`
  return (
    <Chart label={label} height={50 + rows.length * 44}>
      {(w) => {
        const x0 = 196, x1 = w - 40, bw = x1 - x0
        const px = (v: Decimal.Value) => x0 + bw * frac(v, lo, hi)
        const nx = px(now)
        const ticks = [lo, lo.plus(hi.minus(lo).div(2)), hi]
        return (
          <g className="ch">
            {ticks.map((t) => <g key={t.toString()}><line x1={px(t)} x2={px(t)} y1={24} y2={30 + rows.length * 44} className="ch-grid" /><text x={px(t)} y={18} textAnchor="middle" className="ch-tick">{t.toFixed(2)}</text></g>)}
            <line x1={nx} x2={nx} y1={24} y2={30 + rows.length * 44} className="ch-limit" />
            {rows.map((r, i) => {
              const y = 52 + i * 44
              const x = px(r.value)
              return (
                <g key={r.label}>
                  <text x={x0 - 12} y={y + 5} textAnchor="end" className="ch-label">{r.label}</text>
                  <line x1={Math.min(x, nx)} x2={Math.max(x, nx)} y1={y} y2={y} className="ch-stem" />
                  <circle cx={x} cy={y} r={8} className={r.impaired ? 'ch-dot' : 'ch-dot-solid'} />
                  <text x={x + (x < nx ? -14 : 14)} y={y + 5} textAnchor={x < nx ? 'end' : 'start'} className="ch-value">{r.value}</text>
                </g>
              )
            })}
            <text x={nx} y={42 + rows.length * 44} textAnchor="middle" className="ch-note">{`now ${now}`}</text>
          </g>
        )
      }}
    </Chart>
  )
}

// --- where the vault's assets sit ------------------------------------------------------------

export function BalanceBar({ total, available, loss }: { total: string; available: string; loss: string }) {
  const lent = D(total).minus(available)
  const parts = [
    { k: 'Cash in the vault', v: D(available), solid: true },
    { k: 'Lent out', v: lent.minus(loss), solid: false },
    { k: 'Lent out, impaired', v: D(loss), solid: null as null },
  ].filter((p) => p.v.gt(0))
  const label = `The vault holds ${formatXrp(total)} XRP: ${parts.map((p) => `${p.k} ${formatXrp(p.v.toFixed(0))} XRP`).join('; ')}.`
  // A segment too narrow for its two label lines, with a neighbour after it, puts them on a second row: two labels never share a line.
  const width = (p: { v: Decimal }, w: number) => w * num(p.v.div(total))
  const needsRow = parts.some((p, i) => i < parts.length - 1 && num(p.v.div(total)) < 0.16)
  return (
    <Chart label={label} height={needsRow ? 132 : 92}>
      {(w, hatch) => {
        const x0 = 0, bw = w
        let x = x0
        return (
          <g className="ch">
            {parts.map((p, i) => {
              const pw = width(p, bw)
              const last = i === parts.length - 1
              const narrow = pw < 150
              const second = narrow && !last
              const tx = narrow && last ? w : x
              const anchor = narrow && last ? 'end' : 'start'
              const dy = second ? 40 : 0
              const seg = (
                <g key={p.k}>
                  <rect x={x} y={8} width={Math.max(0, pw - 2)} height={34} className={p.solid === true ? 'ch-bar-solid' : p.solid === false ? 'ch-bar' : 'ch-gap'} style={p.solid === null ? { fill: `url(#${hatch})` } : undefined} />
                  <text x={tx} y={62 + dy} textAnchor={anchor} className="ch-label">{p.k}</text>
                  <text x={tx} y={82 + dy} textAnchor={anchor} className="ch-value">{`${formatXrp(p.v.toFixed(0))} XRP`}</text>
                </g>
              )
              x += pw
              return seg
            })}
          </g>
        )
      }}
    </Chart>
  )
}

// --- time left before redemption, against the mandate's limit --------------------------------

export function LockBar({ seconds, maxDays }: { seconds: string; maxDays?: number }) {
  const days = D(seconds).div(86400)
  if (maxDays === undefined) return <p className="ch-label">{`${days.toFixed(1)} days left before redemption`}</p>
  const label = `${days.toFixed(1)} days left before redemption; the mandate allows at most ${maxDays}.`
  return (
    <Chart label={label} height={64}>
      {(w) => {
        const f = frac(days, 0, maxDays)
        return (
          <g className="ch">
            <rect x={0} y={6} width={w} height={26} className="ch-track" />
            <rect x={0} y={6} width={Math.max(1, w * f)} height={26} className="ch-bar-solid" />
            <text x={0} y={54} className="ch-label">{`${days.toFixed(1)} days left`}</text>
            <text x={w} y={54} textAnchor="end" className="ch-label">{`mandate maximum ${maxDays} days`}</text>
          </g>
        )
      }}
    </Chart>
  )
}

// --- the two readings of one share through time ---------------------------------------------

const EVENT_NAME: Record<string, string> = { impair: 'Loss recognised', unimpair: 'Loss reversed', default: 'Default', clawback: 'Clawback' }

export function TwoReadings({ points }: { points: NavPoint[] }) {
  const n = points.length
  const vals = points.flatMap((p) => [D(p.navNaive), D(p.navCorrect)])
  const lo = n ? Decimal.min(...vals).minus('0.03').toDecimalPlaces(2, Decimal.ROUND_FLOOR) : D(0)
  const hi = n ? Decimal.max(...vals).plus('0.03').toDecimalPlaces(2, Decimal.ROUND_CEIL) : D(1)
  const last = points[n - 1]
  const label = last
    ? `Value of one share through ${n} ledger events. Latest: value read by all ${last.navNaive}, withdrawal value ${last.navCorrect}.`
    : 'No history.'
  return (
    <Chart label={label} height={252}>
      {(w, hatch) => {
        const x0 = 52, x1 = w - 150, y0 = 18, y1 = 190
        const px = (i: number) => x0 + (n < 2 ? 0 : ((x1 - x0) * i) / (n - 1))
        const py = (v: Decimal.Value) => y1 - (y1 - y0) * frac(v, lo, hi)
        // A value holds until the next event, then jumps: horizontal to the next x, then vertical to the new value.
        const step = (key: 'navNaive' | 'navCorrect') => points.map((p, i) => (i === 0 ? `M${px(0)} ${py(p[key])}` : `H${px(i)} V${py(p[key])}`)).join(' ')
        const ticks = [lo, lo.plus(hi.minus(lo).div(2)), hi]
        const events = points.map((p, i) => ({ p, i })).filter(({ p }) => EVENT_NAME[p.kind])
        return (
          <g className="ch">
            {ticks.map((t) => <g key={t.toString()}><line x1={x0} x2={x1} y1={py(t)} y2={py(t)} className="ch-grid" /><text x={x0 - 8} y={py(t) + 5} textAnchor="end" className="ch-tick">{t.toFixed(2)}</text></g>)}
            {n > 1 && <path d={`${step('navNaive')} V${py(points[n - 1].navCorrect)} ${points.slice(1).map((_, k) => { const i = n - 1 - k; return `V${py(points[i - 1].navCorrect)} H${px(i - 1)}` }).join(' ')} Z`} style={{ fill: `url(#${hatch})` }} className="ch-gap-fill" />}
            {n > 1 && <path d={step('navNaive')} className="ch-line-dash" fill="none" />}
            {n > 1 && <path d={step('navCorrect')} className="ch-line" fill="none" />}
            {events.map(({ p, i }) => (
              <g key={i}>
                <line x1={px(i)} x2={px(i)} y1={y0} y2={y1} className="ch-limit" />
                <text x={px(i)} y={y1 + 22} textAnchor="middle" className="ch-note">{EVENT_NAME[p.kind]}</text>
              </g>
            ))}
            {last && <>
              <text x={x1 + 10} y={py(last.navNaive) + 5} className="ch-value">{last.navNaive}</text>
              <text x={x1 + 10} y={py(last.navNaive) + 22} className="ch-note">read by all</text>
              <text x={x1 + 10} y={py(last.navCorrect) + 5} className="ch-value">{last.navCorrect}</text>
              <text x={x1 + 10} y={py(last.navCorrect) + 22} className="ch-note">withdrawal</text>
            </>}
            <text x={x0} y={246} className="ch-tick">{`earliest of ${n} events`}</text>
            <text x={x1} y={246} textAnchor="end" className="ch-tick">latest</text>
          </g>
        )
      }}
    </Chart>
  )
}

// --- one row per vault: the two readings, joined ---------------------------------------------

export function Dumbbell({ rows }: { rows: { label: string; held: string; naive: string }[] }) {
  const hi = rows.length ? Decimal.max(...rows.flatMap((r) => [D(r.held), D(r.naive)])).plus('0.05').toDecimalPlaces(1, Decimal.ROUND_CEIL) : D(1)
  const lo = rows.length ? Decimal.min(...rows.flatMap((r) => [D(r.held), D(r.naive)])).minus('0.05').toDecimalPlaces(1, Decimal.ROUND_FLOOR) : D(0)
  const label = `Value of one share, two readings per vault: ${rows.map((r) => r.label).join(', ')}. The values are in the table below.`
  return (
    <Chart label={label} height={34 + rows.length * 40}>
      {(w) => {
        const x0 = 168, x1 = w - 30, bw = x1 - x0
        const px = (v: Decimal.Value) => x0 + bw * frac(v, lo, hi)
        const ticks = [lo, lo.plus(hi.minus(lo).div(2)), hi]
        return (
          <g className="ch">
            {ticks.map((t) => <g key={t.toString()}><line x1={px(t)} x2={px(t)} y1={22} y2={26 + rows.length * 40} className="ch-grid" /><text x={px(t)} y={14} textAnchor="middle" className="ch-tick">{t.toFixed(2)}</text></g>)}
            {rows.map((r, i) => {
              const y = 46 + i * 40
              return (
                <g key={r.label}>
                  <text x={x0 - 12} y={y + 5} textAnchor="end" className="ch-label">{r.label}</text>
                  <line x1={px(r.held)} x2={px(r.naive)} y1={y} y2={y} className="ch-stem" />
                  <circle cx={px(r.naive)} cy={y} r={8} className="ch-dot" />
                  <circle cx={px(r.held)} cy={y} r={8} className="ch-dot-solid" />
                </g>
              )
            })}
          </g>
        )
      }}
    </Chart>
  )
}

// --- credit events along the ledger ----------------------------------------------------------

const EV_SHORT: Record<FeedEvent['type'], string> = {
  LOAN_LATE: 'Late', IMPAIRMENT: 'Impaired', DEFAULT: 'Default', COVER_DRAWN: 'Cover', SHARES_PLEDGED: 'Pledge', LOAN_ORIGINATED: 'Loan', STATEMENT: 'Statement',
  // Step 20: a desk decision, DECLARED, drawn as the other declared events (the neutral diamond).
  MARGIN_CALL_ISSUED: 'Margin call', MARGIN_CALL_CURED: 'Call cured', MARGIN_CALL_EXPIRED: 'Call expired',
}

export function EventTimeline({ events }: { events: FeedEvent[] }) {
  const sorted = [...events].sort((a, b) => a.ledgerIndex - b.ledgerIndex)
  const lo = sorted[0]?.ledgerIndex ?? 0
  const hi = sorted[sorted.length - 1]?.ledgerIndex ?? 1
  const label = `${sorted.length} credit events from ledger ${lo} to ${hi}: ${sorted.map((e) => EV_SHORT[e.type]).join(', ')}.`
  return (
    <Chart label={label} height={124}>
      {(w) => {
        const x0 = 24, x1 = w - 24
        const px = (l: number) => x0 + (hi === lo ? (x1 - x0) / 2 : ((x1 - x0) * (l - lo)) / (hi - lo))
        return (
          <g className="ch">
            <line x1={x0} x2={x1} y1={44} y2={44} className="ch-stem" />
            {sorted.map((e, i) => (
              <g key={e.id}>
                {e.provenance === 'DECLARED'
                  ? <rect x={px(e.ledgerIndex) - 7} y={37} width={14} height={14} transform={`rotate(45 ${px(e.ledgerIndex)} 44)`} className="ch-dot" />
                  : <circle cx={px(e.ledgerIndex)} cy={44} r={8} className="ch-dot-solid" />}
                <text x={px(e.ledgerIndex)} y={i % 2 ? 84 : 24} textAnchor="middle" className="ch-label">{EV_SHORT[e.type]}</text>
              </g>
            ))}
            <text x={x0} y={118} className="ch-tick">{`ledger ${lo}`}</text>
            <text x={x1} y={118} textAnchor="end" className="ch-tick">{`ledger ${hi}`}</text>
          </g>
        )
      }}
    </Chart>
  )
}

// --- a tiny trend line for a tile ------------------------------------------------------------

export function Sparkline({ values, label }: { values: string[]; label: string }) {
  if (values.length < 2) return null
  const lo = Decimal.min(...values.map(D)), hi = Decimal.max(...values.map(D))
  const W = 260, H = 34
  const pts = values.map((v, i) => `${(W * i) / (values.length - 1)},${H - 3 - (H - 6) * frac(v, lo, hi)}`).join(' ')
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <polyline points={pts} fill="none" className="ch-line" />
    </svg>
  )
}
