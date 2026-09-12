import type { Loan, LoanStatus } from '../lib/types'
import { dropsToXrp, fmtIso, ratioToPct, rateToPct, short } from '../lib/format'
import { Chip, type Tone } from './Chip'
import { Countdown } from './Countdown'

/** Closed enum, contract §3.1. An unknown status renders dim with the raw value — never crash. */
const STATUS: Record<LoanStatus, { tone: Tone; row?: 'row-warn' | 'row-bad' | 'row-dead'; pulse?: boolean }> = {
  current:     { tone: '--fg-dim' },
  due_soon:    { tone: '--fg-dim' },
  overdue:     { tone: '--warn', row: 'row-warn' },
  impaired:    { tone: '--bad', row: 'row-bad' },
  defaultable: { tone: '--bad', row: 'row-bad', pulse: true },
  defaulted:   { tone: '--dead', row: 'row-dead' },
  closed:      { tone: '--dead' },
}

export function LoanTable({ loans, receivedAt, tick }: { loans: Loan[]; receivedAt: number; tick: number }) {
  const impairable = loans.filter(l => l.impairable).length

  return (
    <section className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="panel-title" style={{ margin: 0 }}>loans</h2>
        <span className="spacer" />
        {impairable > 0 && (
          <span className="caption">
            {impairable} loan{impairable === 1 ? '' : 's'} overdue and not impaired — impairing is the broker's choice
          </span>
        )}
      </div>

      {loans.length === 0 ? (
        <div className="empty">no loans originated</div>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>status</th><th>loan</th><th>borrower</th>
                <th className="rt">principal</th><th className="rt">total value</th>
                <th className="rt">rate</th><th className="rt">share of debt</th>
                <th>next payment</th><th className="rt">due</th><th className="rt">defaultable in</th>
              </tr>
            </thead>
            <tbody>
              {loans.map(l => {
                const s = STATUS[l.status] ?? { tone: '--fg-dim' as Tone }
                return (
                  <tr key={l.loanId} className={s.row}>
                    <td>
                      <span className={s.pulse ? 'pulse' : undefined}>
                        <Chip tone={s.tone}>{l.status}</Chip>
                      </span>
                      {l.impairable && (
                        <span className="mono" style={{ fontSize: 'var(--t-xs)', color: 'var(--warn)', marginLeft: 10 }}>
                          broker may impair now
                        </span>
                      )}
                    </td>
                    <td className="mono">
                      <a href={l.explorerUrl} target="_blank" rel="noreferrer">{l.loanId.slice(0, 8)}</a>
                    </td>
                    <td className="mono">{short(l.borrower, 10)}</td>
                    <td className="rt">{dropsToXrp(l.principalOutstanding)} XRP</td>
                    <td className="rt">{dropsToXrp(l.totalValueOutstanding)} XRP</td>
                    <td className="rt">{rateToPct(l.interestRate)}</td>
                    <td className="rt">{ratioToPct(l.shareOfDebtTotal)}</td>
                    <td className="mono">{fmtIso(l.nextPaymentDueAt)}</td>
                    <td className="rt">
                      <Countdown seconds={l.secondsUntilDue} receivedAt={receivedAt} tick={tick} />
                    </td>
                    <td className="rt">
                      <Countdown seconds={l.secondsUntilDefaultable} receivedAt={receivedAt} tick={tick} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
