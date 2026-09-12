import { GRADE_LADDER } from '../lib/grades'
import { FACTORS } from '../lib/credit'

/**
 * How the score is built, what the two value figures mean, and what this screen does when
 * it has not been sent figures. One screen, no specification, no addresses.
 */
export function Methodology({ methodVersion }: { methodVersion?: string }) {
  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel-title">how the internal score is built</h2>
        <p className="caption meth">
          Each facility is measured on five factors. Each factor is scored on its own,
          on the same twenty-step scale from {GRADE_LADDER[0]} to {GRADE_LADDER[GRADE_LADDER.length - 1]}.
          The facility score starts at the weakest of them and is then notched down, one
          step at a time, for each condition that makes the weakest factor worse in
          practice. <b>No weights are applied anywhere.</b> A weighted average would let a
          strong factor pay for a broken one, and coverage that cannot be liquidated is not
          paid for by a healthy payment record.
        </p>
        <table className="op-tbl" style={{ marginTop: 12 }}>
          <thead><tr><th>factor</th><th>what it measures</th></tr></thead>
          <tbody>
            {FACTORS.map(f => (
              <tr key={f.name}><td><b>{f.name}</b></td><td className="op-says">{f.says}</td></tr>
            ))}
            <tr><td><b>Recognition</b></td><td className="op-says">exposure that is past due and still carried at par</td></tr>
            <tr><td><b>Concentration</b></td><td className="op-says">the share of drawn debt held by the largest single exposure</td></tr>
          </tbody>
        </table>
        {methodVersion && (
          <p className="caption meth-note">Methodology note {methodVersion}.</p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">reported value against held value</h2>
        <p className="caption meth">
          A facility states a unit value. That figure is its total assets divided by units
          outstanding. It is not adjusted for a loss the facility has already recognised on
          its own book.
        </p>
        <p className="caption meth">
          The held value takes that recognised loss off first. The gap between the two,
          quoted in basis points, is the amount by which the stated figure overstates what
          the facility can currently realise.
        </p>
        <p className="caption meth">
          <b>A zero gap is not safety.</b> It means the two figures agree. A loss nobody has
          recognised yet is absent from both of them, and reads clean on both sides. The gap
          measures recognition, not soundness — which is why it is read next to the
          asset-performance factor and never on its own.
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">when figures are withheld</h2>
        <p className="caption meth">
          If the calculation agent has not sent figures, this service shows the last set it
          received and says how old it is. It does not carry a stale figure forward as if it
          were current, and it does not estimate one.
        </p>
        <p className="caption meth">
          Where a facility has never been reported on, the line is held open with an em-dash
          in every column. A blank is a blank. Nothing on these screens is modelled,
          interpolated or filled in.
        </p>
        <p className="caption meth">
          Amounts are stated in the reporting currency of the facility, as supplied. Dates
          and times are as supplied, in UTC.
        </p>
      </section>
    </div>
  )
}
