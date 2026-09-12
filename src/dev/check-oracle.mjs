// Publishes the solvency vector as a native XLS-47 Oracle and exercises the four
// invariants that corrupt data silently. Run against the vault left by the collateral
// scenario: node src/dev/check-oracle.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { Client } from 'xrpl'
import { Xrpl } from '../xrpl.mjs'
import { Reader } from '../poll.mjs'
import { presentVault } from '../present.mjs'
import { OraclePublisher, vaultToBaseAsset, encodePrice, decodePrice } from '../oracle.mjs'

const f = readdirSync('.demo').filter((n) => n.startsWith('collateral-')).sort().pop()
const st = JSON.parse(readFileSync(`.demo/${f}`, 'utf8'))

const c = new Client('wss://s.devnet.rippletest.net:51233', { connectionTimeout: 20000 })
await c.connect()
const { wallet } = await c.fundWallet()
console.log(`  publisher ${wallet.address}`)

const x = new Xrpl()
await x.connect()
const r = new Reader([st.vaultId], x)
await r.tick()
const detail = presentVault(r.get(st.vaultId))
console.log(`  vault NAV correct=${detail.vault.navCorrect} grade=${detail.score.grade}`)

console.log('\n  --- invariant 4: hex encoding ---')
console.log(`    encodePrice(500000) = "${encodePrice(500000)}" decodes to ${decodePrice(encodePrice(500000))}`)
console.log(`    a DECIMAL write of "500000" would decode to ${decodePrice('500000')}  <- silent corruption`)

const pub = new OraclePublisher(c, wallet)
const closeUnix = (await x.closeTime()) + 946684800

console.log('\n  --- publish the six-dimension vector ---')
const p1 = await pub.publish(detail, closeUnix)
console.log(`    ${p1.result}  docId=${p1.docId}  lut=${p1.lastUpdateTime}  ${p1.hash?.slice(0, 16)}...`)

console.log('\n  --- read back from the ledger ---')
const back = await pub.read(st.vaultId)
console.log(`    object ${back.objectIndex?.slice(0, 20)}...  base=${back.baseAssetHex.slice(0, 16)}...  age=${back.ageSeconds}s`)
for (const d of back.dimensionsOnChain) {
  console.log(`      ${d.key}  raw=0x${d.raw}  ->  ${d.value}  (scale ${d.scale})`)
}
const nav = back.dimensionsOnChain.find((d) => d.key === 'NAV')
console.log(`    NAV round-trip: published ${detail.vault.navCorrect} read ${nav?.value} MATCH=${nav?.value === detail.vault.navCorrect}`)

console.log('\n  --- invariant 2: a same-second republish must not burn a fee ---')
const p2 = await pub.publish(detail, closeUnix)
const okLut = p2.skipped || (p2.result === 'tesSUCCESS' && p2.lastUpdateTime > p1.lastUpdateTime)
console.log(`    ${p2.skipped ? 'skipped (' + p2.reason + ')' : p2.result}  lut ${p1.lastUpdateTime} -> ${p2.lastUpdateTime ?? 'n/a'}`)
console.log(`    ${okLut ? 'PASS: strictly increased, or skipped' : 'FAIL: tecINVALID_UPDATE_TIME risk'}`)

console.log('\n  --- invariant 1: does a partial publish strip the rest? ---')
const one = [{ PriceData: { BaseAsset: vaultToBaseAsset(st.vaultId), QuoteAsset: 'NAV', AssetPrice: encodePrice(1), Scale: 6 } }]
const rr = await c.submitAndWait({
  TransactionType: 'OracleSet',
  Account: wallet.address,
  OracleDocumentID: p1.docId,
  Provider: Buffer.from('BuzzBallz Vault Solvency', 'utf8').toString('hex').toUpperCase(),
  AssetClass: Buffer.from('risk', 'utf8').toString('hex').toUpperCase(),
  LastUpdateTime: Math.floor(Date.now() / 1000),
  PriceDataSeries: one,
}, { wallet, autofill: true })
console.log(`    partial OracleSet -> ${rr.result.meta.TransactionResult}`)
const after = await pub.read(st.vaultId)
const stripped = after.dimensionsOnChain.filter((d) => d.raw === null).map((d) => d.key)
console.log(`    entries now ${after.dimensionsOnChain.length}, price STRIPPED from: ${stripped.join(',') || 'none'}`)
console.log(`    ${stripped.length ? 'CONFIRMED: OracleSet is not a merge' : 'no stripping observed'}`)

console.log('\n  --- recovery: a full republish restores every dimension ---')
await new Promise((res) => setTimeout(res, 1500))
const p3 = await pub.publish(detail, Math.floor(Date.now() / 1000))
const restored = await pub.read(st.vaultId)
const priced = restored.dimensionsOnChain.filter((d) => d.raw !== null).length
console.log(`    ${p3.result ?? 'skipped'}  |  dimensions carrying a price again: ${priced}/6`)

await r.stop()
await c.disconnect()
