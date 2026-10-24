import type { MouseEvent } from 'react'

/** The symbol, drawn inline so it takes the text colour of the theme (an <img> cannot read the page's colours). */
export function Mark({ size }: { size?: number }) {
  // New identity, "Deux lectures": an eccentric ring, two circles read one inside the other.
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M30 128A98 98 0 1 1 226 128A98 98 0 1 1 30 128ZM66 146A62 62 0 1 0 190 146A62 62 0 1 0 66 146Z" />
    </svg>
  )
}

/** Mark and wordmark, as the link home. Ink on light; gold ring and cream word on dark. */
export function Lockup({ small, onClick }: { small?: boolean; onClick?: (e: MouseEvent) => void }) {
  return (
    <a className={'lockup lockup-img' + (small ? ' lockup-sm' : '')} href="/" aria-label="Orma, Portfolio" onClick={onClick}>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcSet="/assets/brand/orma-lockup-color-dark.svg" />
        <img src="/assets/brand/orma-lockup-ink.svg" alt="" height={small ? 34 : 40} />
      </picture>
    </a>
  )
}

/** New identity, "Deux lectures": the Orma | DESK lockup. Ink on light, gold ring and cream word on dark. */
export function DeskLockup({ onClick }: { onClick?: (e: MouseEvent) => void }) {
  return (
    <a className="lockup lockup-desk" href="/" aria-label="Orma Desk, Portfolio" onClick={onClick}>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcSet="/assets/brand/orma-desk-lockup-color-dark.svg" />
        <img src="/assets/brand/orma-desk-lockup-ink.svg" alt="" height={44} />
      </picture>
    </a>
  )
}
