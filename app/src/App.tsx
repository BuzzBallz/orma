import { useEffect, useRef } from 'react'
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

const POLL_MS = 3000

const HINTS: [string, string][] = [
  ['1–5', 'pick a vault'], ['L', 'the book'], ['V', 'this vault'], ['M', 'the moment'], ['space', 'next beat'],
]

/**
 * What whoever is on watch would say, not what a machine would print. One verdict, then
 * a person talking, then the facts that are actually true. Spec §5.1 rule 3 and §6.5:
 * an instruction, never a spinner, never a skeleton, never an invented figure.
 */
function Watch({ verdict, tone, said, aside, facts }: {
  verdict: string; tone: string
  said: React.ReactNode; aside?: React.ReactNode
  facts: [string, React.ReactNode][]
}) {
  return (
    <section className="panel watch" style={{ ['--status-tone' as string]: tone }}>
      <div className="label">on watch</div>
      <div className="verdict">{verdict}</div>
      <p className="said">{said}</p>
      {aside && <p className="said">{aside}</p>}
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="label">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** The command, at the foot of the desk, in mono. Secondary — it is not the headline. */
function RunLine({ extra }: { extra?: React.ReactNode }) {
  return (
    <div className="runline">
      <span className="say">Start the API and the screen fills itself.</span>
      <code>node tools/fixture-server.mjs</code>
      <span className="aside">{extra ?? 'Nothing to click. It reconnects on its own.'}</span>
    </div>
  )
}

/** A framed placeholder for the single-instrument desks, so they do not empty out either. */
function GhostDesk({ title }: { title: string }) {
  return (
    <section className="panel ghost-desk">
      <h2 className="panel-title">{title}</h2>
      <div className="ghost-lines">
        <span style={{ width: '46%' }} /><span style={{ width: '28%' }} />
        <span style={{ width: '62%' }} /><span style={{ width: '35%' }} />
      </div>
      <div className="empty">Everything on this desk comes from one request. We draw it when it lands, not before.</div>
    </section>
  )
}

export default function App() {
  const tick = useTick()
  const { path, vaultId, navigate } = useRoute()

  const health = usePoll<Health>('/api/health', 5000)
  const vaults = usePoll<VaultsResponse>('/api/vaults', path === '/' ? POLL_MS : 15000)
  const detail = usePoll<Detail>(vaultId ? `/api/vaults/${vaultId}` : null, POLL_MS)

  const rows = vaults.data?.vaults ?? []

  // A route with no ?vault= (except / and /oracle) redirects to / — spec §3.
  useEffect(() => {
    if (path !== '/' && path !== '/oracle' && !vaultId) navigate('/', null)
  }, [path, vaultId, navigate])

  // Global keyboard — spec §5.3. Ignored inside form controls and inside the picker.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[data-picker]'))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const n = Number(e.key)
      if (n >= 1 && n <= 5 && rows[n - 1]) {
        // Spec §5.3 rewrites ?vault= in place. The book has no ?vault= to rewrite, so from
        // there a number opens the instrument instead of doing nothing.
        navigate(path === '/' ? '/vault' : path, rows[n - 1].vaultId)
        return
      }

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

  // Views move on a route change, never on first paint.
  const painted = useRef(false)
  useEffect(() => { painted.current = true }, [])

  function body() {
    if (path === '/oracle') {
      return (
        <div className="deskgrid">
          <GhostDesk title="oracle" />
          <Watch
            verdict="ON /MOMENT" tone="var(--accent)"
            said={<>The published reading already has a home. Publisher, object index, the six on-chain dimensions and the ledger aggregate are band 3 of the moment desk, off the same three-second request.</>}
            aside={<>A second page would read the same object twice. Press <kbd>M</kbd>, or{' '}
              <a href="/moment" onClick={e => { e.preventDefault(); navigate('/moment') }}>open it here</a>.</>}
            facts={[['reads', 'oracle object on devnet'], ['computed by', 'the ledger, not by us']]}
          />
        </div>
      )
    }

    if (path === '/') {
      const down = !vaults.data
      if (down) {
        return (
          <div className={vaults.fails > 0 ? 'deskgrid down' : ''}>
            {vaults.fails > 0 && (
              <Watch
                verdict="FEED LOST" tone="var(--bad)"
                said={<>We have lost the feed. The five vaults are still there — we just do not put anything on screen until the server answers.</>}
                aside={<>The poll keeps running in the background, so nobody has to do anything. <b>1–5 picks a vault, the way you would on a desk.</b></>}
                facts={[['reading from', API_BASE], ['it said', vaults.error ?? 'nothing yet'], ['contract', `v${EXPECTED_CONTRACT}`]]}
              />
            )}
            <VaultList vaults={[]} receivedAt={0} tick={tick} onOpen={() => {}} />
            {vaults.fails > 0 && <RunLine />}
          </div>
        )
      }
      return (
        <VaultList
          vaults={rows} receivedAt={vaults.receivedAt} tick={tick}
          stamp={vaults.data}
          onOpen={id => navigate('/vault', id)}
        />
      )
    }

    if (notFound && !detail.data) {
      return (
        <div className="deskgrid">
          <GhostDesk title="instrument" />
          <Watch
            verdict="NOT ON THE BOOK" tone="var(--warn)"
            said={<>The server answered and it holds nothing under that id. Either it is not ours, or it has not been created yet.</>}
            aside={<><a href="/" onClick={e => { e.preventDefault(); navigate('/', null) }}>Back to the book</a>, or press <kbd>1</kbd>…<kbd>5</kbd>. The poll stays on this id in case it shows up.</>}
            facts={[['asked for', short(vaultId, 24)], ['reading from', API_BASE]]}
          />
        </div>
      )
    }

    if (!detail.data) {
      if (detail.fails === 0) return null
      return (
        <div className="deskgrid">
          <GhostDesk title={path === '/moment' ? 'the moment' : 'instrument'} />
          <Watch
            verdict="FEED LOST" tone="var(--bad)"
            said={<>We have lost the feed. This vault is still there — we just do not draw a figure we have not been given.</>}
            aside={<>The poll keeps running. It comes back on its own, no reload.</>}
            facts={[['reading from', API_BASE], ['it said', detail.error ?? 'nothing yet'], ['contract', `v${EXPECTED_CONTRACT}`]]}
          />
        </div>
      )
    }

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
        receivedAt={primary.receivedAt}
        pollMs={POLL_MS}
        onSelect={id => navigate(path === '/' ? '/vault' : path, id)}
        onNavigate={p => navigate(p)}
      />
      {primary.stale && <StaleBar ageMs={primary.ageMs} fails={primary.fails} error={primary.error} />}
      <main className={'page' + (path === '/moment' ? ' tight' : '')}>
        <div key={path} className={painted.current ? 'view' : undefined}>{body()}</div>
      </main>
      <div className="hints">
        {HINTS.map(([k, label]) => (
          <span className="h" key={k}><kbd>{k}</kbd> {label}</span>
        ))}
        <span className="who">built for the XRPL lending hackathon · De Vinci Blockchain, 12–13 Sept 2026</span>
      </div>
    </>
  )
}
