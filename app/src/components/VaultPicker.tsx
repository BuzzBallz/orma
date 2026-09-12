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

  const label = active ? facilityName(active) : 'select a facility'
  const rows = vaults.length
    ? vaults.map(v => ({ id: v.vaultId, name: facilityName(v), grade: v.grade }))
    : [1, 2, 3, 4, 5].map(n => ({ id: '', name: `Facility ${n}`, grade: null }))

  return (
    <span className="picker" data-picker onKeyDown={e => e.stopPropagation()}>
      <span className="label">facility</span>
      <DropdownMenu>
        <DropdownMenuTrigger className="picker-btn">
          <span className="picker-label">{label}</span>
          {active && <Chip tone={gradeTone(active.grade)}>{active.grade}</Chip>}
          <ChevronDown className="chev" size={12} strokeWidth={2.25} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} data-picker className="picker-list">
          <DropdownMenuLabel className="label">facilities · weakest first</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {rows.map((r, i) => (
            <DropdownMenuItem
              key={r.id || i}
              disabled={!r.id}
              onSelect={() => r.id && onSelect(r.id)}
              data-current={!!r.id && r.id === activeVaultId}
            >
              <span className="picker-name">{r.name}</span>
              <span className="spacer" />
              {r.grade
                ? <Chip tone={gradeTone(r.grade)}>{r.grade}</Chip>
                : <span className="num mute">—</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
