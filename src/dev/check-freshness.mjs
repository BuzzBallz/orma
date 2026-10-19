// Offline check that a vault whose read fails is served as what it is: the last good snapshot,
// with the ledger it came from and how old it is, while health stops saying ok. A fake ledger
// answers the first pass and fails the vault read after it. No network.
//   node src/dev/check-freshness.mjs
import { Reader } from '../poll.mjs'
import { createApi } from '../api.mjs'
import { Xrpl } from '../xrpl.mjs'

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

// The ledger itself unreadable: no vault read even starts, so the ledger clock stops with it.
// A minute later by the wall clock, the figures must say they are a minute old.
const workingCloseTime = xrpl.closeTime
xrpl.closeTime = async () => { throw new Error('timeout') }
await reader.tick().catch(() => {})
const realNow = Date.now
Date.now = () => realNow() + 60_000
const unread = await get(`/api/vaults/${ID}/nav`)
eq('a ledger unreadable for a minute leaves the figures stale', [unread.freshness.stale, unread.freshness.ageSeconds >= 60], [true, true])
eq('and health not ok', (await get('/api/health')).ok, false)
Date.now = realNow
xrpl.closeTime = workingCloseTime

// A socket that will not come back: each request tries once to reconnect, so the tick fails
// within seconds instead of waiting on an endless reconnect while health says ok.
const down = new Xrpl('wss://unused.invalid')
down.client = { isConnected: () => false, connect: async () => { throw new Error('ECONNREFUSED') }, request: async () => { throw new Error('NotConnectedError') }, on() {} }
const t0 = Date.now()
const outcome = await Promise.race([new Reader([ID], down).tick().then(() => 'settled', () => 'threw'), new Promise((r) => setTimeout(() => r('pending'), 8000))])
eq('a dead socket fails the tick within seconds', [outcome, Date.now() - t0 < 8000], ['threw', true])

// A loan that cannot be read fails the vault's read: the last good snapshot stays, marked degraded,
// rather than a snapshot that lost a loan and grades the facility as if it never lent it.
let loanFails = false
const withLoan = {
  ...xrpl,
  async accountObjects() { return [{ index: 'B'.repeat(64), VaultID: ID, LoanSequence: 2, Owner: 'rOwner', Account: 'rBroker', DebtTotal: '1000000', CoverAvailable: '0' }] },
  async loan() {
    if (loanFails) throw Object.assign(new Error('timeout'), { data: { error: 'timeout' } })
    return { index: 'C'.repeat(64), Flags: 0, NextPaymentDueDate: 900000000, PaymentInterval: 2592000, PrincipalOutstanding: '1000000', TotalValueOutstanding: '1000000' }
  },
}
const lender = new Reader([ID], withLoan)
await lender.tick()
loanFails = true
await lender.tick()
eq('a loan read that fails keeps the last snapshot with its loan', lender.get(ID).loans.length, 1)
eq('and marks the reader degraded', lender.degraded, true)

await api.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
