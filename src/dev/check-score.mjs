import { Reader } from './poll.mjs'
import { deriveScoreInputs, buildScore } from './score.mjs'
const VAULT = '0B1014D870ECF81C2D9F860E101B04C0631F6A775E5B84AA0E73CBAC3EF97F6C'
const r = new Reader([VAULT]); await r.xrpl.connect(); await r.tick()
const s = r.get(VAULT)
const broker = s.brokers[0] ?? { debtTotal: 0, coverAvailable: 0, coverRateMinimum: 0, coverRateLiquidation: 0 }
const { scoreArgs, broker: bx, cliff } = deriveScoreInputs({
  assetsTotal: s.vault.assetsTotal, assetsAvailable: s.vault.assetsAvailable,
  lossUnrealized: s.vault.lossUnrealized, sharesOutstanding: s.vault.sharesOutstanding,
  broker, loans: s.loans, phase: s.vault.phase,
})
const score = buildScore(scoreArgs)
console.log('\n  ===== LIVE DEVNET VAULT, SCORED END TO END =====')
console.log(`  NAV naive ${s.navNaive} | correct ${s.navCorrect} | ${s.navDivergenceBps} bps`)
console.log(`  GRADE ${score.grade} (${score.gradeNumeric})`)
console.log('  dimensions:')
for (const d of score.dimensions) console.log(`    ${d.key.padEnd(10)} ${String(d.value).padStart(12)} ${d.unit.padEnd(8)} ${d.grade}`)
console.log('  notch trace:')
for (const t of score.notchTrace) console.log(`    ${t.from} -> ${t.to}  ${t.rule}`)
console.log(`  cover: maxLiquidatableNow=${bx.maxLiquidatableNow} required=${bx.coverRequired} stranded=${bx.strandedCoverFraction.toFixed(4)}`)
console.log(`  cliff: claims=${cliff.claims} liquidity=${cliff.liquidityAtRedemption} shortfall=${cliff.projectedShortfall} (${cliff.shortfallPct.toFixed(2)}%)`)
await r.stop()
