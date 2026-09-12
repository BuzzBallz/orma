import { useEffect, useRef, useState } from 'react'
import './app.css'
import { API_MIXED_ORIGIN, SUSPECT_AFTER_FAILS, SUSPECT_BACKOFF_MS } from './lib/api'
import { usePoll } from './lib/usePoll'
import { useTick } from './lib/useTick'
import { useRoute, type RoutePath } from './lib/useRoute'
import type { Health, VaultDetail as Detail, VaultsResponse } from './lib/types'
import { HeaderBar } from './components/HeaderBar'
import { StaleBar } from './components/StaleBar'
import { Portfolio } from './screens/Portfolio'
import { Facility } from './screens/Facility'
import { Event } from './screens/Event'
import { Methodology } from './screens/Methodology'
import { facilityName } from './lib/credit'
import { fmtIso } from './lib/format'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { WALLETS, WalletProvider, useWallet } from './lib/wallet'
import { ArrowLeft, KeyRound } from 'lucide-react'

const POLL_MS = 3000

/**
 * The note beside the screen when there is nothing to put on it. It states what is known
 * and what is missing, in the same language as the rest of the service — never a spinner,
 * never a placeholder figure.
 */
function Note({ heading, tone, said, aside, facts, action }: {
  heading: string; tone: string
  said: React.ReactNode; aside?: React.ReactNode
  facts: [string, React.ReactNode][]
  action?: React.ReactNode
}) {
  return (
    <Card className="panel watch rail" style={{ ['--status-tone' as string]: tone }}>
      <CardHeader className="rail-head">
        <span className="rail-dot" aria-hidden />
        <CardTitle className="rail-code">{heading}</CardTitle>
        <span className="spacer" />
        <span className="label">status</span>
      </CardHeader>
      <CardContent className="rail-body">
        <p className="said">{said}</p>
        {aside && <p className="said">{aside}</p>}
        {action}
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt className="label">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

/** /facility with nothing selected: the shape of the note, with every field held open. */
function FacilityPlaceholder() {
  return (
    <section className="panel ghost-desk rail slotdesk">
      <h2 className="panel-title">credit opinion</h2>
      <div className="slot-big">
        <span className="slot-dash">—</span>
        <span className="slot-say">no facility selected</span>
      </div>
      <dl className="slot-grid">
        {['internal score', 'outlook', 'status', 'reported vs held', 'coverage', 'remaining term'].map(k => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="label">{k}</dt><dd className="num mute">n.a.</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** /event with nothing selected. */
function EventPlaceholder() {
  return (
    <section className="panel ghost-desk rail slotdesk">
      <h2 className="panel-title">next event</h2>
      <div className="slot-big">
        <span className="slot-dash">—</span>
        <span className="slot-say">no scheduled event on file</span>
      </div>
      <ol className="beat-list">
        <li><span className="num mute">·</span> scheduled payment</li>
        <li><span className="num mute">·</span> period boundary</li>
        <li><span className="num mute">·</span> redemption date</li>
        <li><span className="num mute">·</span> review date</li>
      </ol>
    </section>
  )
}

function Desk() {
  const tick = useTick()
  const { path, vaultId, navigate } = useRoute()

  const slow = API_MIXED_ORIGIN
    ? { slowAfter: SUSPECT_AFTER_FAILS, slowCapMs: SUSPECT_BACKOFF_MS }
    : undefined
  const wallet = useWallet()
  const health = usePoll<Health>('/api/health', 5000, slow)
  const vaults = usePoll<VaultsResponse>('/api/vaults', path === '/' ? POLL_MS : 15000, slow)
  const detail = usePoll<Detail>(vaultId ? `/api/vaults/${vaultId}` : null, POLL_MS, slow)

  const rows = vaults.data?.vaults ?? []
  const withheld = !vaults.data || vaults.fails > 0

  // The keys still work for anyone who finds them; they are not advertised as a feature.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[data-picker]'))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= 5 && rows[n - 1]) {
        navigate(path === '/' ? '/facility' : path, rows[n - 1].vaultId)
        return
      }
      const routes: Record<string, RoutePath> = {
        p: '/', f: '/facility', e: '/event', m: '/methodology',
      }
      const r = routes[e.key.toLowerCase()]
      if (r) navigate(r)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [rows, path, navigate])

  const primary = path === '/' ? vaults : detail
  const stamp = path === '/' ? vaults.data : detail.data
  const notFound = detail.code === 'VAULT_NOT_FOUND'

  const wasWithheld = useRef(false)
  useEffect(() => {
    if (vaults.fails > 0) { wasWithheld.current = true; return }
    if (wasWithheld.current && vaults.data) {
      wasWithheld.current = false
      toast.success('Figures received', { description: 'The portfolio is current again.' })
    }
  }, [vaults.fails, vaults.data])

  const [dressed, setDressed] = useState(false)
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200) as unknown as number)
    const id = idle(() => setDressed(true))
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(id as number)
      else clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
    }
  }, [])

  const painted = useRef(false)
  useEffect(() => { painted.current = true }, [])

  const portfolioStatus = {
    ageMs: vaults.ageMs, fails: vaults.fails, error: vaults.error,
  }

  function body() {
    if (path === '/methodology') {
      return <Methodology methodVersion={detail.data?.score.methodVersion} />
    }

    if (path === '/') {
      if (!vaults.data) {
        return (
          <div className={vaults.fails > 0 ? 'deskgrid down' : ''}>
            {vaults.fails > 0 && (
              <Note
                heading="Figures withheld" tone="var(--bad)"
                said={<>We have not been sent figures. The five facilities are on file; we do not put a number on screen until the figures arrive.</>}
                aside={<>The service keeps asking on its own. Nothing needs to be done here.</>}
                facts={[
                  ['last received', vaults.ageMs > 0 ? `${Math.round(vaults.ageMs / 1000)}s ago` : 'not yet'],
                  ['attempts', String(vaults.fails)],
                ]}
              />
            )}
            <Portfolio
              vaults={[]} receivedAt={0} tick={tick}
              status={{ ...portfolioStatus, railOnScreen: vaults.fails > 0 }}
              onOpen={() => navigate('/facility', null)}
            />
          </div>
        )
      }
      return (
        <Portfolio
          vaults={rows} receivedAt={vaults.receivedAt} tick={tick}
          stamp={vaults.data ?? undefined}
          status={portfolioStatus}
          onOpen={id => navigate('/facility', id)}
        />
      )
    }

    if (!vaultId) {
      return (
        <div className="deskgrid">
          {path === '/facility' ? <FacilityPlaceholder /> : <EventPlaceholder />}
          <Note
            heading="No facility selected" tone="var(--fg-dim)"
            said={path === '/facility'
              ? <>A credit opinion covers one facility. Choose one from the portfolio and the note is written from the figures on file for it.</>
              : <>The calendar covers one facility. Choose one from the portfolio to see what falls due and when.</>}
            aside={<>Nothing on this page is estimated: every date and figure comes from the set we were last sent.</>}
            action={
              <Button variant="outline" size="sm" className="btn-term" onClick={() => navigate('/', null)}>
                <ArrowLeft size={12} strokeWidth={2.25} /> portfolio
              </Button>}
            facts={[['facilities on file', rows.length ? String(rows.length) : '—']]}
          />
        </div>
      )
    }

    if (notFound && !detail.data) {
      return (
        <div className="deskgrid">
          {path === '/facility' ? <FacilityPlaceholder /> : <EventPlaceholder />}
          <Note
            heading="Not on file" tone="var(--warn)"
            said={<>There is no facility on file under that reference. Either it is not covered by this service, or it has not been opened yet.</>}
            aside={<>The reference is kept in case it appears.</>}
            action={
              <Button variant="outline" size="sm" className="btn-term" onClick={() => navigate('/', null)}>
                <ArrowLeft size={12} strokeWidth={2.25} /> portfolio
              </Button>}
            facts={[['reference', vaultId.slice(0, 12).toUpperCase()]]}
          />
        </div>
      )
    }

    if (!detail.data) {
      if (detail.fails === 0) return null
      return (
        <div className="deskgrid">
          {path === '/facility' ? <FacilityPlaceholder /> : <EventPlaceholder />}
          <Note
            heading="Figures withheld" tone="var(--bad)"
            said={<>We have not been sent figures for this facility. It is on file; we will not show a number we were not given.</>}
            aside={<>The service keeps asking. It fills itself in when the figures arrive.</>}
            facts={[['attempts', String(detail.fails)]]}
          />
        </div>
      )
    }

    if (path === '/facility') return <Facility d={detail.data} />
    return <Event d={detail.data} tick={tick} />
  }

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={400}>
    <Tabs
      className="tabs-root"
      value={path}
      onValueChange={v => navigate(v as RoutePath)}
    >
      {dressed && (
        <div className="ground" aria-hidden style={{ ['--poll' as string]: POLL_MS + 'ms' }}>
          <span className="g-vignette" />
          <span className="g-sweep" />
        </div>
      )}
      {dressed && <>
        <span className="veil" aria-hidden />
        <span className="veil-grain" aria-hidden />
      </>}
      <Toaster position="bottom-right" closeButton={false} duration={4000} />

      <HeaderBar
        health={health.data}
        healthUnreachable={health.data === null || health.stale}
        vaults={rows}
        activeVaultId={vaultId}
        path={path}
        asOf={stamp?.serverTime ?? null}
        receivedAt={primary.receivedAt}
        pollMs={POLL_MS}
        onSelect={id => navigate(path === '/' ? '/facility' : path, id)}
      />

      {primary.stale
        ? <StaleBar ageMs={primary.ageMs} fails={primary.fails} />
        : wallet.missing && (
          <Alert className="wbanner" onClick={wallet.dismissMissing}>
            <KeyRound size={14} strokeWidth={2} aria-hidden />
            <AlertTitle>{WALLETS.find(w => w.kind === wallet.missing)?.name} is not available in this browser</AlertTitle>
            <AlertDescription>
              Nothing on these pages is behind a sign-in. Signing in only records who is
              reading; every figure is shown either way.
            </AlertDescription>
          </Alert>
        )}

      <TabsContent value={path}>
        <main className={'page' + (path === '/event' ? ' tight' : '')}>
          <div key={path} className={painted.current ? 'view' : undefined}>{body()}</div>
        </main>
      </TabsContent>

      <div className="hints">
        <span className="h">
          <span className="label">status</span>
          <b>{withheld ? 'figures withheld' : 'figures received'}</b>
        </span>
        <Separator orientation="vertical" className="hint-sep" />
        <span className="h">
          <span className="label">as of</span>
          <b>{stamp?.serverTime ? fmtIso(stamp.serverTime) : '—'}</b>
        </span>
        {vaultId && rows.length > 0 && <>
          <Separator orientation="vertical" className="hint-sep" />
          <span className="h optional">
            <span className="label">facility</span>
            <b>{facilityName(rows.find(r => r.vaultId === vaultId))}</b>
          </span>
        </>}
        <span className="who">
          Figures as supplied by the calculation agent. This service does not announce
          rating actions.
        </span>
      </div>
    </Tabs>
    </TooltipProvider>
  )
}

export default function App() {
  return (
    <WalletProvider>
      <Desk />
    </WalletProvider>
  )
}
