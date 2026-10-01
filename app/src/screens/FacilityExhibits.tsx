import type { BrokerHistory, Collateral } from '../lib/types'
import { GradeLetter } from '../components/GradeLetter'
import { Exhibit } from '../components/Exhibit'
import { fmtIso, short } from '../lib/format'
import { Amount } from '../components/Amount'
import { creditText } from '../lib/credit'

/**
 * Exhibits 3 and 4 of the credit opinion.
 *
 * Both are addressed to the same reader as the rest of the opinion — a credit analyst —
 * so they keep that register. Neither invents a figure: where the calculation agent sent
 * nothing, the exhibit says what is missing and why, rather than rendering a zero.
 *
 * Both are also OPTIONAL. A facility with no manager on file, or no units pledged, is a
 * normal state and not an error. The exhibits are omitted rather than shown empty, so an
 * opinion never carries a section that says nothing.
 */

/** The manager's actions, in the language of a credit file rather than the protocol's. */
const ACTION: Record<string, string> = {
  impair: 'flagged as impaired',
  unimpair: 'impairment withdrawn',
  default: 'declared a loss',
  cover_deposit: 'added first-loss capital',
  cover_withdraw: 'withdrew first-loss capital',
  manage: 'managed',
}

/**
 * EXHIBIT 3 — manager conduct.
 *
 * The finding this exists for: first-loss cover consumed on a default is sized against
 * the manager's TOTAL outstanding book at that moment, not against the exposure that
 * defaulted. Each default shrinks the base for the next one, so the total cover consumed
 * across a fixed set of defaults depends on the ORDER the manager declares them in — and
 * the manager choosing that order is the party whose capital is being consumed.
 *
 * Declaring the largest first minimises their own contribution. Declaring the smallest
 * first maximises it. The difference lands on the investors.
 */
export function ManagerConduct({ h }: { h: BrokerHistory | null }) {
  if (!h) return null
  const { ordering: o, reputation: rep, recommendation: rec } = h
  const assessment = <><GradeLetter grade={rep.grade} scale="conduct" size="sm" /> {rep.score} / 100</>

  return (
    <Exhibit title="Exhibit 3 · Manager conduct" meta={assessment}>
      <div className="kv">
        {/* Named as its own scale. Unlabelled, an "A" here reads two notches below the
            facility's own AA on the scale a few centimetres above it. */}
        <span className="label">Conduct Assessment <span className="cond-scale">A–E</span></span>
        <span className="num">{assessment}</span>
      </div>

      {o.applicable ? (
        <>
          <div className="tbl-wrap">
            <table className="op-tbl">
              <thead>
                <tr><th>First-loss cover consumed</th><th className="rt">Amount</th><th>Basis</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><b>As declared</b></td>
                  <td className="rt num"><Amount drops={o.actualCoverPaid!} /></td>
                  <td className="op-says">the sequence the manager actually chose</td>
                </tr>
                <tr>
                  <td>Best available to investors</td>
                  <td className="rt num"><Amount drops={o.bestPossible!} /></td>
                  <td className="op-says">smallest exposure declared first</td>
                </tr>
                <tr>
                  <td>Worst available to investors</td>
                  <td className="rt num"><Amount drops={o.worstPossible!} /></td>
                  <td className="op-says">largest exposure declared first</td>
                </tr>
                <tr>
                  <td><b>Cost of the sequence chosen</b></td>
                  <td className="rt num"><Amount drops={o.costToDepositors!} /></td>
                  <td className="op-says">borne by investors, not by the manager</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="caption">
            Sequence score <b className="num">{o.fairness}</b>, where 0 is worst for investors
            and 1 best. Same losses either way; only the order differs.
          </p>
        </>
      ) : (
        <p className="caption">Sequence not assessable: {creditText(o.reason ?? '')}.</p>
      )}

      {rep.findings.length > 0 && (
        <div className="tbl-wrap">
          <table className="op-tbl">
            <thead><tr><th>Observation</th></tr></thead>
            <tbody>
              {rep.findings.map(f => (
                <tr key={f.code}><td className="op-says">{creditText(f.detail)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rec.applicable && (
        <p className="caption">
          On current distressed exposures, declaring smallest first would apply{' '}
          <b className="num"><Amount drops={rec.atStakeForDepositors!} /></b> more of the manager's
          own capital to investor losses than declaring largest first.
        </p>
      )}

      <div className="tbl-wrap">
        <table className="op-tbl">
          <thead>
            <tr>
              <th>Action</th><th className="rt">Exposure</th>
              <th className="rt">Book before</th><th className="rt">Cover moved</th><th>When</th>
            </tr>
          </thead>
          <tbody>
            {h.events.length === 0 && (
              <tr><td colSpan={5} className="op-says">No manager action on file.</td></tr>
            )}
            {h.events.map((e, i) => (
              <tr key={(e.hash ?? '') + i}>
                <td><b>{ACTION[e.kind] ?? e.kind.replace(/_/g, ' ')}</b></td>
                {/* A cover movement has no exposure and consumes nothing: its figure is
                    the capital it moved, and it belongs in the cover column with a sign.
                    Rendering three zeros made "added first-loss capital" read as a
                    non-event on the exhibit about first-loss capital. */}
                <td className="rt num">{e.exposure === '0' ? '—' : <Amount drops={e.exposure} />}</td>
                {/* An em-dash, never 0.00. Flagging an exposure leaves the manager's own
                    book untouched, so the record does not state it at that moment. */}
                <td className="rt num">{e.debtBefore === null ? '—' : <Amount drops={e.debtBefore} />}</td>
                <td className="rt num">
                  {e.kind === 'cover_deposit' || e.kind === 'cover_withdraw'
                    ? (e.amount && e.amount !== '0'
                        ? <>{e.kind === 'cover_deposit' ? '+' : '−'}<Amount drops={e.amount} /></>
                        : '—')
                    : <Amount drops={e.coverConsumed} />}
                </td>
                <td className="op-says num">{fmtIso(e.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="caption">{creditText(rep.caveat)}</p>
    </Exhibit>
  )
}

/**
 * EXHIBIT 4 — units of this facility pledged away as collateral.
 *
 * An investor can pledge their units to a second lender. That lender has to value the
 * pledge, and the obvious way to do it — units times the reported unit value — carries
 * the facility's own overstatement straight into the second lender's collateral book.
 *
 * The haircut column is applied to the HELD value, never the reported one: a haircut
 * absorbs price volatility, it does not absorb a misstatement.
 */
export function PledgedCollateral({ c }: { c: Collateral | null }) {
  if (!c || c.pledgeCount === 0) return null

  return (
    <Exhibit title="Exhibit 4 · Units pledged as collateral">
      <div className="tbl-wrap">
        <table className="op-tbl">
          <thead>
            <tr><th>Measure</th><th className="rt">Amount</th><th>Basis</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Value on reported figures</td>
              <td className="rt num"><Amount drops={c.totalValueNaive} /></td>
              <td className="op-says">units × reported unit value</td>
            </tr>
            <tr>
              <td>Value on held figures</td>
              <td className="rt num"><Amount drops={c.totalValueCorrect} /></td>
              <td className="op-says">units × held unit value</td>
            </tr>
            <tr>
              <td><b>Overstatement carried into the pledge</b></td>
              <td className="rt num"><Amount drops={c.totalOverstatement} /></td>
              <td className="op-says">{c.totalOverstatementPct}% of the reported value</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="tbl-wrap">
        <table className="op-tbl">
          <thead>
            <tr>
              <th>Pledge</th><th className="rt">Units</th>
              <th className="rt">Reported</th><th className="rt">Held</th><th className="rt">Lendable</th>
            </tr>
          </thead>
          <tbody>
            {c.pledges.map(p => (
              <tr key={p.escrowId}>
                <td className="op-says">{short(p.escrowId, 6)}</td>
                <td className="rt num">{p.shares}</td>
                <td className="rt num"><Amount drops={p.valueNaive} /></td>
                <td className="rt num"><Amount drops={p.valueCorrect} /></td>
                <td className="rt num"><Amount drops={p.maxLendable} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="caption">
        The discount applies to the held value. A discount absorbs volatility, not an
        overstatement.
      </p>
    </Exhibit>
  )
}
