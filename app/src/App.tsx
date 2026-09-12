import { useEffect } from 'react'
import './app.css'
import { API_BASE } from './lib/api'
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

const HINTS = [
  ['1–5', 'jump to a vault'], ['L', 'the five vaults'], ['V', 'vault detail'],
  ['M', 'the moment'], ['space', 'walk the four beats'],
]

function NoData({ error }: { error: string | null }) {
  return (
    <div className="instruction">
      <div className="lead">No response from {API_BASE}</div>
      <div className="why">
        {error ? `The last attempt failed with: ${error}.` : 'Nothing has answered on that port yet.'}
        {' '}Nothing is cached, so there is no last-good payload to fall back to.
      </div>
      Start the API and this screen fills itself within three seconds:
      <code>node tools/fixture-server.mjs</code>
      <div className="next">
        It serves the five vaults on :8787 with live countdowns. The polling loop is still running —
        you do not need to reload.
      </div>
    </div>
  )
}

function NotFound({ vaultId, onBack }: { vaultId: string | null; onBack: () => void }) {
  return (
    <div className="instruction">
      <div className="lead">no vault {short(vaultId, 12)}</div>
      <div className="why">
        The API answered, but it holds no vault with that id. Polling continues, so if this id is
        about to exist it will appear on its own.
      </div>
      <div className="next">
        <a href="/" onClick={e => { e.preventDefault(); onBack() }}>← the five vaults that do exist</a>
        {' '}· or press <kbd>1</kbd>–<kbd>5</kbd>
      </div>
    </div>
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
    if (path !== '/' && !vaultId) navigate('/', null)
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

  // The header stamp comes from whichever payload the current screen polls.
  const primary = path === '/' ? vaults : detail
  const stamp = path === '/' ? vaults.data : detail.data
  const notFound = detail.code === 'VAULT_NOT_FOUND'

  function body() {
    if (path === '/') {
      if (!vaults.data) return vaults.fails > 0 ? <NoData error={vaults.error} /> : null
      return (
        <VaultList
          vaults={rows} receivedAt={vaults.receivedAt} tick={tick}
          onOpen={id => navigate('/vault', id)}
        />
      )
    }
    if (notFound && !detail.data) return <NotFound vaultId={vaultId} onBack={() => navigate('/', null)} />
    if (!detail.data) return detail.fails > 0 ? <NoData error={detail.error} /> : null
    if (path === '/vault') return <VaultDetail d={detail.data} receivedAt={detail.receivedAt} tick={tick} />
    if (path === '/moment') return <Moment d={detail.data} receivedAt={detail.receivedAt} tick={tick} />
    // S4 is droppable by design (spec §S4): everything on it already exists inside S3 band 3.
    return (
      <div className="instruction">
        <div className="lead">The oracle reading lives on the moment screen</div>
        <div className="why">
          Publisher, object index, the six on-chain dimensions and the ledger aggregate are band 3
          of <a href="/moment" onClick={e => { e.preventDefault(); navigate('/moment') }}>/moment</a>,
          against the same poll. A second page would read the same object twice.
        </div>
        <div className="next">press <kbd>M</kbd></div>
      </div>
    )
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
        stale={primary.stale}
        onSelect={id => navigate(path === '/' ? '/vault' : path, id)}
        onNavigate={p => navigate(p)}
      />
      {primary.stale && <StaleBar ageMs={primary.ageMs} fails={primary.fails} error={primary.error} />}
      <main className={'page' + (path === '/moment' ? ' tight' : '')}>
        {body()}
        <div className="hints">
          {HINTS.map(([k, label]) => (
            <span key={k} style={{ marginRight: 16 }}><kbd>{k}</kbd> {label}</span>
          ))}
        </div>
      </main>
    </>
  )
}
