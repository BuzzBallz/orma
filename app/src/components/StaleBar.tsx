/** Spec §5.1 rule 2. Full-width, warn-tinted, numbers live. Never replaces the screen. */
export function StaleBar({ ageMs, fails, error }: { ageMs: number; fails: number; error?: string | null }) {
  const secs = Math.floor(ageMs / 1000)
  return (
    <div className="stalebar">
      STALE · last good response {secs}s ago · {fails} failed poll{fails === 1 ? '' : 's'}
      {error ? ` · ${error}` : ''} · figures below are the last payload, still polling
    </div>
  )
}
