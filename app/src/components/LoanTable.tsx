import type { Loan, LoanStatus } from '../lib/types'
import { dropsToXrp, fmtIso, ratioToPct, rateToPct, short } from '../lib/format'
import { Chip, type Tone } from './Chip'
import { Countdown } from './Countdown'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

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
          <Table className="tbl">
            <TableHeader>
              <TableRow>
                <TableHead>status</TableHead><TableHead>loan</TableHead><TableHead>borrower</TableHead>
                <TableHead className="rt">principal</TableHead><TableHead className="rt">total value</TableHead>
                <TableHead className="rt">rate</TableHead><TableHead className="rt">share of debt</TableHead>
                <TableHead>next payment</TableHead><TableHead className="rt">due</TableHead>
                <TableHead className="rt">defaultable in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loans.map(l => {
                const s = STATUS[l.status] ?? { tone: '--fg-dim' as Tone }
                return (
                  <TableRow key={l.loanId} className={s.row}>
                    <TableCell>
                      <span className={s.pulse ? 'pulse' : undefined}>
                        <Chip tone={s.tone}>{l.status}</Chip>
                      </span>
                      {l.impairable && (
                        <span className="mono" style={{ fontSize: 'var(--t-xs)', color: 'var(--warn)', marginLeft: 10 }}>
                          broker may impair now
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="mono">
                      <a href={l.explorerUrl} target="_blank" rel="noreferrer">{l.loanId.slice(0, 8)}</a>
                    </TableCell>
                    <TableCell className="mono">{short(l.borrower, 10)}</TableCell>
                    <TableCell className="rt">{dropsToXrp(l.principalOutstanding)} XRP</TableCell>
                    <TableCell className="rt">{dropsToXrp(l.totalValueOutstanding)} XRP</TableCell>
                    <TableCell className="rt">{rateToPct(l.interestRate)}</TableCell>
                    <TableCell className="rt">{ratioToPct(l.shareOfDebtTotal)}</TableCell>
                    <TableCell className="mono">{fmtIso(l.nextPaymentDueAt)}</TableCell>
                    <TableCell className="rt">
                      <Countdown seconds={l.secondsUntilDue} receivedAt={receivedAt} tick={tick} />
                    </TableCell>
                    <TableCell className="rt">
                      <Countdown seconds={l.secondsUntilDefaultable} receivedAt={receivedAt} tick={tick} />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
