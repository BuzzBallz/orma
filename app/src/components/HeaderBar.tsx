import { useLayoutEffect, useRef, useState } from 'react'
import type { Health, VaultRow } from '../lib/types'
import type { RoutePath } from '../lib/useRoute'
import { fmtIso } from '../lib/format'
import { FacilityPicker } from './VaultPicker'
import { SignInButton } from './WalletButton'
import { Separator } from '@/components/ui/separator'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * Received, or withheld — said by the timestamp itself.
 *
 * This corner used to be a capsule: a tick icon, a pulsing dot, small caps inside a
 * tinted ring. Three devices to carry one fact, and the fact they carried was already
 * sitting next to them as a date. A desk that is current says so by showing the time it
 * is current to; it does not need a badge agreeing with the clock.
 *
 * Withheld, the stamp goes to an em-dash and one word stands beside it in the same weight
 * as the rest of the bar. The only sign of life is a 24px rule under the stamp that draws
 * itself once per poll — a rule, not a pill, and it is the poll interval that drives it,
 * never a decorative loop.
 */
function Stamp({ asOf, withheld, receivedAt, pollMs }: {
  asOf: string | null; withheld: boolean; receivedAt: number; pollMs: number
}) {
  const stamp = !withheld && asOf ? fmtIso(asOf) : null
  return (
    <span className={'stamp' + (withheld ? ' is-withheld' : '')}>
      <span className="stamp-line">
        As of{' '}
        <b className="stamp-val">
          {stamp
            ? <><span className="on-day">{stamp.slice(0, 11)}</span>{stamp.slice(11)}</>
            : '—'}
        </b>
        {withheld && <span className="stamp-state">Withheld</span>}
      </span>
      <span
        className="stamp-beat" aria-hidden
        key={receivedAt}
        style={{ animationDuration: pollMs + 'ms', animationPlayState: receivedAt ? 'running' : 'paused' }}
      />
    </span>
  )
}

// 'Evidence' last, and named for what it proves rather than for how it works: it is the
// only tab addressed to an engineer, and it should not be the first thing an analyst
// reaches for.
/** Protocol documentation. Overridable so a preview build can point at its own copy. */
const DOCS_URL = import.meta.env.VITE_DOCS_URL
  ?? 'https://ormaprotocol.mintlify.site/'

const DESKS: [RoutePath, string][] = [
  ['/', 'Portfolio'], ['/facility', 'Facility'], ['/event', 'Event'], ['/methodology', 'Methodology'],
  ['/evidence', 'Evidence'],
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
        <img className="mark" src="/assets/mark.svg" alt="" width={22} height={22} />
        Orma
      </span>

      <Separator orientation="vertical" className="sep" />

      {/* The date is in its own span so a narrow bar can drop it and keep the clock: on a
          desk that is watched live the time is the part that says the figures are current,
          and the date is today. Splitting it here is what lets the facility picker keep a
          usable width instead of absorbing the whole overflow. */}
      <span className="meta keep">
        <Stamp
          asOf={asOf}
          withheld={!health || healthUnreachable}
          receivedAt={receivedAt}
          pollMs={pollMs}
        />
      </span>

      <span className="spacer" />

      <TabsList variant="line" className="desks" ref={nav} aria-label="sections">
        {ind && <span className="desk-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
        {DESKS.map(([p, label]) => (
          <TabsTrigger key={p} value={p} className="desk" data-active={path === p ? 'true' : undefined}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Not a tab. The protocol documentation is a different document for a different
          reader, it leaves this application, and pretending otherwise by putting it in the
          tab strip would be a small lie about where a click takes you. */}
      <a className="docs-link" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
        Docs
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5h5v5M9.5 2.5 4 8M8 9.5H2.5V4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>

      <Separator orientation="vertical" className="sep" />

      <FacilityPicker vaults={vaults} activeVaultId={activeVaultId} onSelect={onSelect} />

      <Separator orientation="vertical" className="sep" />

      <SignInButton />
    </header>
  )
}
