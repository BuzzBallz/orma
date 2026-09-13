import type { Oracle, OracleContest } from '../lib/types'
import { short, fmtIso } from '../lib/format'

/**
 * EXHIBIT 7 — the score as a ledger object.
 *
 * The third pillar, and the only one that was never on a screen. Everything else in this
 * product is a reading we performed and are asking to be believed. This is the reading
 * written to the ledger as an XLS-47 PriceOracle, where it stops being ours: the six
 * dimensions below are read BACK from the object, raw hex included, so a judge can compare
 * them against the same object in an explorer without taking our word for the encoding.
 *
 * The contest block is the argument for doing it this way at all. A REST API can only be
 * trusted. An oracle object can be disagreed with: a second publisher posts their own
 * reading against the same base asset, `get_aggregate_price` makes rippled compute the
 * median across both, and neither publisher can touch the other's document or the result.
 * The second reading here is the naive one, 1.000000 — the number a metadata-diffing
 * indexer arrives at — so the spread the ledger reports IS the finding, measured by the
 * ledger rather than asserted by us.
 */
export function OracleObject({ o, contest }: { o: Oracle | null; contest?: OracleContest | null }) {
  if (!o?.published) {
    return (
      <section className="op-sec">
        <h3 className="op-h">Exhibit 7 · The score as a ledger object</h3>
        <p className="caption meth">
          Not published for this facility. The figures above are this service's reading and
          nothing on the ledger contradicts or confirms them.
        </p>
      </section>
    )
  }

  return (
    <section className="op-sec">
      <h3 className="op-h">Exhibit 7 · The score as a ledger object</h3>
      <p className="caption meth">
        Not a row in our database. An XLS-47 PriceOracle, keyed to the vault id, carrying six
        dimensions in one document. Read back from the object below, not from what we sent.
      </p>

      <table className="op-tbl" style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Dimension</th><th className="rt">On the ledger</th><th>As stored</th></tr>
        </thead>
        <tbody>
          {o.dimensionsOnChain.map(d => (
            <tr key={d.key}>
              <td><b>{d.key}</b></td>
              <td className="rt num">{d.value}</td>
              <td className="op-says orc-raw">0x{d.raw} · scale {d.scale}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="caption meth" style={{ marginTop: 10 }}>
        Base asset <b className="orc-raw">{o.baseAssetHex}</b>, document <b>{o.oracleDocumentId}</b>,
        published by <b>{short(o.publisher, 10)}</b>
        {o.lastUpdateAt ? <> at <b>{fmtIso(o.lastUpdateAt)}</b></> : null}
        {o.stale ? <> — <span className="res-no">stale</span></> : null}.{' '}
        <a href={o.explorerUrl} target="_blank" rel="noreferrer noopener">{short(o.objectIndex, 10)}</a>
      </p>

      {/* The whole case for a ledger object over an API, made on the ledger. */}
      {contest?.aggregate && (
        <>
          <table className="op-tbl orc-contest" style={{ marginTop: 16 }}>
            <thead>
              <tr><th>Who published a reading</th><th className="rt">NAV</th><th>How they arrived at it</th></tr>
            </thead>
            <tbody>
              {contest.publishers.map((p, i) => (
                <tr key={i}>
                  <td><b>{p.provider}</b> <span className="op-says">{short(p.account, 8)}</span></td>
                  <td className="rt num">{p.nav}</td>
                  <td className="op-says">{p.basis}</td>
                </tr>
              ))}
              <tr className="orc-median">
                <td><b>Median, computed by rippled</b></td>
                <td className="rt num">{contest.aggregate.median}</td>
                <td className="op-says">
                  standard deviation {Number(contest.aggregate.standardDeviation).toFixed(6)}
                  {contest.aggregate.size ? <> across {contest.aggregate.size} publishers</> : null}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="caption meth" style={{ marginTop: 10 }}>
            Neither publisher computed that median and neither can alter the other's document.
            A second reader who thinks we are wrong does not need our permission to say so,
            and the disagreement is then a number on the ledger rather than an argument.
          </p>
        </>
      )}
    </section>
  )
}
