import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import './app.css'
import { API_MIXED_ORIGIN, SUSPECT_AFTER_FAILS, SUSPECT_BACKOFF_MS } from './lib/api'
import { usePoll } from './lib/usePoll'
import { facilityName } from './lib/credit'
import { follow, useRoute, type RoutePath } from './lib/useRoute'
import type { BrokerHistory, Collateral, Gate, Health, IndexerRace, OracleContest, Resolution, VaultDetail as Detail, VaultsResponse } from './lib/types'
import { HeaderBar } from './components/HeaderBar'
import { Footer } from './components/Footer'
import { StaleBar } from './components/StaleBar'
import { FacilityPicker } from './components/VaultPicker'
import { Portfolio } from './screens/Portfolio'
import { Facility, FacilityPlaceholder } from './screens/Facility'
import { Event, EventPlaceholder } from './screens/Event'
import { Methodology } from './screens/Methodology'
import { Evidence } from './screens/Evidence'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { WALLETS, WalletProvider, useWallet } from './lib/wallet'
import { ArrowLeft, KeyRound } from 'lucide-react'

const POLL_MS = 3000

/**
 * The note on a desk with nothing to put on it. It states what is known and what is
 * missing, in the same language as the rest of the service — never a spinner, never a
 * placeholder figure.
 */
function Note({ heading, watch, said, facts, onBack }: {
  heading: string; watch?: boolean; said: ReactNode
  facts: [string, ReactNode][]
  onBack: () => void
}) {
  return (
    <div className={'state' + (watch ? ' state-watch' : '')}>
      <h2 className="t-heading-s">{heading}</h2>
      <p className="t-body-s dim">{said}</p>
      <a className="lnk" href="/" onClick={e => follow(e, onBack)}>
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden /> Portfolio
      </a>
      {facts.length > 0 && (
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
    </div>
  )
}

function Desk() {
  const { path, vaultId, navigate } = useRoute()

  // A desk rises into place when a reader clicks to it, but not on the first paint and
  // not when the keyboard took them there: a shortcut is used too often to be animated.
  const quiet = useRef(true)
  const go = useCallback((p: RoutePath, id?: string | null) => {
    quiet.current = false
    navigate(p, id)
  }, [navigate])

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
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[data-picker], [role="dialog"]'))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= 5 && rows[n - 1]) {
        quiet.current = true
        navigate(path === '/' ? '/facility' : path, rows[n - 1].vaultId)
        return
      }
      const routes: Record<string, RoutePath> = {
        p: '/', f: '/facility', e: '/event', m: '/methodology', v: '/evidence',
      }
      const r = routes[e.key.toLowerCase()]
      if (r) { quiet.current = true; navigate(r) }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [rows, path, navigate])

  // Exhibits 3 and 4. Fetched only on the facility desk and only once a facility is
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

  // The contestability capture. A fixed historical artifact like the race capture, and on
  // the facility desk because that is where the oracle object it argues about lives.
  const contest = usePoll<OracleContest>(path === '/facility' ? '/api/oracle-aggregate' : null, 60000)

  const primary = path === '/' ? vaults : detail
  // The verification screen is not scoped to a facility, so it dates itself from its own
  // capture. Only the DATE: staleness still comes from `primary`, because a capture is a
  // fixed historical artifact and "stale" means a live figure stopped arriving.
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

  const select = (id: string) => go(path === '/' || path === '/evidence' ? '/facility' : path, id)
  const back = () => go('/', null)
  // On a phone the masthead has no room for the picker, so the two desks that cover one
  // facility carry it at their head instead.
  const picker = <FacilityPicker vaults={rows} activeVaultId={vaultId} onSelect={select} variant="block" />

  function body() {
    if (path === '/evidence') {
      // The capture names its own facility, so nothing here does. Passing the picked
      // facility's name put one facility's name over another's figures.
      return <Evidence d={race.data} />
    }

    if (path === '/methodology') return <Methodology />

    if (path === '/') {
      // With nothing received the same page is drawn, reading em-dash; the masthead
      // already says the figures are withheld.
      return (
        <Portfolio
          vaults={rows} received={vaults.data !== null} asOf={vaults.data?.serverTime ?? null}
          onOpen={id => go('/facility', id)} onNavigate={go}
        />
      )
    }

    const Placeholder = path === '/facility' ? FacilityPlaceholder : EventPlaceholder

    if (!vaultId) {
      return (
        <Placeholder picker={picker}>
          <Note
            heading="No facility selected"
            said={path === '/facility'
              ? <>A credit opinion covers one facility. Choose one from the portfolio.</>
              : <>The calendar covers one facility. Choose one from the portfolio.</>}
            facts={rows.length ? [['Facilities on File', String(rows.length)]] : []}
            onBack={back}
          />
        </Placeholder>
      )
    }

    if (notFound && !detail.data) {
      return (
        <Placeholder picker={picker}>
          <Note
            heading="Not on file" watch
            said={<>No facility on file under that reference.</>}
            facts={[['Reference', vaultId.slice(0, 12).toUpperCase()]]}
            onBack={back}
          />
        </Placeholder>
      )
    }

    if (!detail.data) {
      if (detail.fails === 0) return null
      // The blotter already knows this facility's name even while its detail is
      // unreachable, so the page can be headed properly instead of by an em-dash.
      const known = rows.find(r => r.vaultId === vaultId)
      return (
        <Placeholder name={known ? facilityName(known) : undefined} picker={picker}>
          <p className="t-body-m dim">This facility is on file. No figure is shown until one is received.</p>
        </Placeholder>
      )
    }

    if (path === '/facility') {
      // usePoll deliberately keeps the last good payload across a path change, so that a
      // blip never blanks the figures. For these exhibits that same behaviour would
      // attribute one facility's manager -- and their conduct grade -- to the next
      // facility opened, for as long as the new request is in flight. So each exhibit is
      // shown only when the payload identifies ITSELF as belonging to this facility.
      const d = detail.data
      const h = history.data && d.broker && history.data.loanBrokerId === d.broker.loanBrokerId
        ? history.data : null
      const c = collateral.data && d.vault.shareMptId && collateral.data.shareMptId === d.vault.shareMptId
        ? collateral.data : null
      const rz = resolution.data && d.vault.shareMptId
        && resolution.data.issuanceId?.toUpperCase() === d.vault.shareMptId.toUpperCase()
        ? resolution.data : null
      const gt = gate.data && gate.data.vaultId?.toUpperCase() === d.vault.vaultId.toUpperCase()
        ? gate.data : null
      return <Facility d={d} history={h} collateral={c} resolution={rz} gate={gt} contest={contest.data} picker={picker} />
    }
    return <Event d={detail.data} picker={picker} />
  }

  const missing = wallet.missing && WALLETS.find(w => w.kind === wallet.missing)?.name

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={400}>
      <a className="skip" href="#main">Skip to content</a>
      <Toaster position="bottom-right" closeButton={false} duration={4000} />

      <HeaderBar
        vaults={rows}
        activeVaultId={vaultId}
        path={path}
        asOf={stamp?.serverTime ?? null}
        withheld={!health.data || health.stale}
        slide={!quiet.current}
        onNavigate={go}
        onSelect={select}
      />

      {primary.stale && path !== '/evidence'
        ? <StaleBar ageMs={primary.ageMs} />
        : missing && (
          <button type="button" className="wbanner" onClick={wallet.dismissMissing}>
            <span className="wrap bar-in">
              <KeyRound size={16} strokeWidth={1.75} aria-hidden />
              <span className="k">{missing} is not available in this browser</span>
              <span className="v">Every figure is shown either way.</span>
            </span>
          </button>
        )}

      <main id="main" className="page" tabIndex={-1}>
        <div key={path} className={'view' + (quiet.current ? '' : ' enter')}>{body()}</div>
      </main>

      <Footer vaultId={vaultId} onNavigate={go} />
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
