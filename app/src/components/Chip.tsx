import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'

export type Tone = '--ok' | '--warn' | '--bad' | '--dead' | '--read-correct' | '--fg-dim' | '--read-naive'

/**
 * The only chip in the app (spec §6.3), now shadcn's Badge underneath: the primitive
 * brings the box, the focus ring and the svg sizing; `.chip` keeps the terminal skin and
 * the tone comes from a CSS custom property, never a new hue.
 */
export function Chip({ tone = '--fg-dim', large = false, title, children }:
  { tone?: Tone; large?: boolean; title?: string; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      className={'chip' + (large ? ' chip-lg' : '')}
      title={title}
      style={{ ['--chip-tone' as string]: `var(${tone})` }}
    >{children}</Badge>
  )
}
