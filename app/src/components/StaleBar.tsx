/**
 * The figures below are the last set received. It never replaces the screen: a credit
 * reader needs to know the age of what they are looking at, not to have it taken away.
 */
export function StaleBar({ ageMs }: { ageMs: number }) {
  return (
    <div className="feedbar">
      <div className="wrap bar-in">
        <span className="k">Last Received</span>
        <span className="v">the numbers below are {Math.floor(ageMs / 1000)}s old</span>
      </div>
    </div>
  )
}
