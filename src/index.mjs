/**
 * Entrypoint. Starts the reader against Devnet and serves the frozen contract.
 *
 *   node src/index.mjs --vault <64-hex> [--vault <64-hex> ...]
 *   VAULTS=<id,id> node src/index.mjs
 *
 * Env: PORT (8787), XRPL_WS, POLL_MS (4000), LOG_PRETTY=1, LOG_LEVEL, DEMO_KEY
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'

// Node 20 has --env-file, but running the demo must not depend on remembering a flag,
// and this is ten lines with no dependency. Existing environment always wins, so a
// shell override still works. Written without regexes on purpose: the escaping is a
// liability in a file that gets patched, and indexOf says what it means.
if (existsSync('.env')) {
  for (const raw of readFileSync('.env', 'utf8').split(String.fromCharCode(10))) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const k = line.slice(0, eq).trim()
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (process.env[k] === undefined) process.env[k] = v
  }
}
import { join } from 'node:path'
import { Client, Wallet } from 'xrpl'
import { Reader } from './poll.mjs'
import { createApi } from './api.mjs'
import { setLabel } from './present.mjs'
import { OraclePublisher } from './oracle.mjs'
import { PublishLoop } from './publish-loop.mjs'
import { logger } from './log.mjs'

const log = logger('main')

function parseArgs(argv) {
  const vaults = []
  const labels = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--vault' && argv[i + 1]) {
      const spec = argv[++i]
      const [id, ...rest] = spec.split(':')
      vaults.push(id.toUpperCase())
      if (rest.length) labels[id.toUpperCase()] = rest.join(':')
    }
  }
  if (process.env.VAULTS) {
    for (const id of process.env.VAULTS.split(',').map((s) => s.trim()).filter(Boolean)) {
      vaults.push(id.toUpperCase())
    }
  }
  return { vaults: [...new Set(vaults)], labels }
}

/**
 * Every baker writes its state to demo/<name>.json with a vaultId and a label. Reading
 * them back means the demo starts with `npm start` instead of by copying two 64-character
 * hex ids by hand, which is exactly the kind of thing that goes wrong when someone is
 * watching. Explicit --vault arguments still win.
 */
function vaultsFromDemoDir() {
  const vaults = []
  const labels = {}
  if (!existsSync('demo')) return { vaults, labels }
  for (const f of readdirSync('demo').filter((n) => n.endsWith('.json')).sort()) {
    try {
      const j = JSON.parse(readFileSync(join('demo', f), 'utf8'))
      if (typeof j.vaultId !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(j.vaultId)) continue
      const id = j.vaultId.toUpperCase()
      // Not every capture in demo/ is a facility bake. The oracle aggregate names the
      // vault it is about, which made the startup line claim five facilities for four
      // vaults and put a duplicate id in front of the reader.
      if (vaults.includes(id)) continue
      vaults.push(id)
      if (j.label) labels[id] = j.label
    } catch { /* a malformed capture must not stop the reader from starting */ }
  }
  return { vaults, labels }
}

const cli = parseArgs(process.argv)
const baked = vaultsFromDemoDir()
// Explicit arguments win outright; otherwise fall back to whatever has been baked.
const vaults = cli.vaults.length ? cli.vaults : baked.vaults
const labels = cli.vaults.length ? cli.labels : { ...baked.labels, ...cli.labels }

if (vaults.length === 0) {
  console.error(`
  No vaults given, and demo/ holds no baked facility.

    node src/index.mjs --vault <64-hex id>[:label] [--vault ...]
    VAULTS=<id>,<id> node src/index.mjs

  Or bake one:  node src/demo/bake-ordering.mjs
`)
  process.exit(1)
}
if (!cli.vaults.length) {
  console.log(`  serving ${vaults.length} facility(ies) baked into demo/`)
}

for (const [id, label] of Object.entries(labels)) setLabel(id, label)

const reader = new Reader(vaults)

// --- optional on-ledger publication ----------------------------------------
// Off by default: reading correctly is the product, publishing is distribution, and
// a missing seed must never stop the reader from starting.
//   PUBLISH_SEED=s...  publish from that account
//   PUBLISH=faucet     fund a throwaway publisher (devnet only, for the demo)
let publishLoop = null
if (process.env.PUBLISH_SEED || process.env.PUBLISH === 'faucet') {
  try {
    const pubClient = new Client(process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233', { connectionTimeout: 20000 })
    await pubClient.connect()
    const wallet = process.env.PUBLISH_SEED
      ? Wallet.fromSeed(process.env.PUBLISH_SEED)
      : (await pubClient.fundWallet()).wallet
    const publisher = new OraclePublisher(pubClient, wallet)
    publishLoop = new PublishLoop(reader, publisher)
    publishLoop.attach()
    log.info('publishing enabled', { publisher: wallet.address, funded: !process.env.PUBLISH_SEED })
    if (!process.env.PUBLISH_SEED) log.warn('throwaway publisher; set PUBLISH_SEED to keep the same oracle objects across restarts')
  } catch (e) {
    log.error('publishing disabled, reader continues', { err: String(e).slice(0, 120) })
    publishLoop = null
  }
}
// Accounts to scan for escrowed share collateral. There is no reverse index from an
// MPT issuance to the escrows holding it, so a lender must be told where to look.
const watchAccounts = (process.env.WATCH_ACCOUNTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
// The rater's own address, so the gate route can answer "am I cited in this domain".
// Read from the baked gate facility, which recorded who issued its credential, and
// overridable for anyone running their own issuer.
let raterAddress = process.env.RATER_ADDRESS ?? null
// The nine-step chain that built the gate, each step with the hash it landed under. The
// live gate object says a domain exists; only these say what the ledger did when two
// investors tried to enter it, and the refusal is the whole claim. Scoped to the facility
// it was baked against, so it can never be served against another vault's id.
let gateProof = null
if (existsSync(join('demo', 'gate-vault.json'))) {
  try {
    const baked = JSON.parse(readFileSync(join('demo', 'gate-vault.json'), 'utf8'))
    raterAddress = raterAddress ?? baked.accounts?.rater ?? null
    gateProof = baked.vaultId ? { vaultId: String(baked.vaultId).toUpperCase(), bakedAt: baked.bakedAt ?? null, steps: baked.steps ?? [] } : null
  } catch { /* optional */ }
}

const api = createApi(reader, {
  source: 'devnet',
  watchAccounts,
  raterAddress,
  gateProof,
  oracleFor: (id) => publishLoop?.oracleFor(id) ?? null,
})

// Serve immediately; the first tick fills the snapshots a moment later. health.ok
// stays false until then, which is honest rather than pretending to be ready.
await api.listen()
await reader.start()

log.info('up', {
  vaults: vaults.length,
  api: `http://localhost:${process.env.PORT ?? 8787}`,
  publishing: Boolean(publishLoop),
})

const shutdown = async (sig) => {
  log.info('shutting down', { sig })
  await reader.stop()
  await api.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
