// Offline check of the ordering verdict when other things happen between two defaults: the order
// the broker chose is judged against the fair and the self-serving one on the same footing.
//   node src/dev/check-conduct.mjs
import { analyseOrdering, reputation } from '../history.mjs'
import { Decimal } from '../num.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const D = (x) => new Decimal(x)
const X = 1_000_000
const broker = { coverRateMinimum: 10000, coverRateLiquidation: 10000 } // 10% x 10%, as on Devnet
// What the ledger takes at a default: ceil(DebtTotal x cmin x cliq), on the book at that moment.
const def = (loanId, principal, debtBefore, coverBefore) => {
  const c = D(debtBefore).times(0.01).ceil()
  return { kind: 'default', loanId, at: null, hash: loanId, principal: D(principal), debtBefore: D(debtBefore), debtAfter: D(debtBefore - principal), coverBefore: D(coverBefore), coverAfter: D(coverBefore).minus(c), coverConsumed: c }
}
const window = { complete: true }
const verdict = (events) => {
  const ordering = analyseOrdering(events, broker, window)
  return [ordering.fairness, reputation(events, ordering, broker, window).findings.map((f) => f.code)[0]]
}

// Book of 10, 20 and 30 XRP. Small one first, then the 20 is repaid, then the 30: the fair order.
const fair = [{ kind: 'impair', loanId: 'L10' }, { kind: 'impair', loanId: 'L30' }, def('L10', 10 * X, 60 * X, 5 * X), def('L30', 30 * X, 30 * X, 5 * X - 600000)]
eq('small first, a repayment in between: fair', verdict(fair), ['1.0000', 'ORDERING_FAIR'])

// Big one first, then a new 50 XRP loan, then the small one: the self-serving order.
const selfServing = [{ kind: 'impair', loanId: 'L30' }, { kind: 'impair', loanId: 'L10' }, def('L30', 30 * X, 40 * X, 5 * X), def('L10', 10 * X, 60 * X, 5 * X - 400000)]
eq('big first, a new loan in between: self-serving', verdict(selfServing), ['0.0000', 'ORDERING_SELF_SERVING'])

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
