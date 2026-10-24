import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import Decimal from 'decimal.js'
import { USD_COLLATERAL_RULE, USD_LABEL, type ChangeRow, type CollateralAccount, type FeedEvent, type Figure as FigureDoc, type LoanAsset, type Mandate, type MarginCall, type Mark, type PositionUsd, type Ticket, type TicketUsd, type UsdReference, type UsdTerms } from '../lib/types'
import { AuditTable, FigureValue, HashLink, Panel, ProvenanceKey, ReadAt, Recompute, ShowWork, TestNetBanner, Verdict, Figure, formatBps, formatWhen, formatXrp, type VerdictStatus } from '../components/Ledger'
import { BalanceBar, DefaultDots, LockBar, LtvGauge, PriceBars } from '../components/Charts'
import {
  API_BASE, ApiFailure, assetFromSearch, confirmAction, cureBody, cureTicketPath, deskPlanPath, deskTicketPaths, demoLoanFor, errorSentence, getJson, lendingVaultOf,
  postAction, readOperatorSession, sessionFromFragment, writeOperatorSession,
  type ActionError, type ActionPreview, type DeskPlan, type DeskPlanVault, type LoanCurrency, type OperatorSession, type Position, type Positions,
} from '../lib/api'
import { usePoll } from '../lib/usePoll'
import { follow, tabHref } from '../lib/useRoute'
import { dropsToXrp, inUnit } from '../lib/format'
import { DeskUniverse } from './DeskUniverse'
import { DeskFeed, FEED_POLL_MS, type FeedDoc } from './DeskFeed'

/**
 * Orma Desk: the ticket (the risk report, the default tab and the central screen), the desk's positions
 * and the risk officer's mandate, and under the ticket the operator controls that play the role actions.
 * Every figure is the server's, with its ledger inputs and recomputed in place; a verdict colour only
 * ever comes from <Verdict>, next to its word.
 */

const LOADING = 'The ledger is being read at a validated ledger. The figures appear on their own.'
const NOT_A_HARBOR = 'This facility is not one of the desk\'s Harbors.'

export interface DeskTab {
  id: string
  label: string
  /** The API path the tab reads, or null when it polls nothing. `asset` (step 21): the ticket's loan currency, XRP by default. */
  source: (ctx: { deskPlan?: DeskPlan; facility?: string; asset?: LoanCurrency }) => string | null
  /** How often the tab is read again, 3 s by default. */
  pollMs?: number
  /** usePoll keeps its last answer across a path change: a tab renders `data` only when it is its own document. */
  accepts: (data: unknown) => boolean
  mustContain: string[]
  mustShowKeys?: string[]
}

export const hasSchema = (s: string) => (d: unknown) => typeof d === 'object' && d !== null && (d as { schema?: unknown }).schema === s
export const hasArray = (k: string) => (d: unknown) => typeof d === 'object' && d !== null && Array.isArray((d as Record<string, unknown>)[k])

export const DESK_TABS: DeskTab[] = [
  {
    id: 'ticket', label: 'Ticket', accepts: () => true,
    source: ({ deskPlan, facility, asset }) => (deskPlan ? deskTicketPaths(deskPlan, facility, asset).pledge : null),
    mustContain: ['Withdrawal value', 'Value read by all', 'Test network'],
  },
  {
    id: 'positions', label: 'Positions', accepts: hasArray('positions'),
    source: () => '/api/desk/positions',
    mustContain: ['Collateral at withdrawal value', 'LTV at withdrawal value', 'Source: Orma'],
  },
  {
    id: 'mandate', label: 'Mandate', accepts: hasSchema('orma.mandate/1'), pollMs: 30000,
    source: () => deskPlanPath,
    mustContain: ['Mandate desk-1', 'Maximum loan-to-value at withdrawal value'],
    mustShowKeys: ['hash', 'anchorTx'],
  },
  { id: 'universe', label: 'Universe', source: () => '/api/universe', pollMs: 60000, mustContain: ['not live on mainnet', 'Not a full ledger scan.'], accepts: hasSchema('orma.universe/1') },
  { id: 'feed', label: 'Feed', source: () => '/api/feed', pollMs: FEED_POLL_MS, mustContain: [], accepts: hasArray('events') },
]

/** The two fictional institutions of the demo. The lender is the mandate's `desk`; the borrower's name lives here only. */
export const LENDER_NAME = 'Harbor Credit Desk (fictional)'
export const BORROWER_NAME = 'Tidewater Payments (fictional)'
/** What the desk is, in one line under the title of every tab. */
export const DESK_LINE = 'Short-term secured financing against XRPL vault shares, the on-chain equivalent of a repo. The shares stay in escrow; the price is the withdrawal value.'

/** harbor-2 -> Harbor-2. */
const harborName = (label: string | null) => (label ? label.replace(/^harbor-/, 'Harbor-') : 'unknown facility')
export const deskTitle = (harbor: string | null, tab: string) => `Credit desk: ${harborName(harbor)} · ${tab}`

const cap = (x: string) => x.replace(/^./, (c) => c.toUpperCase())
const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toUpperCase() === b.toUpperCase())

// --- step 21, loans in the test dollar (addendum A11) --------------------------------------------------
// The loan's currency changes, never the collateral. Every dollar amount on the desk carries USD_LABEL, whole.

/** A dollar amount as the server states it, with the stand-in label: the test dollar is never named alone. */
export const dollars = (v: unknown) => `${v === undefined || v === null ? '—' : inUnit(String(v))} USD (${USD_LABEL})`

const SECONDS = /^-?\d+(\.\d+)?$/
/** A count of seconds, from its decimal string, as days, hours, minutes and seconds. A time, never an amount. */
export function secondsText(seconds: string | null | undefined): string {
  if (seconds === null || seconds === undefined || !SECONDS.test(seconds)) return '—'
  const all = new Decimal(seconds)
  const s = all.abs().floor()
  const d = s.div(86400).floor()
  const h = s.mod(86400).div(3600).floor()
  const m = s.mod(3600).div(60).floor()
  const r = s.mod(60)
  const sign = all.isNeg() && !s.isZero() ? '-' : ''
  if (d.gt(0)) return `${sign}${d.toFixed(0)} ${d.eq(1) ? 'day' : 'days'} ${h.toFixed(0)} h ${m.toFixed(0)} min`
  if (h.gt(0)) return `${sign}${h.toFixed(0)} h ${m.toFixed(0)} min ${r.toFixed(0)} s`
  if (m.gt(0)) return `${sign}${m.toFixed(0)} min ${r.toFixed(0)} s`
  return `${sign}${r.toFixed(0)} s`
}

/** The reference price, as a rate: the USD it names is the test dollar, said beside it. */
const perXrp = (value: unknown) => `${text(value)} USD per XRP`

/**
 * The loan figures of a ticket in its own currency: the drops ones of an XRP ticket, the dollar ones of a USD
 * ticket (which carries no maxLoan, requested, ltvHeld or lender1to1). Every reader of those four goes through it.
 */
function loanFigures(t: Ticket): { maxLoan?: FigureDoc; requested?: FigureDoc; ltvHeld?: FigureDoc; lender1to1?: FigureDoc } {
  const f = t.figures
  return t.usd
    ? { maxLoan: f.maxLoanUsd, requested: f.requestedUsd, ltvHeld: f.ltvHeldUsd, lender1to1: f.lender1to1Usd }
    : { maxLoan: f.maxLoan, requested: f.requested, ltvHeld: f.ltvHeld, lender1to1: f.lender1to1 }
}

/** The loan currency of the address bar, followed across pushState links (their popstate) and Back. XRP off a browser. */
function useUrlAsset(): LoanCurrency {
  const [asset, setAsset] = useState<LoanCurrency>(() => (typeof location === 'undefined' ? 'XRP' : assetFromSearch(location.search)))
  useEffect(() => {
    const read = () => setAsset(assetFromSearch(location.search))
    addEventListener('popstate', read)
    return () => removeEventListener('popstate', read)
  }, [])
  return asset
}

/**
 * The ticket tab's address for a loan currency: XRP is the address without `asset`, as before step 21. `tab`
 * first, as a Harbor link, so a currency link and a tab link never read alike.
 */
export function currencyHref(facility: string | undefined, asset: LoanCurrency): string {
  const q = new URLSearchParams()
  q.set('tab', 'ticket')
  if (facility) q.set('facility', facility)
  if (asset === 'USD') q.set('asset', 'USD')
  return '/desk?' + q
}

/** The request's currency: XRP or the test dollar. Offered only when the server lends the dollar (deskPlan.usd). */
function CurrencyChoice({ asset, facility }: { asset: LoanCurrency; facility?: string }) {
  const go = (href: string) => () => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')) }
  return (
    <div className="currency-choice" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <span className="t-label-m">Loan currency</span>
      <nav className="harbors" aria-label="Loan currency">
        {(['XRP', 'USD'] as const).map((a) => (
          <a key={a} href={currencyHref(facility, a)} aria-current={asset === a ? 'true' : undefined} onClick={(e) => follow(e, go(currencyHref(facility, a)))}>{a}</a>
        ))}
      </nav>
      <span className="t-body-s dim">{`USD: ${USD_LABEL}. Either way the collateral is shares of XRP vaults.`}</span>
    </div>
  )
}

function ErrorBlock({ code, message }: { code: string; message?: string }) {
  return (
    <div role="alert">
      <p className="caption">{errorSentence(code)}</p>
      {message && <p className="caption">{message}</p>}
      <details><summary>Error code</summary><code>{code}</code></details>
    </div>
  )
}

function Loading() {
  return <p className="caption">{LOADING}</p>
}

// --- the tab bar -------------------------------------------------------------------------------------

function TabBar({ current, facility, asset = 'XRP' }: { current: string; facility?: string; asset?: LoanCurrency }) {
  // A dollar choice rides along every tab link; an XRP address is what it was.
  const search = (facility ? `?facility=${facility}` : '') + (asset === 'USD' ? `${facility ? '&' : '?'}asset=USD` : '')
  const go = (href: string) => () => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')) }
  return (
    <nav className="tabs" aria-label="Desk tabs">
      {DESK_TABS.map((t) => (
        <a key={t.id} href={tabHref(search, t.id)} aria-current={t.id === current ? 'page' : undefined} onClick={(e) => follow(e, go(tabHref(search, t.id)))}>{t.label}</a>
      ))}
    </nav>
  )
}

// --- the ticket ----------------------------------------------------------------------------------------

function Line({ label, meaning, figure }: { label: string; meaning: string; figure: FigureDoc }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <Figure label={label} meaning={meaning} figure={figure} />
      <Recompute figure={figure} />
    </div>
  )
}

const statusOf = (v: unknown): VerdictStatus => (typeof v === 'string' ? v : (v as { status?: string } | null)?.status ?? 'STALE') as VerdictStatus

/** The mandate's test of this loan: at the withdrawal value, then for a lender pricing the shares at 1:1. */
function MandatePanel({ ticket }: { ticket: Ticket }) {
  const f = loanFigures(ticket)
  const u = ticket.usd
  return (
    <Panel provenance="DECLARED" title="Mandate of the risk officer">
      <p className="caption">{`Mandate ${ticket.mandate.id} · hash ${ticket.mandate.hash}`}</p>
      {f.requested && <Line label="Loan requested" meaning={u ? 'The principal of the planned loan, in dollars.' : 'The principal of the planned loan.'} figure={f.requested} />}
      {f.ltvHeld && <Line label="LTV at withdrawal value" meaning={u ? 'Requested dollars over the withdrawal value of the pledged units, in dollars at the reference price less the haircut.' : 'Requested principal over the withdrawal value of the pledged units.'} figure={f.ltvHeld} />}
      <p>Verdict at the withdrawal value: <Verdict status={statusOf(ticket.verdict)} /></p>
      {ticket.verdict.breaches.map((b) => <p key={b.limit} className="caption">{breachLine(b)}</p>)}
      {f.lender1to1 && <Line label="Lender at 1:1" meaning={u ? 'Requested dollars over the units valued at one XRP each, in dollars at the reference price less the haircut, as a lender pricing shares at par would.' : 'Requested principal over the units valued at one XRP each, as a lender pricing shares at par would.'} figure={f.lender1to1} />}
      {ticket.verdict1to1 && <p>Verdict for a lender at 1:1: <Verdict status={statusOf(ticket.verdict1to1)} /></p>}
    </Panel>
  )
}

/** The six steps of orma-mark for the share, each with its own result: a pending oracle passes. */
function PointerPanel({ mark }: { mark: Mark }) {
  return (
    <Panel provenance="REAL" title="Nav pointer chain" source="Orma">
      <p className="t-body-m">{`orma-mark verdict: ${mark.verdict}${mark.reason ? ` (${mark.reason})` : ''} · ledger ${mark.ledgerIndex}`}</p>
      <ol className="chain">
        {mark.steps.map((s) => (
          <li key={s.step}><span className="t-label-m">{s.step}</span><span className="t-body-s dim">{` ${s.ok ? 'passes' : 'fails'}: ${s.detail}`}</span></li>
        ))}
      </ol>
    </Panel>
  )
}

const LIMIT_LABEL: Record<string, string> = {
  maxLtvBps: 'Max LTV', maxSingleLoanDrops: 'Max single loan', maxN2LossDrops: 'Max loss if one loan defaults', maxLockupDays: 'Max lock-up',
  // step 21: the row of a loan in the test dollar
  maxSingleLoanUsd: 'Max single loan',
}
/** A limit's value in its unit; a value the server could not state (null) is a dash, never a zero. */
const limitValue = (limit: string, x: string | null | undefined) => (x === null || x === undefined ? '—'
  : limit === 'maxSingleLoanUsd' ? dollars(x)
    : limit.endsWith('Bps') ? formatBps(x) : limit.endsWith('Days') ? `${x} days` : `${formatXrp(x)} XRP`)
/** The limit of step 21, in its unit on the mandate panel; the XRP rows keep the raw line they always had. */
const USD_LIMITS = new Set(['maxSingleLoanUsd'])
const breachLine = (b: { limit: string; value: string; threshold: string }) => (USD_LIMITS.has(b.limit)
  ? `${b.limit}: ${limitValue(b.limit, b.value)} over the limit of ${limitValue(b.limit, b.threshold)}`
  : `${b.limit}: ${b.value} over the limit of ${b.threshold}`)
/** The threshold the server named for the LTV limit, when it named one: only a breach carries it on the ticket. */
const ltvLimit = (ticket: Ticket) => ticket.verdict.breaches.find((b) => b.limit === 'maxLtvBps')?.threshold

function Statement({ t, txHash }: { t: Ticket; txHash?: string | null }) {
  const s = t.statement
  if (!s) return null
  const c = s.consistency
  const line = c.status === 'CONSISTENT' ? `Consistent with the ledger at ${c.ledgerIndex}`
    : c.status === 'INCONSISTENT' ? `Not consistent with the ledger at ${c.ledgerIndex}: ${c.detail}`
    : c.status === 'NOT_CHECKABLE' ? `Not checkable against the ledger: ${c.detail}`
    : 'Unreadable statement in Vault.Data'
  return (
    <div>
      <dt>Curator statement <span className="prov" data-prov="DECLARED">DECLARED</span></dt>
      <dd className="stmt">
        {s.doc && <span className="t-body-m">&ldquo;{s.doc.text}&rdquo;</span>}
        <span className="t-body-s dim" title={s.owner}>Signed by the vault owner</span>
        {txHash && <HashLink hash={txHash} />}
        <span className="t-body-s"><span className="prov" data-prov="REAL">REAL</span>{` ${line}`}</span>
      </dd>
    </div>
  )
}

/** The reading of the ticket beside the approval: the verdict and the loan-to-value, as the ticket states them. */
function ApprovalReading({ ticket, choice }: { ticket: Ticket; choice?: ReactNode }) {
  const f = ticket.figures
  const l = loanFigures(ticket)
  const u = ticket.usd
  const par = l.lender1to1?.value ?? null
  return (
    <aside className="desk-aside" aria-label="Approval">
      <div className="approval">
        <h2 className="t-heading-s">Approval</h2>
        {choice}
        {l.requested ? (
          <>
            <p className="t-body-m approval-line">{u
              ? `Loan of ${dollars(l.requested.value)} against collateral worth ${formatXrp(f.heldValue.value)} XRP at withdrawal value, ${dollars(u.collateralHeldUsd)} at the reference price less the haircut.`
              : `Loan of ${formatXrp(l.requested.value)} XRP against collateral worth ${formatXrp(f.heldValue.value)} XRP at withdrawal value.`}</p>
            <div className="approval-verdict">
              <span className="t-label-m">LTV at withdrawal value <span className="dim">{u ? '(loan ÷ collateral, both in dollars)' : '(loan ÷ collateral)'}</span></span>
              <Verdict status={statusOf(ticket.verdict)} big />
            </div>
            {l.ltvHeld && par !== null && <LtvGauge ltvBps={l.ltvHeld.value} parBps={par} limitBps={ltvLimit(ticket)} />}
            {ticket.verdict.breaches.map((b) => <p key={b.limit} className="t-body-s"><strong>{`${LIMIT_LABEL[b.limit] ?? b.limit}: ${limitValue(b.limit, b.value)} of ${limitValue(b.limit, b.threshold)}, over the limit.`}</strong></p>)}
            {ticket.verdict1to1 && <p className="t-body-m approval-line">Lender at 1:1 <Verdict status={statusOf(ticket.verdict1to1)} /></p>}
            <p className="t-body-s dim">The risk officer approves in the operator controls below.</p>
          </>
        ) : <p className="t-body-m approval-line">No loan request is waiting. Play “Sign and request loan” in the operator controls below.</p>}
      </div>
    </aside>
  )
}

/**
 * The XRP/USD price of a dollar loan: the median of the XLS-47 Oracle documents read at the ticket's ledger,
 * REAL. The one component that reads a reference's shape, so a change of that shape lands here and in
 * `referenceLine` only: the median with its method, one line per source (provider, price, age, used or not),
 * the spread against its maximum, the ledger's own aggregate when it was read, and the note.
 */
/**
 * The median and the spread of the used sources, replayed in this browser with decimal.js (the server's
 * medianOf and spreadBpsOf of src/nyc/contracts.mjs): MATCH when both equal what the reference states.
 */
export function recomputeReference(r: Pick<UsdReference, 'value' | 'spreadBps' | 'sources'>): 'MATCH' | 'MISMATCH' {
  const prices = r.sources.filter((s) => s.used && s.price !== null && SECONDS.test(s.price)).map((s) => new Decimal(s.price as string)).sort((a, b) => a.cmp(b))
  if (prices.length === 0 || !SECONDS.test(r.value)) return 'MISMATCH'
  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 ? prices[mid] : prices[mid - 1].plus(prices[mid]).div(2)
  if (median.isZero()) return 'MISMATCH'
  const spread = prices[prices.length - 1].minus(prices[0]).times(10000).div(median).ceil()
  return median.eq(r.value) && spread.eq(r.spreadBps) ? 'MATCH' : 'MISMATCH'
}

function ReferencePrice({ r, ledgerIndex }: { r: UsdReference; ledgerIndex: number }) {
  const used = r.sources.filter((s) => s.used).length
  return (
    <>
      <p className="t-fig-l">{perXrp(r.value)}</p>
      <p className="t-body-s dim">{`USD: ${USD_LABEL}. ${r.method}`}</p>
      <p className="t-body-s">Median and spread of the used sources, recomputed in this browser: <Verdict status={recomputeReference(r)} /></p>
      <div className="table-scroll">
        <table className="op-tbl">
          <thead><tr>{['Oracle source', 'Price', 'Last update', 'Used'].map((h) => <th key={h} scope="col" className={h === 'Price' ? 'num' : undefined}>{h}</th>)}</tr></thead>
          <tbody>
            {r.sources.map((s) => (
              <tr key={`${s.account}-${s.documentId}`}>
                <td>{s.provider}<span className="t-body-s dim block"><HashLink hash={s.account} kind="accounts" />{` · document ${s.documentId}`}</span></td>
                <td className="t-fig-m num">{s.price === null ? 'no price at this ledger' : perXrp(s.price)}</td>
                <td className="t-body-s">{s.ageSeconds === null ? 'never updated' : `${secondsText(s.ageSeconds)} old${s.fresh ? '' : `, past the ${secondsText(String(r.maxAgeSeconds))} allowed`}`}{s.lastUpdateTime && <span className="dim block">{s.lastUpdateTime}</span>}</td>
                <td className="t-body-s">{s.used ? 'used in the median' : s.fresh ? 'not used' : 'not used: not fresh'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv">
        <div><dt>Sources in the median</dt><dd className="t-fig-s">{`${used} of ${r.sources.length}, at least ${r.minSources} required`}</dd></div>
        <div><dt>Spread between the sources used</dt><dd className="t-fig-s">{`${bps(r.spreadBps)}, at most ${bps(r.maxSpreadBps)}`}</dd></div>
        <div><dt>Oldest update used</dt><dd className="t-body-s">{`${formatWhen(r.asOf) || r.asOf} (${r.asOf})`}</dd></div>
        <div><dt>{`Age at ledger ${ledgerIndex}`}</dt><dd className="t-fig-s">{`${secondsText(r.ageSeconds)} (${r.ageSeconds} s), at most ${secondsText(String(r.maxAgeSeconds))} per source`}</dd></div>
        <div><dt>The ledger&apos;s own aggregate</dt><dd className="t-body-s">{`get_aggregate_price at ledger ${r.ledgerAggregate.ledgerIndex}: median ${perXrp(r.ledgerAggregate.median)} over ${r.ledgerAggregate.size} ${r.ledgerAggregate.size === 1 ? 'source' : 'sources'}, the same median`}</dd></div>
        <div><dt>Provenance</dt><dd><span className="prov" data-prov={r.provenance}>{r.provenance}</span></dd></div>
      </dl>
      <p className="t-body-s">{r.note}</p>
    </>
  )
}

/** The reference in one line, for a money preview or a position: the median, how many sources, the spread. */
function referenceLine(r: UsdReference): string {
  const used = r.sources.filter((s) => s.used)
  return `${perXrp(r.value)} (USD: ${USD_LABEL}), median of ${used.length} of ${r.sources.length} oracle sources (${used.map((s) => s.provider).join(', ')}), spread ${bps(r.spreadBps)}, oldest update ${secondsText(r.ageSeconds)} old`
}

/** The dollar side of a USD ticket: the reference price, the terms it is used on, the two dollar figures and the collateral rule. */
function UsdReferencePanel({ usd, figures, ledgerIndex }: { usd: TicketUsd; figures: Ticket['figures']; ledgerIndex: number }) {
  return (
    <Panel provenance={usd.reference.provenance} title="Reference price of the dollar loan" source="XLS-47 oracles, read at this ledger">
      <ReferencePrice r={usd.reference} ledgerIndex={ledgerIndex} />
      <dl className="kv">
        <div><dt>Haircut on the collateral&apos;s dollar value</dt><dd className="t-fig-s">{formatBps(String(usd.terms.fxHaircutBps))}</dd></div>
        <div><dt>Largest single loan in dollars</dt><dd className="t-fig-s">{dollars(usd.terms.maxSingleLoanUsd)}</dd></div>
        <div><dt>Issuer of the test dollar</dt><dd><HashLink hash={usd.loanAsset.issuer} kind="accounts" /></dd></div>
        <div><dt>Terms fingerprint</dt><dd><HashLink hash={usd.terms.hash} noLink /></dd></div>
        <div><dt>Terms anchored on the ledger by</dt><dd><HashLink hash={usd.terms.anchorTx} /></dd></div>
      </dl>
      {figures.collateralHeldUsd && <Line label="Collateral at withdrawal value, in dollars" meaning="The withdrawal value of the pledged units in XRP, at the reference price, less the haircut." figure={figures.collateralHeldUsd} />}
      {figures.priceAge && <Line label="Age of the reference price" meaning="The ledger's close time less the latest oracle update the median used." figure={figures.priceAge} />}
      <p className="t-body-m"><strong>{USD_COLLATERAL_RULE}</strong></p>
    </Panel>
  )
}

const VIEWS = [['summary', 'Summary'], ['defaults', 'If a loan defaults'], ['history', 'Assets and lock-up'], ['proof', 'Proof'], ['audit', 'Audit']] as const
type View = typeof VIEWS[number][0]

function TicketView({ ticket, mark, harbor, loan, buyTicket, deskPlan, changeRows, onChange, choice }: {
  ticket: Ticket; mark: Mark | null; harbor: DeskPlanVault | null; loan: Position | null; buyTicket: Ticket | null; deskPlan?: DeskPlan
  changeRows: ChangeRow[]; onChange: (rows: ChangeRow[]) => void; choice?: ReactNode
}) {
  const [view, setView] = useState<View>('summary')
  const f = ticket.figures
  const l = loanFigures(ticket)
  const asset: LoanCurrency = ticket.usd ? 'USD' : 'XRP'
  const acct = loan?.collateral[0]?.account
  const hiddenField = harbor?.impairL1Hidden?.[0]
  const lossInput = f.heldValue.inputs.find((i) => i.field === 'LossUnrealized')
  const totalInput = f.heldValue.inputs.find((i) => i.field === 'AssetsTotal')
  // The lender at 1:1 takes one share for the drop deposited: par = units / 10^shareScale drops (read off the ticket's own share).
  const par = new Decimal(ticket.share.units).div(new Decimal(10).pow(ticket.share.shareScale)).toFixed(0)
  const perShareNow = new Decimal(f.heldValue.value).div(ticket.share.units).toFixed(6)
  const audit: { label: string; figure: FigureDoc }[] = [
    { label: 'Withdrawal value', figure: f.heldValue },
    { label: 'Value read by all', figure: f.naiveValue },
    { label: 'Overpayment if valued at the value read by all', figure: f.n1Overpayment },
    ...f.n2.flatMap((e) => [
      { label: `${e.label}: loss on the ${ticket.share.units} pledged shares, after cover`, figure: e.lossAfterCover },
      { label: `${e.label}: withdrawal value per share if it defaults`, figure: e.heldPerUnitIfDefault },
      { label: `${e.label}: vault cover drawn`, figure: e.cover },
    ]),
    { label: 'Locked until redemption', figure: f.n3.lockedUntil },
    { label: 'Cash in the vault', figure: f.n3.cashAvailable },
    { label: 'Claim at redemption', figure: f.n3.claim },
    ...(l.maxLoan ? [{ label: ticket.usd ? 'Largest dollar loan the mandate allows' : 'Largest loan the mandate allows', figure: l.maxLoan }] : []),
    ...(l.requested ? [{ label: 'Requested', figure: l.requested }] : []),
    ...(f.collateralHeldUsd ? [{ label: 'Collateral at withdrawal value, in dollars', figure: f.collateralHeldUsd }] : []),
    ...(l.ltvHeld ? [{ label: ticket.usd ? 'LTV at withdrawal value, in dollars' : 'LTV at withdrawal value', figure: l.ltvHeld }] : []),
    ...(l.lender1to1 ? [{ label: ticket.usd ? 'Lender at 1:1, in dollars' : 'Lender at 1:1', figure: l.lender1to1 }] : []),
    ...(f.priceAge ? [{ label: 'Age of the reference price', figure: f.priceAge }] : []),
  ]
  return (
    <>
      <nav className="subtabs" aria-label="Ticket sections">
        {VIEWS.map(([id, label]) => <button key={id} type="button" className="btn btn-secondary" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
      </nav>
      <div className="desk-grid">
        <ApprovalReading ticket={ticket} choice={choice} />
        <div className="desk-report">
          <div hidden={view !== 'summary'} className="view-summary">
            <section className="price-hero" aria-label="Withdrawal value">
              <FigureValue size="display" label="Withdrawal value" mention="XLS-65 withdraw rate" figure={f.heldValue} against={[formatXrp(f.naiveValue.value), formatXrp(par)]} />
              <div className="price-hero-side">
                <FigureValue size="m" label="Value read by all" mention="AssetsTotal / shares" figure={f.naiveValue} against={[formatXrp(f.heldValue.value), formatXrp(par)]} />
                <FigureValue size="m" label="Overpayment if valued at the value read by all" figure={f.n1Overpayment} />
              </div>
            </section>
            <Panel provenance="REAL" title="The three prices of one share" source="Orma">
              <PriceBars held={f.heldValue.value} naive={f.naiveValue.value} par={par} />
            </Panel>
            {ticket.usd && <UsdReferencePanel usd={ticket.usd} figures={f} ledgerIndex={ticket.ledgerIndex} />}
            {hiddenField && lossInput && (
              <p className="hidden-field t-body-m">
                <strong>Not in the transaction log.</strong>{` ${hiddenField}: absent → ${lossInput.value} (${formatXrp(lossInput.value)} XRP), not in PreviousFields.`}
              </p>
            )}
            <details className="evidence">
              <summary>
                <span className="t-body-m">{loan ? 'This loan is live on Devnet' : 'No demo loan yet for this facility.'}</span>
                {loan?.loanSetTxHash && <span className="t-fig-m dim">{`${loan.loanSetTxHash.slice(0, 8)}…${loan.loanSetTxHash.slice(-6)}`}</span>}
                <span className="dim t-body-s">Evidence</span>
              </summary>
              <dl className="proof-dl" aria-label="Evidence">
                <div><dt>LoanSet transaction</dt><dd>{loan?.loanSetTxHash && <HashLink hash={loan.loanSetTxHash} />}</dd></div>
                <div>
                  <dt>Collateral <span className="prov" data-prov="REAL">REAL</span></dt>
                  <dd>
                    {acct && (
                      <>
                        <span className="t-body-s">{acct.conforming ? 'Collateral: 2-of-3 account, master key disabled' : `Collateral account does not meet the 2-of-3 policy: ${acct.reasons.join('; ')}`}</span>
                        <details className="fig-ledger"><summary>Signers</summary>
                          <dl className="ld-calc pop-body">
                            <div><dt>Account</dt><dd><HashLink hash={acct.address} kind="accounts" /></dd></div>
                            <div><dt>Signers</dt><dd className="t-body-s">borrower, desk, Orma agent: any two must sign; the master key is disabled</dd></div>
                            {acct.ledgerIndex !== undefined && <div><dt>Read at</dt><dd className="t-fig-s">{`ledger ${acct.ledgerIndex}`}</dd></div>}
                          </dl>
                        </details>
                      </>
                    )}
                  </dd>
                </div>
                {harbor?.impairL1Tx && <div><dt>L1 impaired by the broker before the slot</dt><dd><HashLink hash={harbor.impairL1Tx} /></dd></div>}
                <Statement t={ticket} txHash={harbor?.statementTx} />
              </dl>
            </details>
          </div>

          <div hidden={view !== 'defaults'} className="view-stack">
            <Panel provenance="MODELLED" title="If one loan defaults alone" source="Orma">
              <DefaultDots now={perShareNow} rows={f.n2.map((e) => ({ label: `${e.label} defaults alone`, value: e.heldPerUnitIfDefault.value, impaired: e.alreadyInHeld }))} />
              <div className="table-scroll">
                <table className="op-tbl">
                  <thead><tr>{['Scenario', `Loss on the ${ticket.share.units} pledged shares, after cover`, 'Vault cover drawn'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                  <tbody>
                    {f.n2.map((e) => (
                      <tr key={e.loanId}>
                        <td>{e.scenario}</td>
                        <td className="t-fig-m">{e.alreadyInHeld ? 'already in the withdrawal value (impaired)' : `${formatXrp(e.lossAfterCover.value)} XRP`}</td>
                        <td className="t-fig-m">{`${formatXrp(e.cover.value)} XRP`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <div hidden={view !== 'history'} className="view-stack">
            <Panel provenance="REAL" title="Assets, cash and lock-up" source="Orma">
              <div className="two">
                {totalInput && lossInput && <div><p className="t-label-m dim">{`Where the vault's ${formatXrp(totalInput.value)} XRP sit`}</p><BalanceBar total={totalInput.value} available={f.n3.cashAvailable.value} loss={lossInput.value} /></div>}
                <div><p className="t-label-m dim">{`Locked ${new Decimal(f.n3.lockedUntil.value).div(86400).floor().toString()} more days · claim ${formatXrp(f.n3.claim.value)} XRP on ${new Date(f.n3.redemptionAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`}</p><LockBar seconds={f.n3.lockedUntil.value} /></div>
              </div>
            </Panel>
          </div>

          <div hidden={view !== 'proof'} className="view-stack">
            {mark && <PointerPanel mark={mark} />}
            <MandatePanel ticket={ticket} />
            <section className="escrow-note" aria-label="How the escrow works">
              <h2 className="t-label-m">How the escrow works</h2>
              <p className="t-body-m">{ticket.escrowPolicy.text.charAt(0).toUpperCase() + ticket.escrowPolicy.text.slice(1) + (ticket.escrowPolicy.text.endsWith('.') ? '' : '.')}</p>
            </section>
          </div>

          <div hidden={view !== 'audit'} className="view-stack">
            <AuditTable entries={audit} />
            <ShowWork rows={changeRows} />
            <ProvenanceKey />
          </div>
        </div>
      </div>
      <OperatorPanel ticket={ticket} buyTicket={buyTicket} harbor={harbor} asset={asset} onChange={onChange}
        units={(asset === 'USD' ? deskPlan?.usd?.plannedLoan.units : deskPlan?.plannedLoan.units) ?? ticket.share.units} />
    </>
  )
}

const usageValues = (u: Position['usage'][number]) => `${limitValue(u.limit, u.value)} of ${limitValue(u.limit, u.threshold)}`
/** A usage row the bars may divide: both sides decimal strings, the limit not zero. The server sends null for a value it could not read. */
const measurable = <U extends { value: string | null; threshold: string | null }>(u: U): u is U & { value: string; threshold: string } =>
  typeof u.value === 'string' && SECONDS.test(u.value) && typeof u.threshold === 'string' && SECONDS.test(u.threshold) && !new Decimal(u.threshold).isZero()
/** A position's loan, in its own currency: dollars with their label for a USD loan, drops shown as XRP otherwise. */
const principalLine = (p: Position) => (p.currency === 'USD'
  ? `Loan in USD · principal outstanding ${dollars(p.principalOutstanding)}`
  : `Loan in XRP · principal outstanding ${formatXrp(p.principalOutstanding)} XRP`)
const usdCollateralLine = (u: PositionUsd | null | undefined) => (!u ? 'Not valued in dollars: the USD terms could not be read.'
  : u.collateralHeldUsd === null || !u.reference ? `Not valued in dollars at this ledger: ${u.priceUnavailable ?? 'no usable XRP/USD price.'}`
    : `${dollars(u.collateralHeldUsd)} at the reference price of ${referenceLine(u.reference)}, less the haircut`)

/** A bar of what is used against a limit, drawn with the limit at 70% of the track so a breach visibly crosses it. */
function Mini({ value, limit }: { value: string; limit: string }) {
  const used = new Decimal(limit).isZero() ? new Decimal(0) : new Decimal(value).div(limit).times(70)
  return (
    <span className="mini" aria-hidden>
      <span className="mini-fill" style={{ width: `${Decimal.min(100, used).toFixed(1)}%` }} />
      <span className="mini-limit" style={{ left: '70%' }} />
    </span>
  )
}

function PositionsTab({ doc, deskPlan, harbor }: { doc: Positions; deskPlan?: DeskPlan; harbor: DeskPlanVault | null }) {
  // The cure of a margin call is a borrower action of the operator's run, as in the ticket's operator panel.
  const [session] = useOperatorSession()
  // One primary button on the tab: the cure of the first ISSUED call; any other call's cure is secondary.
  const firstCall = doc.positions.find((p) => p.marginCall?.status === 'ISSUED')?.loanId
  if (doc.positions.length === 0) return <div className="state"><p className="t-body-s dim">The desk has no loan yet.</p></div>
  return (
    <>
      <p className="t-body-l summary-line">{`${doc.positions.length} ${doc.positions.length === 1 ? 'loan' : 'loans'} on the desk.`}</p>
      <p className="t-body-m parties">{`Lender: ${LENDER_NAME} · Borrower: ${BORROWER_NAME}`}</p>
      <div className="tbl-wrap"><table className="op-tbl">
          <thead><tr>{['Loan', 'Collateral', 'Collateral at withdrawal value', 'LTV at withdrawal value'].map((h) => <th key={h} scope="col" className={h === 'Collateral at withdrawal value' ? 'num' : undefined}>{h}</th>)}</tr></thead>
          <tbody>
            {doc.positions.map((p) => {
              const ltvLimit = p.usage.find((u) => u.limit === 'maxLtvBps')?.threshold ?? undefined
              return (
                <Fragment key={p.loanId}>
                <tr>
                  <td>{p.loanSetTxHash ? <HashLink hash={p.loanSetTxHash} /> : <span className="dim">LoanSet not found in the history</span>}<span className="t-fig-s dim block">{`loan ${p.loanId.slice(0, 8)}`}</span><span className="t-body-s block">{principalLine(p)}</span><span className="t-body-s block">{`${BORROWER_NAME} `}<HashLink hash={p.borrower} kind="accounts" /></span></td>
                  <td>
                    {p.collateral.map((c) => {
                      const v = deskPlan?.vaults.find((x) => same(x.shareMptId, c.shareMptId))
                      return (
                        <div key={c.escrowId}>
                          <p>{v ? cap(harborName(v.label)) : 'Unknown facility'}{harbor && same(c.shareMptId, harbor.shareMptId) && <span className="prov" data-prov="admitted">Selected facility</span>}</p>
                          <p className="t-body-s dim"><span className="prov" data-prov="REAL">REAL</span>{c.account.conforming ? ' 2-of-3, master key disabled' : ` Collateral account ${c.account.address} does not meet the 2-of-3 policy: ${c.account.reasons.join('; ')}`}</p>
                        </div>
                      )
                    })}
                  </td>
                  <td className="t-fig-m num">{`${formatXrp(p.collateralHeldDrops)} XRP`}{p.currency === 'USD' && <span className="t-body-s block">{usdCollateralLine(p.usd)}</span>}</td>
                  <td>
                    <span className="t-fig-m block">{p.ltvHeldBps === null ? '—' : formatBps(String(p.ltvHeldBps))}</span>
                    {p.currency === 'USD' && <span className="t-body-s dim block">in dollars: the loan over the collateral&apos;s dollar value</span>}
                    {ltvLimit !== undefined && p.ltvHeldBps !== null && <Mini value={String(p.ltvHeldBps)} limit={ltvLimit} />}
                    <details className="fig-ledger limits-fold"><summary>All limits</summary>
                      <dl className="usage pop-body">{p.usage.map((u) => <div key={u.limit}><dt>{(LIMIT_LABEL[u.limit] ?? u.limit).replace('Max ', '')}</dt><dd className="t-fig-s">{usageValues(u)}</dd></div>)}</dl>
                    </details>
                  </td>
                </tr>
                {p.marginCall && <MarginCallRow position={p} call={p.marginCall} deskPlan={deskPlan} session={session} primary={p.loanId === firstCall} />}
                </Fragment>
              )
            })}
          </tbody>
        </table></div>
      <p className="t-body-s dim">Source: Orma. LTV is loan-to-value: the loan divided by the collateral valued at its withdrawal value. The tick on each bar is the mandate&apos;s limit.</p>
    </>
  )
}

function MandateTab({ doc, positions }: { doc: Mandate; positions?: Positions | null }) {
  const l = doc.limits
  const gloss = (t: string) => <span className="block dim t-body-s">{t}</span>
  // The position nearest to each limit, for the bar only: the figures shown are the server's own.
  // A row the server could not state (null), or a zero limit, takes no part: it has no fraction of its limit.
  const worst = (limit: string) => (positions?.positions ?? []).flatMap((p) => p.usage.filter((u) => u.limit === limit).filter(measurable)).reduce<{ value: string; threshold: string } | null>((m, u) => (!m || new Decimal(u.value).div(u.threshold).gt(new Decimal(m.value).div(m.threshold)) ? { value: u.value, threshold: u.threshold } : m), null)
  const rows: { key: string; name: string; note: string; shown: string }[] = [
    { key: 'maxLtvBps', name: 'Maximum loan-to-value at withdrawal value', note: "Loan-to-value: the loan divided by the collateral's withdrawal value", shown: formatBps(String(l.maxLtvBps)) },
    { key: 'maxSingleLoanDrops', name: 'Largest single loan', note: 'The largest principal the desk will lend in one loan', shown: `${formatXrp(l.maxSingleLoanDrops)} XRP` },
    { key: 'maxN2LossDrops', name: 'Largest loss if a vault loan defaults', note: 'What the pledged shares could lose if one late loan of the vault defaults', shown: `${formatXrp(l.maxN2LossDrops)} XRP` },
    { key: 'maxLockupDays', name: 'Longest lock-up', note: 'How long the shares may stay locked before redemption', shown: `${l.maxLockupDays} days` },
  ]
  return (
    <Panel provenance="DECLARED" title={`Mandate ${doc.id}`}>
      <p className="t-body-m">{`${doc.desk} · risk officer ${doc.riskOfficer} · issued ${doc.issuedAt}`}</p>
      <div className="table-scroll">
        <table className="op-tbl">
          <thead><tr>{['Limit', 'Mandate', 'Highest position today', 'Used'].map((h) => <th key={h} scope="col" className={h === 'Mandate' || h === 'Highest position today' ? 'num' : undefined}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => {
              const w = worst(r.key)
              return (
                <tr key={r.key}>
                  <td>{r.name}{gloss(r.note)}</td>
                  <td className="t-fig-m num">{r.shown}</td>
                  <td className="t-fig-m num">{w ? limitValue(r.key, w.value) : '—'}</td>
                  <td>{w && <Mini value={w.value} limit={w.threshold} />}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <details className="evidence">
        <summary><span className="t-body-m">Escrow rule and mandate fingerprint</span><span className="dim t-body-s">Details</span></summary>
        <dl className="kv kv-wide">
          <div><dt>Escrow{gloss('Collateral shares sit in escrow for the life of the loan')}</dt><dd className="t-body-m">{`Finish ${doc.policy.escrowFinish}, ${doc.policy.finishAfterMarginSeconds} s after the loan's last due date and grace period; cancellable ${doc.policy.cancelAfterOffsetSeconds} s later.`}</dd></div>
          <div><dt>Mandate fingerprint{gloss('Recomputed by the server; it must match the one anchored on the ledger')}</dt><dd><HashLink hash={doc.hash} noLink /></dd></div>
          <div><dt>Anchored on the ledger by{gloss('The transaction that published the fingerprint')}</dt><dd><HashLink hash={doc.anchorTx} /></dd></div>
        </dl>
      </details>
    </Panel>
  )
}


function TicketTab({ ticket, mark, error, errorMessage, buyTicket, deskPlan, positions, facility, harbor, currency }: {
  ticket: Ticket | null; mark: Mark | null; error: string | null; buyTicket: Ticket | null
  deskPlan?: DeskPlan; positions: Positions | null; facility?: string; harbor: DeskPlanVault | null; currency: LoanCurrency
  /** Step 21: the server's own sentence for a dollar ticket it refused (PRICE_UNAVAILABLE names why). */
  errorMessage?: string | null
}) {
  const [rows, setRows] = useState<ChangeRow[]>([])
  if (deskPlan && !harbor) return <p className="t-body-s">{NOT_A_HARBOR}</p>
  // Without a plan (the smoke of step 9) the share guard does not apply: the props are drawn as given.
  // Step 21: a ticket is drawn only under its own currency, never the XRP figures under a dollar choice.
  const own = ticket && (!harbor || same(ticket.share.mptId, harbor.shareMptId)) && Boolean(ticket.usd) === (currency === 'USD') ? ticket : null
  const ownMark = mark && (!harbor || same(mark.shareMptId, harbor.shareMptId)) ? mark : null
  const choice = deskPlan?.usd ? <CurrencyChoice asset={currency} facility={facility} /> : null
  const said = errorMessage ?? undefined
  if (!own) return error ? <>{choice}<ErrorBlock code={error} message={said} /></> : <>{choice}<Loading /></>
  const loan = deskPlan ? demoLoanFor(positions, deskPlan, facility, currency === 'USD' ? 'USD' : undefined) : null
  return (
    <>
      {error && <ErrorBlock code={error} message={said} />}
      {error ? <p className="read-at t-fig-s">{`Read at ledger ${own.ledgerIndex} — these figures are no longer current.`}</p> : <ReadAt ledger={own.ledgerIndex} at={own.asOf} />}
      <p className="t-body-m parties">{`Lender: ${LENDER_NAME} · Borrower: ${BORROWER_NAME}`}{loan?.borrower && <>{' '}<HashLink hash={loan.borrower} kind="accounts" /></>}</p>
      <TicketView ticket={own} mark={ownMark} harbor={harbor} loan={loan} buyTicket={buyTicket} deskPlan={deskPlan} changeRows={rows} onChange={setRows} choice={choice} />
    </>
  )
}

function DataTab({ tab, data, error, positions, deskPlan, harbor }: {
  tab: DeskTab; data: unknown; error: string | null; positions: Positions | null; deskPlan?: DeskPlan; harbor: DeskPlanVault | null
}) {
  // Positions paints at once from the poll the ticket header already keeps warm.
  const doc = tab.accepts(data) ? data : tab.id === 'positions' && hasArray('positions')(positions) ? positions : null
  const failure = error && (tab.id === 'mandate' && error === 'INTERNAL'
    ? <div role="alert"><p className="t-body-s">The mandate on file does not match its anchored hash.</p><details><summary>Error code</summary><code>{error}</code></details></div>
    : <ErrorBlock code={error} />)
  if (!doc) return failure || <Loading />
  const names = Object.fromEntries((deskPlan?.vaults ?? []).map((v) => [v.vaultId.toUpperCase(), cap(harborName(v.label))]))
  return (
    <>
      {failure}
      <ReadAt ledger={String((doc as { ledgerIndex?: number }).ledgerIndex)} />
      {tab.id === 'positions' && <PositionsTab doc={doc as Positions} deskPlan={deskPlan} harbor={harbor} />}
      {tab.id === 'universe' && <DeskUniverse data={data} error={error} names={names} />}
      {tab.id === 'mandate' && <MandateTab doc={doc as Mandate} positions={positions} />}
      {tab.id === 'feed' && <DeskFeed data={doc as FeedDoc} />}
    </>
  )
}

const TAB_SUBTITLE: Record<string, string> = {
  positions: "The loans the desk has made, the collateral held behind each, and how close each stands to the mandate's limits.",
  mandate: "The risk officer's limits. The desk refuses any loan that breaks one of them.",
  universe: 'The vaults Orma reads, all valued at the same ledger.',
  feed: "Credit events seen on the ledger, with each curator's own statements shown next to what the ledger confirms.",
}

/**
 * `data`: the answer of the current tab's source; `error`: the code of its last failed read.
 * `asset` (step 21): the loan currency `ticket` is in, when the caller read it. Absent (App, which polls only the
 * XRP ticket), the screen takes the currency from `?asset=` and, on USD, reads the dollar ticket itself. The
 * dollar is offered only when the plan carries `usd`; without it the screen is XRP, whatever the address says.
 */
export function DeskScreen({ ticket, mark, tab, data, error = null, buyTicket = null, deskPlan, positions = null, facility, asset }: {
  ticket: Ticket | null; mark: Mark | null; tab: string; data?: unknown; error?: string | null
  buyTicket?: Ticket | null; deskPlan?: DeskPlan; positions?: Positions | null; facility?: string; asset?: LoanCurrency
}) {
  const current = DESK_TABS.find((t) => t.id === tab) ?? DESK_TABS[0]
  const fromUrl = useUrlAsset()
  const currency: LoanCurrency = deskPlan?.usd && (asset ?? fromUrl) === 'USD' ? 'USD' : 'XRP'
  const usdPath = asset === undefined && currency === 'USD' && current.id === 'ticket' ? DESK_TABS[0].source({ deskPlan, facility, asset: 'USD' }) : null
  const usdRead = usePoll<Ticket>(usdPath, 3000)
  const shownTicket = asset === undefined && currency === 'USD' ? usdRead.data : ticket
  const shownError = asset === undefined && currency === 'USD' ? usdRead.code : error
  const shownMessage = asset === undefined && currency === 'USD' && usdRead.code === 'PRICE_UNAVAILABLE' ? usdRead.error : null
  const harbor = deskPlan ? deskTicketPaths(deskPlan, facility).harbor : null
  const label = deskPlan ? harbor?.label ?? null : 'harbor-1'
  const harbors = deskPlan?.vaults.filter((v) => v.label.startsWith('harbor-')) ?? []
  // Another Harbor, same tab: `tab` first, so a tab link and a Harbor link never read alike. A dollar choice rides along.
  const harborHref = (vaultId: string) => '/desk?' + new URLSearchParams({ tab: current.id, facility: vaultId, ...(currency === 'USD' ? { asset: 'USD' } : {}) })
  const go = (href: string) => () => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')) }
  const title = current.id === 'ticket' ? `Collateral report${label ? ` · ${cap(harborName(label))}` : ''}` : current.label
  return (
    <div className="desk-stage">
      <TestNetBanner />
      <header className="desk-head">
        <div>
          <h1 className="t-heading-l">{title}</h1>
          <p className="t-body-m desk-line">{DESK_LINE}</p>
          {TAB_SUBTITLE[current.id] && <p className="t-body-m dim tab-sub">{TAB_SUBTITLE[current.id]}</p>}
        </div>
        {harbors.length > 0 && (current.id === 'ticket' || current.id === 'positions') && (
          <div className="desk-head-right">
            <nav className="harbors" aria-label="Harbor">
              {harbors.map((h) => (
                <a key={h.label} href={harborHref(h.vaultId)} aria-current={harbor?.label === h.label ? 'true' : undefined} onClick={(e) => follow(e, go(harborHref(h.vaultId)))}>{cap(harborName(h.label))}</a>
              ))}
            </nav>
          </div>
        )}
      </header>
      <TabBar current={current.id} facility={facility} asset={currency} />
      <div id="desk-body" className="desk-body">
        {current.id === 'ticket'
          ? <TicketTab ticket={shownTicket} mark={mark} error={shownError} errorMessage={shownMessage} buyTicket={buyTicket} deskPlan={deskPlan} positions={positions} facility={facility} harbor={harbor} currency={currency} />
          : <DataTab tab={current} data={data} error={error} positions={positions} deskPlan={deskPlan} harbor={harbor} />}
      </div>
    </div>
  )
}

// --- the operator panel ------------------------------------------------------------------------------

export interface ActionCtx {
  harbor: string; lending: 'desk' | 'spare'; ticket: Ticket | null; buyTicket: Ticket | null
  pledgeActionId: string | null; requestActionId: string | null
  /** Step 21: the loan's currency; USD puts `asset: 'USD'` on requestLoan, lent by the vault desk only. */
  asset?: LoanCurrency
}
export interface OperatorAction { role: string; action: string; verb: string; body: (ctx: ActionCtx) => object | null }

const pledgeBody = (c: ActionCtx) => c.ticket && ({ vault: c.lending, share: c.ticket.share.mptId, ticketId: c.ticket.ticketId, inputsDigest: c.ticket.inputsDigest, units: c.ticket.share.units })
const onHarbor = (c: ActionCtx) => ({ vault: c.harbor })
const onRequest = (c: ActionCtx) => ({ vault: c.lending, requestActionId: c.requestActionId })

/** One line per action of the allow-list, in this order, each with its exact verb. */
export const OPERATOR_ACTIONS: OperatorAction[] = [
  { role: 'holder', action: 'simulateWithdraw', verb: 'Simulate withdrawal — nothing is sent', body: onHarbor },
  { role: 'borrower', action: 'pledgeEscrow', verb: 'Pledge shares into escrow', body: pledgeBody },
  { role: 'borrower', action: 'requestLoan', verb: 'Sign and request loan', body: (c) => c.ticket && { ...pledgeBody(c), pledgeActionId: c.pledgeActionId, ...(c.asset === 'USD' ? { asset: 'USD' } : {}) } },
  { role: 'riskOfficer', action: 'approve', verb: 'Approve and countersign loan', body: onRequest },
  { role: 'riskOfficer', action: 'decline', verb: 'Decline loan request', body: onRequest },
  { role: 'riskOfficer', action: 'rerequest', verb: 'Re-request with a fresh ticket', body: onRequest },
  { role: 'broker', action: 'impairL1', verb: 'Impair loan L1', body: onHarbor },
  { role: 'broker', action: 'wait', verb: 'Wait — do not impair L1', body: onHarbor },
  { role: 'broker', action: 'defaultL2', verb: 'Default loan L2 — irreversible', body: onHarbor },
  { role: 'buyer', action: 'authorize', verb: 'Authorize share holding', body: (c) => c.buyTicket && { vault: 'spare', share: c.buyTicket.share.mptId } },
  { role: 'buyer', action: 'settle', verb: 'Settle OTC purchase — two legs, not atomic', body: (c) => c.buyTicket && { vault: 'spare', share: c.buyTicket.share.mptId, ticketId: c.buyTicket.ticketId, inputsDigest: c.buyTicket.inputsDigest, units: c.buyTicket.share.units } },
]

/** The session after a pledge validated or a loan was requested: pure, the panel writes it to sessionStorage too. */
export function rememberOperator(session: OperatorSession, patch: { pledgeActionId: string } | { requestActionId: string }): OperatorSession {
  return { ...session, ...patch }
}

interface RoleAction { actionId: string; state: string; engineResult?: string; txHash?: string; preview?: ActionPreview | null }
type Phase = 'idle' | 'previewing' | 'previewed' | 'confirming' | 'validated' | 'failed' | 'refused' | 'pending-approval' | 'done'
export interface RowState { phase: Phase; actionId?: string; preview?: ActionPreview; action?: RoleAction; error?: ActionError }

const money = (p?: ActionPreview | null) => (p?.money ?? {}) as Record<string, unknown>
const text = (v: unknown) => (v === undefined || v === null ? '—' : String(v))
const xrp = (v: unknown) => `${dropsToXrp(text(v))} XRP`
/** Basis points from a preview, a dash when the server sent none: formatBps would throw on it. */
const bps = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && SECONDS.test(v)) ? formatBps(String(v)) : '—')

/** The dollar lines of a USD approve preview (step 21): the same reads as XRP, each amount in dollars with its label. */
function usdApproveLines(m: Record<string, unknown>): ReactNode[] {
  const ref = m.reference as UsdReference | undefined
  const breaches = (Array.isArray(m.breaches) ? m.breaches : []) as { limit: string; value: string; threshold: string }[]
  const lines: ReactNode[] = [
    `Principal: ${dollars(m.principalUsd)}`,
    `Collateral at withdrawal value: ${xrp(m.collateralHeldDrops)}, worth ${dollars(m.collateralHeldUsd)} at the reference price less the haircut`,
    `LTV at withdrawal value, in dollars: ${bps(m.ltvHeldBps)} against a limit of ${bps(m.maxLtvBps)}`,
    <>Verdict: <Verdict status={statusOf(m.verdict)} /></>,
    ...breaches.map((b) => `${LIMIT_LABEL[b.limit] ?? b.limit}: ${limitValue(b.limit, b.value)} of ${limitValue(b.limit, b.threshold)}, over the limit.`),
    <>{`Lender at 1:1, in dollars: ${bps(m.ltv1to1Bps)}`} <Verdict status={statusOf(m.verdict1to1)} /></>,
  ]
  if (ref) {
    lines.push(`Reference price (${text(ref.provenance)}): ${referenceLine(ref)}`)
  }
  lines.push(typeof m.collateralRule === 'string' ? m.collateralRule : USD_COLLATERAL_RULE)
  return lines
}

/** The money of a preview, before the button: what the action will cost or move, in the desk's words. */
function MoneyPreview({ action, preview, units }: { action: string; preview: ActionPreview; units: string }) {
  const m = money(preview)
  if (typeof m.error === 'string') return <p className="caption">{`The money of this action could not be computed: ${m.error}`}</p>
  const lines: ReactNode[] = []
  if (action === 'requestLoan' && m.asset === 'USD') {
    // step 21: a loan in the test dollar, its principal in dollars
    lines.push(text(preview.engineResult), `Principal: ${dollars(m.principalUsd)}`, `Escrow: ${text(m.escrowIndex)}`, `Valid until ledger ${text(m.lastLedgerSequence)}`)
  } else if (action === 'requestLoan') {
    lines.push(text(preview.engineResult), `Principal: ${xrp(m.principalDrops)}`, `Escrow: ${text(m.escrowIndex)}`, `Valid until ledger ${text(m.lastLedgerSequence)}`)
  } else if (action === 'approve' && m.asset === 'USD') {
    const col = m.collateral as { conforming?: boolean; reasons?: string[] } | undefined
    lines.push(...usdApproveLines(m))
    if (col && col.conforming === false) lines.push(`Collateral refused: ${(col.reasons ?? []).join('; ')}`)
  } else if (action === 'approve') {
    const col = m.collateral as { conforming?: boolean; reasons?: string[] } | undefined
    lines.push(
      `Principal: ${xrp(m.principalDrops)}`,
      `Collateral at withdrawal value: ${xrp(m.collateralHeldDrops)}`,
      `LTV at withdrawal value: ${formatBps(text(m.ltvHeldBps))} against a limit of ${formatBps(text(m.maxLtvBps))}`,
      <>Verdict: <Verdict status={statusOf(m.verdict)} /></>,
      <>{`Lender at 1:1: ${formatBps(text(m.ltv1to1Bps))}`} <Verdict status={statusOf(m.verdict1to1)} /></>,
    )
    if (col && col.conforming === false) lines.push(`Collateral refused: ${(col.reasons ?? []).join('; ')}`)
  } else if (action === 'defaultL2' && m.heldPerUnitNow !== undefined) {
    lines.push(
      `Withdrawal value per share now: ${text(m.heldPerUnitNow)} drops`,
      `Withdrawal value per share if L2 defaults: ${text(m.heldPerUnitIfDefault)} drops`,
      `${text(m.lossAfterCover)} drops: loss on the ${units} pledged shares, after cover`,
      `${text(m.cover)} drops: vault cover drawn`,
    )
  } else if (m.reserveDrops !== undefined) {
    lines.push(`${text(preview.engineResult)}: the desk creates the collateral account and pays its ${xrp(m.reserveDrops)} reserve.`)
  } else {
    lines.push(`Simulated result: ${text(preview.engineResult)}`)
  }
  return (
    <div>
      <p className="caption">{`Preview · ${text(preview.provenance)}`}</p>
      {lines.map((l, i) => <p key={i} className="caption">{l}</p>)}
    </div>
  )
}

type Remember = (patch: { pledgeActionId: string } | { requestActionId: string }) => void

/**
 * The life of one role action, shared by the operator rows and the cure of a margin call: preview, confirm,
 * then the state read back from GET …/actions/{id}. `makeBody` may fetch (the cure reads its ticket first);
 * a body of null is a document not read yet.
 */
function useActionFlow({ role, action, session, remember, onChange, initial }: {
  role: string; action: string; session: OperatorSession; remember?: Remember; onChange?: (rows: ChangeRow[]) => void; initial?: RowState
}) {
  const [row, setRow] = useState<RowState>(initial ?? { phase: 'idle' })
  const result = useRef<HTMLDivElement>(null)
  const watch = row.phase === 'confirming' && row.actionId && session.runId ? `/api/roles/${session.runId}/actions/${row.actionId}` : null
  const poll = usePoll<RoleAction>(watch, 2000)

  // The row moves past `confirming` only on what GET …/actions/{id} reads back, never on the 202.
  useEffect(() => {
    const a = poll.data
    if (!a || a.actionId !== row.actionId || row.phase !== 'confirming') return
    if (a.state === 'validated' && !(action === 'defaultL2' && !money(a.preview).realised)) {
      if (action === 'pledgeEscrow') remember?.({ pledgeActionId: a.actionId })
      setRow((r) => ({ ...r, phase: 'validated', action: a }))
    } else if (a.state === 'failed' || a.state === 'pending-approval') {
      setRow((r) => ({ ...r, phase: a.state as Phase, action: a }))
    } else {
      setRow((r) => ({ ...r, action: a }))
    }
  }, [poll.data, row.actionId, row.phase, action, remember])

  // After a preview and after a refusal the reader is taken to the row's result, never left on BODY.
  useEffect(() => {
    if (row.phase === 'previewed' || row.phase === 'refused') result.current?.focus()
  }, [row.phase])

  async function preview(makeBody: () => object | null | Promise<object>) {
    const { runId, token } = session
    if (!runId || !token) return setRow({ phase: 'refused', error: { code: 'UNAUTHORIZED' } })
    const made = makeBody()
    if (!made) return setRow({ phase: 'refused', error: { code: 'WARMING_UP' } })
    setRow({ phase: 'previewing' })
    let body: object
    try {
      body = await made
    } catch (e: unknown) {
      // Only the cure fetches before it posts: its ticket read failed, and nothing was sent.
      return setRow({ phase: 'refused', error: { code: e instanceof ApiFailure && e.code ? e.code : 'UNREACHABLE' } })
    }
    const a = await postAction(action, role, runId, token, body)
    const err = a.body.error
    if (a.status === 202 && a.body.actionId && a.body.preview) {
      if (action === 'requestLoan') remember?.({ requestActionId: a.body.actionId })
      if (a.body.preview.schema === 'orma.change/1') onChange?.(a.body.preview.rows ?? [])
      return setRow({ phase: 'previewed', actionId: a.body.actionId, preview: a.body.preview })
    }
    if (action === 'requestLoan' && err?.code === 'ESCROW_POLICY' && err.requestActionId) remember?.({ requestActionId: err.requestActionId })
    setRow({ phase: 'refused', error: err ?? { code: 'UNREACHABLE' } })
  }

  async function confirm() {
    if (!session.runId || !session.token || !row.actionId) return
    setRow((r) => ({ ...r, phase: 'confirming' }))
    const a = await confirmAction(session.runId, session.token, row.actionId)
    const state = a.body.state
    if (a.status !== 202) return setRow((r) => ({ ...r, phase: 'refused', error: a.body.error ?? { code: 'UNREACHABLE' } }))
    if (state === 'pending-approval') return setRow((r) => ({ ...r, phase: 'pending-approval' }))
    // A preview-only action (simulateWithdraw, wait) has nothing to submit: its confirm ends there.
    if (state === 'previewed') return setRow((r) => ({ ...r, phase: 'done' }))
    if (state === 'refused') return setRow((r) => ({ ...r, phase: 'refused', error: a.body.error ?? { code: 'BREACHED' } }))
  }

  return { row, result, preview, confirm }
}

/** The result region of an action: its money preview, then what the ledger did with it, in the action's own verb. */
function ActionStatus({ action, verb, row, units, focus }: { action: string; verb: string; row: RowState; units: string; focus: RefObject<HTMLDivElement | null> }) {
  const realised = money(row.action?.preview ?? row.preview).realised as { predicted?: string; realised?: string; verdict?: string; error?: string } | undefined
  return (
    <div role="status" tabIndex={-1} ref={focus}>
      {row.preview && <MoneyPreview action={action} preview={row.preview} units={units} />}
      {row.phase === 'confirming' && (
        <p className="caption">{row.action?.state === 'validated' ? 'Realising… reading the vault at the validation ledger' : 'Submitting to the ledger…'}</p>
      )}
      {row.phase === 'validated' && (
        <div>
          {action === 'defaultL2' && realised && (realised.error
            ? <p className="caption">{`The realised value could not be read: ${realised.error}`}</p>
            : <>
                <p className="caption">{`Predicted: ${text(realised.predicted)} drops per share`}</p>
                <p className="caption">{`Realised: ${text(realised.realised)} drops per share`}</p>
                <p><Verdict status={statusOf(realised.verdict)} /></p>
              </>)}
          <p className="caption">{`${verb} — validated on the ledger${row.action?.txHash ? `, transaction ${row.action.txHash}` : ''}.`}</p>
          <p className="caption"><code>{row.actionId}</code></p>
        </div>
      )}
      {row.phase === 'pending-approval' && (
        <p className="caption">{`Signed by the borrower; awaiting the desk's countersignature · `}<code>{row.actionId}</code></p>
      )}
      {row.phase === 'done' && <p className="caption">Recorded as a preview only: this action builds no transaction to submit.</p>}
      {row.phase === 'failed' && <p role="alert" className="caption">{`The ledger did not apply it: ${text(row.action?.engineResult)}.`}</p>}
      {row.phase === 'refused' && row.error && <ErrorBlock code={row.error.code} message={action === 'requestLoan' && row.error.requestActionId ? row.error.message : undefined} />}
    </div>
  )
}

function ActionRow({ entry, ctx, session, remember, onChange, units, initial }: {
  entry: OperatorAction; ctx: ActionCtx; session: OperatorSession; units: string
  remember: Remember; onChange?: (rows: ChangeRow[]) => void; initial?: RowState
}) {
  const { row, result, preview, confirm } = useActionFlow({ role: entry.role, action: entry.action, session, remember, onChange, initial })
  return (
    <div style={{ borderTop: '1px solid var(--color-line)', paddingBlock: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <p className="caption"><b>{entry.role}</b>{` · ${entry.action}`}</p>
      <div>
        <button type="button" className="btn btn-secondary" onClick={() => preview(() => entry.body(ctx))} disabled={row.phase === 'previewing'}>
          {row.phase === 'previewing' ? 'Previewing…' : 'Preview'}
        </button>
      </div>
      <ActionStatus action={entry.action} verb={entry.verb} row={row} units={units} focus={result} />
      {row.phase === 'previewed' && (
        <div><button type="button" className="btn btn-primary" onClick={confirm}>{entry.verb}</button></div>
      )}
    </div>
  )
}

/**
 * The operator's run: read from sessionStorage, adopted once from the operator link's fragment (then wiped from
 * the address bar), and the memory of a validated pledge or a requested loan. One per screen: the ticket's
 * operator panel, or the Positions tab for the cure of a margin call.
 */
function useOperatorSession(): [OperatorSession, Remember] {
  const [session, setSession] = useState<OperatorSession>(readOperatorSession)
  useEffect(() => {
    const s = sessionFromFragment(location.hash)
    if (!s) return
    writeOperatorSession(s)
    setSession(s)
    history.replaceState(null, '', location.pathname + location.search)
  }, [])
  const remember = useCallback((patch: { pledgeActionId: string } | { requestActionId: string }) => {
    setSession((s) => {
      const next = rememberOperator(s, patch)
      writeOperatorSession(next)
      return next
    })
  }, [])
  return [session, remember]
}

function OperatorPanel({ ticket, buyTicket, harbor, units, onChange, asset = 'XRP' }: {
  ticket: Ticket; buyTicket: Ticket | null; harbor: DeskPlanVault | null; units: string; onChange: (rows: ChangeRow[]) => void; asset?: LoanCurrency
}) {
  // The operator link carries the run in its fragment once; the screen adopts it and wipes it from the address bar.
  const [session, remember] = useOperatorSession()
  const [picked, setLending] = useState<'desk' | 'spare'>('desk')
  // Step 21: the test dollar is lent by the vault desk only, so a USD request is never played from spare.
  const lending = asset === 'USD' ? 'desk' : picked
  const label = harbor?.label ?? 'harbor-1'
  const ctx: ActionCtx = {
    harbor: label, lending, ticket, buyTicket, pledgeActionId: session.pledgeActionId, requestActionId: session.requestActionId,
    ...(asset === 'USD' ? { asset } : {}),
  }
  const line = (e: OperatorAction) => <ActionRow key={e.action} entry={e} ctx={ctx} session={session} remember={remember} onChange={onChange} units={units} />
  const notPlayed = (e: OperatorAction) => harbor?.impairL1Tx && (e.action === 'impairL1' || e.action === 'wait')
  return (
    <section style={{ borderTop: '1px solid var(--color-line)', paddingTop: 'var(--space-4)' }} aria-label="Operator controls (demo)">
      <h2 className="exh-title">Operator controls (demo)</h2>
      <p className="caption">{`${harborName(label)} · lending from `}
        <select aria-label="Lending vault" value={lending} disabled={asset === 'USD'} onChange={(e) => setLending(e.target.value === 'spare' ? 'spare' : 'desk')}>
          <option value="desk">desk</option>
          <option value="spare">spare</option>
        </select>
      </p>
      {asset === 'USD' && <p className="caption">{`Loan in USD (${USD_LABEL}): lent from the desk vault only; the request carries asset USD.`}</p>}
      {OPERATOR_ACTIONS.filter((e) => !notPlayed(e)).map(line)}
      {OPERATOR_ACTIONS.some(notPlayed) && (
        <details>
          <summary>not played: L1 already impaired (see header)</summary>
          {OPERATOR_ACTIONS.filter(notPlayed).map(line)}
        </details>
      )}
    </section>
  )
}

// --- the margin call (step 20, addendum A11) ---------------------------------------------------------
// A desk decision, DECLARED: the desk issues the call and the desk may act. Orma is never its subject.

const CURE_VERB = 'Pledge more shares'
const cureConfirmVerb = (units: string) => `Confirm: pledge ${units} more shares into escrow`
const NEEDS_RUN = 'The operator controls need a run: open the operator link of the run to pledge from this page.'
const NOT_A_LENDER = 'This loan is not lent from the desk or spare vault, so no pledge can be played from this page.'
const EXPIRED_LINE = 'The cure window has passed. The desk may act under its escrow policy, which finishes an escrow only after a default.'

/** HH:MM:SS of an ISO time in UTC; the string itself when it does not parse. */
function utcClock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19)
}

/** A duration as HH:MM:SS, never below zero. A time, not an amount. */
function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

function marginCallSentence(call: MarginCall): string {
  const held = call.ltvHeldBps === null ? '—' : formatBps(String(call.ltvHeldBps))
  // step 21: on a loan in the test dollar the LTV is the loan over the collateral's dollar value
  return `Margin call issued by ${LENDER_NAME} at ledger ${call.issuedLedger ?? '—'}: LTV at withdrawal value${call.currency === 'USD' ? ', in dollars,' : ''} ${held} against the mandate's ${formatBps(String(call.maxLtvBps))}. `
    + `Cure by ${utcClock(call.cureBy)} UTC: pledge ${call.shortfall?.sharesToAdd ?? '—'} more shares, or the desk may act under its escrow policy.`
}

/** Step 21: what a dollar call's cure must add, in drops of withdrawal value and in dollars beside them. */
const usdShortfallLine = (s: NonNullable<MarginCall['shortfall']>) =>
  `Shortfall: ${xrp(s.collateralValueDrops)} of withdrawal value, worth ${dollars(s.collateralValueUsd)} at the reference price less the haircut.`

/** The time left to cure, from the client clock every second; the first render computes it once. */
function CureCountdown({ cureBy }: { cureBy: string }) {
  const end = new Date(cureBy).getTime()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (Number.isNaN(end)) return null
  return (
    <p className="t-body-m">
      <span className="t-label-m">Time left to cure </span>
      <span className="t-fig-m" role="timer" aria-live="off">{hms(end - now)}</span>
      {end <= now && <span className="t-body-s dim"> · the desk records the expiry at the next ledger close</span>}
    </p>
  )
}

/**
 * The cure: the operator's pledgeEscrow, played for the shortfall's units of the position's own share, from the
 * loan's lending vault, with `cureLoanId` so the escrow names the loan it cures. A ticket for those units first,
 * then the preview and its money, then the confirm: the flow of the operator panel's rows.
 */
function CureAction({ position, call, deskPlan, session, primary, initial }: {
  position: Position; call: MarginCall; deskPlan?: DeskPlan; session: OperatorSession; primary: boolean; initial?: RowState
}) {
  const { row, result, preview, confirm } = useActionFlow({ role: 'borrower', action: 'pledgeEscrow', session, initial })
  const units = call.shortfall?.sharesToAdd ?? null
  const share = position.collateral[0]?.shareMptId ?? null
  const lending = deskPlan ? lendingVaultOf(deskPlan, position.vaultId) : null
  if (!units || !share) return null
  const facility = deskPlan?.vaults.find((v) => same(v.shareMptId, share))
  const blocked = !session.runId || !session.token ? NEEDS_RUN : !lending ? NOT_A_LENDER : null
  const cls = primary ? 'btn btn-primary' : 'btn btn-secondary'
  const start = () => preview(() => {
    if (!lending) return null
    const vault = lending
    return getJson<Ticket>(cureTicketPath(share, units)).then((t) => cureBody({ lending: vault, share, ticketId: t.ticketId, inputsDigest: t.inputsDigest, units, loanId: call.loanId }))
  })
  return (
    <div style={{ borderTop: '1px solid var(--color-line)', paddingTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <p className="caption">{`Pledges ${units} more shares of ${facility ? cap(harborName(facility.label)) : 'the pledged vault'} into escrow for loan ${call.loanId.slice(0, 8)}, from the ${lending ?? 'unknown'} lending vault. The escrow names the loan it cures.`}</p>
      <ActionStatus action="pledgeEscrow" verb={CURE_VERB} row={row} units={units} focus={result} />
      {row.phase === 'validated' && <p className="caption">The desk re-reads the loan at the next ledger: the call is cured once the LTV at withdrawal value is back within the mandate&apos;s limit.</p>}
      {row.phase === 'previewed'
        ? <div><button type="button" className={cls} onClick={confirm}>{cureConfirmVerb(units)}</button></div>
        : row.phase !== 'confirming' && row.phase !== 'validated' && (
          <div><button type="button" className={cls} disabled={blocked !== null || row.phase === 'previewing'} onClick={start}>{row.phase === 'previewing' ? 'Previewing…' : CURE_VERB}</button></div>
        )}
      {blocked && <p className="t-body-s">{blocked}</p>}
    </div>
  )
}

function MarginCallBanner({ position, call, deskPlan, session, primary, initial }: {
  position: Position; call: MarginCall; deskPlan?: DeskPlan; session: OperatorSession; primary: boolean; initial?: RowState
}) {
  return (
    <Panel provenance="DECLARED" title={`Margin call on loan ${call.loanId.slice(0, 8)}`} source={LENDER_NAME}>
      <p className="t-body-m"><strong>{marginCallSentence(call)}</strong></p>
      {call.currency === 'USD' && call.shortfall && <p className="t-body-m">{usdShortfallLine(call.shortfall)}</p>}
      {call.status === 'EXPIRED' && <p className="t-body-m">{EXPIRED_LINE}</p>}
      {call.status === 'ISSUED' && call.cureBy && <CureCountdown cureBy={call.cureBy} />}
      {call.reasons.length > 0 && <ul className="t-body-s">{call.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {(call.entryHash || call.triggerTx) && (
        <dl className="kv">
          {call.entryHash && (
            <div><dt>Decision-log entry</dt><dd><HashLink hash={call.entryHash} noLink />{' '}<a className="lnk" href={`${API_BASE}/api/desk/decisions`} target="_blank" rel="noreferrer noopener">Decision log</a></dd></div>
          )}
          {call.triggerTx && <div><dt>Impairment or default on the pledged vault</dt><dd><HashLink hash={call.triggerTx} /></dd></div>}
        </dl>
      )}
      {call.status === 'ISSUED' && <CureAction position={position} call={call} deskPlan={deskPlan} session={session} primary={primary} initial={initial} />}
    </Panel>
  )
}

/** Under a position's row: the banner of an open call (ISSUED or EXPIRED), one line for a cured call, nothing otherwise. */
function MarginCallRow({ position, call, deskPlan, session, primary }: {
  position: Position; call: MarginCall; deskPlan?: DeskPlan; session: OperatorSession; primary: boolean
}) {
  if (call.status !== 'ISSUED' && call.status !== 'EXPIRED' && call.status !== 'CURED') return null
  return (
    <tr>
      <td colSpan={4}>
        {call.status === 'CURED'
          ? (
            <p className="t-body-s">
              <span className="prov" data-prov="DECLARED">DECLARED</span>
              {` Margin call cured at ledger ${call.ledgerIndex}: LTV at withdrawal value${call.currency === 'USD' ? ', in dollars,' : ''} back within the mandate's limit.`}
              {call.entryHash && <>{' '}<HashLink hash={call.entryHash} noLink /></>}
            </p>
          )
          : <MarginCallBanner position={position} call={call} deskPlan={deskPlan} session={session} primary={primary} />}
      </td>
    </tr>
  )
}

// --- smoke cases -------------------------------------------------------------------------------------

const FIX_L = 6390000
const FIX_HASH = 'AB'.repeat(32)
const fix = (formulaId: FigureDoc['formulaId'], unit: FigureDoc['unit'], value: string): FigureDoc => ({ value, unit, meaning: 'fixture', formula: 'fixture', formulaId, inputs: [], provenance: 'MODELLED' })
const FIX_TICKET: Ticket = {
  schema: 'orma.ticket/1', ticketId: 'E'.repeat(64), inputsDigest: 'F'.repeat(64), asOf: '2026-10-25T12:00:00Z', ledgerIndex: FIX_L, ledgerHash: FIX_HASH,
  op: 'pledge', share: { mptId: '11'.repeat(24), vaultId: '22'.repeat(32), units: '5000000', shareScale: 0 },
  mandate: { id: 'desk-1', hash: 'C'.repeat(64), anchorTx: 'D'.repeat(64) },
  figures: {
    heldValue: fix('heldValue', 'drops', '4000000'), naiveValue: fix('naiveValue', 'drops', '5000000'), n1Overpayment: fix('n1Overpayment', 'drops', '1000000'), n2: [],
    n3: { lockedUntil: fix('lockedUntil', 'seconds', '1415248'), redemptionAt: '2026-11-10T00:00:00Z', cashAvailable: fix('cashAvailable', 'drops', '35000000'), claim: fix('claim', 'drops', '4000000') },
    maxLoan: fix('maxLoan', 'drops', '2137600'), requested: fix('requested', 'drops', '2600000'), ltvHeld: fix('ltvHeld', 'bps', '6500'), lender1to1: fix('lender1to1', 'bps', '5200'),
  },
  conduct: { recognitionLagSeconds: [], defaultsWithoutImpairment: 0, coverOrderCostDrops: '0' },
  escrowPolicy: { finishAfter: '0', cancelAfter: '0', text: 'fixture' },
  statement: null,
  verdict: { status: 'BREACHED', breaches: [{ limit: 'maxLtvBps', value: '6500', threshold: '5344' }] },
  verdict1to1: { status: 'PASS', breaches: [] },
}
const FIX_SESSION: OperatorSession = { runId: 'r1', token: 't0', pledgeActionId: null, requestActionId: null }
const FIX_CTX: ActionCtx = { harbor: 'harbor-1', lending: 'desk', ticket: FIX_TICKET, buyTicket: FIX_TICKET, pledgeActionId: 'p1', requestActionId: 'q1' }
const FIX_ACTION = 'A1'.repeat(16)
const APPROVE_MONEY = {
  principalDrops: '2600000', collateralHeldDrops: '4000000', ltvHeldBps: 6500, maxLtvBps: 5344, verdict: { status: 'BREACHED' }, breaches: [],
  ltv1to1Bps: 5200, verdict1to1: { status: 'PASS' }, escrow: 'ok', collateral: { address: 'rCollateral', conforming: true, reasons: [] }, digest: 'same', sequence: 'ok',
}
const DEFAULT_MONEY = { heldPerUnitNow: '0.800000', heldPerUnitIfDefault: '0.703000', lossAfterCover: '485000', cover: '150000' }
const PREVIEWS: Record<string, ActionPreview> = {
  simulateWithdraw: { engineResult: 'tecTOO_SOON', provenance: 'SIMULATED' },
  pledgeEscrow: { engineResult: 'tesSUCCESS', provenance: 'SIMULATED' },
  requestLoan: { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED', money: { principalDrops: '2000000', escrowIndex: 'E5'.repeat(32), lastLedgerSequence: FIX_L + 600 } },
  approve: { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED', money: APPROVE_MONEY },
  decline: { engineResult: 'not-simulated (no transaction)', provenance: 'DECLARED' },
  rerequest: { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED' },
  impairL1: { engineResult: 'tecNO_PERMISSION', provenance: 'SIMULATED' },
  wait: { engineResult: 'not-simulated (no transaction)', provenance: 'DECLARED' },
  defaultL2: { engineResult: 'tesSUCCESS', provenance: 'SIMULATED', money: DEFAULT_MONEY },
  authorize: { engineResult: 'tesSUCCESS', provenance: 'SIMULATED' },
  settle: { engineResult: 'tesSUCCESS', provenance: 'SIMULATED' },
}
const entryOf = (action: string) => OPERATOR_ACTIONS.find((e) => e.action === action) as OperatorAction
const row = (action: string, initial: RowState) => (
  <ActionRow entry={entryOf(action)} ctx={FIX_CTX} session={FIX_SESSION} remember={() => {}} units="5000000" initial={initial} />
)
const previewed = (action: string, preview = PREVIEWS[action]) => row(action, { phase: 'previewed', actionId: FIX_ACTION, preview })
const FIX_MARK: Mark = {
  schema: 'orma.mark/1', shareMptId: '11'.repeat(24), verdict: 'agree', tolerance: '0', ledgerIndex: FIX_L, ledgerHash: FIX_HASH, node: 'fixture',
  steps: [
    { step: 'read MPTokenIssuance', ok: true, detail: 'fixture' }, { step: 'oracle cross-check', ok: true, detail: 'oracle pending: last publish precedes this ledger' },
  ],
}
const ERROR_CODES = ['STALE', 'BREACHED', 'ESCROW_POLICY', 'LOCKED', 'NOT_CONFIGURED', 'UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST', 'NOT_FOUND', 'SEQUENCE_PASSED', 'INCONSISTENT_SNAPSHOT', 'SUBMIT_UNCONFIRMED', 'WARMING_UP', 'BUSY']
const PREVIEW_TEXT: Record<string, string> = {
  simulateWithdraw: 'Simulated result: tecTOO_SOON', pledgeEscrow: 'Simulated result: tesSUCCESS', requestLoan: 'not-simulated (awaiting countersignature)',
  approve: 'BREACHED', decline: 'Simulated result: not-simulated (no transaction)', rerequest: 'Simulated result: not-simulated (awaiting countersignature)',
  impairL1: 'Simulated result: tecNO_PERMISSION', wait: 'Simulated result: not-simulated (no transaction)', defaultL2: 'Withdrawal value per share now:',
  authorize: 'Simulated result: tesSUCCESS', settle: 'Simulated result: tesSUCCESS',
}

// Step 20: one desk loan of 2 XRP against Harbor-1 shares, lent from the desk vault, under each status of its call.
const FIX_SHARE = '11'.repeat(24)
const FIX_DESK_VAULT = '33'.repeat(32)
const FIX_LOAN = 'C1'.repeat(32)
const FIX_ENTRY = 'E1'.repeat(32)
const FIX_TRIGGER = 'D2'.repeat(32)
const planVault = (label: string, vaultId: string, shareMptId: string): DeskPlanVault => ({ label, vaultId, shareMptId, loanBrokerId: '44'.repeat(32), impairL1Tx: null, impairL1Hidden: null, statementTx: null })
const FIX_PLAN: DeskPlan = {
  plannedLoan: { units: '5000000', principalDrops: '2000000', paymentInterval: 600, gracePeriod: 60 },
  plannedBuy: { share: '99'.repeat(24), units: '1000' },
  vaults: [planVault('harbor-1', '22'.repeat(32), FIX_SHARE), planVault('desk', FIX_DESK_VAULT, '77'.repeat(24)), planVault('spare', '66'.repeat(32), '88'.repeat(24))],
}
const FIX_ACCOUNT: CollateralAccount = {
  address: 'rCollateralOfTheFixture', signers: { borrower: 'rB', desk: 'rD', agent: 'rA' }, quorum: 2, masterDisabled: true, regularKey: null, depositAuth: true,
  mptAuthorized: true, sharesHeld: '5000000', escrowCount: 1, ownerCount: 1, conforming: true, reasons: [], provenance: 'REAL', ledgerIndex: FIX_L, ledgerHash: FIX_HASH,
}
const FIX_REASONS = [
  "The mandate's limit is an LTV at withdrawal value of 53.44%.",
  'LTV at withdrawal value 55.56% against the limit of 53.44%.',
  'Withdrawal value per share moved from 0.800000 to 0.720000 drops after the default of loan L2.',
]
const FIX_CALL: MarginCall = {
  status: 'ISSUED', loanId: FIX_LOAN, issuedLedger: FIX_L - 20, issuedAt: '2026-10-25T18:00:00Z', cureBy: '2026-10-25T18:10:00Z', ltvHeldBps: 5556, maxLtvBps: 5344,
  shortfall: { collateralValueDrops: '142515', sharesToAdd: '197938', withdrawalValuePerShare: '0.720000' }, reasons: FIX_REASONS,
  provenance: 'DECLARED', ledgerIndex: FIX_L, ledgerHash: FIX_HASH, entryHash: FIX_ENTRY, triggerTx: FIX_TRIGGER,
}
const FIX_EXPIRED: MarginCall = { ...FIX_CALL, status: 'EXPIRED', ledgerIndex: FIX_L + 200 }
const FIX_CURED: MarginCall = { ...FIX_CALL, status: 'CURED', shortfall: null, ltvHeldBps: 5100, reasons: ['LTV at withdrawal value 51.00% against the limit of 53.44%.'], triggerTx: undefined }
const FIX_NONE: MarginCall = { ...FIX_CALL, status: 'NONE', issuedLedger: null, issuedAt: null, cureBy: null, shortfall: null, reasons: [], entryHash: undefined, triggerTx: undefined }
const positionWith = (marginCall: MarginCall, loanId = FIX_LOAN): Position => ({
  loanId, loanSetTxHash: 'B3'.repeat(32), vaultId: FIX_DESK_VAULT, borrower: 'rBorrowerOfTheFixture', principalOutstanding: '2000000',
  collateral: [{ escrowId: 'A4'.repeat(32), shareMptId: FIX_SHARE, units: '5000000', account: FIX_ACCOUNT }], collateralHeldDrops: '3600000', ltvHeldBps: 5556,
  usage: [{ limit: 'maxLtvBps', value: '5556', threshold: '5344' }], marginCall: { ...marginCall, loanId },
})
const positionsTab = (...positions: Position[]) => <DeskScreen ticket={null} mark={null} tab="positions" data={{ ledgerIndex: FIX_L, ledgerHash: FIX_HASH, positions }} deskPlan={FIX_PLAN} />
const banner = (session: OperatorSession, initial?: RowState) => <MarginCallBanner position={positionWith(FIX_CALL)} call={FIX_CALL} deskPlan={FIX_PLAN} session={session} primary initial={initial} />
// Written out, not built by marginCallSentence: the case fails if the sentence drifts from the addendum.
const ISSUED_LINE = "Margin call issued by Harbor Credit Desk (fictional) at ledger 6389980: LTV at withdrawal value 55.56% against the mandate's 53.44%. Cure by 18:10:00 UTC: pledge 197938 more shares, or the desk may act under its escrow policy."
const CURE_MONEY = 'Pledges 197938 more shares of Harbor-1 into escrow for loan C1C1C1C1, from the desk lending vault.'
const NEVER_SAID = ['iquidat', 'eize', 'Orma decide', 'Orma issue']
const marginEvent = (type: FeedEvent['type'], n: number, why: string, entryHash: string): FeedEvent => ({
  id: `${String(FIX_L + n).padStart(19, '0')}-0`, type, provenance: 'DECLARED', vaultId: FIX_DESK_VAULT, loanId: FIX_LOAN, ledgerIndex: FIX_L + n, ledgerHash: FIX_HASH,
  why, moneyEffect: null, receipts: [], entryHash,
})
const MARGIN_WHYS = [
  "Harbor Credit Desk (fictional) issued a margin call on loan C1C1C1C1: LTV at withdrawal value 55.56% against the mandate's 53.44%.",
  'Harbor Credit Desk (fictional) recorded the margin call on loan C1C1C1C1 as cured: LTV at withdrawal value 51.00%.',
  'Harbor Credit Desk (fictional) recorded the margin call on loan C1C1C1C1 as expired: the cure window passed with the loan still above the limit.',
]
const FIX_MARGIN_FEED: FeedDoc = {
  ledgerIndex: FIX_L + 300, nextCursor: null, amendments: { source: 'xrpscan', fetchedAt: '2026-10-25T12:00:00Z', status: 'unavailable', items: [] },
  events: [
    marginEvent('MARGIN_CALL_ISSUED', 10, MARGIN_WHYS[0], 'F1'.repeat(32)),
    marginEvent('MARGIN_CALL_CURED', 20, MARGIN_WHYS[1], 'F2'.repeat(32)),
    marginEvent('MARGIN_CALL_EXPIRED', 30, MARGIN_WHYS[2], 'F3'.repeat(32)),
  ],
}

// Step 21: the same Harbor-1 shares against 2.322 dollars of the desk's dollar pool, shaped as the server's
// (EXAMPLES.ticketUsd and EXAMPLES.marginCallUsd of src/nyc/contracts.mjs). 4 XRP of withdrawal value at 1.29,
// less a 10% haircut: 4.644000 dollars, so 2.322 dollars is an LTV of 50.00%; 5 XRP at par: 40.00%.
const FIX_USD_ASSET: LoanAsset = { currency: 'USD', issuer: 'rUSDw1nGKbkLj9hTjHmBPbVSVcXCoVhQe7', label: USD_LABEL }
const FIX_USD_VAULT = '55'.repeat(32)
// The price: the median of three XLS-47 documents read at the ticket's ledger (close 12:00:00Z), a fourth one
// stale and left out. Spread ceil((1.2926 − 1.2899) × 10000 / 1.29) = 21 bps; asOf the oldest used update, 42 s old.
const FIX_ORACLE_NOTE = 'On Devnet the documents are relayed from exchange quotes by a test account of the desk, standing in for independent oracle providers.'
const FIX_METHOD = 'Median of the fresh XLS-47 Oracle documents of the terms, read at this ledger'
const oracle = (provider: string, n: number) => ({ account: `rOracle${provider}`, documentId: n, provider, uri: `https://example.invalid/${provider.toLowerCase()}` })
const FIX_SOURCES = [oracle('Kraken', 1), oracle('Bitstamp', 2), oracle('Coinbase', 3), oracle('Bitfinex', 4)]
const FIX_USD_TERMS: UsdTerms = {
  schema: 'orma.usdterms/1', id: 'desk-1', mandateHash: 'C'.repeat(64), loanAsset: FIX_USD_ASSET,
  xrpUsdOracle: { baseAsset: 'XRP', quoteAsset: 'USD', sources: FIX_SOURCES, aggregation: 'median', minSources: 2, maxAgeSeconds: 600, maxSpreadBps: 100, note: FIX_ORACLE_NOTE },
  fxHaircutBps: 1000, maxSingleLoanUsd: '10', issuedAt: '2026-10-25T00:30:00.000Z', hash: 'C3'.repeat(32), anchorTx: 'C4'.repeat(32),
}
const FIX_PLAN_USD: DeskPlan = {
  ...FIX_PLAN,
  usd: { plannedLoan: { units: '5000000', principalUsd: '2.322', paymentInterval: 86400, gracePeriod: 3600 }, loanAsset: FIX_USD_ASSET, vaultId: FIX_USD_VAULT, loanBrokerId: '56'.repeat(32), terms: FIX_USD_TERMS },
}
const read = (i: number, price: string | null, lastUpdateTime: string | null, ageSeconds: string | null, fresh: boolean, used: boolean) =>
  ({ ...FIX_SOURCES[i], price, lastUpdateTime, ageSeconds, fresh, used, ledgerIndex: FIX_L, ledgerHash: FIX_HASH })
const FIX_USD_REF: UsdReference = {
  value: '1.29', provenance: 'REAL', method: FIX_METHOD, asOf: '2026-10-25T11:59:18Z', ageSeconds: '42',
  sources: [
    read(0, '1.2926', '2026-10-25T11:59:30Z', '30', true, true), read(1, '1.29', '2026-10-25T11:59:18Z', '42', true, true),
    read(2, '1.2899', '2026-10-25T11:59:25Z', '35', true, true), read(3, '1.31', '2026-10-25T10:00:00Z', '7200', false, false),
  ],
  spreadBps: 21, maxSpreadBps: 100, minSources: 2, maxAgeSeconds: 600,
  ledgerAggregate: { median: '1.29', size: 3, ledgerIndex: FIX_L, ledgerHash: FIX_HASH }, note: FIX_ORACLE_NOTE,
}
const FIX_USD_TERMS_REF = { id: 'desk-1', hash: FIX_USD_TERMS.hash, anchorTx: FIX_USD_TERMS.anchorTx, fxHaircutBps: 1000, maxSingleLoanUsd: '10' }
const usdTicketOf = (reference: UsdReference, verdict: Ticket['verdict']): Ticket => {
  const { maxLoan: _m, requested: _r, ltvHeld: _l, lender1to1: _p, ...figures } = FIX_TICKET.figures
  void [_m, _r, _l, _p]
  return {
    ...FIX_TICKET, ticketId: 'F'.repeat(64),
    figures: {
      ...figures,
      maxLoanUsd: fix('maxLoanUsd', 'usd', '2.481753'), requestedUsd: fix('requestedUsd', 'usd', '2.322'), collateralHeldUsd: fix('collateralHeldUsd', 'usd', '4.644000'),
      ltvHeldUsd: fix('ltvHeldUsd', 'bps', '5000'), lender1to1Usd: fix('lender1to1Usd', 'bps', '4000'), priceAge: fix('priceAge', 'seconds', reference.ageSeconds),
    },
    verdict, verdict1to1: { status: 'PASS', breaches: [] },
    usd: { loanAsset: FIX_USD_ASSET, requestedUsd: '2.322', collateralHeldUsd: '4.644000', ltvHeldBps: 5000, reference, terms: FIX_USD_TERMS_REF, collateralRule: USD_COLLATERAL_RULE },
  }
}
const FIX_USD_TICKET = usdTicketOf(FIX_USD_REF, { status: 'PASS', breaches: [] })
// One line written out, not built by referenceLine: the case fails if the line drifts.
const REF_LINE = `1.29 USD per XRP (USD: ${USD_LABEL}), median of 3 of 4 oracle sources (Kraken, Bitstamp, Coinbase), spread 0.21%, oldest update 42 s old`
const PRICE_UNAVAILABLE_SAID = 'Only 1 of the 4 oracle sources is fresh at ledger 6390000, fewer than the 2 the terms require.'
const L_USD = `USD (${USD_LABEL})`
const usdScreen = (t: Ticket) => <DeskScreen ticket={t} mark={null} tab="ticket" deskPlan={FIX_PLAN_USD} asset="USD" />
const REQUEST_USD: ActionPreview = {
  engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED',
  money: { asset: 'USD', loanAsset: FIX_USD_ASSET, principalUsd: '2.322', escrowIndex: 'E5'.repeat(32), lastLedgerSequence: FIX_L + 600 },
}
const APPROVE_USD_MONEY = {
  asset: 'USD', loanAsset: FIX_USD_ASSET, principalUsd: '2.322', collateralHeldDrops: '4000000', collateralHeldUsd: '4.644000', ltvHeldBps: 5000, maxLtvBps: 5344,
  verdict: { status: 'PASS', breaches: [] }, breaches: [], ltv1to1Bps: 4000, verdict1to1: { status: 'PASS', breaches: [] }, reference: FIX_USD_REF,
  collateralRule: USD_COLLATERAL_RULE, escrow: 'ok', collateral: { address: 'rCollateral', conforming: true, reasons: [] }, digest: 'same', sequence: 'ok', ledgerIndex: FIX_L,
}
const APPROVE_USD: ActionPreview = { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED', money: APPROVE_USD_MONEY }
// A dollar loan of the dollar pool: 3.6 XRP of withdrawal value is 4.179600 dollars, so 2.322 dollars is 55.55%;
// the shortfall is sharesToRestoreUsd's (src/desk/margin-call.mjs) for those numbers. One usage row the server could not read (null).
const FIX_USD_CALL: MarginCall = {
  ...FIX_CALL, currency: 'USD', ltvHeldBps: 5555,
  shortfall: { collateralValueDrops: '141815', sharesToAdd: '196965', withdrawalValuePerShare: '0.720000', collateralValueUsd: '0.164647' },
  reasons: ['The mandate desk-1 limits the LTV at withdrawal value to 53.44 %.', `The LTV at withdrawal value, in USD (${USD_LABEL}), is 55.55 %, above that limit.`],
}
const FIX_USD_POSITION = {
  ...positionWith(FIX_USD_CALL), vaultId: FIX_USD_VAULT, principalOutstanding: '2.322', currency: 'USD', collateralHeldDrops: '3600000', ltvHeldBps: 5555,
  usage: [
    { limit: 'maxLtvBps', value: '5555', threshold: '5344' }, { limit: 'maxSingleLoanUsd', value: '2.322', threshold: '10' },
    { limit: 'maxN2LossDrops', value: null, threshold: '1000000' }, { limit: 'maxLockupDays', value: '1415248', threshold: '2592000' },
  ],
  usd: { loanAsset: FIX_USD_ASSET, principalOutstandingUsd: '2.322', collateralHeldUsd: '4.179600', ltvHeldBps: 5555, reference: FIX_USD_REF, terms: FIX_USD_TERMS_REF },
  marginCall: { ...FIX_USD_CALL, loanId: FIX_LOAN },
} as unknown as Position
const usdPositionsTab = (...positions: Position[]) => <DeskScreen ticket={null} mark={null} tab="positions" data={{ ledgerIndex: FIX_L, ledgerHash: FIX_HASH, positions }} deskPlan={FIX_PLAN_USD} />
const USD_ISSUED_LINE ="Margin call issued by Harbor Credit Desk (fictional) at ledger 6389980: LTV at withdrawal value, in dollars, 55.55% against the mandate's 53.44%. Cure by 18:10:00 UTC: pledge 196965 more shares, or the desk may act under its escrow policy."
const FIX_MANDATE: Mandate = {
  schema: 'orma.mandate/1', id: 'desk-1', desk: LENDER_NAME, riskOfficer: 'rRiskOfficer',
  limits: { maxLtvBps: 5344, maxSingleLoanDrops: '10000000', maxN2LossDrops: '1000000', maxLockupDays: 30 },
  policy: { escrowFinish: 'only-after-default', finishAfterMarginSeconds: 600, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 },
  issuedAt: '2026-10-24T12:00:00.000Z', hash: 'C'.repeat(64), anchorTx: 'D'.repeat(64),
}

export interface SmokeCase { name: string; element: ReactNode; mustContain?: string[]; before?: string[]; enabledButton?: string; mustNotContain?: string[] }

export const SMOKE_CASES: SmokeCase[] = [
  ...ERROR_CODES.map((code) => ({ name: `error ${code}`, element: <ErrorBlock code={code} />, mustContain: [errorSentence(code), code, 'role="alert"'] })),
  ...OPERATOR_ACTIONS.map((e) => ({
    name: `${e.action} previewed`, element: previewed(e.action), before: [PREVIEW_TEXT[e.action], e.verb], mustContain: ['btn btn-primary'],
    ...(e.action === 'approve' ? { enabledButton: e.verb } : {}),
  })),
  { name: 'requestLoan preview carries its principal before its verb', element: previewed('requestLoan'), before: ['not-simulated (awaiting countersignature)', 'Principal: 2.000000 XRP', 'Sign and request loan'], mustNotContain: ['tesSUCCESS'] },
  { name: 'defaultL2 names both withdrawal values before its verb', element: previewed('defaultL2'), before: ['Withdrawal value per share now:', 'Withdrawal value per share if L2 defaults:', 'Default loan L2 — irreversible'] },
  {
    name: 'approve on an ineligible share', element: previewed('approve', { ...PREVIEWS.approve, money: { ...APPROVE_MONEY, collateral: { address: 'rCollateral', conforming: false, reasons: ['vault asset is not XRP: its issuer can claw it back or freeze it'] } } }),
    before: ['Collateral refused: vault asset is not XRP', 'Approve and countersign loan'],
  },
  { name: 'approve BREACHED, lender at 1:1 PASS, before the button', element: previewed('approve'), before: ['Lender at 1:1', 'Approve and countersign loan'], mustContain: ['BREACHED', 'PASS'], enabledButton: 'Approve and countersign loan' },
  {
    name: 'defaultL2 validated without money.realised', element: row('defaultL2', { phase: 'confirming', actionId: FIX_ACTION, preview: PREVIEWS.defaultL2, action: { actionId: FIX_ACTION, state: 'validated', preview: PREVIEWS.defaultL2 } }),
    mustContain: ['Realising… reading the vault at the validation ledger'],
  },
  {
    name: 'requestLoan pending approval', element: row('requestLoan', { phase: 'pending-approval', actionId: FIX_ACTION, preview: PREVIEWS.requestLoan }),
    mustContain: ['Signed by the borrower; awaiting the desk', FIX_ACTION], mustNotContain: ['confirming', 'Confirming'],
  },
  (() => {
    const p = { ...PREVIEWS.defaultL2, money: { ...DEFAULT_MONEY, realised: { predicted: '0.703000', realised: '0.703000', verdict: 'MATCH' } } }
    return {
      name: 'defaultL2 validated with its realised value', element: row('defaultL2', { phase: 'validated', actionId: FIX_ACTION, preview: p, action: { actionId: FIX_ACTION, state: 'validated', preview: p } }),
      before: ['Predicted:', 'Realised:'], mustContain: ['0.703000', 'MATCH', FIX_ACTION], mustNotContain: ['Nothing was sent.'],
    }
  })(),
  {
    name: 'pledgeEscrow validated', element: row('pledgeEscrow', { phase: 'validated', actionId: FIX_ACTION, preview: PREVIEWS.pledgeEscrow, action: { actionId: FIX_ACTION, state: 'validated' } }),
    before: ['Pledge shares into escrow', FIX_ACTION], mustNotContain: ['Nothing was sent.'],
  },
  { name: 'pointer chain with a pending oracle', element: <PointerPanel mark={FIX_MARK} />, before: ['oracle cross-check', 'oracle pending: last publish precedes this ledger'], mustContain: ['passes: oracle pending'] },
  { name: 'mandate panel: BREACHED at withdrawal value, PASS at 1:1', element: <MandatePanel ticket={FIX_TICKET} />, before: ['LTV at withdrawal value', 'BREACHED', 'Lender at 1:1', 'PASS'] },
  {
    name: 'approve refused BREACHED keeps its preview', element: row('approve', { phase: 'refused', actionId: FIX_ACTION, preview: PREVIEWS.approve, error: { code: 'BREACHED' } }),
    mustContain: ['BREACHED', 'Lender at 1:1', 'PASS', errorSentence('BREACHED'), 'role="alert"', 'tabindex="-1"'], before: ['Lender at 1:1', errorSentence('BREACHED')],
  },
  {
    name: 'requestLoan refused ESCROW_POLICY on an existing request', element: row('requestLoan', { phase: 'refused', error: { code: 'ESCROW_POLICY', requestActionId: 'q1', message: 'The pledged escrow is already named by another loan request. Nothing was signed. Use Re-request with a fresh ticket.' } }),
    mustContain: ['Use Re-request with a fresh ticket.'],
  },
  { name: 'tab bar under a facility', element: <TabBar current="ticket" facility={FIX_TICKET.share.vaultId} />, before: [FIX_TICKET.share.vaultId, 'Mandate'], mustContain: [`facility=${FIX_TICKET.share.vaultId}&amp;tab=mandate`] },
  ...DESK_TABS.filter((t) => t.id !== 'ticket').map((t) => ({
    name: `${t.id} tab whose read fails`, element: <DeskScreen ticket={null} mark={null} tab={t.id} error="WARMING_UP" />,
    mustContain: [errorSentence('WARMING_UP'), 'role="alert"'], mustNotContain: [LOADING],
  })),
  {
    name: 'ticket tab whose read fails after figures arrived', element: <DeskScreen ticket={FIX_TICKET} mark={null} tab="ticket" error="INCONSISTENT_SNAPSHOT" />,
    before: [errorSentence('INCONSISTENT_SNAPSHOT'), 'these figures are no longer current', 'Withdrawal value'],
  },
  { name: 'simulateWithdraw result in a status region', element: previewed('simulateWithdraw'), mustContain: ['role="status"', 'tabindex="-1"'] },
  { name: 'decline previewed', element: previewed('decline'), mustContain: ['Decline loan request'], mustNotContain: ['declined'] },
  { name: 'rerequest previewed', element: previewed('rerequest'), mustContain: ['Re-request with a fresh ticket'], mustNotContain: ['LoanSet'] },
  (() => {
    const text = 'L1 marked impaired: payment missed by 1 min'
    const raw = Array.from(new TextEncoder().encode(JSON.stringify({ s: 'orma.stmt/1', kind: 'impaired', text, at: 846180562 }))).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    const doc: FeedDoc = {
      ledgerIndex: FIX_L, nextCursor: null, amendments: { source: 'xrpscan', fetchedAt: '2026-10-25T12:00:00Z', status: 'unavailable', items: [] },
      events: [{
        id: `${String(FIX_L).padStart(19, '0')}-0`, type: 'STATEMENT', provenance: 'DECLARED', vaultId: '22'.repeat(32), ledgerIndex: FIX_L, ledgerHash: FIX_HASH, txHash: FIX_HASH,
        why: `The vault owner declared on the ledger: "${text}"`, moneyEffect: null, receipts: [{ object: 'Vault', field: 'Data', before: null, after: raw }],
        statement: {
          provenance: 'DECLARED', raw, owner: 'rOwner', doc: { s: 'orma.stmt/1', kind: 'impaired', text, at: 846180562 },
          consistency: { status: 'CONSISTENT', detail: 'L1 carries lsfLoanImpaired', provenance: 'REAL', ledgerIndex: FIX_L, ledgerHash: FIX_HASH },
        },
      }],
    }
    return { name: 'feed-statement', element: <DeskFeed data={doc} />, mustContain: ['DECLARED', 'REAL', text, 'Amendment votes could not be fetched'] }
  })(),
  ...['simulateWithdraw', 'wait'].map((a) => ({ name: `${a} after its button`, element: row(a, { phase: 'done', actionId: FIX_ACTION, preview: PREVIEWS[a] }), mustContain: ['Recorded as a preview only'], mustNotContain: ['Sent.'] })),
  // Step 20, the margin call. Without an operator run (the server render): the banner, the button disabled.
  {
    name: 'positions with an ISSUED margin call', element: positionsTab(positionWith(FIX_CALL)),
    mustContain: [
      ISSUED_LINE, 'Time left to cure', 'role="timer"', CURE_VERB, LENDER_NAME, `Source: ${LENDER_NAME}`, 'DECLARED', ...FIX_REASONS, FIX_ENTRY, FIX_TRIGGER,
      `/transactions/${FIX_TRIGGER}`, '/api/desk/decisions', NEEDS_RUN, `class="btn btn-primary" disabled="">${CURE_VERB}</button>`, 'Collateral at withdrawal value',
    ],
    before: ['LTV at withdrawal value', ISSUED_LINE, 'Time left to cure', FIX_REASONS[0], 'Decision-log entry', CURE_MONEY, CURE_VERB, NEEDS_RUN],
    mustNotContain: [...NEVER_SAID, EXPIRED_LINE, 'Margin call cured'],
  },
  {
    name: 'margin call banner with an operator run: the button enabled', element: banner(FIX_SESSION),
    before: [ISSUED_LINE, CURE_MONEY, CURE_VERB], enabledButton: CURE_VERB, mustContain: ['btn btn-primary'], mustNotContain: [NEEDS_RUN, cureConfirmVerb('197938')],
  },
  {
    name: 'margin call cure previewed: its money before its confirm', element: banner(FIX_SESSION, { phase: 'previewed', actionId: FIX_ACTION, preview: PREVIEWS.pledgeEscrow }),
    before: [CURE_MONEY, 'Simulated result: tesSUCCESS', cureConfirmVerb('197938')], enabledButton: cureConfirmVerb('197938'), mustNotContain: [`>${CURE_VERB}</button>`],
  },
  {
    name: 'margin call cure refused: the sentence, then the button again', element: banner(FIX_SESSION, { phase: 'refused', error: { code: 'STALE' } }),
    before: [errorSentence('STALE'), CURE_VERB], mustContain: ['role="alert"'], enabledButton: CURE_VERB,
  },
  {
    name: 'margin call cure validated', element: banner(FIX_SESSION, { phase: 'validated', actionId: FIX_ACTION, preview: PREVIEWS.pledgeEscrow, action: { actionId: FIX_ACTION, state: 'validated', txHash: 'AC'.repeat(32) } }),
    before: [`${CURE_VERB} — validated on the ledger, transaction ${'AC'.repeat(32)}`, 'The desk re-reads the loan at the next ledger'], mustNotContain: [`>${CURE_VERB}</button>`],
  },
  {
    name: 'positions with an EXPIRED margin call', element: positionsTab(positionWith(FIX_EXPIRED)),
    before: [ISSUED_LINE, EXPIRED_LINE, FIX_REASONS[0]], mustContain: [`Source: ${LENDER_NAME}`, FIX_ENTRY, FIX_TRIGGER],
    mustNotContain: [...NEVER_SAID, 'Time left to cure', CURE_VERB],
  },
  {
    name: 'positions with a CURED margin call', element: positionsTab(positionWith(FIX_CURED)),
    mustContain: ["Margin call cured at ledger 6390000: LTV at withdrawal value back within the mandate's limit.", FIX_ENTRY],
    mustNotContain: ['Margin call issued by', CURE_VERB, 'Time left to cure'],
  },
  {
    name: 'positions with no margin call', element: positionsTab(positionWith(FIX_NONE)),
    mustContain: ['Collateral at withdrawal value', 'LTV at withdrawal value'], mustNotContain: ['Margin call', CURE_VERB, 'Time left to cure'],
  },
  {
    name: 'positions with two ISSUED margin calls: the first cure primary, the second secondary', element: positionsTab(positionWith(FIX_CALL), positionWith(FIX_CALL, 'C2'.repeat(32))),
    mustContain: [`class="btn btn-primary" disabled="">${CURE_VERB}</button>`, `class="btn btn-secondary" disabled="">${CURE_VERB}</button>`, 'Margin call on loan C1C1C1C1', 'Margin call on loan C2C2C2C2'],
  },
  {
    name: 'feed with the three margin-call events', element: <DeskFeed data={FIX_MARGIN_FEED} />,
    mustContain: [
      'Margin call issued', 'Margin call cured', 'Margin call expired', ...MARGIN_WHYS, 'F1'.repeat(32), 'F2'.repeat(32), 'F3'.repeat(32),
      'DECLARED · desk', 'Decision-log entry', 'or decided by the desk', 'Margin call, Call cured, Call expired',
    ],
    mustNotContain: ['vault owner', 'Ledger field', ...NEVER_SAID],
  },
  // Step 21, loans in the test dollar. Every dollar amount carries the label, whole.
  {
    name: 'USD ticket: the label, the oracle median with each source, the spread, the note, the collateral rule, the XRP | USD choice', element: usdScreen(FIX_USD_TICKET),
    mustContain: [
      USD_LABEL, '1.29 USD per XRP', FIX_METHOD, FIX_ORACLE_NOTE, 'Kraken', 'Bitstamp', 'Coinbase', 'Bitfinex', '1.2926 USD per XRP', '1.2899 USD per XRP', '1.31 USD per XRP',
      'used in the median', 'not used: not fresh', '2 h 0 min 0 s old, past the 10 min 0 s allowed', 'rOracleKraken', 'document 1',
      '3 of 4, at least 2 required', '0.21%, at most 1.00%', 'Oldest update used', '2026-10-25T11:59:18Z', 'Age at ledger 6390000', '42 s (42 s), at most 10 min 0 s per source',
      'get_aggregate_price at ledger 6390000: median 1.29 USD per XRP over 3 sources, the same median', 'Source: XLS-47 oracles, read at this ledger</span><span class="prov" data-prov="REAL">REAL</span>',
      USD_COLLATERAL_RULE, 'aria-label="Loan currency"', 'href="/desk?tab=ticket"', 'href="/desk?tab=ticket&amp;asset=USD" aria-current="true">USD</a>',
      `Loan of 2.322 ${L_USD} against collateral worth 4.000000 XRP at withdrawal value, 4.644000 ${L_USD} at the reference price less the haircut.`,
      `2.481753 ${L_USD}`, 'Largest single loan in dollars', `10 ${L_USD}`, 'Reference price of the dollar loan',
      'asset=USD&amp;tab=mandate', `Loan in USD (${USD_LABEL}): lent from the desk vault only`, 'disabled=""',
    ],
    before: ['Loan currency', 'Loan of 2.322', 'Reference price of the dollar loan', '1.29 USD per XRP', `USD: ${USD_LABEL}. ${FIX_METHOD}`, 'recomputed in this browser', 'Kraken', 'Bitfinex', 'Spread between the sources used', FIX_ORACLE_NOTE, USD_COLLATERAL_RULE],
    mustNotContain: ['STALE', 'declared', 'NaN', 'undefined', ...NEVER_SAID],
  },
  { name: 'reference median and spread recomputed in the browser: MATCH', element: <ReferencePrice r={FIX_USD_REF} ledgerIndex={FIX_L} />, mustContain: ['>MATCH</span>'], mustNotContain: ['MISMATCH'] },
  { name: 'reference with a median that is not the median of its used sources: MISMATCH', element: <ReferencePrice r={{ ...FIX_USD_REF, value: '1.2926' }} ledgerIndex={FIX_L} />, mustContain: ['>MISMATCH</span>'] },
  { name: 'reference with a wrong spread: MISMATCH', element: <ReferencePrice r={{ ...FIX_USD_REF, spreadBps: 20 }} ledgerIndex={FIX_L} />, mustContain: ['>MISMATCH</span>'] },
  {
    name: 'reference recompute leaves out an unused source: a stale price moved changes nothing', element: <ReferencePrice r={{ ...FIX_USD_REF, sources: FIX_USD_REF.sources.map((x) => (x.used ? x : { ...x, price: '9.99' })) }} ledgerIndex={FIX_L} />,
    mustContain: ['>MATCH</span>'], mustNotContain: ['MISMATCH'],
  },
  {
    name: 'reference with a source that never published: no price, never updated', element: <ReferencePrice r={{ ...FIX_USD_REF, sources: [...FIX_USD_REF.sources.slice(0, 3), read(3, null, null, null, false, false)] }} ledgerIndex={FIX_L} />,
    mustContain: ['no price at this ledger', 'never updated', '>MATCH</span>'], mustNotContain: ['null', 'NaN'],
  },
  {
    name: 'USD ticket refused 409 PRICE_UNAVAILABLE: the sentence, no figure', element: <DeskScreen ticket={null} mark={null} tab="ticket" deskPlan={FIX_PLAN_USD} asset="USD" error="PRICE_UNAVAILABLE" />,
    mustContain: [errorSentence('PRICE_UNAVAILABLE'), 'PRICE_UNAVAILABLE', 'role="alert"', 'aria-label="Loan currency"'], mustNotContain: ['Ledger field', LOADING, 'BREACHED'],
  },
  { name: 'PRICE_UNAVAILABLE with the sentence of the server', element: <ErrorBlock code="PRICE_UNAVAILABLE" message={PRICE_UNAVAILABLE_SAID} />, before: [errorSentence('PRICE_UNAVAILABLE'), PRICE_UNAVAILABLE_SAID, 'PRICE_UNAVAILABLE</code>'] },
  {
    name: 'an XRP ticket under a dollar choice is never drawn: the loading note, no figure', element: usdScreen(FIX_TICKET),
    mustContain: [LOADING, 'aria-label="Loan currency"'], mustNotContain: ['Ledger field', 'Loan of 2.600000 XRP'],
  },
  {
    name: 'XRP ticket on a plan that lends the dollar: the choice on XRP, no dollar figure', element: <DeskScreen ticket={FIX_TICKET} mark={null} tab="ticket" deskPlan={FIX_PLAN_USD} />,
    mustContain: ['aria-label="Loan currency"', 'href="/desk?tab=ticket" aria-current="true">XRP</a>', 'Loan of 2.600000 XRP against collateral worth 4.000000 XRP at withdrawal value.'],
    mustNotContain: ['Reference price of the dollar loan', USD_COLLATERAL_RULE, 'asset=USD&amp;tab=', 'disabled=""'],
  },
  {
    name: 'XRP ticket on a plan without usd: no currency choice at all', element: <DeskScreen ticket={FIX_TICKET} mark={null} tab="ticket" deskPlan={FIX_PLAN} asset="USD" />,
    mustContain: ['Loan of 2.600000 XRP'], mustNotContain: ['Loan currency', USD_LABEL, 'asset=USD'],
  },
  {
    name: 'requestLoan USD previewed: the principal in dollars with the label, before its verb', element: previewed('requestLoan', REQUEST_USD),
    before: ['not-simulated (awaiting countersignature)', `Principal: 2.322 ${L_USD}`, 'Escrow:', 'Sign and request loan'], mustNotContain: ['Principal: — XRP', 'tesSUCCESS'],
  },
  {
    name: 'approve USD previewed: dollars with the label, the reference price, the collateral rule, before the enabled button', element: previewed('approve', APPROVE_USD),
    before: [
      `Principal: 2.322 ${L_USD}`, `Collateral at withdrawal value: 4.000000 XRP, worth 4.644000 ${L_USD} at the reference price less the haircut`,
      'LTV at withdrawal value, in dollars: 50.00% against a limit of 53.44%', 'Verdict:', 'Lender at 1:1, in dollars: 40.00%',
      `Reference price (REAL): ${REF_LINE}`,
      USD_COLLATERAL_RULE, 'Approve and countersign loan',
    ],
    mustContain: ['PASS'], mustNotContain: ['STALE', 'Principal: — XRP'], enabledButton: 'Approve and countersign loan',
  },
  {
    name: 'positions with a USD loan under an ISSUED margin call: dollars with the label beside the drops', element: usdPositionsTab(FIX_USD_POSITION),
    mustContain: [
      `Loan in USD · principal outstanding 2.322 ${L_USD}`, `4.179600 ${L_USD} at the reference price of ${REF_LINE}, less the haircut`, '3.600000 XRP',
      '55.55%', "in dollars: the loan over the collateral's dollar value", `single loan</dt><dd class="t-fig-s">2.322 ${L_USD} of 10 ${L_USD}`,
      'loss if one loan defaults</dt><dd class="t-fig-s">— of 1.000000 XRP',
      USD_ISSUED_LINE, `Shortfall: 0.141815 XRP of withdrawal value, worth 0.164647 ${L_USD} at the reference price less the haircut.`,
      `The LTV at withdrawal value, in USD (${USD_LABEL}), is 55.55 %, above that limit.`,
      'Pledges 196965 more shares of Harbor-1 into escrow for loan C1C1C1C1, from the desk lending vault.', CURE_VERB, NEEDS_RUN,
    ],
    before: [USD_ISSUED_LINE, 'Shortfall:', 'Time left to cure', CURE_VERB],
    mustNotContain: [...NEVER_SAID, 'Loan in XRP', NOT_A_LENDER, '2.322000 XRP', '0.000002 XRP', 'reference price</dt>'],
  },
  {
    name: 'positions with a USD loan and no usable price: no dollar figure, the reason, the LTV a dash',
    element: usdPositionsTab({ ...FIX_USD_POSITION, ltvHeldBps: null, usage: [{ limit: 'maxLtvBps', value: null, threshold: '5344' }], usd: { ...(FIX_USD_POSITION.usd as PositionUsd), collateralHeldUsd: null, ltvHeldBps: null, reference: null, priceUnavailable: PRICE_UNAVAILABLE_SAID }, marginCall: { ...FIX_NONE, currency: 'USD' } }),
    mustContain: [`Not valued in dollars at this ledger: ${PRICE_UNAVAILABLE_SAID}`, `Loan in USD · principal outstanding 2.322 ${L_USD}`, '3.600000 XRP', '<span class="t-fig-m block">—</span>'],
    mustNotContain: ['NaN', 'null', 'USD per XRP', 'Margin call issued'],
  },
  {
    name: 'positions with a cured USD margin call', element: usdPositionsTab({ ...FIX_USD_POSITION, marginCall: { ...FIX_USD_CALL, status: 'CURED', shortfall: null } }),
    mustContain: ["Margin call cured at ledger 6390000: LTV at withdrawal value, in dollars, back within the mandate's limit."], mustNotContain: ['Shortfall:', CURE_VERB],
  },
  {
    name: 'mandate tab beside a USD position with a null usage value: no crash, the dollar rows ignored', element: <DeskScreen ticket={null} mark={null} tab="mandate" data={FIX_MANDATE} positions={{ ledgerIndex: FIX_L, ledgerHash: FIX_HASH, positions: [FIX_USD_POSITION, positionWith(FIX_NONE, 'C2'.repeat(32))] }} />,
    mustContain: ['Maximum loan-to-value at withdrawal value', '55.56%', 'Largest single loan', 'Longest lock-up'], mustNotContain: [USD_LABEL],
  },
]
