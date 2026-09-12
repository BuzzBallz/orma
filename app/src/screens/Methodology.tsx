import { GRADE_LADDER } from '../lib/grades'
import { FACTORS } from '../lib/credit'

/** Three blocks, one screen. Enough to read a score, not a specification. */
export function Methodology() {
  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel-title">How the internal score is built</h2>
        <p className="caption meth">
          Five factors, each scored on its own from {GRADE_LADDER[0]} to{' '}
          {GRADE_LADDER[GRADE_LADDER.length - 1]}. For a fixed-term facility the headline
          question is whether claims can be met on the redemption date, so the score{' '}
          <b>starts at that factor</b> and is notched down once for each condition that
          weakens confidence in the answer. <b>No weights are applied</b> — a weighted
          average would let a strong factor pay for a broken one.
        </p>
        <p className="caption meth">
          Every step is shown. A facility can therefore score well on the headline question
          and still carry a weak factor: a loss already written down is a loss the unit
          value has already absorbed, and what remains is whether the cash is there to pay
          the reduced claim.
        </p>
        <table className="op-tbl" style={{ marginTop: 12 }}>
          <thead><tr><th>Factor</th><th>What it measures</th></tr></thead>
          <tbody>
            {FACTORS.map(f => (
              <tr key={f.name}><td><b>{f.name}</b></td><td className="op-says">{f.says}</td></tr>
            ))}
            <tr><td><b>Recognition</b></td><td className="op-says">exposure past due and still carried at par</td></tr>
            <tr><td><b>Concentration</b></td><td className="op-says">share of drawn debt held by the largest single exposure</td></tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 className="panel-title">Reported value against held value</h2>
        <p className="caption meth">
          The reported value is total assets divided by units outstanding. The held value
          takes off a loss the facility has already recognised. The gap between them, in
          basis points, is how far the stated figure overstates what can currently be
          realised.
        </p>
        <p className="caption meth">
          <b>A zero gap is not safety.</b> It means the two figures agree. A loss nobody has
          recognised is absent from both, and reads clean on both sides.
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">When figures are withheld</h2>
        <p className="caption meth">
          The last set received is shown, with its age. A stale figure is never carried
          forward as current and never estimated. A facility never reported on is held open
          with an em-dash in every column.
        </p>
      </section>
    </div>
  )
}
