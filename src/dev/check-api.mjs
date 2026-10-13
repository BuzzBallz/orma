// Offline check of two api.mjs behaviours: HEAD answers like GET, and a vault not read yet is
// "warming up" (503), not "no such vault" (404). No network, no ledger.
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

// The first pass reads the vaults one by one: a snapshot of one does not mean the others were reached.
reader.passes = 0
eq('a vault the first pass has not reached yet', (await call('GET', `/api/vaults/${ID}/nav`)).code, 'WARMING_UP')
reader.passes = 1
reader.vaultIds = [ID]
eq('a tracked vault whose first read failed', (await call('GET', `/api/vaults/${ID}/broker-history`)).code, 'WARMING_UP')
reader.vaultIds = []
eq('an id the reader does not track, once a pass is done', (await call('GET', `/api/vaults/${ID}/nav-history`)).code, 'VAULT_NOT_FOUND')

// A share id is unknown while a tracked vault is unread, and a vault the ledger says does not exist
// is absent, not forever warming up.
const MPT = 'CD'.repeat(24)
reader.vaultIds = [ID]
eq('a share id while a tracked vault is unread', (await call('GET', `/api/mpt/${MPT}/nav`)).code, 'WARMING_UP')
reader.missing = new Set([ID])
eq('a tracked vault the ledger says does not exist', (await call('GET', `/api/vaults/${ID}/nav`)).code, 'VAULT_NOT_FOUND')
eq('and a share id once every tracked vault is read or missing', (await call('GET', `/api/mpt/${MPT}/nav`)).code, 'SHARE_NOT_TRACKED')

await api.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0  // not process.exit(): on Windows it aborts while the closed sockets are still closing
