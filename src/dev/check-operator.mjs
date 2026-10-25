// Offline check of the operator routes and the cached reads of api.mjs: only the whole path names
// an action, an inherited name is no action, a loopback request a proxy forwards needs the key,
// the body is bounded, and requests that arrive during a cache miss share one ledger read stamped
// at that read. No network, no ledger.
//   node src/dev/check-operator.mjs
import { createApi } from '../api.mjs'

const ID = 'AB'.repeat(32)
const MPT = 'CD'.repeat(24)
let issuanceReads = 0
const xrpl = {
  mptIssuance: () => {
    issuanceReads++
    return new Promise((resolve) => setTimeout(() => resolve({}), 100))
  },
}
const snap = { vaultId: ID, vault: { vaultId: ID, shareMptId: MPT, owner: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }, brokers: [], loans: [] }
const reader = {
  snapshots: new Map([[ID, snap]]), passes: 1, vaultIds: [ID], get: (id) => (id === ID ? snap : null), all: () => [snap],
  getByShareMpt: () => null, serverTime: '2026-10-25T10:00:00Z', ledgerIndex: 100, xrpl,
}
const ran = []
const demo = {
  kill: async (body) => { ran.push('kill'); return { got: body } },
  unkill: async () => { ran.push('unkill'); return {} },
}
const api = createApi(reader, { port: 0, demo })
await api.listen()
const base = `http://127.0.0.1:${api.server.address().port}`

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const post = async (path, { headers = {}, body } = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers, body })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

// The action is the whole path, and only the map's own functions are actions.
eq('an inherited name is no action', (await post('/api/demo/constructor', { body: '{"x":1}' })).status, 404)
eq('nor is toString', (await post('/api/demo/toString')).status, 404)
eq('a deeper path ending in an action runs nothing', (await post('/api/demo/x/kill')).status, 404)
eq('and nothing ran', ran, [])
const kill = await post('/api/demo/kill', { body: '{"why":"check"}' })
eq('a direct loopback script runs the action with its body', [kill.status, kill.body?.action, kill.body?.got], [200, 'kill', { why: 'check' }])
eq('an action without a body', (await post('/api/demo/unkill')).status, 200)

// A request a proxy forwards over loopback is a public one.
eq('loopback with x-forwarded-for and no key', (await post('/api/demo/kill', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 403)
eq('loopback with a forwarded header and no key', (await post('/api/demo/kill', { headers: { forwarded: 'for=203.0.113.9' } })).status, 403)
process.env.DEMO_KEY = 'check-operator-key'
eq('a wrong key', (await post('/api/demo/kill', { headers: { 'x-forwarded-for': '203.0.113.9', 'x-demo-key': 'nope' } })).status, 403)
eq('the key opens it', (await post('/api/demo/kill', { headers: { 'x-forwarded-for': '203.0.113.9', 'x-demo-key': 'check-operator-key' } })).status, 200)
delete process.env.DEMO_KEY

// The body is bounded and must be a JSON object.
eq('a body over 64 KB', (await post('/api/demo/kill', { body: 'x'.repeat(65 * 1024) })).status, 413)
eq('a body that is not JSON', (await post('/api/demo/kill', { body: '{nope' })).status, 400)
eq('a JSON null body', (await post('/api/demo/kill', { body: 'null' })).status, 400)
eq('and the server still answers', (await fetch(base + '/api/health')).status, 200)

// Five gate requests during one miss: one issuance read, and every answer stamped at that read.
const gates = await Promise.all(Array.from({ length: 5 }, async () => (await fetch(`${base}/api/vaults/${ID}/gate`)).json()))
eq('five requests in one miss share one ledger read', issuanceReads, 1)
reader.ledgerIndex = 101
reader.serverTime = '2026-10-25T10:00:04Z'
const later = await (await fetch(`${base}/api/vaults/${ID}/gate`)).json()
eq('a cached answer keeps the ledger and time of its read', [later.ledgerIndex, later.serverTime, issuanceReads], [gates[0].ledgerIndex, gates[0].serverTime, 1])

await api.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0 // not process.exit(): on Windows it aborts while the closed sockets are still closing
