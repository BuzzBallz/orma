/**
 * The figures below are the last set received. It never replaces the screen: a credit
 * reader needs to know the age of what they are looking at, not to have it taken away.
 */
export function StaleBar({ ageMs }: { ageMs: number; fails?: number }) {
  return (
    <div className="feedbar">
      <span className="k">figures withheld</span>
      <span>the numbers below were received {Math.floor(ageMs / 1000)}s ago</span>
    </div>
  )
}
