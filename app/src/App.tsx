import { useEffect, useRef, useState } from 'react'
import './app.css'
import { API_MIXED_ORIGIN, SUSPECT_AFTER_FAILS, SUSPECT_BACKOFF_MS } from './lib/api'
import { usePoll } from './lib/usePoll'
import { facilityName } from './lib/credit'
import { useTick } from './lib/useTick'
import { useRoute, type RoutePath } from './lib/useRoute'
import type { BrokerHistory, Collateral, Gate, Health, IndexerRace, Resolution, VaultDetail as Detail, VaultsResponse } from './lib/types'
import { HeaderBar } from './components/HeaderBar'
import { StaleBar } from './components/StaleBar'
import { Portfolio } from './screens/Portfolio'
import { Facility, Ladder } from './screens/Facility'
import { Event } from './screens/Event'
import { Methodology } from './screens/Methodology'
import { Evidence } from './screens/Evidence'
import { Tabs, TabsContent } from '@/components/ui/tabs'
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
      </div>
      <dl className="slot-grid">
        {['Internal Score', 'Outlook', 'Status', 'Reported vs Held', 'Coverage', 'Remaining Term'].map(k => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="label">{k}</dt><dd className="num mute">n.a.</dd>
          </div>
        ))}
      </dl>
      {/* The scale is part of the document, so it is drawn here too — extinguished, and
          reading an em-dash. Leaving it out would make the withheld desk a different shape
          from the one figures arrive into; lighting a notch would invent a grade. */}
      <Ladder />
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
        p: '/', f: '/facility', e: '/event', m: '/methodology', v: '/evidence',
      }
      const r = routes[e.key.toLowerCase()]
      if (r) navigate(r)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [rows, path, navigate])

  // A finished capture, not a moving figure: fetch it only while its tab is open and
  // do not re-ask every four seconds. null path means usePoll stays idle.
  // Exhibits 3 and 4. Fetched only on the facility tab and only once a facility is
  // chosen, and slowly: a manager's track record is history, not a live figure. A 404
  // here (no manager, no pledges) is a normal state, so usePoll keeps data null and the
  // exhibits omit themselves rather than rendering an error into a credit opinion.
  const histPath = path === '/facility' && vaultId ? `/api/vaults/${vaultId}/broker-history` : null
  const collPath = path === '/facility' && vaultId ? `/api/vaults/${vaultId}/collateral` : null
  const history = usePoll<BrokerHistory>(histPath, 20000)
  // Exhibit 5 is keyed on the SHARE token, not on the vault: it is the lookup a holder
  // has. It needs the detail payload to know the share id, so it starts one poll behind
  // the rest and that is correct -- there is nothing to resolve until we know what the
  // facility issues. 60s: a resolution walks the ledger and then a URL, and neither
  // changes minute to minute.
  const shareId = path === '/facility' ? detail.data?.vault?.shareMptId ?? null : null
  const resolution = usePoll<Resolution>(
    shareId ? `/api/mpt/${shareId}/resolve?units=1000000` : null, 60000)
  const collateral = usePoll<Collateral>(collPath, 20000)
  // An admission rule changes when its owner edits it, not every four seconds.
  const gate = usePoll<Gate>(path === '/facility' && vaultId ? `/api/vaults/${vaultId}/gate` : null, 30000)

  const race = usePoll<IndexerRace>(path === '/evidence' ? '/api/indexer-race' : null, 30000)

  const primary = path === '/' ? vaults : detail
  // The verification screen is not scoped to a facility, so it has no detail payload to
  // date itself from, and the header read "figures received" with no as-of beside it --
  // which invites exactly the question that screen exists to answer. The capture carries
  // its own stamp, so use it.
  //
  // Only for the DATE. Staleness deliberately still comes from `primary`: a capture is a
  // fixed historical artifact polled every 30s, so routing staleness through it would
  // post a permanent "received 12s ago" warning over a transaction that is not going to
  // change. Stale means a live figure stopped arriving. This one already arrived.
  const stamp = path === '/' ? vaults.data : path === '/evidence' ? race.data : detail.data
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

  function body() {
    if (path === '/evidence') {
      // The capture is not facility-scoped, so the page takes its title from whichever
      // facility the picker is holding. With none chosen it falls back to naming the
      // finding rather than borrowing a name the record never claimed.
      const open = vaultId ? rows.find(r => r.vaultId === vaultId) : undefined
      return <Evidence d={race.data} name={open ? facilityName(open) : undefined} />
    }

    if (path === '/methodology') {
      return <Methodology />
    }

    if (path === '/') {
      if (!vaults.data) {
        return (
          <div className={vaults.fails > 0 ? 'deskgrid down' : ''}>
            {vaults.fails > 0 && (
              <Note
                heading="Figures withheld" tone="var(--bad)"
                said={<>The five facilities are on file. No figure is shown until one is received.</>}
                facts={[['Last Received', vaults.ageMs > 0 ? `${Math.round(vaults.ageMs / 1000)}s ago` : 'not yet']]}
              />
            )}
            <Portfolio
              vaults={[]} receivedAt={0} tick={tick}
              onOpen={() => navigate('/facility', null)}
            />
          </div>
        )
      }
      return (
        <Portfolio
          vaults={rows} receivedAt={vaults.receivedAt} tick={tick}
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
              ? <>A credit opinion covers one facility. Choose one from the portfolio.</>
              : <>The calendar covers one facility. Choose one from the portfolio.</>}
            action={
              <Button variant="outline" size="sm" className="btn-term" onClick={() => navigate('/', null)}>
                <ArrowLeft size={12} strokeWidth={2.25} /> portfolio
              </Button>}
            facts={rows.length ? [['facilities on file', String(rows.length)]] : []}
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
            said={<>No facility on file under that reference.</>}
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
            said={<>This facility is on file. No figure is shown until one is received.</>}
            facts={[]}
          />
        </div>
      )
    }

    if (path === '/facility') {
      // usePoll deliberately keeps the last good payload across a path change, so that a
      // blip never blanks the figures. For these two exhibits that same behaviour would
      // attribute one facility's manager -- and their conduct grade -- to the next
      // facility opened, for as long as the new request is in flight. So each exhibit is
      // shown only when the payload identifies ITSELF as belonging to this facility.
      // Matching on the payload's own id is stronger than matching on the url it came
      // from: it survives a redirect, a cache and a race.
      const d = detail.data
      const h = history.data && d.broker && history.data.loanBrokerId === d.broker.loanBrokerId
        ? history.data : null
      const c = collateral.data && d.vault.shareMptId && collateral.data.shareMptId === d.vault.shareMptId
        ? collateral.data : null
      // Same identity check as the other two exhibits: the resolution must name the
      // share token this facility actually issues, or it belongs to a different page.
      const rz = resolution.data && d.vault.shareMptId
        && resolution.data.issuanceId?.toUpperCase() === d.vault.shareMptId.toUpperCase()
        ? resolution.data : null
      const gt = gate.data && gate.data.vaultId?.toUpperCase() === d.vault.vaultId.toUpperCase()
        ? gate.data : null
      return <Facility d={d} history={h} collateral={c} resolution={rz} gate={gt} />
    }
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

      {primary.stale && path !== '/evidence'
        ? <StaleBar ageMs={primary.ageMs} fails={primary.fails} />
        : wallet.missing && (
          <Alert className="wbanner" onClick={wallet.dismissMissing}>
            <KeyRound size={14} strokeWidth={2} aria-hidden />
            <AlertTitle>{WALLETS.find(w => w.kind === wallet.missing)?.name} is not available in this browser</AlertTitle>
            <AlertDescription>Every figure is shown either way.</AlertDescription>
          </Alert>
        )}

      <TabsContent value={path}>
        <main className={'page' + (path === '/event' ? ' tight' : '')}>
          <div key={path} className={painted.current ? 'view' : undefined}>{body()}</div>
        </main>
      </TabsContent>

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
