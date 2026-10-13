import { useEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { NavPoint } from '../lib/types'
import { Exhibit } from './Exhibit'
import { axisLabel, fmtIso, short } from '../lib/format'

const LONG: Record<string, string> = {
  deposit: 'Deposit', withdraw: 'Withdrawal', loan: 'Loan', payment: 'Repayment', loan_closed: 'Loan closed',
  impair: 'Loss recognised', unimpair: 'Loss reversed', default: 'Default', clawback: 'Clawback',
}
const SHORT: Record<string, string> = { ...LONG, withdraw: 'Withdraw', impair: 'Loss', unimpair: 'Reversal', payment: 'Repaid', loan_closed: 'Closed' }

/** The moments the book changes in value for a reason other than money moving in or out. */
const KEY = new Set(['impair', 'unimpair', 'default', 'clawback'])

const H = 248, PAD = { l: 48, r: 14, t: 20, b: 46 }
const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]

/**
 * Reported and held NAV at every transaction that modified the facility, the moments the
 * book changed value in yellow. The x axis counts transactions, not hours: they come in
 * bursts, and on a clock the whole history would sit on one pixel. Between two points
 * nothing can move the NAV, so each value runs on to the next point, and the last one to now.
 */
export function NavChart({ points }: { points: NavPoint[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = points.length
  const held = points.map(p => Number(p.navCorrect))
  const rep = points.map(p => Number(p.navNaive))
  const all = [...held, ...rep]
  let lo = Math.min(...all), hi = Math.max(...all)
  if (hi - lo < 0.02) { const mid = (hi + lo) / 2; lo = mid - 0.05; hi = mid + 0.05 }
  else { const pad = (hi - lo) * 0.18; lo = Math.max(0, lo - pad); hi += pad }
  const step = STEPS.find(s => (hi - lo) / s <= 6) ?? 1
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t / step) * step)

  const plotW = width - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (i / n) * plotW
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * plotH
  const run = (vs: number[]) => vs.map((v, i) => (i === 0 ? `M${x(0)} ${y(v)}` : `H${x(i)} V${y(v)}`)).join(' ') + ` H${x(n)}`

  const last = points[n - 1]
  const lone = Math.abs(y(held[n - 1]) - y(rep[n - 1])) < 20
  const slot = plotW / n
  const wide = slot >= 100
  const labelled = (i: number, p: NavPoint) => slot >= 70 || KEY.has(p.kind) || i === 0
  // The last value is written on the line only where the final step leaves room for it.
  const ends = slot >= (lone ? 26 : 17) * 8 + 12

  return (
    <div className="navc" ref={box}>
      <TooltipProvider delayDuration={100}>
        <svg
          width={width} height={H} role="img"
          aria-label={`NAV over ${n} transactions: reported ${points[0].navNaive} to ${last.navNaive}, held ${points[0].navCorrect} to ${last.navCorrect}.`}
        >
          {ticks.map(t => (
            <g key={t}>
              <line className="navc-grid" x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
              <text className="navc-tick" x={PAD.l - 8} y={y(t) + 4} textAnchor="end">{axisLabel(t)}</text>
            </g>
          ))}

          {points.map((_, i) => rep[i] - held[i] > 0.0005 && (
            <rect key={i} className="navc-gap" x={x(i)} y={y(rep[i])} width={x(i + 1) - x(i)} height={y(held[i]) - y(rep[i])} />
          ))}
          <path className="navc-rep" d={run(rep)} />
          <path className="navc-held" d={run(held)} />

          {ends && (lone
            ? <text className="navc-end" x={x(n) - 6} y={y(held[n - 1]) - 10} textAnchor="end">Held and reported {last.navCorrect}</text>
            : <>
                <text className="navc-end rep" x={x(n) - 6} y={y(rep[n - 1]) - 8} textAnchor="end">Reported {last.navNaive}</text>
                <text className="navc-end" x={x(n) - 6} y={y(held[n - 1]) + 18} textAnchor="end">Held {last.navCorrect}</text>
              </>)}

          {points.map((p, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <g className={'navc-pt' + (KEY.has(p.kind) ? ' key' : '')}>
                  <circle className="hit" cx={x(i)} cy={y(held[i])} r={14} />
                  <circle className="dot" cx={x(i)} cy={y(held[i])} r={KEY.has(p.kind) ? 7 : 3.5} />
                </g>
              </TooltipTrigger>
              <TooltipContent className="tip" side="top">
                <span className="navc-tip">{LONG[p.kind] ?? p.kind} · {fmtIso(p.at)}</span>
                <span className="navc-tip">Held {p.navCorrect} · Reported {p.navNaive}</span>
              </TooltipContent>
            </Tooltip>
          ))}

          {points.map((p, i) => labelled(i, p) && (
            <text key={i} className="navc-xl" x={x(i)} y={H - PAD.b + 22} textAnchor="middle">{(wide ? LONG : SHORT)[p.kind] ?? p.kind}</text>
          ))}
          <text className="navc-xl" x={x(n)} y={H - PAD.b + 22} textAnchor="end">Now</text>
        </svg>
      </TooltipProvider>

      <ul className="navc-legend t-label-s">
        <li><svg width="26" height="8" aria-hidden><line x1="0" x2="26" y1="4" y2="4" className="navc-held" /></svg>Held</li>
        <li><svg width="26" height="8" aria-hidden><line x1="0" x2="26" y1="4" y2="4" className="navc-rep" /></svg>Reported</li>
        <li><span className="navc-dot" aria-hidden />Loss recognised or default</li>
      </ul>

      <Exhibit title="Transactions" meta={`${n} transactions`}>
        <div className="tbl-wrap">
          <table className="op-tbl">
            <thead>
              <tr><th>When</th><th>Event</th><th className="rt">Reported</th><th className="rt">Held</th><th>Transaction</th></tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <td className="num">{fmtIso(p.at)}</td>
                  <td>{KEY.has(p.kind) && <span className="navc-dot" aria-hidden />}{LONG[p.kind] ?? p.kind}</td>
                  <td className="rt num">{p.navNaive}</td>
                  <td className="rt num">{p.navCorrect}</td>
                  <td className="op-says num">{short(p.hash, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Exhibit>
    </div>
  )
}
