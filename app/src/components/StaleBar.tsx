/**
 * The figures below are the last set we were sent. It never replaces the screen: a credit
 * reader needs to know the age of what they are looking at, not to have it taken away.
 */
export function StaleBar({ ageMs, fails }: { ageMs: number; fails: number }) {
  const secs = Math.floor(ageMs / 1000)
  return (
    <div className="feedbar">
      <span><span className="k">figures withheld</span> · the numbers below are the last set received</span>
      <span><span className="k">received</span> {secs}s ago</span>
      <span><span className="k">attempts since</span> {fails}</span>
      <span className="k">still asking</span>
    </div>
  )
}
