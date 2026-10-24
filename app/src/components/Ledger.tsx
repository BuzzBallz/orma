import type { ReactNode } from 'react'
import Decimal from 'decimal.js'
import type { ChangeRow, Figure as FigureDoc, FormulaId, Provenance } from '../lib/types'
import { dropsToXrp, ratioToPct } from '../lib/format'

/**
 * The institutional register's kit. Every figure on an NYC surface goes through <Figure>, every panel
 * through <Panel>, and <Verdict> is the only place a verdict colour may appear, always next to its word.
 * RECOMPUTE replays the server's FORMULAS (src/nyc/contracts.mjs) in the browser, so a reader can check
 * a figure against its own inputs without trusting the number it was handed.
 */

Decimal.set({ precision: 40, toExpNeg: -9e15, toExpPos: 9e15 })

const LSF_LOAN_IMPAIRED = 0x00020000n

/** 5345 bps -> "53.45%", divided by 100 with decimal.js, never multiplied. */
export function formatBps(bps: string): string {
  return new Decimal(bps).div(100).toFixed(2) + '%'
}

function formatSeconds(seconds: string): string {
  const s = new Decimal(seconds).abs()
  const days = s.div(86400).floor()
  const hours = s.mod(86400).div(3600).floor()
  if (days.gt(0)) return `${days.toFixed(0)} days ${hours.toFixed(0)} h`
  return `${hours.toFixed(0)} h ${s.mod(3600).div(60).floor().toFixed(0)} min`
}

/** Share units at the vault's scale, with their XRP equivalent at the withdrawal value when the inputs carry it. */
function formatShareUnits(figure: FigureDoc): string {
  const named = new Map(figure.inputs.map((i) => [i.name, i.value]))
  const scale = new Decimal(named.get('Scale') ?? '0')
  const whole = new Decimal(figure.value).div(new Decimal(10).pow(scale))
  const total = named.get('AssetsTotal')
  const outstanding = named.get('OutstandingAmount')
  if (total === undefined || outstanding === undefined || new Decimal(outstanding).isZero()) return `${whole.toFixed()} units`
  const perUnit = new Decimal(total).minus(named.get('LossUnrealized') ?? '0').div(new Decimal(outstanding).div(new Decimal(10).pow(scale))).toFixed(6)
  return `${whole.toFixed()} units ≈ ${dropsToXrp(whole.times(perUnit).toFixed(0))} XRP at the withdrawal value`
}

function formatFigure(figure: FigureDoc): string {
  switch (figure.unit) {
    case 'drops': return `${dropsToXrp(figure.value)} XRP`
    case 'bps': return formatBps(figure.value)
    case 'ratio': return ratioToPct(figure.value)
    case 'seconds': return formatSeconds(figure.value)
    case 'share-units': return formatShareUnits(figure)
  }
}

/** One figure: its value in its unit, what it means, and behind "Ledger field" the value verbatim and every ledger input. */
export function Figure({ label, meaning, figure }: { label: string; meaning: string; figure: FigureDoc }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div className="caption">{label}</div>
      <div className="num" style={{ font: '500 20px/1.3 var(--font-mono)' }}>{formatFigure(figure)}</div>
      <p className="caption">{meaning}</p>
      <details>
        <summary>Ledger field</summary>
        <p className="caption"><code>{figure.value}</code> · {figure.formula}</p>
        <div className="tbl-wrap">
          <table className="op-tbl fit">
            <tbody>
              {figure.inputs.map((i) => (
                <tr key={i.name}>
                  <td><b>{i.object}.{i.field}</b></td>
                  <td className="num">{i.value}</td>
                  <td className="mute">{i.id} · ledger {i.ledgerIndex} · {i.ledgerHash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/** A panel, its provenance always shown, in the neutral register: never a colour. */
export function Panel({ provenance, title, source, children }: { provenance: Provenance; title: string; source?: string; children?: ReactNode }) {
  return (
    <section style={{ borderTop: '1px solid var(--color-line)', paddingBlock: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-4)' }}>
        <div>
          <h2 className="exh-title">{title}</h2>
          {source && <p className="caption" style={{ color: 'var(--color-text-2)' }}>Source: {source}</p>}
        </div>
        <span style={{ color: 'var(--color-text-2)', border: '1px solid var(--color-line)', padding: '2px 8px', font: '500 12px/1.5 var(--font-sans)' }}>{provenance}</span>
      </header>
      {children}
    </section>
  )
}

export type VerdictStatus = 'PASS' | 'BREACHED' | 'STALE' | 'MATCH' | 'MISMATCH'

/** The only component that may use a verdict colour, and it always prints the word beside it. */
export function Verdict({ status }: { status: VerdictStatus }) {
  const color = status === 'PASS' || status === 'MATCH' ? 'var(--color-ok)' : status === 'STALE' ? 'var(--color-watch)' : 'var(--color-loss)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 13px/1.5 var(--font-sans)' }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
      {status}
    </span>
  )
}

type Inputs = Record<string, string>

function reader(inputs: Inputs) {
  const v = (name: string) => {
    if (inputs[name] === undefined) throw new RangeError(`missing input ${name}`)
    return new Decimal(inputs[name] === '' ? '0' : inputs[name])
  }
  const scale = () => new Decimal(10).pow(v('Scale'))
  const s = () => v('OutstandingAmount').div(scale())
  const u = () => v('units').div(scale())
  const perUnit = (x: Decimal) => (s().isZero() ? new Decimal(0) : new Decimal(x.div(s()).toFixed(6)))
  const value = (p: Decimal) => new Decimal(u().times(p).toFixed(0))
  const floor = (x: Decimal) => x.toFixed(0, Decimal.ROUND_DOWN)
  const exp = () => (v('LEVersion').eq(1) ? v('PrincipalOutstanding') : v('TotalValueOutstanding').minus(v('ManagementFeeOutstanding')))
  const cover = () => Decimal.min(v('DebtTotal').times(v('CoverRateMinimum').div(1e5)).times(v('CoverRateLiquidation').div(1e5)).ceil(), exp(), v('CoverAvailable'))
  const impaired = () => (BigInt(v('Flags').toFixed(0)) & LSF_LOAN_IMPAIRED) !== 0n
  const held = () => value(perUnit(v('AssetsTotal').minus(v('LossUnrealized'))))
  const ifDefault = () => perUnit(v('AssetsTotal').minus(exp().minus(cover())).minus(v('LossUnrealized').minus(impaired() ? exp() : 0)))
  return { v, perUnit, value, floor, cover, impaired, held, ifDefault }
}

/** One function per key of FORMULAS, with its rounding: a key without one fails `tsc -b`. */
export const RECOMPUTE: Record<FormulaId, (inputs: Inputs) => string> = {
  heldValue: (i) => reader(i).held().toFixed(0),
  claim: (i) => reader(i).held().toFixed(0),
  naiveValue: (i) => { const r = reader(i); return r.value(r.perUnit(r.v('AssetsTotal'))).toFixed(0) },
  n1Overpayment: (i) => { const r = reader(i); return r.value(r.perUnit(r.v('AssetsTotal'))).minus(r.held()).toFixed(0) },
  cover: (i) => reader(i).cover().toFixed(0),
  heldPerUnitIfDefault: (i) => reader(i).ifDefault().toFixed(6),
  lossAfterCover: (i) => { const r = reader(i); return r.impaired() ? '0' : r.held().minus(r.value(r.ifDefault())).toFixed(0) },
  maxLoan: (i) => { const r = reader(i); return r.floor(r.v('maxLtvBps').times(r.held()).div(10000)) },
  maxUnits: (i) => {
    const r = reader(i)
    const p = r.perUnit(r.v('AssetsTotal').minus(r.v('LossUnrealized')))
    return p.isZero() ? '0' : r.floor(r.v('maxSingleLoanDrops').times(new Decimal(10).pow(r.v('Scale'))).div(p))
  },
  requested: (i) => reader(i).v('principalDrops').toFixed(0),
  ltvHeld: (i) => { const r = reader(i); return r.floor(r.v('principalDrops').times(10000).div(r.held())) },
  lender1to1: (i) => { const r = reader(i); return r.floor(r.v('principalDrops').times(10000).div(r.v('units').div(new Decimal(10).pow(r.v('Scale'))))) },
  cashAvailable: (i) => reader(i).v('AssetsAvailable').toFixed(0),
  lockedUntil: (i) => { const r = reader(i); return r.v('RedemptionDate').minus(r.v('close_time')).toFixed(0) },
}

/** Replays the figure's formula on its own inputs. MATCH if and only if the result equals the served value. */
export function Recompute({ figure }: { figure: FigureDoc }) {
  let status: VerdictStatus = 'MISMATCH'
  const fn = Object.hasOwn(RECOMPUTE, figure.formulaId) ? RECOMPUTE[figure.formulaId] : null
  if (fn) {
    try {
      const result = fn(Object.fromEntries(figure.inputs.map((i) => [i.name, i.value])))
      if (new Decimal(result).eq(figure.value)) status = 'MATCH'
    } catch {
      status = 'MISMATCH' // a missing input, or a figure no formula can produce
    }
  }
  return <span className="caption">Recomputed in your browser: <Verdict status={status} /></span>
}

/** What a transaction changed, field by field, and how many of those changes its metadata hides. */
export function ShowWork({ rows }: { rows: ChangeRow[] }) {
  const hidden = rows.filter((r) => r.admitted === 'HIDDEN').length
  const show = (x: unknown) => (x === undefined || x === null ? 'absent' : typeof x === 'string' ? x : JSON.stringify(x))
  return (
    <details className="exh">
      <summary><span className="exh-title">Show the work</span></summary>
      <div className="exh-body">
        <div className="tbl-wrap">
          <table className="op-tbl">
            <thead><tr><th scope="col">Object</th><th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Admitted</th><th scope="col">Rule</th><th scope="col">Effect</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.object.index}:${r.field}`}>
                  <td><b>{r.object.type}</b></td>
                  <td>{r.field}</td>
                  <td className="num">{show(r.before)}</td>
                  <td className="num">{show(r.after)}</td>
                  <td><span style={{ color: 'var(--color-text-2)', border: '1px solid var(--color-line)', padding: '0 6px' }}>{r.admitted}</span></td>
                  <td className="mute">{r.rule.source} {r.rule.file}:{r.rule.line}</td>
                  <td className="num">{r.moneyEffect ? `${r.moneyEffect.value} ${r.moneyEffect.unit}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="caption">A metadata-diffing reader would miss {hidden} of these changes.</p>
      </div>
    </details>
  )
}

export function TestNetBanner() {
  return (
    <p className="caption" role="note" style={{ borderBottom: '1px solid var(--color-line)', paddingBlock: 'var(--space-2)', color: 'var(--color-text-2)' }}>
      Test network — XRPL Devnet. Nothing here moves real money.
    </p>
  )
}

/** The contract of the kit, held by the compiler: each line stops compiling the day a prop turns optional. */
function _contractProbes(f: FigureDoc) {
  return [
    // @ts-expect-error a Figure without meaning
    <Figure key="1" label="x" figure={f} />,
    // @ts-expect-error a Figure without figure
    <Figure key="2" label="x" meaning="x" />,
    // @ts-expect-error a Panel without provenance
    <Panel key="3" title="x" />,
  ]
}
void _contractProbes
