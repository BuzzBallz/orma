import type { ReactNode } from 'react'
import type { BrokerHistory, Collateral } from '../lib/types'
import { Chip } from '../components/Chip'
import { gradeTone } from '../lib/grades'
import { dropsToXrp, fmtIso, short } from '../lib/format'

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="op-sec">
      <h3 className="op-h">{title}</h3>
      {children}
    </section>
  )
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

  return (
    <Section title="Exhibit 3 · Manager conduct">
      <div className="kv" style={{ marginBottom: 12 }}>
        <dt className="label">Conduct assessment</dt>
        <dd className="num">
          <Chip tone={gradeTone(rep.grade)}>{rep.grade}</Chip> {rep.score} / 100
        </dd>
      </div>

      {o.applicable ? (
        <>
          <table className="op-tbl">
            <thead>
              <tr><th>first-loss cover consumed</th><th className="rt">XRP</th><th>basis</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><b>As declared</b></td>
                <td className="rt num">{dropsToXrp(o.actualCoverPaid!)}</td>
                <td className="op-says">the sequence the manager actually chose</td>
              </tr>
              <tr>
                <td>Best available to investors</td>
                <td className="rt num">{dropsToXrp(o.bestPossible!)}</td>
                <td className="op-says">smallest exposure declared first</td>
              </tr>
              <tr>
                <td>Worst available to investors</td>
                <td className="rt num">{dropsToXrp(o.worstPossible!)}</td>
                <td className="op-says">largest exposure declared first</td>
              </tr>
              <tr>
                <td><b>Cost of the sequence chosen</b></td>
                <td className="rt num">{dropsToXrp(o.costToDepositors!)}</td>
                <td className="op-says">borne by investors, not by the manager</td>
              </tr>
            </tbody>
          </table>
          <p className="caption meth" style={{ marginTop: 10 }}>
            Sequence score <b className="num">{o.fairness}</b> — 0 is the sequence worst for
            investors, 1 the best. Same losses either way; only the order differs.
          </p>
        </>
      ) : (
        <p className="caption meth">
          Sequence not assessable: {o.reason}. Two or more declared losses are needed before
          the order can be said to have cost anything.
        </p>
      )}

      {rep.findings.length > 0 && (
        <table className="op-tbl" style={{ marginTop: 12 }}>
          <thead><tr><th>observation</th></tr></thead>
          <tbody>
            {rep.findings.map(f => (
              <tr key={f.code}><td className="op-says">{f.detail}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      {rec.applicable && (
        <p className="caption meth" style={{ marginTop: 10 }}>
          On current distressed exposures, declaring smallest first would apply{' '}
          <b className="num">{dropsToXrp(rec.atStakeForDepositors!)}</b> XRP more of the
          manager's own capital to investor losses than declaring largest first.
        </p>
      )}

      <table className="op-tbl" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>action</th><th className="rt">exposure</th>
            <th className="rt">book before</th><th className="rt">cover used</th><th>when</th>
          </tr>
        </thead>
        <tbody>
          {h.events.length === 0 && (
            <tr><td colSpan={5} className="op-says">No manager action on file.</td></tr>
          )}
          {h.events.map((e, i) => (
            <tr key={(e.hash ?? '') + i}>
              <td><b>{ACTION[e.kind] ?? e.kind.replace(/_/g, ' ')}</b></td>
              <td className="rt num">{e.exposure === '0' ? '—' : dropsToXrp(e.exposure)}</td>
              {/* An em-dash, never 0.00. Flagging an exposure leaves the manager's own
                  book untouched, so the record does not state it at that moment. */}
              <td className="rt num">{e.debtBefore === null ? '—' : dropsToXrp(e.debtBefore)}</td>
              <td className="rt num">{dropsToXrp(e.coverConsumed)}</td>
              <td className="op-says">{fmtIso(e.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="caption meth" style={{ marginTop: 10 }}>{rep.caveat}</p>
    </Section>
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
    <Section title="Exhibit 4 · Units pledged as collateral">
      <table className="op-tbl">
        <thead>
          <tr><th>measure</th><th className="rt">XRP</th><th>basis</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Value on reported figures</td>
            <td className="rt num">{dropsToXrp(c.totalValueNaive)}</td>
            <td className="op-says">units × reported unit value</td>
          </tr>
          <tr>
            <td>Value on held figures</td>
            <td className="rt num">{dropsToXrp(c.totalValueCorrect)}</td>
            <td className="op-says">units × held unit value</td>
          </tr>
          <tr>
            <td><b>Overstatement carried into the pledge</b></td>
            <td className="rt num">{dropsToXrp(c.totalOverstatement)}</td>
            <td className="op-says">{c.totalOverstatementPct}% of the reported value</td>
          </tr>
        </tbody>
      </table>

      <table className="op-tbl" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>pledge</th><th className="rt">units</th>
            <th className="rt">reported</th><th className="rt">held</th><th className="rt">lendable</th>
          </tr>
        </thead>
        <tbody>
          {c.pledges.map(p => (
            <tr key={p.escrowId}>
              <td className="op-says">{short(p.escrowId, 6)}</td>
              <td className="rt num">{p.shares}</td>
              <td className="rt num">{dropsToXrp(p.valueNaive)}</td>
              <td className="rt num">{dropsToXrp(p.valueCorrect)}</td>
              <td className="rt num">{dropsToXrp(p.maxLendable)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="caption meth" style={{ marginTop: 10 }}>
        Lendable applies the discount to the held value, not the reported one. A discount
        absorbs volatility; it does not absorb an overstatement.
      </p>
    </Section>
  )
}
