import type { ReactNode } from 'react'

export type Tone = '--ok' | '--warn' | '--bad' | '--dead' | '--accent' | '--fg-dim' | '--muted'

/** The only chip in the app (spec §6.3). Toned by a CSS custom property, never a new hue. */
export function Chip({ tone = '--fg-dim', large = false, title, children }:
  { tone?: Tone; large?: boolean; title?: string; children: ReactNode }) {
  return (
    <span
      className={'chip' + (large ? ' chip-lg' : '')}
      title={title}
      style={{ ['--chip-tone' as string]: `var(${tone})` }}
    >{children}</span>
  )
}
