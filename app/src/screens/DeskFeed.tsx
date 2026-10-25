import { useEffect, useState } from 'react'
import type { FeedEvent, StatementCheck, StatementDoc } from '../lib/types'
import { API_BASE } from '../lib/api'
import { dropsToXrp } from '../lib/format'
import { HashLink } from '../components/Ledger'
import { EventTimeline } from '../components/Charts'
import type { SmokeCase } from './Desk'

/**
 * The credit events of the desk's vaults, each from two full re-reads of the ledger, never from metadata.
 * /api/feed is read again every FEED_POLL_MS by App.tsx and arrives as `data`; the live stream adds what
 * happens between two reads, and on any error of the stream the screen keeps to the polling.
 */
export const FEED_POLL_MS = 3000

export interface FeedDoc {
  ledgerIndex: number
  events: FeedEvent[]
  nextCursor: string | null
  amendments: { source: string; fetchedAt: string; status: 'ok' | 'unavailable'; items: { name?: string; amendment_id?: string; enabled?: boolean }[] }
}

const LABELS: Record<FeedEvent['type'], string> = {
  LOAN_LATE: 'Loan late', IMPAIRMENT: 'Loan impaired by the broker', DEFAULT: 'Loan defaulted', COVER_DRAWN: 'First-loss cover drawn',
  SHARES_PLEDGED: 'Shares pledged as collateral', LOAN_ORIGINATED: 'Loan originated', STATEMENT: 'Curator statement',
  MARGIN_CALL_ISSUED: 'Margin call issued', MARGIN_CALL_CURED: 'Margin call cured', MARGIN_CALL_EXPIRED: 'Margin call expired',
}

/** Step 20: the three events a desk decision makes, DECLARED by the desk, each recorded in the decision log. */
const MARGIN_TYPES: FeedEvent['type'][] = ['MARGIN_CALL_ISSUED', 'MARGIN_CALL_CURED', 'MARGIN_CALL_EXPIRED']
const isMarginCall = (ev: FeedEvent) => MARGIN_TYPES.includes(ev.type)
/** Who stated a DECLARED event: the desk for a margin call, the vault owner for a statement. */
const sourceOf = (ev: FeedEvent) => (ev.provenance === 'REAL' ? 'REAL · ledger' : isMarginCall(ev) ? 'DECLARED · desk' : 'DECLARED · vault owner')

const order = (id: string) => id.split('-').map((x) => x.replace(/^0+(?=\d)/, '').padStart(20, '0')).join('-')
const effect = (m: FeedEvent['moneyEffect']) => (m === null ? null : m.unit === 'drops' ? `${dropsToXrp(m.value)} XRP` : `${m.value} ${m.unit}`)

/**
 * A statement's consistency in words, the same on the Feed and on the ticket: only INCONSISTENT says the ledger
 * contradicts the curator; a note or a deleted loan cannot be checked, and an unreadable Vault.Data says so.
 */
export function consistencyLine(c: StatementCheck): string {
  return c.status === 'CONSISTENT' ? `Consistent with the ledger at ${c.ledgerIndex}`
    : c.status === 'INCONSISTENT' ? `Not consistent with the ledger at ${c.ledgerIndex}: ${c.detail}`
    : c.status === 'NOT_CHECKABLE' ? `Not checkable against the ledger: ${c.detail}`
    : 'Unreadable statement in Vault.Data'
}

/** A receipt value in words: absent, or a long hex string cut with its length; short strings are quoted. */
function receiptValue(v: unknown): string {
  if (v === null || v === undefined) return 'absent'
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 20)}… (${v.length} characters)` : JSON.stringify(v)
  return JSON.stringify(v)
}

function EventRow({ ev }: { ev: FeedEvent }) {
  const st = ev.statement
  const m = effect(ev.moneyEffect)
  const margin = isMarginCall(ev)
  return (
    <li className="feed-row">
      <span className="t-fig-m">{ev.ledgerIndex}</span>
      <div className="feed-what">
        <p className="t-label-m">{LABELS[ev.type]}</p>
        <p className="t-body-m">{ev.type === 'STATEMENT' && st?.doc ? `“${st.doc.text}”` : ev.why}</p>
        {st && (
          <p className="t-body-s">
            <span className="prov" data-prov="REAL">REAL</span>
            {` ${consistencyLine(st.consistency)}`}
          </p>
        )}
        <details className="fig-ledger">
          <summary>Receipts</summary>
          <div className="pop-body receipts">
            {ev.txHash && <p className="t-body-s">Transaction <HashLink hash={ev.txHash} /></p>}
            {ev.entryHash && <p className="t-body-s">Decision-log entry <HashLink hash={ev.entryHash} noLink /></p>}
            <p className="t-fig-s dim">{ev.type}</p>
            {(!margin || ev.receipts.length > 0) && <table className="ld-inputs">
              <thead><tr><th scope="col">Ledger field</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
              <tbody>
                {ev.receipts.map((r, i) => (
                  <tr key={i}>
                    <td><span className="block">{r.field}</span><span className="t-fig-s dim">{r.object}</span></td>
                    <td className="t-fig-m">{receiptValue(r.before)}</td>
                    <td className="t-fig-m">{receiptValue(r.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>}
          </div>
        </details>
      </div>
      <span className="t-fig-m">{m ?? '—'}</span>
      <span><span className="prov" data-prov={ev.provenance}>{sourceOf(ev)}</span></span>
    </li>
  )
}

export function DeskFeed({ data }: { data: FeedDoc }) {
  const [live, setLive] = useState<FeedEvent[]>([])
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    // Rendered on the server (the smoke, under tsx) there is no EventSource: the screen keeps to the polling.
    if (typeof EventSource !== 'undefined') {
      const es = new EventSource(`${API_BASE}/api/feed/stream`)
      es.addEventListener('credit', (m) => {
        const ev = JSON.parse((m as MessageEvent).data) as FeedEvent
        setLive((l) => [...l.filter((x) => x.id !== ev.id), ev].slice(-200))
      })
      es.onerror = () => {
        es.close()
        setPaused(true)
      }
      return () => es.close()
    }
  }, [])
  const known = new Set(data.events.map((e) => e.id))
  const events = [...data.events, ...live.filter((e) => !known.has(e.id))].sort((a, b) => (order(a.id) < order(b.id) ? 1 : -1))
  const a = data.amendments
  return (
    <>
      {paused && <p className="t-body-s dim" role="status">Live updates paused; refreshing every 3 seconds.</p>}
      {events.length === 0
        ? <div className="state"><p className="t-body-s dim">No credit event since the service started.</p></div>
        : (
          <>
            <section className="panel" aria-label="Events along the ledger">
              <header className="panel-head"><h2 className="t-heading-s">{`${events.length} events along the ledger`}</h2><span className="t-body-s dim">{`Filled dot: read from the ledger. Diamond: stated by the curator${events.some(isMarginCall) ? ', or decided by the desk' : ''}.`}</span></header>
              <EventTimeline events={events} />
            </section>
            <ul className="feed">
              <li className="feed-head" aria-hidden><span>Ledger</span><span>Event</span><span>Effect</span><span>Source</span></li>
              {events.map((ev) => <EventRow key={ev.id} ev={ev} />)}
            </ul>
          </>
        )}
      <section className="protocol" aria-label="Protocol">
        <h2 className="t-heading-s">Protocol · source: xrpscan <span className="prov" data-prov="REAL">REAL</span></h2>
        {a.status === 'unavailable'
          ? <p className="t-body-s">Amendment votes could not be fetched; measurements are unaffected.</p>
          : (
            <>
              <p className="t-fig-s dim">{`Amendment votes read at ${a.fetchedAt}`}</p>
              <ul>
                {a.items.map((it, i) => <li key={it.amendment_id ?? i} className="t-body-m">{`${it.name ?? it.amendment_id ?? 'unnamed'} · ${it.enabled ? 'enabled' : 'voting'}`}</li>)}
              </ul>
            </>
          )}
      </section>
    </>
  )
}

// One curator statement per consistency status, on the Feed as on the ticket: only INCONSISTENT says the ledger contradicts it.
const FIX_L = 6390000
const FIX_HASH = 'AB'.repeat(32)
const stmtEvent = (n: number, kind: StatementDoc['kind'], consistency: Pick<StatementCheck, 'status' | 'detail'>, doc = true): FeedEvent => ({
  id: `${String(FIX_L + n).padStart(19, '0')}-0`, type: 'STATEMENT', provenance: 'DECLARED', vaultId: '22'.repeat(32), ledgerIndex: FIX_L + n, ledgerHash: FIX_HASH,
  why: 'The vault owner wrote a statement into Vault.Data.', moneyEffect: null, receipts: [],
  statement: {
    provenance: 'DECLARED', raw: '7B7D', owner: 'rVaultOwner', doc: doc ? { s: 'orma.stmt/1', kind, text: `A ${kind} statement.`, at: FIX_L + n } : null,
    consistency: { ...consistency, provenance: 'REAL', ledgerIndex: FIX_L + n, ledgerHash: FIX_HASH },
  },
})
const feedOf = (...events: FeedEvent[]): FeedDoc => ({ ledgerIndex: FIX_L + 100, nextCursor: null, amendments: { source: 'xrpscan', fetchedAt: '2026-10-25T12:00:00Z', status: 'unavailable', items: [] }, events })
const NOTE_DETAIL = 'a note asserts nothing the ledger can check'
const REPAID_DETAIL = `loan BBBBBBBB… is no longer on the ledger at ${FIX_L + 2}: a LoanDelete removes repaid and defaulted loans alike`

export const SMOKE_CASES: SmokeCase[] = [
  {
    name: 'statements that cannot be checked or read are never called inconsistent',
    element: <DeskFeed data={feedOf(stmtEvent(1, 'note', { status: 'NOT_CHECKABLE', detail: NOTE_DETAIL }), stmtEvent(2, 'repaid', { status: 'NOT_CHECKABLE', detail: REPAID_DETAIL }), stmtEvent(3, 'note', { status: 'UNPARSEABLE', detail: 'Vault.Data is not a valid orma.stmt/1 document' }, false))} />,
    mustContain: [`Not checkable against the ledger: ${NOTE_DETAIL}`, `Not checkable against the ledger: ${REPAID_DETAIL}`, 'Unreadable statement in Vault.Data'],
    mustNotContain: ['Not consistent', 'Consistent with'],
  },
  {
    name: 'statements the ledger confirms or contradicts say so, at their ledger',
    element: <DeskFeed data={feedOf(stmtEvent(1, 'impaired', { status: 'CONSISTENT', detail: 'L1 carries lsfLoanImpaired' }), stmtEvent(2, 'repaid', { status: 'INCONSISTENT', detail: `L2 carries lsfLoanDefault at ledger ${FIX_L + 2}` }))} />,
    mustContain: [`Consistent with the ledger at ${FIX_L + 1}`, `Not consistent with the ledger at ${FIX_L + 2}: L2 carries lsfLoanDefault at ledger ${FIX_L + 2}`],
    mustNotContain: ['Not checkable', 'Unreadable statement'],
  },
]
