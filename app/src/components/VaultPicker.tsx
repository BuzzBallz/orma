import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { short } from '../lib/format'
import { gradeTone } from '../lib/grades'

/**
 * The instrument picker. A native <select> cannot be styled to match the desk, so this is
 * a listbox: button + options, full keyboard support, and it carries data-picker so the
 * global 1-5 / L / V / M shortcuts stand down while it is open.
 */
export function VaultPicker({ vaults, activeVaultId, onSelect }: {
  vaults: VaultRow[]; activeVaultId: string | null; onSelect: (vaultId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const listId = useId()

  const index = vaults.findIndex(v => v.vaultId === activeVaultId)
  const active = index >= 0 ? vaults[index] : null

  useEffect(() => { if (open) setCursor(index >= 0 ? index : 0) }, [open, index])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    addEventListener('mousedown', onDown)
    return () => removeEventListener('mousedown', onDown)
  }, [open])

  function choose(i: number) {
    const v = vaults[i]
    if (v) onSelect(v.vaultId)
    setOpen(false)
    ;(box.current?.querySelector('button') as HTMLButtonElement | null)?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // While the picker has focus it owns the keyboard, so the desk shortcuts stay quiet.
    e.stopPropagation()
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, vaults.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0) }
    else if (e.key === 'End') { e.preventDefault(); setCursor(vaults.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(cursor) }
  }

  const label = active
    ? `${index + 1} · ${active.label ?? short(active.vaultId, 8)}`
    : activeVaultId ? short(activeVaultId, 12)
    : vaults.length > 0 ? 'select' : 'no feed'

  return (
    <div className="picker" ref={box} data-picker onKeyDown={onKeyDown}>
      <span className="label">vault</span>
      <button
        type="button"
        className="picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={vaults.length === 0}
        onClick={() => setOpen(o => !o)}
      >
        <span className="picker-label">{label}</span>
        {active && <span className="chip" style={{ ['--chip-tone' as string]: `var(${gradeTone(active.grade)})` }}>{active.grade}</span>}
        <ChevronDown className="chev" size={12} strokeWidth={2.25} aria-hidden />
      </button>

      {open && (
        <ul className="picker-list" id={listId} role="listbox" aria-label="instrument">
          {vaults.map((v, i) => (
            <li
              key={v.vaultId}
              role="option"
              aria-selected={v.vaultId === activeVaultId}
              data-cursor={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(i)}
            >
              <span className="num mute" style={{ width: 12 }}>{i + 1}</span>
              <span className="picker-name">{v.label ?? short(v.vaultId, 8)}</span>
              <span className="spacer" />
              <span className="chip" style={{ ['--chip-tone' as string]: `var(${gradeTone(v.grade)})` }}>{v.grade}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
