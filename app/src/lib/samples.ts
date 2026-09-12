import { useEffect, useRef } from 'react'

export interface Sample { t: number; naive: number; correct: number }   // Number() here = PIXEL POSITIONS ONLY

const MAX = 240   // 12 minutes at 3s

/**
 * Ring buffer of NAV readings, keyed by vaultId and CLEARED on vault change (spec §7.3).
 * These feed chart geometry only — every figure printed beside the chart comes from the strings.
 */
export function useSamples(vaultId: string | null, naive: string, correct: string, receivedAt: number): Sample[] {
  const buf = useRef<Sample[]>([])
  const key = useRef<string | null>(null)
  const lastAt = useRef(0)

  if (key.current !== vaultId) { key.current = vaultId; buf.current = []; lastAt.current = 0 }

  useEffect(() => {
    if (receivedAt === 0 || receivedAt === lastAt.current) return
    lastAt.current = receivedAt
    const n = Number(naive), c = Number(correct)
    if (!Number.isFinite(n) || !Number.isFinite(c)) return
    buf.current = [...buf.current, { t: receivedAt, naive: n, correct: c }].slice(-MAX)
  }, [receivedAt, naive, correct])

  return buf.current
}
