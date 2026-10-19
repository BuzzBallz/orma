// Offline check of the nav pointer resolver against a pointer someone else wrote: a private host
// is never fetched, a redirect is not followed, a large body is cut off, and the failure detail
// never echoes what answered. No network, no ledger.
//   node src/dev/check-ssrf.mjs
import { createServer } from 'node:http'
import { resolveFromIssuance } from '../nav.mjs'

const ID = 'CD'.repeat(24)
const xrplFor = (navUrl) => ({
  mptIssuance: async () => ({
    Issuer: 'rIssuer', OutstandingAmount: '1',
    MPTokenMetadata: Buffer.from(JSON.stringify({ orma: { nav_url: navUrl } })).toString('hex').toUpperCase(),
  }),
})
const follow = (out) => out.steps.find((s) => s.step === 'follow pointer')

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

let fetched = 0
const spy = async () => { fetched++; return new Response('{}') }
for (const url of ['http://127.0.0.1:8787/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/']) {
  const out = await resolveFromIssuance(xrplFor(url), ID, { fetchImpl: spy })
  eq(`not followed: ${url}`, [follow(out).ok, follow(out).detail], [false, 'not followed: the host is not a public address'])
}
eq('and nothing was fetched', fetched, 0)

const PUBLIC = 'https://93.184.215.14/nav'
const respond = (res) => async () => res
eq('a public pointer that answers a valuation',
  follow(await resolveFromIssuance(xrplFor(PUBLIC), ID, { fetchImpl: respond(Response.json({ unitValue: { held: '0.8' } })) })).ok, true)
eq('a body over 64 KB',
  follow(await resolveFromIssuance(xrplFor(PUBLIC), ID, { fetchImpl: respond(new Response('x'.repeat(65 * 1024))) })).detail, 'answered, but over 64 KB')
eq('an HTML page does not leak into the detail',
  follow(await resolveFromIssuance(xrplFor(PUBLIC), ID, { fetchImpl: respond(new Response('<html>internal admin</html>')) })).detail, 'answered, but not JSON')
eq('a connection error does not leak into the detail',
  follow(await resolveFromIssuance(xrplFor(PUBLIC), ID, { fetchImpl: async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:6379') } })).detail, 'no answer')

// The real fetch, against a real redirect: allowPrivate only so it may reach this local server.
const server = createServer((req, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }).end())
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const out = await resolveFromIssuance(xrplFor(`http://127.0.0.1:${server.address().port}/nav`), ID, { allowPrivate: true })
eq('a redirect is not followed', follow(out).detail, 'HTTP 302, redirect not followed')
server.close()

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
