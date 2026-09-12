import { useLayoutEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck } from 'lucide-react'
import type { Health, VaultRow } from '../lib/types'
import type { RoutePath } from '../lib/useRoute'
import { fmtIso } from '../lib/format'
import { FacilityPicker } from './VaultPicker'
import { SignInButton } from './WalletButton'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'

/** Received, or withheld. Those are the only two states a reader needs from this corner. */
function StatusBadge({ health, unreachable }: { health: Health | null; unreachable: boolean }) {
  const withheld = !health || unreachable
  const Icon = withheld ? CircleAlert : CircleCheck
  return (
    <Badge
      variant="outline" className="pill"
      style={{ ['--pill-tone' as string]: withheld ? 'var(--bad)' : 'var(--ok)' }}
    >
      <Icon size={12} strokeWidth={2.25} aria-hidden />
      <span className={'dot' + (withheld ? ' waiting' : '')} />
      {withheld ? 'figures withheld' : 'figures received'}
    </Badge>
  )
}

const DESKS: [RoutePath, string][] = [
  ['/', 'portfolio'], ['/facility', 'facility'], ['/event', 'event'], ['/methodology', 'methodology'],
]

export function HeaderBar({ health, healthUnreachable, vaults, activeVaultId, path, asOf, receivedAt, pollMs, onSelect }: {
  health: Health | null
  healthUnreachable: boolean
  vaults: VaultRow[]
  activeVaultId: string | null
  path: RoutePath
  asOf: string | null
  receivedAt: number
  pollMs: number
  onSelect: (vaultId: string) => void
}) {
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
        <img className="mark" src="/assets/mark.svg" alt="" width={18} height={18} />
        Facility Monitor
      </span>

      <Separator orientation="vertical" className="sep" />

      <span className="statusgroup">
        <StatusBadge health={health} unreachable={healthUnreachable} />
        <span className="tick" aria-hidden>
          <i key={receivedAt} style={{ animationDuration: pollMs + 'ms', animationPlayState: receivedAt ? 'running' : 'paused' }} />
        </span>
      </span>

      {asOf && <>
        <Separator orientation="vertical" className="sep" />
        <span className="meta keep">as of <b>{fmtIso(asOf)}</b></span>
      </>}

      <span className="spacer" />

      <TabsList variant="line" className="desks" ref={nav} aria-label="sections">
        {ind && <span className="desk-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
        {DESKS.map(([p, label]) => (
          <TabsTrigger key={p} value={p} className="desk" data-active={path === p ? 'true' : undefined}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>

      <Separator orientation="vertical" className="sep" />

      <FacilityPicker vaults={vaults} activeVaultId={activeVaultId} onSelect={onSelect} />

      <Separator orientation="vertical" className="sep" />

      <SignInButton />
    </header>
  )
}
