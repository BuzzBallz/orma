import type { VaultDetail } from '../lib/types'
import { beatRows, type Beat } from '../lib/beats'
import { Chip } from '../components/Chip'
import { duration, dropsToXrp, fmtIso, ratioToPct } from '../lib/format'
import { creditText, facilityName } from '../lib/credit'

/**
 * The forward calendar for one facility: what falls due, when, and what it is worth.
 * Every line is a date the calculation agent sent. Nothing is projected forward by us.
 */
export function Event({ d, tick }: { d: VaultDetail; tick: number }) {
  const v = d.vault
  const rows: Beat[] = beatRows(d)

  const next = rows[0]
  const shortfall = Number(d.phaseInfo.projectedShortfall) > 0

  return (
    <div className="stack">
      <section className="panel">
        <div className="row" style={{ marginBottom: 14, alignItems: 'baseline' }}>
          <h2 className="panel-title" style={{ margin: 0 }}>Next Event</h2>
          <span className="num mute" style={{ fontSize: 'var(--t-xs)' }}>{facilityName(v)}</span>
          <span className="spacer" />
          <span className="num mute" style={{ fontSize: 'var(--t-xs)' }}>
            Figures Received {fmtIso(d.serverTime)}
          </span>
        </div>

        {next ? (
          <div className="ev-lead">
            <div>
              <div className="label">Next</div>
              <div className="ev-what">{next.what}</div>
              <div className="ev-who">{next.who}</div>
            </div>
            <div className="ev-when">
              <div className="num ev-in" key={tick % 2}>
                {next.inSeconds < 0 ? `${duration(-next.inSeconds)} past due` : `in ${duration(next.inSeconds)}`}
              </div>
              {next.when && <div className="num mute">{fmtIso(next.when)}</div>}
            </div>
          </div>
        ) : (
          <div className="empty">No scheduled event on file.</div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Calendar</h2>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Event</th><th>Counterparty</th>
                <th className="rt">Amount</th><th className="rt">Due</th><th className="rt">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><Chip tone={r.tone}>{r.what}</Chip></td>
                  <td className="mono" style={{ fontSize: 'var(--t-sm)' }}>{r.who}</td>
                  <td className="rt num">{r.amount ? dropsToXrp(r.amount) : '—'}</td>
                  <td className="rt num">{r.inSeconds < 0 ? `${duration(-r.inSeconds)} ago` : duration(r.inSeconds)}</td>
                  <td className="rt num mute">{r.when ? fmtIso(r.when) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-title">What Happens at Redemption</h2>
        <p className="caption" style={{ maxWidth: '90ch' }}>
          Claims of {dropsToXrp(d.phaseInfo.claimsAtRedemption)} are projected against
          liquidity of {dropsToXrp(d.phaseInfo.liquidityAtRedemption)}.
          {shortfall
            ? <> That is a shortfall of {dropsToXrp(d.phaseInfo.projectedShortfall)}, or{' '}
                {ratioToPct(d.phaseInfo.shortfallPct)} of claims. Redemption is served in the
                order requests arrive, so the shortfall falls on whoever asks last.</>
            : <> Claims are covered.</>}
          {d.phaseInfo.withdrawBlockedReason && <> Withdrawals are currently closed: {creditText(d.phaseInfo.withdrawBlockedReason)}.</>}
        </p>
      </section>
    </div>
  )
}
