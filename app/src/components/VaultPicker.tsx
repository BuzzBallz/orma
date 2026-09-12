import { ChevronDown } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { short } from '../lib/format'
import { gradeTone } from '../lib/grades'
import { Chip } from './Chip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The instrument selector, on shadcn's DropdownMenu (Radix underneath): keyboard
 * navigation, focus trapping and dismissal come from the primitive rather than from
 * hand-written listbox code. It keeps data-picker so the global 1-5 / L / V / M
 * shortcuts stand down while it has focus (spec §5.3).
 */
export function VaultPicker({ vaults, activeVaultId, onSelect }: {
  vaults: VaultRow[]; activeVaultId: string | null; onSelect: (vaultId: string) => void
}) {
  const index = vaults.findIndex(v => v.vaultId === activeVaultId)
  const active = index >= 0 ? vaults[index] : null

  const label = active
    ? `${index + 1} · ${active.label ?? short(active.vaultId, 8)}`
    : activeVaultId ? short(activeVaultId, 12)
    : vaults.length ? 'select' : 'no feed'

  return (
    <span className="picker" data-picker onKeyDown={e => e.stopPropagation()}>
      <span className="label">vault</span>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={vaults.length === 0} className="picker-btn">
          <span className="picker-label">{label}</span>
          {active && <Chip tone={gradeTone(active.grade)}>{active.grade}</Chip>}
          <ChevronDown className="chev" size={12} strokeWidth={2.25} aria-hidden />
        </DropdownMenuTrigger>
        {/* data-picker rides the portalled content too: it lands on <body>, outside the
            span above, and the global 1-5 shortcuts must stand down inside it as well. */}
        <DropdownMenuContent align="end" sideOffset={6} data-picker className="picker-list">
          <DropdownMenuLabel className="label">instruments · worst first</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {vaults.map((v, i) => (
            <DropdownMenuItem
              key={v.vaultId}
              onSelect={() => onSelect(v.vaultId)}
              data-current={v.vaultId === activeVaultId}
            >
              <span className="num mute" style={{ width: 12 }}>{i + 1}</span>
              <span className="picker-name">{v.label ?? short(v.vaultId, 8)}</span>
              <span className="spacer" />
              <Chip tone={gradeTone(v.grade)}>{v.grade}</Chip>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
