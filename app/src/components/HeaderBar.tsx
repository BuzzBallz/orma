import { useLayoutEffect, useRef, useState } from 'react'
import { Activity, CircleAlert, Radio } from 'lucide-react'
import { EXPECTED_CONTRACT } from '../lib/api'
import type { Health, VaultRow } from '../lib/types'
import type { RoutePath } from '../lib/useRoute'
import { fmtIso } from '../lib/format'
import { useFlash } from '../lib/useFlash'
import { VaultPicker } from './VaultPicker'
import { WalletButton } from './WalletButton'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * Spec §8: an unreachable /api/health is the earliest warning that the demo is misrouted,
 * so the pill flips even while usePoll still holds the last good health payload.
 * The dot pulses only while the feed is down — a live desk that is waiting, not a dead page.
 */
function HealthPill({ health, unreachable }: { health: Health | null; unreachable: boolean }) {
  const down = !health || unreachable
  const [tone, text] = down
    ? ['--bad', 'no feed']
    : health!.source === 'devnet' ? ['--ok', 'devnet'] : ['--warn', 'fixtures']
  const Icon = down ? CircleAlert : health!.source === 'devnet' ? Radio : Activity
  return (
    <Badge variant="outline" className="pill" style={{ ['--pill-tone' as string]: `var(${tone})` }}>
      <Icon size={12} strokeWidth={2.25} aria-hidden />
      <span className={'dot' + (down ? ' waiting' : '')} />
      {text}
    </Badge>
  )
}

const DESKS: [RoutePath, string][] = [
  ['/', 'list'], ['/vault', 'vault'], ['/moment', 'moment'], ['/oracle', 'oracle'],
]

export function HeaderBar({ health, healthUnreachable, vaults, activeVaultId, path, ledgerIndex, serverTime, receivedAt, pollMs, onSelect }: {
  health: Health | null
  healthUnreachable: boolean
  vaults: VaultRow[]
  activeVaultId: string | null
  path: RoutePath
  ledgerIndex: number | null
  serverTime: string | null
  receivedAt: number
  pollMs: number
  onSelect: (vaultId: string) => void
}) {
  const live = health != null && !healthUnreachable
  const contractMismatch = live && health!.contractVersion !== EXPECTED_CONTRACT
  const ledgerMoved = useFlash(ledgerIndex)

  // The desk indicator slides. Measured, because the labels are not equal width.
  const nav = useRef<HTMLDivElement>(null)
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLButtonElement>('[data-active="true"]')
    if (!el || !nav.current) return
    const a = el.getBoundingClientRect(), b = nav.current.getBoundingClientRect()
    setInd({ x: a.left - b.left, w: a.width })
  }, [path, vaults.length])

  return (
    <header className="topbar">
      <span className="brand">
        {/* Drawn for this project, not the XRPL trademark — see public/assets/README.md. */}
        <img className="mark" src="/assets/mark.svg" alt="" width={18} height={18} />
        Vault Fragility Oracle
        <span className="sub">xls-66</span>
      </span>

      <Separator orientation="vertical" className="sep" />

      <span className="statusgroup">
        <HealthPill health={health} unreachable={healthUnreachable} />
        {/* One poll cycle, drawn. Restarts on every good payload; frozen while the feed is down. */}
        <span className="tick" aria-hidden>
          <i key={receivedAt} style={{ animationDuration: pollMs + 'ms', animationPlayState: receivedAt ? 'running' : 'paused' }} />
        </span>
      </span>

      <Separator orientation="vertical" className="sep" />

      <span className="meta" style={contractMismatch ? { color: 'var(--warn)' } : undefined}>
        {contractMismatch
          ? <>contract <b>{health!.contractVersion}</b> ≠ {EXPECTED_CONTRACT}</>
          : <>contract <b>v{live ? health!.contractVersion : EXPECTED_CONTRACT}</b></>}
      </span>
      <span className={'meta keep' + (ledgerMoved ? ' flash' : '')}>ledger <b>{ledgerIndex ?? '—'}</b></span>
      <span className="meta optional">{fmtIso(serverTime)}</span>

      <span className="spacer" />

      {/* The four desks are real tabs: the routed view below is their panel. Radix gives us
          roving focus and arrow-key travel between desks for free; `data-active` is ours so
          the measured indicator and the CSS do not have to guess at Radix's internals. */}
      <TabsList variant="line" className="desks" ref={nav} aria-label="desks">
        {ind && <span className="desk-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
        {DESKS.map(([p, label]) => (
          <TabsTrigger key={p} value={p} className="desk" data-active={path === p ? 'true' : undefined}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>

      <Separator orientation="vertical" className="sep" />

      <VaultPicker vaults={vaults} activeVaultId={activeVaultId} onSelect={onSelect} />

      <Separator orientation="vertical" className="sep" />

      <WalletButton />
    </header>
  )
}
