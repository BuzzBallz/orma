import { GRADE_LADDER, letterTone } from '../lib/grades'
import { FACTORS } from '../lib/credit'
import { Scale } from '../components/Scale'

/** Three blocks, one screen. Enough to read a score, not a specification. */
export function Methodology() {
  const N = GRADE_LADDER.length
  return (
    <section className="wrap grid12 meth">
      <div className="meth-main">
        <h1 className="t-display-l">How the internal score is built</h1>
        <p className="t-body-l">
          Five factors, each scored on its own from {GRADE_LADDER[0]} to {GRADE_LADDER[N - 1]}.
          For a fixed-term facility the headline question is whether claims can be met on the
          redemption date, so the score starts at that factor and is notched down once for
          each condition that weakens confidence in the answer. No weights are applied. A
          weighted average would let a strong factor pay for a broken one.
        </p>
        <p className="t-body-l">
          Every step is shown. A facility can therefore score well on the headline question
          and still carry a weak factor: a loss already written down is a loss the unit
          value has already absorbed, and what remains is whether the cash is there to pay
          the reduced claim.
        </p>
        <div className="tbl-wrap fac-list">
          <table className="op-tbl fit">
            <thead><tr><th>Factor</th><th>What it measures</th></tr></thead>
            <tbody>
              {FACTORS.map(f => (
                <tr key={f.name}><td><b>{f.name}</b></td><td className="op-says">{f.says}</td></tr>
              ))}
              <tr><td><b>Recognition</b></td><td className="op-says">exposure past due and still carried at par</td></tr>
              <tr><td><b>Concentration</b></td><td className="op-says">share of drawn debt held by the largest single exposure</td></tr>
            </tbody>
          </table>
        </div>

        <h2 className="t-heading-l">Reported value against held value</h2>
        <p className="t-body-l">
          The reported value is total assets divided by units outstanding. The held value
          takes off a loss the facility has already recognised. The gap between them, in
          basis points, is how far the stated figure overstates what can currently be
          realised.
        </p>
        <div className="meth-zero">
          <p className="t-quote">A zero gap is not safety.</p>
          <p className="t-body-l dim">
            It means the two figures agree. A loss nobody has recognised is absent from both,
            and reads clean on both sides.
          </p>
        </div>

        <h2 className="t-heading-l">When figures are withheld</h2>
        <p className="t-body-l">
          The last set received is shown, with its age. A stale figure is never carried
          forward as current and never estimated. A facility never reported on is held open
          with an em-dash in every column.
        </p>
        <div className="meth-scale"><Scale label={false} /></div>
      </div>

      <aside className="meth-side" aria-label="Internal scale, AAA to D">
        <ol className="ladder-v">
          {GRADE_LADDER.map((g, i) => (
            <li key={g}>
              <b style={{ ['--tone' as string]: `var(${letterTone(g)})` }}>{g}</b>
              <span>{i + 1} of {N}</span>
            </li>
          ))}
        </ol>
      </aside>
    </section>
  )
}
