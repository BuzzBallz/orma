// Offline check of the MCP server: the handshake, the tool list, a tool that reads the API, and
// arguments that are not ids refused before any request leaves. A local stand-in plays the API.
//   node src/dev/check-mcp.mjs
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const asked = []
const api = createServer((req, res) => { asked.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }).end('{"vaults":[]}') })
await new Promise((r) => api.listen(0, '127.0.0.1', r))
process.env.ORMA_API = `http://127.0.0.1:${api.address().port}`
const { serve } = await import('../mcp.mjs')

const input = new PassThrough()
const output = new PassThrough()
serve(input, output)
const replies = []
output.on('data', (c) => String(c).split('\n').filter(Boolean).forEach((l) => replies.push(JSON.parse(l))))
let next = 0
const rpc = async (method, params) => {
  const id = ++next
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  for (let i = 0; i < 100 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 20))
  return replies.find((r) => r.id === id)
}

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } })
eq('initialize answers with tools and the asked version', [init.result.protocolVersion, Object.keys(init.result.capabilities)], ['2025-06-18', ['tools']])
input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
eq('ping answers', (await rpc('ping')).result, {})
eq('and the notification before it got no answer', replies.every((r) => r.id !== undefined && r.id !== null), true)
eq('five read-only tools', (await rpc('tools/list')).result.tools.map((t) => t.name),
  ['list_facilities', 'get_valuation', 'get_valuation_by_share', 'get_facility', 'get_manager_conduct'])

const list = await rpc('tools/call', { name: 'list_facilities', arguments: {} })
eq('a tool reads the API', [list.result.isError, list.result.content[0].text, asked.at(-1)], [false, '{"vaults":[]}', '/api/vaults'])

const before = asked.length
const traversal = await rpc('tools/call', { name: 'get_valuation', arguments: { vaultId: '../../api/demo/state' } })
eq('an id that is not hex is refused', traversal.result.isError, true)
const extra = await rpc('tools/call', { name: 'get_valuation_by_share', arguments: { mptIssuanceId: 'CD'.repeat(24), units: '1&x=1' } })
eq('units that are not digits are refused', extra.result.isError, true)
eq('and neither reached the API', asked.length, before)

const pledge = await rpc('tools/call', { name: 'get_valuation_by_share', arguments: { mptIssuanceId: 'CD'.repeat(24), units: '1000000' } })
eq('a valid share id and units reach the right route', [pledge.result.isError, asked.at(-1)], [false, `/api/mpt/${'CD'.repeat(24)}/nav?units=1000000`])
eq('an unknown method is a JSON-RPC error', (await rpc('resources/list')).error.code, -32601)

input.end()
api.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
