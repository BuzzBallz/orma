/**
 * The figures below are the last set received. It never replaces the screen: a credit
 * reader needs to know the age of what they are looking at, not to have it taken away.
 */
export function StaleBar({ ageMs }: { ageMs: number; fails?: number }) {
  return (
    <div className="feedbar">
      {/* The badge in the chrome already says figures are withheld. Repeating it here put
          the same two words twice on one screen and left the bar's own job — saying how old
          the figures below are — as an afterthought. The age is the whole point of the bar. */}
      <span className="k">Last Received</span>
      <span>the numbers below are {Math.floor(ageMs / 1000)}s old</span>
    </div>
  )
}
