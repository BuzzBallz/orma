import { ChevronDown } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { gradeTone } from '../lib/grades'
import { facilityName } from '../lib/credit'
import { Chip } from './Chip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** Facilities by name, weakest first — the order the portfolio is already sorted in. */
export function FacilityPicker({ vaults, activeVaultId, onSelect }: {
  vaults: VaultRow[]; activeVaultId: string | null; onSelect: (vaultId: string) => void
}) {
  const index = vaults.findIndex(v => v.vaultId === activeVaultId)
  const active = index >= 0 ? vaults[index] : null

  const label = active
    ? facilityName(active)
    : vaults.length ? 'select a facility' : 'none on file'

  return (
    <span className="picker" data-picker onKeyDown={e => e.stopPropagation()}>
      <span className="label">facility</span>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={vaults.length === 0} className="picker-btn">
          <span className="picker-label">{label}</span>
          {active && <Chip tone={gradeTone(active.grade)}>{active.grade}</Chip>}
          <ChevronDown className="chev" size={12} strokeWidth={2.25} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} data-picker className="picker-list">
          <DropdownMenuLabel className="label">facilities · weakest first</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {vaults.map(v => (
            <DropdownMenuItem
              key={v.vaultId}
              onSelect={() => onSelect(v.vaultId)}
              data-current={v.vaultId === activeVaultId}
            >
              <span className="picker-name">{facilityName(v)}</span>
              <span className="spacer" />
              <Chip tone={gradeTone(v.grade)}>{v.grade}</Chip>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
