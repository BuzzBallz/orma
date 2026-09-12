import { useEffect } from 'react'
import './app.css'
import { API_BASE, EXPECTED_CONTRACT } from './lib/api'
import { usePoll } from './lib/usePoll'
import { useTick } from './lib/useTick'
import { useRoute, type RoutePath } from './lib/useRoute'
import type { Health, VaultDetail as Detail, VaultsResponse } from './lib/types'
import { HeaderBar } from './components/HeaderBar'
import { StaleBar } from './components/StaleBar'
import { VaultDetail } from './screens/VaultDetail'
import { VaultList } from './screens/VaultList'
import { Moment } from './screens/Moment'
import { short } from './lib/format'

const HINTS: [string, string][] = [
  ['1–5', 'instrument'], ['L', 'list'], ['V', 'vault'], ['M', 'moment'], ['space', 'beat'],
]

/**
 * The API-down state. Spec §5.1 rule 3 and §6.5: an instruction, never a spinner
 * and never a skeleton. Composed as a desk status board — one verdict, one action,
 * the technical facts kept true but subordinate.
 */
function Status({ kicker, verdict, tone, lede, facts, action, note }: {
  kicker: string; verdict: string; tone: string
  lede: React.ReactNode
  facts: [string, React.ReactNode][]
  action?: React.ReactNode
  note?: React.ReactNode
}) {
  return (
    <div className="status" style={{ ['--status-tone' as string]: tone }}>
      <div className="kicker">{kicker}</div>
      <div className="verdict">{verdict}</div>
      <p className="lede">{lede}</p>
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="label">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {action}
      {note && <div className="note">{note}</div>}
    </div>
  )
}

function NoFeed({ error }: { error: string | null }) {
  return (
    <Status
      kicker="system"
      verdict="NO FEED"
      tone="var(--bad)"
      lede={<>
        The oracle is reading nothing. No payload has ever arrived, so there is no last-good
        figure to hold on screen. <b>The polling loop is still running</b> — it recovers on its own.
      </>}
      facts={[
        ['endpoint', API_BASE],
        ['last error', error ?? 'no response'],
        ['contract', `v${EXPECTED_CONTRACT} expected`],
      ]}
      action={
        <div className="action">
          <div className="say">Start the API. This screen fills itself within three seconds.</div>
          <code>node tools/fixture-server.mjs</code>
        </div>
      }
      note="Five vaults, countdowns computed from validated-ledger close time. No reload needed."
    />
  )
}

function UnknownInstrument({ vaultId, onBack }: { vaultId: string | null; onBack: () => void }) {
  return (
    <Status
      kicker="instrument"
      verdict="UNKNOWN"
      tone="var(--warn)"
      lede={<>
        The feed answered and holds no vault under that id. Polling continues, so if the
        instrument is about to exist it appears here on its own.
      </>}
      facts={[['requested', short(vaultId, 24)], ['feed', API_BASE]]}
      action={
        <div className="action">
          <div className="say">
            <a href="/" onClick={e => { e.preventDefault(); onBack() }}>Back to the book</a>
            {' — or press '}<kbd>1</kbd>…<kbd>5</kbd>
          </div>
        </div>
      }
    />
  )
}

function OracleDesk({ onGo }: { onGo: () => void }) {
  return (
    <Status
      kicker="oracle"
      verdict="BAND 3"
      tone="var(--accent)"
      lede={<>
        The published reading lives on the moment desk: publisher, object index, the six
        on-chain dimensions and the ledger aggregate, against the same three-second poll.
        A second page would read the same object twice.
      </>}
      facts={[['reads', 'oracle object on devnet'], ['computed by', 'the ledger, not by us']]}
      action={
        <div className="action">
          <div className="say">
            <a href="/moment" onClick={e => { e.preventDefault(); onGo() }}>Open the moment desk</a>
            {' — or press '}<kbd>M</kbd>
          </div>
        </div>
      }
    />
  )
}

export default function App() {
  const tick = useTick()
  const { path, vaultId, navigate } = useRoute()

  const health = usePoll<Health>('/api/health', 5000)
  const vaults = usePoll<VaultsResponse>('/api/vaults', path === '/' ? 3000 : 15000)
  const detail = usePoll<Detail>(vaultId ? `/api/vaults/${vaultId}` : null, 3000)

  const rows = vaults.data?.vaults ?? []

  // A route with no ?vault= (except /) redirects to / — spec §3.
  useEffect(() => {
    if (path !== '/' && path !== '/oracle' && !vaultId) navigate('/', null)
  }, [path, vaultId, navigate])

  // Global keyboard — spec §5.3. Ignored inside form controls.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const n = Number(e.key)
      if (n >= 1 && n <= 5 && rows[n - 1]) { navigate(path, rows[n - 1].vaultId); return }

      const routes: Record<string, RoutePath> = { l: '/', v: '/vault', m: '/moment', o: '/oracle' }
      const r = routes[e.key.toLowerCase()]
      if (r) navigate(r)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [rows, path, navigate])

  // The header stamp comes from whichever payload the current desk polls.
  const primary = path === '/' ? vaults : detail
  const stamp = path === '/' ? vaults.data : detail.data
  const notFound = detail.code === 'VAULT_NOT_FOUND'

  function body() {
    if (path === '/oracle') return <OracleDesk onGo={() => navigate('/moment')} />
    if (path === '/') {
      if (!vaults.data) return vaults.fails > 0 ? <NoFeed error={vaults.error} /> : null
      return (
        <VaultList
          vaults={rows} receivedAt={vaults.receivedAt} tick={tick}
          onOpen={id => navigate('/vault', id)}
        />
      )
    }
    if (notFound && !detail.data) return <UnknownInstrument vaultId={vaultId} onBack={() => navigate('/', null)} />
    if (!detail.data) return detail.fails > 0 ? <NoFeed error={detail.error} /> : null
    if (path === '/vault') return <VaultDetail d={detail.data} receivedAt={detail.receivedAt} tick={tick} />
    return <Moment d={detail.data} receivedAt={detail.receivedAt} tick={tick} />
  }

  return (
    <>
      <HeaderBar
        health={health.data}
        healthUnreachable={health.data === null || health.stale}
        vaults={rows}
        activeVaultId={vaultId}
        path={path}
        ledgerIndex={stamp?.ledgerIndex ?? null}
        serverTime={stamp?.serverTime ?? null}
        onSelect={id => navigate(path === '/' ? '/vault' : path, id)}
        onNavigate={p => navigate(p)}
      />
      {primary.stale && <StaleBar ageMs={primary.ageMs} fails={primary.fails} error={primary.error} />}
      <main className={'page' + (path === '/moment' ? ' tight' : '')}>{body()}</main>
      <div className="hints">
        {HINTS.map(([k, label]) => (
          <span className="h" key={k}><kbd>{k}</kbd> {label}</span>
        ))}
      </div>
    </>
  )
}
