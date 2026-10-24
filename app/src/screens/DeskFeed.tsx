import { useEffect, useState } from 'react'
import type { FeedEvent } from '../lib/types'
import { API_BASE } from '../lib/api'
import { dropsToXrp } from '../lib/format'
import { Panel } from '../components/Ledger'

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
}

const order = (id: string) => id.split('-').map((x) => x.replace(/^0+(?=\d)/, '').padStart(20, '0')).join('-')
const effect = (m: FeedEvent['moneyEffect']) => (m === null ? null : m.unit === 'drops' ? `${dropsToXrp(m.value)} XRP` : `${m.value} ${m.unit}`)

function EventRow({ ev }: { ev: FeedEvent }) {
  const st = ev.statement
  return (
    <li style={{ borderTop: '1px solid var(--color-line)', paddingBlock: 'var(--space-2)' }}>
      <p className="caption"><b>{LABELS[ev.type]}</b>{` · ${ev.provenance === 'DECLARED' ? 'DECLARED · vault owner' : `REAL · ledger ${ev.ledgerIndex}`}`}</p>
      <p className="caption">{ev.why}</p>
      {effect(ev.moneyEffect) && <p className="caption">{`Effect: ${effect(ev.moneyEffect)}`}</p>}
      {st && (
        <p className="caption">
          <span style={{ color: 'var(--color-text-2)', border: '1px solid var(--color-line)', padding: '0 6px' }}>REAL</span>
          {` ${st.consistency.status === 'CONSISTENT' ? 'Consistent' : 'Not consistent'} with the ledger at ${st.consistency.ledgerIndex}: ${st.consistency.detail}`}
        </p>
      )}
      {ev.txHash && <p className="caption"><a className="lnk" href={`https://devnet.xrpl.org/transactions/${ev.txHash}`} target="_blank" rel="noreferrer"><code>{ev.txHash}</code></a></p>}
      <details>
        <summary>Receipts</summary>
        <p className="caption"><code>{ev.type}</code></p>
        {ev.receipts.map((r, i) => <p key={i} className="caption"><code>{`${r.object}.${r.field}: ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`}</code></p>)}
      </details>
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
      <Panel provenance="REAL" title="Credit events" source="Orma">
        {paused && <p className="caption">Live updates paused; refreshing every 3 seconds.</p>}
        {events.length === 0
          ? <p className="caption">No credit event since the service started.</p>
          : <ul style={{ listStyle: 'none', padding: 0 }}>{events.map((ev) => <EventRow key={ev.id} ev={ev} />)}</ul>}
      </Panel>
      <Panel provenance="REAL" title="Protocol · source: xrpscan">
        {a.status === 'unavailable'
          ? <p className="caption">Amendment votes could not be fetched; measurements are unaffected.</p>
          : (
            <>
              <p className="caption">{`Amendment votes read at ${a.fetchedAt}`}</p>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {a.items.map((it, i) => <li key={it.amendment_id ?? i} className="caption">{`${it.name ?? it.amendment_id ?? 'unnamed'} · ${it.enabled ? 'enabled' : 'voting'}`}</li>)}
              </ul>
            </>
          )}
      </Panel>
    </>
  )
}
