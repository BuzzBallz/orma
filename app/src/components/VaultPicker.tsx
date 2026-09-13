import { ChevronDown } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { facilityName } from '../lib/credit'
import { GradeLetter } from './GradeLetter'
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
    : vaults.length ? 'Select a Facility' : 'None on File'

  return (
    // No caption. The tab beside this already says "Facility"; captioning the control
    // "facility" too put the same word twice in one bar and told the reader nothing about
    // which of the two did what. The tab chooses the view, this chooses the name — and it
    // says which name it is holding, which is the only label it needs.
    <span className="picker" data-picker onKeyDown={e => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={vaults.length === 0} className="picker-btn">
          <span className="picker-label">{label}</span>
          {active && <GradeLetter grade={active.grade} size="sm" />}
          <ChevronDown className="chev" size={12} strokeWidth={2.25} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} data-picker className="picker-list">
          <DropdownMenuLabel className="label">Facilities · Weakest First</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {vaults.map(v => (
            <DropdownMenuItem
              key={v.vaultId}
              onSelect={() => onSelect(v.vaultId)}
              data-current={v.vaultId === activeVaultId}
            >
              <span className="picker-name">{facilityName(v)}</span>
              <span className="spacer" />
              <GradeLetter grade={v.grade} size="sm" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
