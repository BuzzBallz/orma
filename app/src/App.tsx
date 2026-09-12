import { Fragment, useEffect, useRef } from 'react'
import './app.css'
import { API_BASE, API_MIXED_ORIGIN, EXPECTED_CONTRACT, SUSPECT_AFTER_FAILS, SUSPECT_BACKOFF_MS } from './lib/api'
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
import { useState } from 'react'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { WALLETS, WalletProvider, useWallet } from './lib/wallet'
import { ArrowLeft, ArrowUpRight, Check, Copy, Puzzle } from 'lucide-react'

const POLL_MS = 3000

const HINTS: [string, string][] = [
  ['1–5', 'pick a vault'], ['L', 'the book'], ['V', 'this vault'], ['M', 'the moment'], ['space', 'next beat'],
]

/**
 * The technical rail. What whoever is on watch would say, then the facts that are
 * actually true — spec §5.1 rule 3 and §6.5: an instruction, never a spinner, never a
 * skeleton, never an invented figure. Card is used HERE and only here: this is a rail
 * beside the desk, not a feature tile.
 *
 * The state used to be a 40px word floating in the panel. A desk does not shout a
 * headline at you; it prints a status code on a rule and gets on with it.
 */
function Watch({ verdict, tone, said, aside, facts, action }: {
  verdict: string; tone: string
  said: React.ReactNode; aside?: React.ReactNode
  facts: [string, React.ReactNode][]
  action?: React.ReactNode
}) {
  return (
    <Card className="panel watch rail" style={{ ['--status-tone' as string]: tone }}>
      <CardHeader className="rail-head">
        <span className="rail-dot" aria-hidden />
        <CardTitle className="rail-code">{verdict}</CardTitle>
        <span className="spacer" />
        <span className="label">on watch</span>
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

const RUN_CMD = 'node tools/fixture-server.mjs'

/** The command to bring the feed back, in the one status line — never a second strip. */
function RunHint() {
  const [copied, setCopied] = useState(false)
  return (
    <span className="h run">
      <code>{RUN_CMD}</code>
      <Button
        variant="ghost" size="xs" className="btn-term btn-mini"
        onClick={() => {
          navigator.clipboard?.writeText(RUN_CMD).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }, () => {})
        }}
      >
        {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={2.25} />}
        {copied ? 'copied' : 'copy'}
      </Button>
    </span>
  )
}

/** A framed placeholder for the single-instrument desks, so they do not empty out either. */
function GhostDesk({ title }: { title: string }) {
  return (
    <section className="panel ghost-desk rail">
      <h2 className="panel-title">{title}</h2>
      <div className="ghost-lines">
        <span style={{ width: '46%' }} /><span style={{ width: '28%' }} />
        <span style={{ width: '62%' }} /><span style={{ width: '35%' }} />
      </div>
      <div className="empty">Everything on this desk comes from one request. We draw it when it lands, not before.</div>
    </section>
  )
}

/** /vault with nothing selected: one slot, blown up, saying exactly what it is waiting for. */
function SlotDesk() {
  return (
    <section className="panel ghost-desk rail slotdesk">
      <h2 className="panel-title">instrument</h2>
      <div className="slot-big">
        <span className="slot-dash">—</span>
        <span className="slot-say">awaiting feed</span>
      </div>
      <dl className="slot-grid">
        {['grade', 'phase', 'reported nav', 'correct nav', 'divergence', 'redemption'].map(k => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="label">{k}</dt><dd className="num mute">—</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** /moment with nothing selected. Four beats, none of them playable yet. */
function BeatDesk() {
  return (
    <section className="panel ghost-desk rail slotdesk">
      <h2 className="panel-title">the moment</h2>
      <div className="slot-big">
        <span className="slot-dash">—</span>
        <span className="slot-say">no beat until feed</span>
      </div>
      <ol className="beat-list">
        <li><span className="num mute">1</span> the two readers</li>
        <li><span className="num mute">2</span> the gap opens</li>
        <li><span className="num mute">3</span> we publish it</li>
        <li><span className="num mute">4</span> the gate</li>
      </ol>
    </section>
  )
}

/**
 * /oracle. Three rules, stated. This desk explains the method, so it has something true
 * to say with or without a feed — the numbers that obey these rules live on /moment.
 */
function RuleDesk() {
  const RULES: [string, React.ReactNode][] = [
    ['divergence', <>The gap between what a vault <b>reports</b> and what it <b>holds</b>, in basis points. One reader divides total assets by shares; the other subtracts the declared loss first.</>],
    ['declared loss', <>A loss the broker has written down. The correct reader subtracts it; the naive one never sees it. That subtraction is the whole disagreement.</>],
    ['zero is not safety', <>A loss nobody has declared reads fine on <b>both</b> sides. Zero divergence means the two readers agree, not that the vault is sound.</>],
  ]
  return (
    <section className="panel rail ruledesk">
      <h2 className="panel-title">oracle — the three rules</h2>
      <dl className="rulelist">
        {RULES.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="label">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Desk() {
  const tick = useTick()
  const { path, vaultId, navigate } = useRoute()

  // A suspect base (http from https) is still tried — Chrome lets http://localhost through,
  // so the demo laptop running the fixture server behind a Vercel URL genuinely works. It
  // just stops hammering once it is clear nothing is answering. See API_MIXED_ORIGIN.
  const slow = API_MIXED_ORIGIN
    ? { slowAfter: SUSPECT_AFTER_FAILS, slowCapMs: SUSPECT_BACKOFF_MS }
    : undefined
  const wallet = useWallet()
  const health = usePoll<Health>('/api/health', 5000, slow)
  const vaults = usePoll<VaultsResponse>('/api/vaults', path === '/' ? POLL_MS : 15000, slow)
  const detail = usePoll<Detail>(vaultId ? `/api/vaults/${vaultId}` : null, POLL_MS, slow)

  const rows = vaults.data?.vaults ?? []

  // Spec §3 sent a vault-less /vault or /moment back to the book. That rule made both
  // desks UNREACHABLE with no feed — no rows means no id to pick, so the tab bounced you
  // straight back and read as broken. Owner's call: the desks stand on their own and say
  // what they are waiting for. The URL keeps telling the truth either way.

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

  const feedDown = !vaults.data || vaults.fails > 0

  // B3 — the feed coming back is worth exactly one toast, on the edge, never on a timer.
  const wasDown = useRef(false)
  useEffect(() => {
    if (vaults.fails > 0) { wasDown.current = true; return }
    if (wasDown.current && vaults.data) {
      wasDown.current = false
      toast.success('Feed back', { description: `reading again from ${API_BASE}` })
    }
  }, [vaults.fails, vaults.data])

  // C5 — the ground and the veil cost nothing at first paint. They mount on the first
  // idle frame, after the desk and its five slots are already on screen, so noise.png is
  // not even requested while the book is being drawn.
  const [dressed, setDressed] = useState(false)
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200) as unknown as number)
    const id = idle(() => setDressed(true))
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(id as number)
      else clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
    }
  }, [])

  // Views move on a route change, never on first paint.
  const painted = useRef(false)
  useEffect(() => { painted.current = true }, [])

  function body() {
    // Tried, and nothing is answering, from a base we already had reason to doubt. Name
    // the cause instead of leaving five em-dashes unexplained — and the slow poll keeps
    // running, so the desk fills itself the moment an API does show up.
    if (API_MIXED_ORIGIN && !vaults.data && vaults.fails >= SUSPECT_AFTER_FAILS) {
      return (
        <div className="deskgrid down">
          <Watch
            verdict="NO API" tone="var(--warn)"
            said={<>Nothing is answering at that address. The desk is drawn and the book keeps its five slots, but every figure is an em-dash: we do not put a number on screen that nobody sent us.</>}
            aside={<>Point <code>VITE_API_BASE</code> at an https endpoint and the screen fills itself. Nothing else changes.</>}
            facts={[
              ['reading from', API_BASE],
              ['likely cause', API_MIXED_ORIGIN],
              ['failed polls', String(vaults.fails)],
              ['still asking', `every ${SUSPECT_BACKOFF_MS / 1000}s`],
              ['contract', `v${EXPECTED_CONTRACT}`],
            ]}
          />
          <VaultList
            vaults={[]} receivedAt={0} tick={tick}
            status={{ ageMs: vaults.ageMs, fails: vaults.fails, error: vaults.error, contract: EXPECTED_CONTRACT, railOnScreen: true }}
            onOpen={() => navigate('/vault', null)}
          />
        </div>
      )
    }

    if (path === '/oracle') {
      return (
        <div className="deskgrid">
          <RuleDesk />
          <Watch
            verdict="ON /MOMENT" tone="var(--fg-dim)"
            said={<>The published reading already has a home. Publisher, object index, the six on-chain dimensions and the ledger aggregate are band 3 of the moment desk, off the same three-second request.</>}
            aside={<>A second page would read the same object twice.</>}
            action={
              <Button variant="outline" size="sm" className="btn-term" onClick={() => navigate('/moment')}>
                the moment desk <ArrowUpRight size={12} strokeWidth={2.25} />
              </Button>}
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
            <VaultList
              vaults={[]} receivedAt={0} tick={tick}
              status={{ ageMs: vaults.ageMs, fails: vaults.fails, error: vaults.error, contract: EXPECTED_CONTRACT, railOnScreen: true }}
              onOpen={() => navigate('/vault', null)}
            />
          </div>
        )
      }
      return (
        <VaultList
          vaults={rows} receivedAt={vaults.receivedAt} tick={tick}
          stamp={vaults.data ?? undefined}
          status={{ ageMs: vaults.ageMs, fails: vaults.fails, error: vaults.error, contract: EXPECTED_CONTRACT }}
          onOpen={id => navigate('/vault', id)}
        />
      )
    }

    if (!vaultId) {
      return (
        <div className="deskgrid">
          {path === '/vault'
            ? <SlotDesk />
            : <BeatDesk />}
          <Watch
            verdict="NO INSTRUMENT" tone="var(--fg-dim)"
            said={path === '/vault'
              ? <>Nothing is selected. This desk shows one vault at a time — every figure on it comes from one request for that vault, and we have not been asked for one yet.</>
              : <>Nothing is selected. The moment is four beats through one vault, and it has no beat to play until a vault is picked and the feed answers.</>}
            aside={<>Pick one from the book, or press <kbd>1</kbd>…<kbd>5</kbd> once the feed is up.</>}
            action={
              <Button variant="outline" size="sm" className="btn-term" onClick={() => navigate('/', null)}>
                <ArrowLeft size={12} strokeWidth={2.25} /> the book
              </Button>}
            facts={[['reading from', API_BASE], ['instruments on the book', rows.length ? String(rows.length) : '—']]}
          />
        </div>
      )
    }

    if (notFound && !detail.data) {
      return (
        <div className="deskgrid">
          <GhostDesk title="instrument" />
          <Watch
            verdict="NOT ON THE BOOK" tone="var(--warn)"
            said={<>The server answered and it holds nothing under that id. Either it is not ours, or it has not been created yet.</>}
            aside={<>Press <kbd>1</kbd>…<kbd>5</kbd> for an instrument that is on the book. The poll stays on this id in case it shows up.</>}
            action={
              <Button variant="outline" size="sm" className="btn-term" onClick={() => navigate('/', null)}>
                <ArrowLeft size={12} strokeWidth={2.25} /> back to the book
              </Button>}
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

  // The four desks are a real tab set: TabsList lives in the topbar, the routed view is the
  // panel. The root is display:contents, so it carries Radix's context and no layout.
  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={400}>
    <Tabs
      className="tabs-root"
      value={path}
      onValueChange={v => navigate(v as RoutePath)}
    >
      {/* Inert ground: grid, vignette, and a sweep whose period IS the poll. Fixed and
          pointer-events:none — it can never eat a click. Mounted on idle, never before. */}
      {dressed && (
        <div className="ground" aria-hidden style={{ ['--poll' as string]: POLL_MS + 'ms' }}>
          <span className="g-vignette" />
          <span className="g-sweep" />
        </div>
      )}
      {/* Over the desk: scanlines, then the grain. A tube's lines are in front of the
          phosphor, not behind it — behind a 92% panel they read as nothing at all. */}
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
        ledgerIndex={stamp?.ledgerIndex ?? null}
        serverTime={stamp?.serverTime ?? null}
        receivedAt={primary.receivedAt}
        pollMs={POLL_MS}
        onSelect={id => navigate(path === '/' ? '/vault' : path, id)}
      />
      {primary.stale
        ? <StaleBar ageMs={primary.ageMs} fails={primary.fails} error={primary.error} />
        : wallet.missing && (
          <Alert className="wbanner" onClick={wallet.dismissMissing}>
            <Puzzle size={14} strokeWidth={2} aria-hidden />
            <AlertTitle>{WALLETS.find(w => w.kind === wallet.missing)?.name} is not in this browser</AlertTitle>
            <AlertDescription>
              Install it and reload, or paste a classic address to follow the desk read-only.
              Nothing on this screen is behind a wallet.
            </AlertDescription>
          </Alert>
        )}
      <TabsContent value={path}>
        <main className={'page' + (path === '/moment' ? ' tight' : '')}>
          <div key={path} className={painted.current ? 'view' : undefined}>{body()}</div>
        </main>
      </TabsContent>
      {/* One bar at the foot of the screen: how to bring the feed back, then the keys,
          then who built it. Narrow screens keep the first key and drop the rest. */}
      <div className="hints">
        {feedDown && <>
          <RunHint />
          <Separator orientation="vertical" className="hint-sep" />
        </>}
        {HINTS.map(([k, label], i) => (
          <Fragment key={k}>
            {i > 0 && <Separator orientation="vertical" className="hint-sep" />}
            <span className="h key"><kbd>{k}</kbd> {label}</span>
          </Fragment>
        ))}
        <span className="who">built for the XRPL lending hackathon · De Vinci Blockchain, 12–13 Sept 2026</span>
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
