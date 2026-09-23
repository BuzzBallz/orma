import type { ReactNode } from 'react'
import type { VaultDetail } from '../lib/types'
import { beatRows, type Beat } from '../lib/beats'
import { duration, dropsToXrp, fmtIso, ratioToPct } from '../lib/format'
import { creditText, facilityName } from '../lib/credit'

/** A calendar tone, in the colours this product has. */
const TONE: Record<Beat['tone'], string | undefined> = { '--bad': 'loss', '--warn': 'watch', '--fg-dim': undefined }

/** The calendar table. Five columns wide; on a phone each row folds into a card of its own. */
function Calendar({ children }: { children: ReactNode }) {
  return (
    <div className="tbl-wrap">
      <table className="cal">
        <thead>
          <tr>
            <th>Event</th><th>Counterparty</th>
            <th className="rt">Amount</th><th className="rt">Due</th><th className="rt">Date</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

/** The same desk with nothing selected, or nothing received: the calendar's shape, held open. */
export function EventPlaceholder({ name, picker, children }: {
  name?: string; picker?: ReactNode; children?: ReactNode
}) {
  return (
    <>
      <header className="wrap ev-head">
        <div className="ev-head-row">
          <h1 className="t-display-l">Next Event</h1>
          <span className="t-fig-s mute">—</span>
        </div>
        <p className={'t-heading-m ' + (name ? 'dim' : 'mute')}>{name ?? '—'}</p>
        {picker && <div className="op-pick">{picker}</div>}
      </header>
      {children && <section className="wrap state-slot">{children}</section>}
      <section className="wrap">
        <div className="ev-feature grid12">
          <div className="ev-feature-what">
            <span className="t-label-s mute">Next</span>
            <span className="t-display-m mute">—</span>
            <span className="t-fig-s mute">no scheduled event on file</span>
          </div>
        </div>
      </section>
      <section className="wrap ev-cal">
        <h2 className="t-heading-m">Calendar</h2>
        <Calendar>
          {['Scheduled payment', 'Period boundary', 'Redemption date', 'Review date'].map(k => (
            <tr key={k}>
              <td><span className="what mute">{k}</span></td>
              <td className="who">—</td>
              <td className="rt"><span className="fig">—</span></td>
              <td className="rt"><span className="fig">—</span></td>
              <td className="rt"><span className="fig">—</span></td>
            </tr>
          ))}
        </Calendar>
      </section>
    </>
  )
}

/**
 * The forward calendar for one facility: what falls due, when, and what it is worth.
 * Every line is a date the calculation agent sent. Nothing is projected forward by us.
 */
export function Event({ d, picker }: { d: VaultDetail; picker?: ReactNode }) {
  const v = d.vault
  const rows: Beat[] = beatRows(d)
  const next = rows[0]
  const shortfall = Number(d.phaseInfo.projectedShortfall) > 0

  return (
    <>
      <header className="wrap ev-head">
        <div className="ev-head-row">
          <h1 className="t-display-l">Next Event</h1>
          <span className="t-fig-s mute">Figures Received {fmtIso(d.serverTime)}</span>
        </div>
        <p className="t-heading-m dim">{facilityName(v)}</p>
        {picker && <div className="op-pick">{picker}</div>}
      </header>

      <section className="wrap">
        {next ? (
          <div className="ev-feature grid12">
            <div className="ev-feature-what">
              <span className="t-label-s mute">Next</span>
              <span className={'t-display-m ' + (TONE[next.tone] ?? '')}>{next.what}</span>
              <span className="t-fig-s mute">{next.who}</span>
            </div>
            <div className="ev-feature-when">
              <span className="t-fig-l">
                {next.inSeconds < 0 ? `${duration(-next.inSeconds)} past due` : `in ${duration(next.inSeconds)}`}
              </span>
              {next.when && <span className="t-fig-s mute">{fmtIso(next.when)}</span>}
            </div>
          </div>
        ) : (
          <div className="ev-feature grid12">
            <p className="ev-feature-what t-body-l dim">No scheduled event on file.</p>
          </div>
        )}
      </section>

      <section className="wrap ev-cal">
        <h2 className="t-heading-m">Calendar</h2>
        <Calendar>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><span className={'what ' + (TONE[r.tone] ?? '')}>{r.what}</span></td>
              <td className="who">{r.who}</td>
              <td className="rt"><span className="fig">{r.amount ? dropsToXrp(r.amount) : '—'}</span></td>
              <td className="rt"><span className="fig">{r.inSeconds < 0 ? `${duration(-r.inSeconds)} ago` : duration(r.inSeconds)}</span></td>
              <td className="rt"><span className="fig">{r.when ? fmtIso(r.when) : '—'}</span></td>
            </tr>
          ))}
        </Calendar>
      </section>

      <section className="wrap ev-what">
        <h2 className="t-heading-m">What happens at redemption</h2>
        <p className="t-body-l">
          Claims of {dropsToXrp(d.phaseInfo.claimsAtRedemption)} are projected against
          liquidity of {dropsToXrp(d.phaseInfo.liquidityAtRedemption)}.
          {shortfall
            ? <> <span className="loss">That is a shortfall of {dropsToXrp(d.phaseInfo.projectedShortfall)}, or{' '}
                {ratioToPct(d.phaseInfo.shortfallPct)} of claims.</span> Redemption is served in the
                order requests arrive, so the shortfall falls on whoever asks last.</>
            : <> <span className="ok strong">Claims are covered.</span></>}
          {d.phaseInfo.withdrawBlockedReason && <> Withdrawals are currently closed: {creditText(d.phaseInfo.withdrawBlockedReason)}.</>}
        </p>
      </section>
    </>
  )
}
