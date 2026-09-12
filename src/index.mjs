/**
 * Entrypoint. Starts the reader against Devnet and serves the frozen contract.
 *
 *   node src/index.mjs --vault <64-hex> [--vault <64-hex> ...]
 *   VAULTS=<id,id> node src/index.mjs
 *
 * Env: PORT (8787), XRPL_WS, POLL_MS (4000), LOG_PRETTY=1, LOG_LEVEL, DEMO_KEY
 */
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

const { vaults, labels } = parseArgs(process.argv)

if (vaults.length === 0) {
  console.error(`
  No vaults given.

    node src/index.mjs --vault <64-hex id>[:label] [--vault ...]
    VAULTS=<id>,<id> node src/index.mjs

  Bake one first, or pass a known Devnet vault id.
`)
  process.exit(1)
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
const api = createApi(reader, {
  source: 'devnet',
  watchAccounts,
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
