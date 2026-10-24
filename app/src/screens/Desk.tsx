import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Decimal from 'decimal.js'
import type { ChangeRow, Figure as FigureDoc, Mandate, Mark, Ticket } from '../lib/types'
import { AuditTable, FigureValue, HashLink, Panel, ProvenanceKey, ReadAt, Recompute, ShowWork, TestNetBanner, Verdict, Figure, formatBps, formatXrp, type VerdictStatus } from '../components/Ledger'
import { BalanceBar, DefaultDots, LockBar, LtvGauge, PriceBars } from '../components/Charts'
import {
  confirmAction, deskPlanPath, deskTicketPaths, demoLoanFor, errorSentence, postAction, readOperatorSession,
  sessionFromFragment, writeOperatorSession,
  type ActionError, type ActionPreview, type DeskPlan, type DeskPlanVault, type OperatorSession, type Position, type Positions,
} from '../lib/api'
import { usePoll } from '../lib/usePoll'
import { follow, tabHref } from '../lib/useRoute'
import { dropsToXrp } from '../lib/format'
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
  /** The API path the tab reads, or null when it polls nothing. */
  source: (ctx: { deskPlan?: DeskPlan; facility?: string }) => string | null
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
    source: ({ deskPlan, facility }) => (deskPlan ? deskTicketPaths(deskPlan, facility).pledge : null),
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

/** harbor-2 -> Harbor-2. */
const harborName = (label: string | null) => (label ? label.replace(/^harbor-/, 'Harbor-') : 'unknown facility')
export const deskTitle = (harbor: string | null, tab: string) => `Credit desk: ${harborName(harbor)} · ${tab}`

const cap = (x: string) => x.replace(/^./, (c) => c.toUpperCase())
const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toUpperCase() === b.toUpperCase())

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

function TabBar({ current, facility }: { current: string; facility?: string }) {
  const search = facility ? `?facility=${facility}` : ''
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
  const f = ticket.figures
  return (
    <Panel provenance="DECLARED" title="Mandate of the risk officer">
      <p className="caption">{`Mandate ${ticket.mandate.id} · hash ${ticket.mandate.hash}`}</p>
      {f.requested && <Line label="Loan requested" meaning="The principal of the planned loan." figure={f.requested} />}
      {f.ltvHeld && <Line label="LTV at withdrawal value" meaning="Requested principal over the withdrawal value of the pledged units." figure={f.ltvHeld} />}
      <p>Verdict at the withdrawal value: <Verdict status={statusOf(ticket.verdict)} /></p>
      {ticket.verdict.breaches.map((b) => <p key={b.limit} className="caption">{`${b.limit}: ${b.value} over the limit of ${b.threshold}`}</p>)}
      {f.lender1to1 && <Line label="Lender at 1:1" meaning="Requested principal over the units valued at one XRP each, as a lender pricing shares at par would." figure={f.lender1to1} />}
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

const LIMIT_LABEL: Record<string, string> = { maxLtvBps: 'Max LTV', maxSingleLoanDrops: 'Max single loan', maxN2LossDrops: 'Max loss if one loan defaults', maxLockupDays: 'Max lock-up' }
const limitValue = (limit: string, x: string) => (limit.endsWith('Bps') ? formatBps(x) : limit.endsWith('Days') ? `${x} days` : `${formatXrp(x)} XRP`)
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
function ApprovalReading({ ticket }: { ticket: Ticket }) {
  const f = ticket.figures
  const par = f.lender1to1?.value ?? null
  return (
    <aside className="desk-aside" aria-label="Approval">
      <div className="approval">
        <h2 className="t-heading-s">Approval</h2>
        {f.requested ? (
          <>
            <p className="t-body-m approval-line">{`Loan of ${formatXrp(f.requested.value)} XRP against collateral worth ${formatXrp(f.heldValue.value)} XRP at withdrawal value.`}</p>
            <div className="approval-verdict">
              <span className="t-label-m">LTV at withdrawal value <span className="dim">(loan ÷ collateral)</span></span>
              <Verdict status={statusOf(ticket.verdict)} big />
            </div>
            {f.ltvHeld && par !== null && <LtvGauge ltvBps={f.ltvHeld.value} parBps={par} limitBps={ltvLimit(ticket)} />}
            {ticket.verdict.breaches.map((b) => <p key={b.limit} className="t-body-s"><strong>{`${LIMIT_LABEL[b.limit] ?? b.limit}: ${limitValue(b.limit, b.value)} of ${limitValue(b.limit, b.threshold)}, over the limit.`}</strong></p>)}
            {ticket.verdict1to1 && <p className="t-body-m approval-line">Lender at 1:1 <Verdict status={statusOf(ticket.verdict1to1)} /></p>}
            <p className="t-body-s dim">The risk officer approves in the operator controls below.</p>
          </>
        ) : <p className="t-body-m approval-line">No loan request is waiting. Play “Sign and request loan” in the operator controls below.</p>}
      </div>
    </aside>
  )
}

const VIEWS = [['summary', 'Summary'], ['defaults', 'If a loan defaults'], ['history', 'Assets and lock-up'], ['proof', 'Proof'], ['audit', 'Audit']] as const
type View = typeof VIEWS[number][0]

function TicketView({ ticket, mark, harbor, loan, buyTicket, deskPlan, changeRows, onChange }: {
  ticket: Ticket; mark: Mark | null; harbor: DeskPlanVault | null; loan: Position | null; buyTicket: Ticket | null; deskPlan?: DeskPlan
  changeRows: ChangeRow[]; onChange: (rows: ChangeRow[]) => void
}) {
  const [view, setView] = useState<View>('summary')
  const f = ticket.figures
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
      { label: `${e.label}: vault cover liquidated`, figure: e.cover },
    ]),
    { label: 'Locked until redemption', figure: f.n3.lockedUntil },
    { label: 'Cash in the vault', figure: f.n3.cashAvailable },
    { label: 'Claim at redemption', figure: f.n3.claim },
    ...(f.maxLoan ? [{ label: 'Largest loan the mandate allows', figure: f.maxLoan }] : []),
    ...(f.requested ? [{ label: 'Requested', figure: f.requested }] : []),
    ...(f.ltvHeld ? [{ label: 'LTV at withdrawal value', figure: f.ltvHeld }] : []),
    ...(f.lender1to1 ? [{ label: 'Lender at 1:1', figure: f.lender1to1 }] : []),
  ]
  return (
    <>
      <nav className="subtabs" aria-label="Ticket sections">
        {VIEWS.map(([id, label]) => <button key={id} type="button" className="btn btn-secondary" aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
      </nav>
      <div className="desk-grid">
        <ApprovalReading ticket={ticket} />
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
                  <thead><tr>{['Scenario', `Loss on the ${ticket.share.units} pledged shares, after cover`, 'Vault cover liquidated'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
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
      <OperatorPanel ticket={ticket} buyTicket={buyTicket} harbor={harbor} units={deskPlan?.plannedLoan.units ?? ticket.share.units} onChange={onChange} />
    </>
  )
}

const usageValues = (u: Position['usage'][number]) => `${limitValue(u.limit, u.value)} of ${limitValue(u.limit, u.threshold)}`

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
  if (doc.positions.length === 0) return <div className="state"><p className="t-body-s dim">The desk has no loan yet.</p></div>
  return (
    <>
      <p className="t-body-l summary-line">{`${doc.positions.length} ${doc.positions.length === 1 ? 'loan' : 'loans'} on the desk.`}</p>
      <div className="tbl-wrap"><table className="op-tbl">
          <thead><tr>{['Loan', 'Collateral', 'Collateral at withdrawal value', 'LTV at withdrawal value'].map((h) => <th key={h} scope="col" className={h === 'Collateral at withdrawal value' ? 'num' : undefined}>{h}</th>)}</tr></thead>
          <tbody>
            {doc.positions.map((p) => {
              const ltvLimit = p.usage.find((u) => u.limit === 'maxLtvBps')?.threshold
              return (
                <tr key={p.loanId}>
                  <td>{p.loanSetTxHash ? <HashLink hash={p.loanSetTxHash} /> : <span className="dim">LoanSet not found in the history</span>}<span className="t-fig-s dim block">{`loan ${p.loanId.slice(0, 8)}`}</span></td>
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
                  <td className="t-fig-m num">{`${formatXrp(p.collateralHeldDrops)} XRP`}</td>
                  <td>
                    <span className="t-fig-m block">{formatBps(String(p.ltvHeldBps))}</span>
                    {ltvLimit !== undefined && <Mini value={String(p.ltvHeldBps)} limit={ltvLimit} />}
                    <details className="fig-ledger limits-fold"><summary>All limits</summary>
                      <dl className="usage pop-body">{p.usage.map((u) => <div key={u.limit}><dt>{(LIMIT_LABEL[u.limit] ?? u.limit).replace('Max ', '')}</dt><dd className="t-fig-s">{usageValues(u)}</dd></div>)}</dl>
                    </details>
                  </td>
                </tr>
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
  const worst = (limit: string) => (positions?.positions ?? []).flatMap((p) => p.usage.filter((u) => u.limit === limit)).reduce<{ value: string; threshold: string } | null>((m, u) => (!m || new Decimal(u.value).div(u.threshold).gt(new Decimal(m.value).div(m.threshold)) ? { value: u.value, threshold: u.threshold } : m), null)
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


function TicketTab({ ticket, mark, error, buyTicket, deskPlan, positions, facility, harbor }: {
  ticket: Ticket | null; mark: Mark | null; error: string | null; buyTicket: Ticket | null
  deskPlan?: DeskPlan; positions: Positions | null; facility?: string; harbor: DeskPlanVault | null
}) {
  const [rows, setRows] = useState<ChangeRow[]>([])
  if (deskPlan && !harbor) return <p className="t-body-s">{NOT_A_HARBOR}</p>
  // Without a plan (the smoke of step 9) the share guard does not apply: the props are drawn as given.
  const own = ticket && (!harbor || same(ticket.share.mptId, harbor.shareMptId)) ? ticket : null
  const ownMark = mark && (!harbor || same(mark.shareMptId, harbor.shareMptId)) ? mark : null
  if (!own) return error ? <ErrorBlock code={error} /> : <Loading />
  const loan = deskPlan ? demoLoanFor(positions, deskPlan, facility) : null
  return (
    <>
      {error && <ErrorBlock code={error} />}
      {error ? <p className="read-at t-fig-s">{`Read at ledger ${own.ledgerIndex} — these figures are no longer current.`}</p> : <ReadAt ledger={own.ledgerIndex} at={own.asOf} />}
      <TicketView ticket={own} mark={ownMark} harbor={harbor} loan={loan} buyTicket={buyTicket} deskPlan={deskPlan} changeRows={rows} onChange={setRows} />
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

/** `data`: the answer of the current tab's source; `error`: the code of its last failed read. */
export function DeskScreen({ ticket, mark, tab, data, error = null, buyTicket = null, deskPlan, positions = null, facility }: {
  ticket: Ticket | null; mark: Mark | null; tab: string; data?: unknown; error?: string | null
  buyTicket?: Ticket | null; deskPlan?: DeskPlan; positions?: Positions | null; facility?: string
}) {
  const current = DESK_TABS.find((t) => t.id === tab) ?? DESK_TABS[0]
  const harbor = deskPlan ? deskTicketPaths(deskPlan, facility).harbor : null
  const label = deskPlan ? harbor?.label ?? null : 'harbor-1'
  const harbors = deskPlan?.vaults.filter((v) => v.label.startsWith('harbor-')) ?? []
  // Another Harbor, same tab: `tab` first, so a tab link and a Harbor link never read alike.
  const harborHref = (vaultId: string) => '/desk?' + new URLSearchParams({ tab: current.id, facility: vaultId })
  const go = (href: string) => () => { history.pushState(null, '', href); dispatchEvent(new PopStateEvent('popstate')) }
  const title = current.id === 'ticket' ? `Collateral report${label ? ` · ${cap(harborName(label))}` : ''}` : current.label
  return (
    <div className="desk-stage">
      <TestNetBanner />
      <header className="desk-head">
        <div>
          <h1 className="t-heading-l">{title}</h1>
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
      <TabBar current={current.id} facility={facility} />
      <div id="desk-body" className="desk-body">
        {current.id === 'ticket'
          ? <TicketTab ticket={ticket} mark={mark} error={error} buyTicket={buyTicket} deskPlan={deskPlan} positions={positions} facility={facility} harbor={harbor} />
          : <DataTab tab={current} data={data} error={error} positions={positions} deskPlan={deskPlan} harbor={harbor} />}
      </div>
    </div>
  )
}

// --- the operator panel ------------------------------------------------------------------------------

export interface ActionCtx {
  harbor: string; lending: 'desk' | 'spare'; ticket: Ticket | null; buyTicket: Ticket | null
  pledgeActionId: string | null; requestActionId: string | null
}
export interface OperatorAction { role: string; action: string; verb: string; body: (ctx: ActionCtx) => object | null }

const pledgeBody = (c: ActionCtx) => c.ticket && ({ vault: c.lending, share: c.ticket.share.mptId, ticketId: c.ticket.ticketId, inputsDigest: c.ticket.inputsDigest, units: c.ticket.share.units })
const onHarbor = (c: ActionCtx) => ({ vault: c.harbor })
const onRequest = (c: ActionCtx) => ({ vault: c.lending, requestActionId: c.requestActionId })

/** One line per action of the allow-list, in this order, each with its exact verb. */
export const OPERATOR_ACTIONS: OperatorAction[] = [
  { role: 'holder', action: 'simulateWithdraw', verb: 'Simulate withdrawal — nothing is sent', body: onHarbor },
  { role: 'borrower', action: 'pledgeEscrow', verb: 'Pledge shares into escrow', body: pledgeBody },
  { role: 'borrower', action: 'requestLoan', verb: 'Sign and request loan', body: (c) => c.ticket && { ...pledgeBody(c), pledgeActionId: c.pledgeActionId } },
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

/** The money of a preview, before the button: what the action will cost or move, in the desk's words. */
function MoneyPreview({ action, preview, units }: { action: string; preview: ActionPreview; units: string }) {
  const m = money(preview)
  if (typeof m.error === 'string') return <p className="caption">{`The money of this action could not be computed: ${m.error}`}</p>
  const lines: ReactNode[] = []
  if (action === 'requestLoan') {
    lines.push(text(preview.engineResult), `Principal: ${xrp(m.principalDrops)}`, `Escrow: ${text(m.escrowIndex)}`, `Valid until ledger ${text(m.lastLedgerSequence)}`)
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
      `${text(m.cover)} drops: vault cover liquidated`,
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

function ActionRow({ entry, ctx, session, remember, onChange, units, initial }: {
  entry: OperatorAction; ctx: ActionCtx; session: OperatorSession; units: string
  remember: (patch: { pledgeActionId: string } | { requestActionId: string }) => void
  onChange?: (rows: ChangeRow[]) => void; initial?: RowState
}) {
  const [row, setRow] = useState<RowState>(initial ?? { phase: 'idle' })
  const result = useRef<HTMLDivElement>(null)
  const watch = row.phase === 'confirming' && row.actionId && session.runId ? `/api/roles/${session.runId}/actions/${row.actionId}` : null
  const poll = usePoll<RoleAction>(watch, 2000)

  // The row moves past `confirming` only on what GET …/actions/{id} reads back, never on the 202.
  useEffect(() => {
    const a = poll.data
    if (!a || a.actionId !== row.actionId || row.phase !== 'confirming') return
    if (a.state === 'validated' && !(entry.action === 'defaultL2' && !money(a.preview).realised)) {
      if (entry.action === 'pledgeEscrow') remember({ pledgeActionId: a.actionId })
      setRow((r) => ({ ...r, phase: 'validated', action: a }))
    } else if (a.state === 'failed' || a.state === 'pending-approval') {
      setRow((r) => ({ ...r, phase: a.state as Phase, action: a }))
    } else {
      setRow((r) => ({ ...r, action: a }))
    }
  }, [poll.data, row.actionId, row.phase, entry.action, remember])

  // After a preview and after a refusal the reader is taken to the row's result, never left on BODY.
  useEffect(() => {
    if (row.phase === 'previewed' || row.phase === 'refused') result.current?.focus()
  }, [row.phase])

  async function preview() {
    const body = entry.body(ctx)
    if (!session.runId || !session.token) return setRow({ phase: 'refused', error: { code: 'UNAUTHORIZED' } })
    if (!body) return setRow({ phase: 'refused', error: { code: 'WARMING_UP' } })
    setRow({ phase: 'previewing' })
    const a = await postAction(entry.action, entry.role, session.runId, session.token, body)
    const err = a.body.error
    if (a.status === 202 && a.body.actionId && a.body.preview) {
      if (entry.action === 'requestLoan') remember({ requestActionId: a.body.actionId })
      if (a.body.preview.schema === 'orma.change/1') onChange?.(a.body.preview.rows ?? [])
      return setRow({ phase: 'previewed', actionId: a.body.actionId, preview: a.body.preview })
    }
    if (entry.action === 'requestLoan' && err?.code === 'ESCROW_POLICY' && err.requestActionId) remember({ requestActionId: err.requestActionId })
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

  const realised = money(row.action?.preview ?? row.preview).realised as { predicted?: string; realised?: string; verdict?: string; error?: string } | undefined
  return (
    <div style={{ borderTop: '1px solid var(--color-line)', paddingBlock: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <p className="caption"><b>{entry.role}</b>{` · ${entry.action}`}</p>
      <div>
        <button type="button" className="btn btn-secondary" onClick={preview} disabled={row.phase === 'previewing'}>
          {row.phase === 'previewing' ? 'Previewing…' : 'Preview'}
        </button>
      </div>
      <div role="status" tabIndex={-1} ref={result}>
        {row.preview && <MoneyPreview action={entry.action} preview={row.preview} units={units} />}
        {row.phase === 'confirming' && (
          <p className="caption">{row.action?.state === 'validated' ? 'Realising… reading the vault at the validation ledger' : 'Submitting to the ledger…'}</p>
        )}
        {row.phase === 'validated' && (
          <div>
            {entry.action === 'defaultL2' && realised && (realised.error
              ? <p className="caption">{`The realised value could not be read: ${realised.error}`}</p>
              : <>
                  <p className="caption">{`Predicted: ${text(realised.predicted)} drops per share`}</p>
                  <p className="caption">{`Realised: ${text(realised.realised)} drops per share`}</p>
                  <p><Verdict status={statusOf(realised.verdict)} /></p>
                </>)}
            <p className="caption">{`${entry.verb} — validated on the ledger${row.action?.txHash ? `, transaction ${row.action.txHash}` : ''}.`}</p>
            <p className="caption"><code>{row.actionId}</code></p>
          </div>
        )}
        {row.phase === 'pending-approval' && (
          <p className="caption">{`Signed by the borrower; awaiting the desk's countersignature · `}<code>{row.actionId}</code></p>
        )}
        {row.phase === 'done' && <p className="caption">Recorded as a preview only: this action builds no transaction to submit.</p>}
        {row.phase === 'failed' && <p role="alert" className="caption">{`The ledger did not apply it: ${text(row.action?.engineResult)}.`}</p>}
        {row.phase === 'refused' && row.error && <ErrorBlock code={row.error.code} message={entry.action === 'requestLoan' && row.error.requestActionId ? row.error.message : undefined} />}
      </div>
      {row.phase === 'previewed' && (
        <div><button type="button" className="btn btn-primary" onClick={confirm}>{entry.verb}</button></div>
      )}
    </div>
  )
}

function OperatorPanel({ ticket, buyTicket, harbor, units, onChange }: {
  ticket: Ticket; buyTicket: Ticket | null; harbor: DeskPlanVault | null; units: string; onChange: (rows: ChangeRow[]) => void
}) {
  const [session, setSession] = useState<OperatorSession>(readOperatorSession)
  const [lending, setLending] = useState<'desk' | 'spare'>('desk')
  // The operator link carries the run in its fragment once; the screen adopts it and wipes it from the address bar.
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
  const label = harbor?.label ?? 'harbor-1'
  const ctx: ActionCtx = { harbor: label, lending, ticket, buyTicket, pledgeActionId: session.pledgeActionId, requestActionId: session.requestActionId }
  const line = (e: OperatorAction) => <ActionRow key={e.action} entry={e} ctx={ctx} session={session} remember={remember} onChange={onChange} units={units} />
  const notPlayed = (e: OperatorAction) => harbor?.impairL1Tx && (e.action === 'impairL1' || e.action === 'wait')
  return (
    <section style={{ borderTop: '1px solid var(--color-line)', paddingTop: 'var(--space-4)' }} aria-label="Operator controls (demo)">
      <h2 className="exh-title">Operator controls (demo)</h2>
      <p className="caption">{`${harborName(label)} · lending from `}
        <select aria-label="Lending vault" value={lending} onChange={(e) => setLending(e.target.value === 'spare' ? 'spare' : 'desk')}>
          <option value="desk">desk</option>
          <option value="spare">spare</option>
        </select>
      </p>
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
]
