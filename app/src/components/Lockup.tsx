import type { MouseEvent } from 'react'

/**
 * mark.svg, drawn inline. An <img> cannot read this page's colours, so the O and the upper
 * current would stay cream on a light page. Inline, they take the text colour of whichever
 * theme the reader is in; the lower current stays gold in both.
 */
export function Mark({ size }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M32 6c10.5 0 18 8.9 18 21.5S42.5 49 32 49 14 40.1 14 27.5 21.5 6 32 6Zm0 4.6c-5.6 0-8.9 6.6-8.9 16.9s3.3 16.9 8.9 16.9 8.9-6.6 8.9-16.9S37.6 10.6 32 10.6Z"
        fill="currentColor"
      />
      <path
        d="M7 54.2c5.6-3.6 9.9-3.6 14.5-.9 5.2 3 8.4 3.1 12.9.4 5.5-3.3 9.7-3.4 14.8-.6 3.2 1.8 6 1.9 8.8.4"
        stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"
      />
      <path
        d="M11 59.6c5.3-2.6 9.4-2.6 13.7-.4 4.9 2.5 8 2.5 12.2.1 5.2-2.9 9.2-3 14-.6"
        style={{ stroke: 'var(--color-brand-gold)' }} strokeWidth="2.1" strokeLinecap="round"
      />
    </svg>
  )
}

/** Mark and wordmark, as the link home. */
export function Lockup({ small, onClick }: { small?: boolean; onClick?: (e: MouseEvent) => void }) {
  return (
    <a className={'lockup' + (small ? ' lockup-sm' : '')} href="/" aria-label="Orma, Portfolio" onClick={onClick}>
      <Mark />
      <span className="lockup-word">Orma</span>
    </a>
  )
}
