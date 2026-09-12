import { useEffect, useRef, useState } from 'react'
import './app.css'
import { API_MIXED_ORIGIN, SUSPECT_AFTER_FAILS, SUSPECT_BACKOFF_MS } from './lib/api'
import { usePoll } from './lib/usePoll'
import { facilityName } from './lib/credit'
import { useTick } from './lib/useTick'
import { useRoute, type RoutePath } from './lib/useRoute'
import type { Health, VaultDetail as Detail, VaultsResponse } from './lib/types'
import { HeaderBar } from './components/HeaderBar'
import { StaleBar } from './components/StaleBar'
import { Portfolio } from './screens/Portfolio'
import { Facility } from './screens/Facility'
import { Event } from './screens/Event'
import { Methodology } from './screens/Methodology'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { WALLETS, WalletProvider, useWallet } from './lib/wallet'
import { KeyRound } from 'lucide-react'

const POLL_MS = 3000




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

  function body() {
    if (path === '/methodology') {
      return <Methodology />
    }

    // No rail beside the portfolio. The state is in the chrome badge, the table shows
    // em-dashes, and one sentence under the heading says why — the same words in four
    // places is what made the page read as a loop.
    if (path === '/') {
      return (
        <Portfolio
          vaults={rows} receivedAt={vaults.receivedAt} tick={tick}
          onOpen={id => navigate('/facility', id || null)}
        />
      )
    }

    // Both single-facility desks always render their own document, payload or not. An
    // empty view that looks like the previous empty view is how a reader concludes the
    // tabs are decoration — so the structure is what changes, not a status rail.
    const picked = vaultId ? rows.find(r => r.vaultId === vaultId) : undefined
    const selectedName = picked ? facilityName(picked)
      : notFound && vaultId ? `Not on file — ${vaultId.slice(0, 12).toUpperCase()}`
      : undefined

    if (path === '/facility') return <Facility d={detail.data} name={selectedName} />
    return <Event d={detail.data} tick={tick} name={selectedName} />
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
            <AlertDescription>Every figure is shown either way.</AlertDescription>
          </Alert>
        )}

      <TabsContent value={path}>
        <main className="page">
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
