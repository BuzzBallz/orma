import { useEffect, useRef, useState } from 'react'

export interface Sample { t: number; naive: number; correct: number }   // Number() here = PIXEL POSITIONS ONLY

const MAX = 240   // 12 minutes at 3s
const EMPTY: Sample[] = []   // stable identity: a fresh [] each render would redraw the chart

/**
 * Ring buffer of NAV readings, keyed by vaultId and cleared on vault change (spec §7.3).
 * These feed chart geometry only — every figure printed beside the chart comes from the strings.
 *
 * The buffer lives in state, not in a ref mutated during render. React 19 may discard and
 * replay a render; a render that cleared a ref would either drop samples or let the effect
 * push into a buffer that no longer belongs to the vault on screen — the stale segment
 * joining two vaults that spec F9.1 explicitly forbids.
 */
export function useSamples(vaultId: string | null, naive: string, correct: string, receivedAt: number): Sample[] {
  const [buf, setBuf] = useState<{ key: string | null; list: Sample[] }>({ key: vaultId, list: EMPTY })
  const lastAt = useRef(0)

  useEffect(() => {
    if (receivedAt === 0 || receivedAt === lastAt.current) return
    lastAt.current = receivedAt
    const n = Number(naive), c = Number(correct)
    if (!Number.isFinite(n) || !Number.isFinite(c)) return
    setBuf(b => {
      // A buffer from another vault is not ours to extend.
      const kept = b.key === vaultId ? b.list : EMPTY
      return { key: vaultId, list: [...kept, { t: receivedAt, naive: n, correct: c }].slice(-MAX) }
    })
  }, [receivedAt, naive, correct, vaultId])

  // A vault whose buffer has not been rebuilt yet shows nothing, never the previous line.
  return buf.key === vaultId ? buf.list : EMPTY
}
