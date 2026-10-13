import type { Resolution } from '../lib/types'
import { dropsToXrp } from '../lib/format'
import { Exhibit } from '../components/Exhibit'

/**
 * EXHIBIT 5 — what a second lender can establish from the units alone.
 *
 * The situation this answers: an investor pledges their units of this facility to a
 * different lender as collateral. That lender has no relationship with the facility, no
 * access to its reporting, and no reason to accept a figure anyone hands them. What they
 * have is the units.
 *
 * If the unit itself says where its honest valuation lives, that is enough. The lender
 * reads the instrument, follows what it declares, and prices the pledge. Every step is
 * shown here, including the ones that fail, because a lender being told "this collateral
 * is opaque" is better served than one shown a number with no provenance.
 *
 * The naive alternative is the whole point: units multiplied by the reported unit value
 * carries this facility's own overstatement straight into the second lender's book.
 */

/** The quantity the exhibit prices. A round number, so the arithmetic is checkable by eye. */
const SAMPLE_UNITS = 1_000_000

export function PledgeResolution({ r }: { r: Resolution | null }) {
  if (!r) return null

  const nav = r.nav
  const conf = r.metadata?.conformance
  const pledge = nav?.pledge ?? r.pledge

  return (
    <Exhibit title="Exhibit 5 · What a second lender can establish alone">
      <div className="tbl-wrap">
      <table className="op-tbl">
        <thead><tr><th>Step</th><th>Result</th></tr></thead>
        <tbody>
          {r.steps.map((s, i) => (
            <tr key={i}>
              <td><b>{s.step}</b></td>
              <td className="op-says">
                <span className={s.ok ? 'res-ok' : 'res-no'}>{s.ok ? 'yes' : 'no'}</span>
                {s.detail ? <> · {s.detail}</> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {r.opaque && (
        <p className="caption res-verdict">
          The units carry nothing readable. A lender would have to price them on the
          borrower's word.
        </p>
      )}

      {conf && !conf.conformant && (
        <p className="caption">
          The instrument does not meet the discovery standard
          {conf.missing.length ? <>: missing {conf.missing.join(', ')}</> : null}. It is still
          readable, but catalogues and explorers are not obliged to list it.
        </p>
      )}

      {conf?.taxonomyNote && <p className="caption">{conf.taxonomyNote}</p>}

      {pledge && (
        <>
          <div className="tbl-wrap">
          <table className="op-tbl">
            <thead>
              <tr><th>A pledge of {SAMPLE_UNITS.toLocaleString()} units</th><th className="rt">XRP</th><th>Basis</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Priced on the reported figure</td>
                <td className="rt num">{pledge.valueReported === null ? '—' : dropsToXrp(pledge.valueReported)}</td>
                <td className="op-says">what a lender computes without reading the instrument</td>
              </tr>
              <tr>
                <td><b>Priced on the held figure</b></td>
                <td className="rt num">{pledge.valueHeld === null ? '—' : dropsToXrp(pledge.valueHeld)}</td>
                <td className="op-says">what the instrument itself points to</td>
              </tr>
              <tr>
                <td><b>Overstatement avoided</b></td>
                <td className="rt num">{pledge.overstatement === null ? '—' : dropsToXrp(pledge.overstatement)}</td>
                <td className="op-says">carried into the lender's book if the pledge is priced naively</td>
              </tr>
            </tbody>
          </table>
          </div>
          {pledge.unpriced && <p className="caption res-verdict">{pledge.unpriced}</p>}
        </>
      )}

      {nav && (
        <p className="caption">
          Recompute: <b className="num">({dropsToXrp(nav.provenance.assetsTotal)} − {dropsToXrp(nav.provenance.lossUnrealized)}) ÷ {dropsToXrp(nav.provenance.unitsOutstanding)} = {nav.unitValue.held}</b>,
          ledger <b className="num">{nav.ledgerIndex ?? '—'}</b>.
        </p>
      )}
    </Exhibit>
  )
}
