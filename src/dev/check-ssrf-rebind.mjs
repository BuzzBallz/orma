// Offline check of the nav pointer resolver against DNS rebinding and the reserved ranges: a name that
// answers a public address to the check and a private one to the connection is never reached, the
// connection resolves through the checked lookup, and the reserved and translated ranges are not
// followed. A stub resolver plays DNS; a local server counts what reaches it. No network, no ledger.
//   node src/dev/check-ssrf-rebind.mjs
import { createServer } from 'node:http'
import { resolveFromIssuance } from '../nav.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const ID = 'CD'.repeat(24)
const VAULT = 'AB'.repeat(32)
const xrplFor = (navUrl) => ({
  mptIssuance: async () => ({
    Issuer: 'rIssuer', OutstandingAmount: '1',
    MPTokenMetadata: Buffer.from(JSON.stringify({ orma: { nav_url: navUrl } })).toString('hex').toUpperCase(),
  }),
  req: async ({ command }) => ({ result: command === 'account_info' ? { account_data: { VaultID: VAULT } } : { vault: { ShareMPTID: ID } } }),
})
const follow = (out) => out.steps.find((s) => s.step === 'follow pointer')
const NOT_PUBLIC = 'not followed: the host is not a public address'

// What the pointer would reach inside our network.
const hits = []
const server = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }).end('{}') })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

// The first answer is public, every later one is the private address: a zero-TTL rebinding name.
let lookups = 0
const rebinding = async () => (++lookups === 1 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '127.0.0.1', family: 4 }])
const out = await resolveFromIssuance(xrplFor(`http://rebind.example:${port}/internal-admin`), ID, { lookupImpl: rebinding })
eq('a name that rebinds to a private address after the check is not followed', follow(out)?.detail, NOT_PUBLIC)
eq('the connection resolved through the checked lookup', lookups, 2)
eq('and nothing reached the private server', hits, [])

for (const url of [
  'http://198.18.0.1/nav', 'http://192.0.0.1/nav', 'http://224.0.0.1/nav', 'http://240.0.0.1/nav',
  'http://[64:ff9b::7f00:1]/nav', 'http://[2002:7f00:1::]/nav', 'http://[ff02::1]/nav',
]) {
  let fetched = 0
  const spy = async () => { fetched++; return new Response('{}') }
  const o = await resolveFromIssuance(xrplFor(url), ID, { fetchImpl: spy })
  eq(`not followed: ${url}`, [follow(o)?.detail, fetched], [NOT_PUBLIC, 0])
}

server.close()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
