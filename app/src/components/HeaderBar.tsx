import { EXPECTED_CONTRACT } from '../lib/api'
import type { Health, VaultRow } from '../lib/types'
import type { RoutePath } from '../lib/useRoute'
import { Chip } from './Chip'
import { fmtIso, short } from '../lib/format'

/** Spec §8: the source badge is the earliest warning that the demo is misrouted. */
function SourceBadge({ health, unreachable }: { health: Health | null; unreachable: boolean }) {
  // Spec §8: an unreachable /api/health is the earliest warning that the demo is misrouted,
  // so the badge must flip even though usePoll still holds the last good health payload.
  if (!health || unreachable) return <Chip tone="--bad">no health</Chip>
  if (health.source === 'devnet') return <Chip tone="--ok">devnet</Chip>
  return <Chip tone="--warn">fixtures</Chip>
}

export function HeaderBar({ health, healthUnreachable, vaults, activeVaultId, path, ledgerIndex, serverTime, stale, onSelect, onNavigate }: {
  health: Health | null
  healthUnreachable: boolean
  vaults: VaultRow[]
  activeVaultId: string | null
  path: RoutePath
  ledgerIndex: number | null
  serverTime: string | null
  stale: boolean
  onSelect: (vaultId: string) => void
  onNavigate: (path: RoutePath) => void
}) {
  const contractMismatch = health != null && health.contractVersion !== EXPECTED_CONTRACT
  const links: [RoutePath, string][] = [['/', 'list'], ['/vault', 'vault'], ['/moment', 'moment'], ['/oracle', 'oracle']]

  return (
    <header className="header">
      <span className="brand">Vault Fragility Oracle</span>
      <SourceBadge health={health} unreachable={healthUnreachable} />
      <span className="meta" style={contractMismatch && !healthUnreachable ? { color: 'var(--warn)' } : undefined}>
        {contractMismatch && !healthUnreachable
          ? `contract ${health!.contractVersion} ≠ ${EXPECTED_CONTRACT}`
          : `contract v${health?.contractVersion ?? EXPECTED_CONTRACT}`}
      </span>
      <span className="meta">ledger #{ledgerIndex ?? '—'}</span>
      <span className="meta optional">{fmtIso(serverTime)}</span>
      {stale && <Chip tone="--warn">stale</Chip>}
      <span className="spacer" />
      {links.map(([p, label]) => (
        <button key={p} className="navlink" data-active={path === p} onClick={() => onNavigate(p)}>{label}</button>
      ))}
      <select
        value={activeVaultId ?? ''}
        onChange={e => {
          onSelect(e.target.value)
          // Hand focus back to the document: §5.3 makes every shortcut ignore events coming from a
          // select, so leaving focus here would silently kill 1-5 and space for the rest of the demo.
          e.target.blur()
        }}
        aria-label="active vault"
      >
        {activeVaultId && !vaults.some(v => v.vaultId === activeVaultId) && (
          <option value={activeVaultId}>{short(activeVaultId, 12)}</option>
        )}
        {vaults.map((v, i) => (
          <option key={v.vaultId} value={v.vaultId}>
            {i + 1}. {v.label ?? short(v.vaultId, 8)} · {v.grade}
          </option>
        ))}
      </select>
    </header>
  )
}
