// Offline check of the MCP server on input that is not a request object: a `null` line, a number or a
// batch array is answered as an invalid request and the server keeps answering after it, and a
// tools/call with `arguments: null` is read as no arguments. A local stand-in plays the API.
//   node src/dev/check-mcp-edges.mjs
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

// A crash on a line is an unhandled rejection; counted here instead of ending the check.
let crashed = 0
process.on('unhandledRejection', () => { crashed++ })

const input = new PassThrough()
const output = new PassThrough()
serve(input, output)
const replies = []
output.on('data', (c) => String(c).split('\n').filter(Boolean).forEach((l) => replies.push(JSON.parse(l))))
const settle = () => new Promise((r) => setTimeout(r, 100))
let next = 0
const rpc = async (method, params) => {
  const id = ++next
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  for (let i = 0; i < 100 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 20))
  return replies.find((r) => r.id === id)
}

for (const line of ['null', '42', '[]']) {
  const before = replies.length
  input.write(line + '\n')
  await settle()
  eq(`the line ${line} is an invalid request`, replies.slice(before).map((r) => [r.id, r.error?.code]), [[null, -32600]])
}
eq('and none of them threw', crashed, 0)
eq('the server still answers after them', (await rpc('ping'))?.result, {})

const listed = await rpc('tools/call', { name: 'list_facilities', arguments: null })
eq('arguments: null reads as no arguments and reaches the API', [listed?.result?.isError, listed?.result?.content?.[0]?.text], [false, '{"vaults":[]}'])
eq('which was asked once', asked, ['/api/vaults'])
const missing = await rpc('tools/call', { name: 'get_facility', arguments: null })
eq('a required argument under arguments: null is reported missing, not as an unreachable API',
  missing?.result?.content?.[0]?.text, 'missing vaultId')

input.end()
api.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
