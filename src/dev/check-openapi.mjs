// Offline check that the OpenAPI document names every route the prose reference indexes, and that
// the API serves it. No network, no ledger.
//   node src/dev/check-openapi.mjs
import { readFileSync } from 'node:fs'
import { createApi } from '../api.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
const doc = readFileSync(new URL('../../documentation/pages/http-api.mdx', import.meta.url), 'utf8')
const indexed = [...doc.matchAll(/^\| `GET (\/api\/[^`]+)` \|/gm)].map((m) => m[1].replace(/:(\w+)/g, '{$1}'))
eq('the reference indexes routes', indexed.length > 10, true)
eq('every indexed route is in the OpenAPI document', indexed.filter((p) => !spec.paths[p]), [])

const api = createApi({ snapshots: new Map(), all: () => [], serverTime: null }, { port: 0 })
await api.listen()
const res = await fetch(`http://127.0.0.1:${api.server.address().port}/api/openapi.json`)
eq('the API serves it, open to any origin', [res.status, res.headers.get('access-control-allow-origin'), (await res.json()).openapi], [200, '*', '3.1.0'])
await api.close()

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
