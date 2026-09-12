/**
 * Rebake every demo facility with windows chosen for a presentation rather than for a test.
 *
 * WHY THIS EXISTS. A closed-ended vault's dates are immutable, so a facility baked with a
 * fifteen minute window is in its Redemption phase an hour later and cannot be moved
 * back. Three of ours had already slid there, which is fine for the ledger evidence and
 * wrong for anything shown on a screen: countdowns go negative, and the phase on display
 * is not the phase the story is about.
 *
 * THE PHASES ARE THE POINT, not an afterthought:
 *
 *   Meridian, Kestrel, Calder  ->  INVESTMENT
 *     Mid-life. Capital is lent out, losses are visible, and withdrawals are refused for
 *     the whole phase. That is the state the product is about.
 *
 *   Thorne (the gate)          ->  SUBSCRIPTION
 *     Deposits are ONLY legal in Subscription. A gate demo that does live deposits has
 *     no choice: once the window closes the ledger refuses everyone with tecEXPIRED and
 *     the credential is never consulted, so the demo would show the phase rule rather
 *     than the gate.
 *
 * Sequential, not parallel: four bakes at once means eight to ten faucet calls in a few
 * seconds, and a rate-limited faucet mid-bake leaves a half-built vault whose dates
 * cannot be corrected.
 *
 * Run: node src/demo/rebake-all.mjs [--hours 18]
 */
import { spawn } from 'node:child_process'

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d }
const HOURS = Number(arg('hours', 18))
const SECONDS = Math.round(HOURS * 3600)

const JOBS = [
  {
    name: 'Meridian Trade Finance I',
    why: 'the impairment capture, Demo 1',
    script: 'src/demo/capture-impair.mjs',
    args: ['--window', String(SECONDS)],
  },
  {
    name: 'Kestrel Bridge Financing II',
    why: 'the default ordering measurement, Exhibit 3 and Slide 7',
    script: 'src/demo/bake-ordering.mjs',
    args: ['--window', String(SECONDS)],
  },
  {
    name: 'Calder Structured Credit III',
    why: 'the share token that resolves to its own valuation, Exhibit 5',
    script: 'src/demo/bake-metadata.mjs',
    args: ['--window', String(SECONDS)],
  },
  {
    // The gate wants a long SUBSCRIPTION, which its own baker derives from --window:
    // it sets SubscriptionDate at now + 900 and RedemptionDate at that plus the window.
    // To keep it in Subscription through the presentation the script is passed the
    // window it needs and left to place the dates.
    name: 'Thorne Senior Secured I',
    why: 'the admission gate, Demo 3, must stay in Subscription for live deposits',
    script: 'src/demo/bake-gate.mjs',
    args: ['--window', String(SECONDS)],
    subscriptionSeconds: SECONDS,
  },
]

const run = (job) => new Promise((resolve) => {
  const env = { ...process.env }
  // bake-gate places SubscriptionDate itself; this tells it how long to hold the phase.
  if (job.subscriptionSeconds) env.GATE_SUBSCRIPTION_SECONDS = String(job.subscriptionSeconds)
  const p = spawn(process.execPath, [job.script, ...job.args], { stdio: ['ignore', 'pipe', 'pipe'], env })
  let tail = []
  const keep = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 6) tail.shift() } }
  p.stdout.on('data', keep)
  p.stderr.on('data', keep)
  p.on('close', (code) => resolve({ code, tail }))
})

console.log(`\n  Rebaking 4 facilities with a ${HOURS} hour horizon.`)
console.log('  Sequential on purpose: a rate-limited faucet mid-bake leaves an unfixable vault.\n')

const results = []
for (const job of JOBS) {
  const t0 = Date.now()
  process.stdout.write(`  ${job.name.padEnd(30)} ${job.why}\n`)
  const { code, tail } = await run(job)
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  results.push({ name: job.name, ok: code === 0, secs })
  if (code === 0) {
    console.log(`  ${''.padEnd(30)} done in ${secs}s\n`)
  } else {
    console.log(`  ${''.padEnd(30)} FAILED after ${secs}s (exit ${code})`)
    for (const l of tail) console.log(`  ${''.padEnd(30)} ${l.slice(0, 96)}`)
    console.log('')
  }
}

console.log('  ' + '-'.repeat(58))
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(30)} ${r.secs}s`)
const failed = results.filter((r) => !r.ok)
console.log(`\n  ${results.length - failed.length}/${results.length} baked.`)
if (failed.length) {
  console.log('  Restart the API so it picks up whatever did land, then rerun the ones that failed.\n')
  process.exit(1)
}
console.log('  Restart the API to serve them:  node src/index.mjs\n')
