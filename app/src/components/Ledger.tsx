import { Fragment, useState, type ReactNode } from 'react'
import Decimal from 'decimal.js'
import { Check, Clock, X } from 'lucide-react'
import { useFlash } from '../lib/useFlash'
import { USD_LABEL, type ChangeRow, type Figure as FigureDoc, type FormulaId, type Provenance } from '../lib/types'
import { dropsToXrp, ratioToPct } from '../lib/format'
import { durationText } from '../lib/duration'

/**
 * The institutional register's kit. Every figure on an NYC surface goes through <Figure>, every panel
 * through <Panel>, and <Verdict> is the only place a verdict colour may appear, always next to its word.
 * RECOMPUTE replays the server's FORMULAS (src/nyc/contracts.mjs) in the browser, so a reader can check
 * a figure against its own inputs without trusting the number it was handed.
 */

Decimal.set({ precision: 40, toExpNeg: -9e15, toExpPos: 9e15 })

const LSF_LOAN_IMPAIRED = 0x00020000n

const D = (x: Decimal.Value) => new Decimal(x)
const EXPLORER = 'https://devnet.xrpl.org'

export function formatXrp(drops: string): string {
  return D(drops).div(1_000_000).toFixed(6)
}

export function figureParts(f: Pick<FigureDoc, 'value' | 'unit'>): { text: string; unit: string } {
  switch (f.unit) {
    case 'drops': return { text: formatXrp(f.value), unit: 'XRP' }
    case 'bps': return { text: formatBps(f.value), unit: '' }
    case 'ratio': return { text: D(f.value).mul(100).toFixed(2) + '%', unit: 'of par' }
    // one duration formatter for every surface, signed, to the second under a minute
    case 'seconds': return { text: durationText(f.value), unit: '' }
    case 'share-units': return { text: D(f.value).toFixed(0), unit: 'shares' }
    // step 21: every dollar figure carries the stand-in label, whole
    case 'usd': return { text: D(f.value).toFixed(), unit: `USD (${USD_LABEL})` }
  }
}


/** 5345 bps -> "53.45%", divided by 100 with decimal.js, never multiplied. */
export function formatBps(bps: string): string {
  return new Decimal(bps).div(100).toFixed(2) + '%'
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
    case 'seconds': return durationText(figure.value)
    case 'share-units': return formatShareUnits(figure)
    case 'usd': return `${D(figure.value).toFixed()} USD (${USD_LABEL})`
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
                  <td className="num">{i.value}{inputGloss(i.name, i.value) !== null && <span className="block t-fig-s dim">{inputGloss(i.name, i.value)}</span>}</td>
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

export function Panel({ provenance, title, source, children, className }: {
  provenance: Provenance; title: string; source?: string; children: ReactNode; className?: string
}) {
  return (
    <section className={'panel' + (className ? ' ' + className : '')} aria-label={title}>
      <header className="panel-head">
        <h2 className="t-heading-s">{title}</h2>
        <span className="panel-meta">
          {source && <span className="panel-source t-label-s">{`Source: ${source}`}</span>}
          <span className="prov" data-prov={provenance}>{provenance}</span>
        </span>
      </header>
      {children}
    </section>
  )
}


export type VerdictStatus = 'PASS' | 'BREACHED' | 'STALE' | 'MATCH' | 'MISMATCH'
const ICON = { PASS: Check, MATCH: Check, BREACHED: X, MISMATCH: X, STALE: Clock }

export function Verdict({ status, big }: { status: VerdictStatus; big?: boolean }) {
  const Icon = ICON[status]
  const flash = useFlash(status)
  return (
    <span className={'verdict' + (big ? ' verdict-big' : '') + (flash ? ' flash' : '')} data-status={status} aria-live={big ? 'polite' : undefined}>
      <Icon size={big ? 20 : 16} strokeWidth={2} aria-hidden /> <span className="verdict-word">{status}</span>
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
  // step 21: d drops at the declared reference price, less the haircut, rounded down to a millionth of a dollar
  const usd = (d: Decimal) => new Decimal(d.div(1e6).times(v('xrpUsd')).times(new Decimal(1).minus(v('fxHaircutBps').div(10000))).toFixed(6, Decimal.ROUND_DOWN))
  const impaired = () => (BigInt(v('Flags').toFixed(0)) & LSF_LOAN_IMPAIRED) !== 0n
  const held = () => value(perUnit(v('AssetsTotal').minus(v('LossUnrealized'))))
  const ifDefault = () => perUnit(v('AssetsTotal').minus(exp().minus(cover())).minus(v('LossUnrealized').minus(impaired() ? exp() : 0)))
  return { v, perUnit, value, floor, cover, impaired, held, ifDefault, usd }
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
  // step 21: a loan in the test dollar against the same shares
  collateralHeldUsd: (i) => { const r = reader(i); return r.usd(r.held()).toFixed(6) },
  maxLoanUsd: (i) => { const r = reader(i); return r.v('maxLtvBps').times(r.usd(r.held())).div(10000).toFixed(6, Decimal.ROUND_DOWN) },
  requestedUsd: (i) => reader(i).v('principalUsd').toFixed(),
  ltvHeldUsd: (i) => { const r = reader(i); return r.floor(r.v('principalUsd').times(10000).div(r.usd(r.held()))) },
  lender1to1Usd: (i) => { const r = reader(i); return r.floor(r.v('principalUsd').times(10000).div(r.usd(r.v('units').div(new Decimal(10).pow(r.v('Scale')))))) },
  priceAge: (i) => { const r = reader(i); return r.v('close_time').minus(r.v('priceAsOf')).toFixed(0) },
  // step 22: how long a loan is past its due date
  pastDue: (i) => { const r = reader(i); return Decimal.max(0, r.v('close_time').minus(r.v('NextPaymentDueDate'))).toFixed(0) },
}

/** MATCH if and only if replaying the figure's formula on its own inputs gives the served value. */
export function recomputeStatus(figure: FigureDoc): 'MATCH' | 'MISMATCH' {
  const fn = Object.hasOwn(RECOMPUTE, figure.formulaId) ? RECOMPUTE[figure.formulaId] : null
  if (!fn) return 'MISMATCH'
  try {
    return new Decimal(fn(Object.fromEntries(figure.inputs.map((i) => [i.name, i.value])))).eq(figure.value) ? 'MATCH' : 'MISMATCH'
  } catch {
    return 'MISMATCH' // a missing input, or a figure no formula can produce
  }
}

/** The figure replayed in the reader's browser; `bare` prints the verdict alone, for a table column that already says what it is. */
export function Recompute({ figure, bare }: { figure: FigureDoc; bare?: boolean }) {
  const status = recomputeStatus(figure)
  if (bare) return <Verdict status={status} />
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
  return <p className="testnet t-label-s" role="note">Test network — XRPL Devnet. Nothing here moves real money.</p>
}


export function HashLink({ hash, kind = 'transactions', noLink }: { hash: string; kind?: 'transactions' | 'accounts'; noLink?: boolean }) {
  const [copied, setCopied] = useState(false)
  const short = hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
  return (
    <span className="hash">
      {noLink
        ? <span className="t-fig-m" title={hash}>{short}</span>
        : <a className="lnk t-fig-m" href={`${EXPLORER}/${kind}/${hash}`} target="_blank" rel="noreferrer noopener" aria-label={`${short}, full ${kind === 'transactions' ? 'transaction hash' : 'account'} ${hash}, opens the Devnet explorer`}>{short}</a>}
      <button
        type="button" className="btn btn-secondary"
        onClick={() => { navigator.clipboard?.writeText(hash).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }}
      >{copied ? 'Copied' : 'Copy'}</button>
    </span>
  )
}


/** The leading characters a price shares with the others: muted on screen, so the digits that differ stand out. */
export function sharedPrefix(text: string, others: string[]): string {
  let i = 0
  while (i < text.length - 1 && others.every((t) => t[i] === text[i])) i++
  return text.slice(0, i)
}


const FRIENDLY: Record<string, string> = {
  AssetsTotal: 'Total assets', LossUnrealized: 'Recognised loss', AssetsAvailable: 'Cash available', OutstandingAmount: 'Shares outstanding', Scale: 'Share scale',
  units: 'Shares in this ticket', DebtTotal: "Broker's total debt", CoverRateMinimum: 'Minimum cover rate', CoverRateLiquidation: 'Share of the cover drawn on a default',
  CoverAvailable: 'First-loss cover available', LEVersion: 'Loan engine version', PrincipalOutstanding: 'Loan principal outstanding',
  TotalValueOutstanding: 'Loan total value outstanding', ManagementFeeOutstanding: 'Management fee outstanding', Flags: 'Loan flags',
  RedemptionDate: 'Redemption date', close_time: 'Ledger close time', maxLtvBps: 'Mandate: max LTV', maxSingleLoanDrops: 'Mandate: max single loan', principalDrops: 'Planned loan principal',
  principalUsd: 'Planned loan principal', xrpUsd: 'XRP/USD reference price, USD per XRP',
}
const DROP_FIELDS = new Set(['AssetsTotal', 'LossUnrealized', 'AssetsAvailable', 'DebtTotal', 'CoverAvailable', 'PrincipalOutstanding', 'TotalValueOutstanding', 'ManagementFeeOutstanding', 'maxSingleLoanDrops', 'principalDrops'])
// step 21: a dollar input carries the stand-in label whole, as a dollar figure does; the reference price is dollars per XRP
const USD_FIELDS: Record<string, string> = { principalUsd: `USD (${USD_LABEL})`, xrpUsd: `USD per XRP (${USD_LABEL})` }

/** The reading under an input's verbatim value: XRP for drops, the labelled dollar for a dollar input, else null. */
export function inputGloss(name: string, value: string): string | null {
  if (DROP_FIELDS.has(name)) return `${formatXrp(value)} XRP`
  return Object.hasOwn(USD_FIELDS, name) ? `${value} ${USD_FIELDS[name]}` : null
}

/** One figure's trace, readable in a full-width row: what it means, how it is computed, and each ledger value it used. */
export function LedgerDetail({ figure }: { figure: FigureDoc }) {
  const f = figureParts(figure)
  return (
    <div className="ld">
      <p className="ld-meaning t-body-m">{figure.meaning}</p>
      <dl className="ld-calc">
        <div><dt>Formula</dt><dd><code>{figure.formula}</code></dd></div>
        <div><dt>Result</dt><dd><code>{figure.value}</code><span className="dim">{` (${f.text}${f.unit ? ' ' + f.unit : ''})`}</span></dd></div>
      </dl>
      <div className="table-scroll">
        <table className="ld-inputs">
          <thead><tr><th scope="col">Input</th><th scope="col" className="num">Value</th><th scope="col">Ledger object</th><th scope="col">Read at</th></tr></thead>
          <tbody>
            {figure.inputs.map((x) => (
              <tr key={x.name + x.id}>
                <td><span className="block">{FRIENDLY[x.name] ?? x.name}</span><span className="t-fig-s dim">{`${x.object}.${x.field}`}</span></td>
                <td className="t-fig-m num">{x.value}{inputGloss(x.name, x.value) !== null && <span className="block t-fig-s dim">{inputGloss(x.name, x.value)}</span>}</td>
                <td className="t-fig-s" title={x.id}>{x.id.length > 16 ? `${x.id.slice(0, 8)}…${x.id.slice(-6)}` : x.id}</td>
                <td className="t-fig-s">{`ledger ${x.ledgerIndex}`}<span className="block dim" title={x.ledgerHash}>{`${x.ledgerHash.slice(0, 8)}…`}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Value only: label, number, optional gloss. Its recompute and ledger inputs live once, in the AuditTable. */
export function FigureValue({ label, figure, size = 'l', mention, against, shown }: {
  label: string; figure: FigureDoc; size?: 'display' | 'l' | 'm'; mention?: string; against?: string[]; shown?: string
}) {
  const f = figureParts(figure)
  const flash = useFlash(['heldValue', 'ltvHeld', 'lender1to1'].includes(figure.formulaId) ? figure.value : null)
  const same = shown || !against?.length ? '' : sharedPrefix(f.text, against)
  return (
    <div className="fv">
      <p className="fig-label t-label-m">{label}</p>
      <p className={'fig-value fig-' + size + (flash ? ' flash' : '')}>
        {shown ?? <>{same && <span className="fig-same">{same}</span>}{f.text.slice(same.length)}</>}
        {!shown && f.unit && <span className="fig-unit"> {f.unit}</span>}
      </p>
      {mention && <p className="fig-mention t-body-s">{mention}</p>}
      <details className="fig-ledger">
        <summary>Ledger field</summary>
        <div className="pop-body pop-wide"><LedgerDetail figure={figure} /></div>
      </details>
    </div>
  )
}

/** Every figure of the ticket once: value, provenance, the recompute done in this browser, and its ledger trace in a full-width row. */
export function AuditTable({ entries }: { entries: { label: string; figure: FigureDoc }[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  return (
    <details className="exh audit" open>
      <summary>
        <span className="exh-title">Audit: every figure, recomputed</span>
        <span className="exh-meta"><span className="exh-meta-text">{entries.length} figures, each replayed in this browser from its ledger inputs</span></span>
      </summary>
      <div className="exh-body">
        <div className="table-scroll">
          <table className="op-tbl audit-tbl">
            <thead><tr>{['Figure', 'Value', 'Source', 'Recomputed', 'Inputs'].map((h, i) => <th key={i} scope="col" className={h === 'Value' ? 'num' : undefined}>{h === 'Inputs' ? <span className="sr-only">{h}</span> : h}</th>)}</tr></thead>
            <tbody>
              {entries.map(({ label, figure }) => {
                const f = figureParts(figure)
                const k = label + figure.formulaId
                const isOpen = open.has(k)
                return (
                  <Fragment key={k}>
                    <tr>
                      <td>{label}</td>
                      <td className="t-fig-m num">{f.text}{f.unit && ` ${f.unit}`}</td>
                      <td><span className="prov" data-prov={figure.provenance}>{figure.provenance}</span></td>
                      <td><Recompute figure={figure} bare /></td>
                      <td><button type="button" className="btn btn-secondary" aria-expanded={isOpen} onClick={() => toggle(k)}>Ledger field</button></td>
                    </tr>
                    <tr className="ld-row" hidden={!isOpen}><td colSpan={5}><LedgerDetail figure={figure} /></td></tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  )
}


export function ReadAt({ ledger, at }: { ledger: number | string; at?: string }) {
  return <p className="read-at t-fig-s">{`Read at ledger ${ledger}`}{at && ` · ${formatWhen(at)}`}</p>
}

/** "22 Oct 2026, 20:41 UTC": the time a reading was taken, in one fixed zone. */
export function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
}

/** What the four provenance labels mean, once, at the foot of every tab. */
export function ProvenanceKey() {
  return (
    <dl className="prov-key" aria-label="How to read the labels">
      {([['REAL', 'read from the ledger'], ['DECLARED', 'stated by a party, not computed'], ['MODELLED', 'computed by Orma from ledger values'], ['SIMULATED', 'a preview: nothing is sent']] as const).map(([k, v]) => (
        <div key={k}><dt><span className="prov" data-prov={k}>{k}</span></dt><dd className="t-body-s">{v}</dd></div>
      ))}
      <div><dt><span className="prov">MATCH</span></dt><dd className="t-body-s">the figure was recomputed in this browser from its ledger inputs</dd></div>
    </dl>
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
