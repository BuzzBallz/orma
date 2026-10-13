import { ChevronDown } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { facilityName } from '../lib/credit'
import { GradeLetter } from './GradeLetter'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Facilities by name, weakest first — the order the portfolio is already sorted in.
 *
 * One control, three places: in the masthead of the two desks that cover one facility, as
 * the portfolio's one filled button, and full width at the head of those desks on a phone,
 * where the masthead has no room for it.
 */
export function FacilityPicker({ vaults, activeVaultId, onSelect, variant = 'nav' }: {
  vaults: VaultRow[]; activeVaultId: string | null; onSelect: (vaultId: string) => void
  variant?: 'nav' | 'cta' | 'block'
}) {
  const active = vaults.find(v => v.vaultId === activeVaultId) ?? null

  const label = active
    ? facilityName(active)
    : vaults.length ? 'Select a Facility' : 'None on File'

  return (
    <span className="picker" data-picker onKeyDown={e => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={vaults.length === 0}
          className={'picker-btn' + (variant === 'cta' ? ' picker-cta' : variant === 'block' ? ' picker-block' : '')}
        >
          <span className="picker-in">
            <span className="picker-label">{label}</span>
            {active && <GradeLetter grade={active.grade} size="sm" />}
          </span>
          <ChevronDown className="chev" size={16} strokeWidth={1.75} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={variant === 'nav' ? 'end' : 'start'} sideOffset={6} data-picker className="picker-list">
          <DropdownMenuLabel className="picker-head">Facilities · Weakest First</DropdownMenuLabel>
          <DropdownMenuSeparator className="picker-sep" />
          {vaults.map(v => (
            <DropdownMenuItem
              key={v.vaultId}
              onSelect={() => onSelect(v.vaultId)}
              data-current={v.vaultId === activeVaultId}
            >
              <span className="picker-name">{facilityName(v)}</span>
              <GradeLetter grade={v.grade} size="sm" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
