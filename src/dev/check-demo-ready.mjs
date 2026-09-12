/**
 * Is the demonstration presentable right now?
 *
 * Exits 2 when something would embarrass you on stage, so start-demo.sh can say so
 * rather than printing four green lines over a facility whose window closed an hour ago.
 *
 * Two things it refuses to let pass:
 *   a negative countdown, which shows a redemption date in the past and reads as a bug;
 *   the gate facility outside Subscription, where a live deposit returns tecEXPIRED for
 *   the phase and the credential is never consulted, so the demonstration shows the
 *   phase rule instead of the gate.
 */
const BASE = process.env.API_BASE ?? 'http://localhost:8787'

let book
try {
  book = await (await fetch(`${BASE}/api/vaults`)).json()
} catch (e) {
  console.log(`  the reader did not answer on ${BASE}: ${String(e).slice(0, 70)}`)
  process.exit(2)
}

let blocking = 0
for (const v of book.vaults ?? []) {
  const hours = v.secondsToRedemption / 3600
  let flag = ''
  if (v.secondsToRedemption < 0) { flag = '  WINDOW EXPIRED'; blocking++ }
  else if (hours < 3) flag = `  expires in ${hours.toFixed(1)}h`
  console.log(
    '  ' + String(v.label).padEnd(30) + String(v.grade).padEnd(4) +
    String(v.phase).padEnd(13) + 'oracle ' + String(v.oraclePublished).padEnd(6) + flag,
  )
}

const gate = (book.vaults ?? []).find((v) => /Thorne/.test(v.label ?? ''))
if (gate && gate.phase !== 'Subscription') {
  console.log(`\n  STOP  the gate facility is in ${gate.phase}, not Subscription.`)
  console.log('        A live deposit there returns tecEXPIRED for the phase and the')
  console.log('        credential is never consulted. Rebake before demonstrating it.')
  blocking++
}

if (blocking) {
  console.log('\n  Rebake, in order:')
  console.log('    node src/demo/rebake-all.mjs --hours 18')
  console.log('    node src/index.mjs')
  console.log('    node src/demo/repair-resolution.mjs')
}
process.exit(blocking ? 2 : 0)
