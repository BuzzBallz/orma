import { useEffect, useRef } from 'react'
import { duration, formatCountdown, formatElapsed } from '../lib/format'

/**
 * Server-anchored countdown (spec §5.2). The API computed `seconds` from validated-ledger close_time;
 * we only interpolate between polls with performance.now(). Date.now() is never involved.
 */
export function useAnchored(seconds: number, receivedAt: number, tick: number): number {
  const anchor = useRef({ seconds, at: receivedAt || performance.now() })
  useEffect(() => {
    anchor.current = { seconds, at: receivedAt || performance.now() }
  }, [seconds, receivedAt])
  void tick // re-render driver
  return anchor.current.seconds - (performance.now() - anchor.current.at) / 1000
}

/** mode "due": "overdue 7m 00s" / "in 2m 13s". mode "boundary": flips to "passed 15m 00s ago". */
export function Countdown({ seconds, receivedAt, tick, mode = 'due', className }: {
  seconds: number; receivedAt: number; tick: number
  mode?: 'due' | 'boundary' | 'bare'; className?: string
}) {
  const live = useAnchored(seconds, receivedAt, tick)
  const negative = live <= 0
  let text: string
  if (mode === 'boundary') text = negative ? formatElapsed(-live) : 'in ' + duration(live)
  else if (mode === 'bare') text = duration(live)
  else text = formatCountdown(live)
  return (
    <span className={'num ' + (className ?? '')} style={negative && mode === 'due' ? { color: 'var(--bad)' } : undefined}>
      {text}
    </span>
  )
}
