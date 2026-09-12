/**
 * Spec §5.1 rule 2. The feed went quiet; the figures below are the last payload
 * the ledger actually served. Never replaces the screen.
 */
export function StaleBar({ ageMs, fails, error }: { ageMs: number; fails: number; error?: string | null }) {
  const secs = Math.floor(ageMs / 1000)
  return (
    <div className="feedbar">
      <span><span className="k">feed stale</span> · figures below are the last payload</span>
      <span><span className="k">last good</span> {secs}s ago</span>
      <span><span className="k">failed polls</span> {fails}</span>
      {error && <span><span className="k">error</span> {error}</span>}
      <span className="k">still polling</span>
    </div>
  )
}
