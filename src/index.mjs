/**
 * Entrypoint. Starts the reader against Devnet and serves the frozen contract.
 *
 *   node src/index.mjs --vault <64-hex> [--vault <64-hex> ...]
 *   VAULTS=<id,id> node src/index.mjs
 *
 * Env: PORT (8787), XRPL_WS, POLL_MS (4000), LOG_PRETTY=1, LOG_LEVEL, DEMO_KEY
 */
import { Reader } from './poll.mjs'
import { createApi } from './api.mjs'
import { setLabel } from './present.mjs'
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
const api = createApi(reader, { source: 'devnet' })

// Serve immediately; the first tick fills the snapshots a moment later. health.ok
// stays false until then, which is honest rather than pretending to be ready.
await api.listen()
await reader.start()

log.info('up', { vaults: vaults.length, api: `http://localhost:${process.env.PORT ?? 8787}` })

const shutdown = async (sig) => {
  log.info('shutting down', { sig })
  await reader.stop()
  await api.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
