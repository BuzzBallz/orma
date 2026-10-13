// Offline check of two api.mjs behaviours: HEAD answers like GET, and an id asked before the
// first snapshot is "warming up" (503), not "no such vault" (404). No network, no ledger.
//   node src/dev/check-api.mjs
import { createApi } from '../api.mjs'

const ID = 'AB'.repeat(32)
const reader = { snapshots: new Map(), get: () => null, all: () => [], getByShareMpt: () => null, serverTime: '2026-10-13T00:00:00Z', ledgerIndex: 1, xrpl: null }
const api = createApi(reader, { port: 0 })
await api.listen()
const base = `http://127.0.0.1:${api.server.address().port}`

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const call = async (method, path) => {
  const r = await fetch(base + path, { method })
  const text = await r.text()
  return { status: r.status, code: text ? JSON.parse(text).error?.code ?? null : null, bytes: text.length }
}

const cold = await call('GET', `/api/vaults/${ID}/nav`)
eq('GET nav before the first snapshot', [cold.status, cold.code], [503, 'WARMING_UP'])
eq('HEAD nav before the first snapshot', (await call('HEAD', `/api/vaults/${ID}/nav`)).status, 503)
eq('HEAD health', await call('HEAD', '/api/health'), { status: 200, code: null, bytes: 0 })

reader.snapshots.set('x', {})
eq('GET unknown id once a snapshot exists', (await call('GET', `/api/vaults/${ID}/nav`)).code, 'VAULT_NOT_FOUND')
eq('HEAD unknown id once a snapshot exists', (await call('HEAD', `/api/vaults/${ID}/nav`)).status, 404)

await api.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exit(bad ? 1 : 0)
