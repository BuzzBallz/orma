import type { Loan, VaultDetail } from '../lib/types'
import { Chip } from '../components/Chip'
import { duration, dropsToXrp, fmtIso, ratioToPct } from '../lib/format'
import { creditText, facilityName } from '../lib/credit'

type Row = { when: string | null; inSeconds: number; what: string; who: string; amount: string | null; tone: '--bad' | '--warn' | '--fg-dim' }

const STATUS_TONE: Record<string, '--bad' | '--warn' | '--fg-dim'> = {
  defaulted: '--bad', defaultable: '--bad', impaired: '--bad',
  overdue: '--warn', due_soon: '--warn',
}

function loanRows(loans: Loan[]): Row[] {
  return loans.flatMap(l => {
    const rows: Row[] = []
    if (l.nextPaymentDueAt) {
      rows.push({
        when: l.nextPaymentDueAt, inSeconds: l.secondsUntilDue,
        what: l.secondsUntilDue < 0 ? 'Payment past due' : 'Scheduled payment',
        who: `Exposure ${l.loanId.slice(0, 8)}`,
        amount: l.periodicPayment,
        tone: STATUS_TONE[l.status] ?? '--fg-dim',
      })
    }
    if (l.secondsUntilDefaultable > 0 && l.status !== 'defaulted' && l.status !== 'closed') {
      rows.push({
        when: null, inSeconds: l.secondsUntilDefaultable,
        what: 'Becomes declarable in default',
        who: `Exposure ${l.loanId.slice(0, 8)}`,
        amount: null, tone: '--warn',
      })
    }
    return rows
  })
}

/**
 * The forward calendar for one facility: what falls due, when, and what it is worth.
 * Every line is a date the calculation agent sent. Nothing is projected forward by us.
 */
export function Event({ d, tick, name }: { d: VaultDetail | null; tick: number; name?: string }) {
  if (!d) return <CalendarSkeleton name={name} />
  const v = d.vault
  const scheduled: Row[] = [
    {
      when: d.phaseInfo.nextBoundaryAt, inSeconds: d.phaseInfo.secondsToNextBoundary,
      what: `${v.phase} period ends`, who: facilityName(v), amount: null, tone: '--fg-dim',
    },
    {
      when: v.redemptionAt, inSeconds: v.secondsToRedemption,
      what: 'Redemption date', who: facilityName(v),
      amount: d.phaseInfo.claimsAtRedemption,
      tone: Number(d.phaseInfo.projectedShortfall) > 0 ? '--bad' : '--fg-dim',
    },
  ]
  const rows: Row[] = [...scheduled, ...loanRows(d.loans)].sort((a, b) => a.inSeconds - b.inSeconds)

  const next = rows[0]
  const shortfall = Number(d.phaseInfo.projectedShortfall) > 0

  return (
    <div className="stack">
      <section className="panel">
        <div className="row" style={{ marginBottom: 14, alignItems: 'baseline' }}>
          <h2 className="panel-title" style={{ margin: 0 }}>next event</h2>
          <span className="num mute" style={{ fontSize: 'var(--t-xs)' }}>{facilityName(v)}</span>
          <span className="spacer" />
          <span className="num mute" style={{ fontSize: 'var(--t-xs)' }}>
            figures received {fmtIso(d.serverTime)}
          </span>
        </div>

        {next ? (
          <div className="ev-lead">
            <div>
              <div className="label">next</div>
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
        <h2 className="panel-title">calendar</h2>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>event</th><th>counterparty</th>
                <th className="rt">amount</th><th className="rt">due</th><th className="rt">date</th>
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
        <h2 className="panel-title">what happens at redemption</h2>
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

/**
 * The calendar before any figures. The four kinds of entry it will hold, each on an
 * em-dash — the shape of the page, with nothing filled in.
 */
function CalendarSkeleton({ name }: { name?: string }) {
  const KINDS = ['Scheduled payment', 'Period boundary', 'Redemption date', 'Review date']
  return (
    <div className="stack">
      <section className="panel">
        <div className="row" style={{ marginBottom: 14, alignItems: 'baseline' }}>
          <h2 className="panel-title" style={{ margin: 0 }}>next event</h2>
          <span className="num mute" style={{ fontSize: 'var(--t-xs)' }}>{name ?? 'no facility selected'}</span>
        </div>
        <p className="caption" style={{ maxWidth: '70ch' }}>
          No scheduled event on file.
          {!name && ' Choose a facility from the portfolio to see what falls due and when.'}
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">calendar</h2>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr><th>event</th><th>counterparty</th><th className="rt">amount</th><th className="rt">due</th><th className="rt">date</th></tr>
            </thead>
            <tbody>
              {KINDS.map(k => (
                <tr key={k} className="ghost">
                  <td className="mute">{k}</td>
                  <td className="mute">—</td>
                  <td className="rt num mute">—</td>
                  <td className="rt num mute">—</td>
                  <td className="rt num mute">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
