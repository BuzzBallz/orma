// Offline check: does coverForOrder reproduce the figures measured on-chain in the
// A3 verification? Loans of 30 and 10 XRP, cmin = cliq = 10%, cover 20 XRP.
// Measured live: BIG-FIRST 500000 drops, SMALL-FIRST 700000 drops.
import { coverForOrder } from '../history.mjs'
import { num, Decimal } from '../num.mjs'
const D0 = 40000000, COVER = 20000000, CMIN = 10000, CLIQ = 10000
const big = num(30000000), small = num(10000000)
const bigFirst = coverForOrder([big, small], D0, CMIN, CLIQ, COVER)
const smallFirst = coverForOrder([small, big], D0, CMIN, CLIQ, COVER)
const rows = [
  ['BIG-FIRST  ', bigFirst, 500000],
  ['SMALL-FIRST', smallFirst, 700000],
]
let pass = true
for (const [label, got, want] of rows) {
  const okv = got.eq(want)
  if (!okv) pass = false
  console.log(`  ${label}  computed ${got.toFixed(0).padStart(7)}  measured on-chain ${String(want).padStart(7)}  ${okv ? 'MATCH' : 'MISMATCH'}`)
}
const swing = smallFirst.minus(bigFirst).div(bigFirst).times(100)
console.log(`  swing ${swing.toFixed(2)}%  (measured 40.00%)  ${swing.toFixed(2) === '40.00' ? 'MATCH' : 'MISMATCH'}`)
// closed form: T = c[k*D0 - sum (k-i)*p_i]
const c = new Decimal(CMIN).div(1e5).times(new Decimal(CLIQ).div(1e5))
const closed = (ps) => c.times(new Decimal(ps.length).times(D0).minus(ps.reduce((a,p,i)=>a.plus(num(p).times(ps.length-1-i)),new Decimal(0))))
console.log(`  closed form big-first   ${closed([big,small]).toFixed(0)}`)
console.log(`  closed form small-first ${closed([small,big]).toFixed(0)}`)
console.log(pass ? '\n  PASS: the module reproduces the on-chain measurements exactly' : '\n  FAIL')
process.exit(pass ? 0 : 1)
