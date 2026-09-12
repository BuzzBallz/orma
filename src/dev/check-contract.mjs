// Does the presenter emit exactly the contract shape? Compare its keys against a
// committed fixture, which IS the contract by construction.
import { readFileSync } from 'node:fs'
import { Reader } from '../poll.mjs'
import { presentVault, presentRow } from '../present.mjs'
const VAULT='0B1014D870ECF81C2D9F860E101B04C0631F6A775E5B84AA0E73CBAC3EF97F6C'
const fx=JSON.parse(readFileSync('fixtures/vault-6717B5115871C2C1A5552C62B68F52A55C9C58086BD1FDC78D7DCE43ACDD773C.json','utf8'))
const list=JSON.parse(readFileSync('fixtures/vaults.json','utf8')).vaults[0]
const r=new Reader([VAULT]); await r.xrpl.connect(); await r.tick()
const snap=r.get(VAULT)
const live=presentVault(snap); const row=presentRow(snap)
let bad=0
const cmp=(name,a,b)=>{
  const ka=new Set(Object.keys(a)), kb=new Set(Object.keys(b))
  const missing=[...kb].filter(k=>!ka.has(k)), extra=[...ka].filter(k=>!kb.has(k))
  if(missing.length||extra.length){bad++; console.log(`  ${name}: MISSING ${missing.join(',')||'-'} | EXTRA ${extra.join(',')||'-'}`)}
  else console.log(`  ${name}: keys match (${ka.size})`)
}
cmp('top level', live, fx)
cmp('vault    ', live.vault, fx.vault)
cmp('broker   ', live.broker, fx.broker)
cmp('score    ', live.score, fx.score)
cmp('phaseInfo', live.phaseInfo, fx.phaseInfo)
cmp('row      ', row, list)
if(live.loans.length && fx.loans.length) cmp('loan[0]  ', live.loans[0], fx.loans[0])
if(live.alerts.length && fx.alerts.length) cmp('alert[0] ', live.alerts[0], fx.alerts[0])
console.log(bad? `\n  ${bad} MISMATCH(ES)` : '\n  PASS — live presenter matches the frozen contract exactly')
await r.stop()
