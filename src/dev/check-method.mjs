// Offline check of the notches for capital already destroyed: unchanged below 90%, at most CCC
// from 90%, D at 100%, and the same table served by /api/methodology. No network, no ledger.
//   node src/dev/check-method.mjs
import { buildScore, METHOD_VERSION, REALISED_LOSS_BANDS } from '../score.mjs'
import { createApi } from '../api.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const healthy = { liquidityRatio: 1, coverAdequacy: 1, concentration: 0.1, recogLagSeconds: 0, shortfallPct: 0, phase: 'Open' }
const grade = (realisedLossPct) => buildScore({ ...healthy, realisedLossPct }).grade
eq('no capital destroyed', grade(0), 'AAA')
eq('10% destroyed, as in 1.0.0', grade(10), 'A')
eq('79% destroyed, as in 1.0.0 (Kestrel)', grade(79), 'B')
eq('90% destroyed: at most CCC', grade(90), 'CCC')
eq('100% destroyed: D', grade(100), 'D')
const step = buildScore({ ...healthy, realisedLossPct: 100 }).notchTrace[1]
eq('the trace records the notches actually applied', [step.from, step.delta, step.to], ['AAA', -19, 'D'])
eq('the score names its method version', buildScore(healthy).methodVersion, METHOD_VERSION)

const api = createApi({ snapshots: new Map(), all: () => [], serverTime: null }, { port: 0 })
await api.listen()
const served = await (await fetch(`http://127.0.0.1:${api.server.address().port}/api/methodology`)).json()
eq('/api/methodology serves the table the score applies', [served.methodVersion, served.realisedLoss], [METHOD_VERSION, REALISED_LOSS_BANDS])
await api.close()

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
