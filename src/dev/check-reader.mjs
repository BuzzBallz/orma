import { Reader } from './poll.mjs'
// The vault from the A2 verification run: 100 XRP, two 10 XRP loans, BOTH impaired.
// Known-correct answer: naive 1.000000, correct 0.800000, 2000 bps.
const VAULT = '0B1014D870ECF81C2D9F860E101B04C0631F6A775E5B84AA0E73CBAC3EF97F6C'
const r = new Reader([VAULT])
await r.xrpl.connect()
const t0 = Date.now()
await r.tick()
console.log(`\n  tick took ${Date.now() - t0} ms`)
const s = r.get(VAULT)
if (!s) { console.log('  NO SNAPSHOT'); process.exit(1) }
console.log(`  serverTime ${s.readAt}  ledger ${s.ledgerIndex}`)
console.log(`  phase=${s.vault.phase} kind=${s.vault.vaultKind} accounting=${s.vault.leVersion}`)
console.log(`  assetsTotal=${s.vault.assetsTotal} available=${s.vault.assetsAvailable} loss=${s.vault.lossUnrealized} shares=${s.vault.sharesOutstanding}`)
console.log(`  NAV naive=${s.navNaive}  correct=${s.navCorrect}  divergence=${s.navDivergenceBps} bps`)
console.log(`  canWithdraw=${s.phaseInfo.canWithdraw} reason=${s.phaseInfo.withdrawBlockedReason}`)
console.log(`  brokers=${s.brokers.length} loans=${s.loans.length}`)
for (const b of s.brokers) console.log(`    broker ${b.loanBrokerId.slice(0,12)} debt=${b.debtTotal} cover=${b.coverAvailable} cmin=${b.coverRateMinimum} cliq=${b.coverRateLiquidation}`)
for (const l of s.loans) console.log(`    loan ${l.loanId.slice(0,12)} ${l.status.padEnd(11)} principal=${l.principalOutstanding} dueIn=${l.secondsUntilDue}s flags=${l.flags}`)
const ok = s.navNaive === '1.000000' && s.navCorrect === '0.800000'
console.log(`\n  ${ok ? 'PASS' : 'FAIL'}: expected naive 1.000000 / correct 0.800000`)
await r.stop()
