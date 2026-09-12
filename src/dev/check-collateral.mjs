// Re-value the collateral from the last scenario, with the dedupe fix in place.
import { readFileSync, readdirSync } from 'node:fs'
import { Xrpl } from '../xrpl.mjs'
import { Reader } from '../poll.mjs'
import { findShareEscrows, presentCollateral } from '../collateral.mjs'
const f = readdirSync('.demo').filter(n=>n.startsWith('collateral-')).sort().pop()
const st = JSON.parse(readFileSync(`.demo/${f}`,'utf8'))
const x = new Xrpl(); await x.connect()
const r = new Reader([st.vaultId], x); await r.tick()
const snap = r.get(st.vaultId)
const esc = await findShareEscrows(x, st.shareMptId, [st.accounts.lp, st.accounts.lender, st.accounts.owner])
const c = presentCollateral(esc, snap, 10)
const xrp = (d)=> (Number(d)/1e6).toFixed(2)
console.log(`\n  vault ${st.vaultId.slice(0,20)}...  (${f})`)
console.log(`  AssetsTotal ${xrp(snap.vault.assetsTotal)} XRP | LossUnrealized ${xrp(snap.vault.lossUnrealized)} XRP | shares ${xrp(snap.vault.sharesOutstanding)}`)
console.log(`  NAV naive ${c.navNaive} | correct ${c.navCorrect}  (${snap.navDivergenceBps} bps)`)
console.log(`\n  pledges found: ${c.pledgeCount}   <- must be 1, not 2`)
for (const p of c.pledges) {
  console.log(`    escrow ${p.escrowId.slice(0,16)}  ${xrp(p.shares)} shares  ${p.pledgor.slice(0,8)} -> ${p.beneficiary.slice(0,8)}`)
  console.log(`      naive ${xrp(p.valueNaive)} XRP | correct ${xrp(p.valueCorrect)} XRP | overstated ${xrp(p.overstatement)} XRP (${p.overstatementPct}%)`)
  console.log(`      maxLendable @10% haircut on the HONEST value: ${xrp(p.maxLendable)} XRP`)
}
console.log(`\n  TOTAL naive ${xrp(c.totalValueNaive)} | correct ${xrp(c.totalValueCorrect)} | overstatement ${xrp(c.totalOverstatement)} XRP (${c.totalOverstatementPct}%)`)
await r.stop()
