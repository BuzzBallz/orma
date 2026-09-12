import { EXPECTED_CONTRACT } from '../lib/api'
import type { Health, VaultRow } from '../lib/types'
import type { RoutePath } from '../lib/useRoute'
import { fmtIso, short } from '../lib/format'

/**
 * Spec §8: the source badge is the earliest warning that the demo is misrouted,
 * so it is the one signal that flips even while usePoll still holds the last good
 * health payload. Rendered as a pill: the dot carries the tone, the text stays quiet.
 */
function HealthPill({ health, unreachable }: { health: Health | null; unreachable: boolean }) {
  const [tone, text] = !health || unreachable
    ? ['--bad', 'no feed']
    : health.source === 'devnet'
      ? ['--ok', 'devnet']
      : ['--warn', 'fixtures']
  return (
    <span className="pill" style={{ ['--pill-tone' as string]: `var(${tone})` }}>
      <span className="dot" />
      {text}
    </span>
  )
}

const DESKS: [RoutePath, string][] = [
  ['/', 'list'], ['/vault', 'vault'], ['/moment', 'moment'], ['/oracle', 'oracle'],
]

export function HeaderBar({ health, healthUnreachable, vaults, activeVaultId, path, ledgerIndex, serverTime, onSelect, onNavigate }: {
  health: Health | null
  healthUnreachable: boolean
  vaults: VaultRow[]
  activeVaultId: string | null
  path: RoutePath
  ledgerIndex: number | null
  serverTime: string | null
  onSelect: (vaultId: string) => void
  onNavigate: (path: RoutePath) => void
}) {
  const live = health != null && !healthUnreachable
  const contractMismatch = live && health!.contractVersion !== EXPECTED_CONTRACT

  return (
    <header className="topbar">
      <span className="brand">
        <span className="mark" />
        Vault Fragility Oracle
        <span className="sub">xls-66</span>
      </span>

      <span className="sep" />

      <HealthPill health={health} unreachable={healthUnreachable} />

      <span className="sep" />

      <span className="meta" style={contractMismatch ? { color: 'var(--warn)' } : undefined}>
        {contractMismatch
          ? <>contract <b>{health!.contractVersion}</b> ≠ {EXPECTED_CONTRACT}</>
          : <>contract <b>v{live ? health!.contractVersion : EXPECTED_CONTRACT}</b></>}
      </span>
      <span className="meta">ledger <b>{ledgerIndex ?? '—'}</b></span>
      <span className="meta optional">{fmtIso(serverTime)}</span>

      <span className="spacer" />

      <nav className="desks">
        {DESKS.map(([p, label]) => (
          <button key={p} className="desk" data-active={path === p} onClick={() => onNavigate(p)}>{label}</button>
        ))}
      </nav>

      <span className="sep" />

      <span className="selector">
        <span className="label">vault</span>
        <select
          value={activeVaultId ?? ''}
          onChange={e => {
            onSelect(e.target.value)
            // Hand focus back to the document: §5.3 makes every shortcut ignore events from a
            // select, so leaving focus here would silently kill 1-5 and space for the rest of the demo.
            e.target.blur()
          }}
          aria-label="active vault"
        >
          {activeVaultId && !vaults.some(v => v.vaultId === activeVaultId) && (
            <option value={activeVaultId}>{short(activeVaultId, 12)}</option>
          )}
          {vaults.length === 0 && !activeVaultId && <option value="">no feed</option>}
          {vaults.map((v, i) => (
            <option key={v.vaultId} value={v.vaultId}>
              {i + 1} · {v.label ?? short(v.vaultId, 8)} · {v.grade}
            </option>
          ))}
        </select>
        <span className="chev">▼</span>
      </span>
    </header>
  )
}
