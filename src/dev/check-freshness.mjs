// Offline check that a vault whose read fails is served as what it is: the last good snapshot,
// with the ledger it came from and how old it is, while health stops saying ok. A fake ledger
// answers the first pass and fails the vault read after it. No network.
//   node src/dev/check-freshness.mjs
import { Reader } from '../poll.mjs'
import { createApi } from '../api.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const ID = 'AB'.repeat(32)
let ledger = 100
let failing = false
const xrpl = {
  lastLedger: null,
  async closeTime() { ledger += 1; this.lastLedger = ledger; return 800000000 + (ledger - 101) * 10 },
  async vaultInfo() {
    if (failing) throw Object.assign(new Error('timeout'), { data: { error: 'timeout' } })
    return { index: ID, Owner: 'rOwner', Account: 'rPseudo', AssetsTotal: '1000000', AssetsAvailable: '1000000', LossUnrealized: '0', shares: { OutstandingAmount: '1000000', mpt_issuance_id: 'CD'.repeat(24) } }
  },
  async accountObjects() { return [] },
}
const reader = new Reader([ID], xrpl)
await reader.tick()                       // ledger 101, read
failing = true
for (let i = 0; i < 5; i++) await reader.tick()  // ledgers 102 to 106, 50 s later, every read fails

const api = createApi(reader, { port: 0 })
await api.listen()
const base = `http://127.0.0.1:${api.server.address().port}`
const get = async (path) => (await fetch(base + path)).json()

const nav = await get(`/api/vaults/${ID}/nav`)
eq('the nav document names the ledger it was read at', nav.ledgerIndex, 101)
eq('and says it is stale, and by how much', [nav.freshness.stale, nav.freshness.ageSeconds], [true, 50])
const list = await get('/api/vaults')
eq('the list carries the same freshness', list.vaults[0].freshness, { readAt: nav.asOf, readLedgerIndex: 101, ageSeconds: 50, stale: true })
const health = await get('/api/health')
eq('health is not ok while a vault cannot be read', [health.ok, health.degraded], [false, true])

failing = false
await reader.tick()
eq('one good pass later, the snapshot is fresh', (await get(`/api/vaults/${ID}/nav`)).freshness.stale, false)
eq('and health is ok again', (await get('/api/health')).ok, true)

await api.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
