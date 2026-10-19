/**
 * A read-only MCP server over the public API, so an agent can read a facility's credit without
 * integration code. It holds no key and signs nothing: every tool is a GET against ORMA_API.
 *
 *   ORMA_API=https://orma-api.onrender.com node src/mcp.mjs
 *
 * MCP over stdio is JSON-RPC 2.0, one message per line. This answers the four methods a tools-only
 * server needs (initialize, ping, tools/list, tools/call), in a few dozen lines rather than through
 * an SDK that would bring an HTTP framework into an image that otherwise has two dependencies.
 */
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const API = (process.env.ORMA_API ?? 'https://orma-api.onrender.com').replace(/\/+$/, '')
const VAULT = /^[A-Fa-f0-9]{64}$/
const MPT = /^[A-Fa-f0-9]{48}$/
const UNITS = /^[0-9]{1,30}$/

const vaultArg = { vaultId: { type: 'string', pattern: VAULT.source, description: 'The vault id, 64 hex characters.' } }
const mptArg = { mptIssuanceId: { type: 'string', pattern: MPT.source, description: 'The share token, an MPT issuance id of 48 hex characters.' } }
const unitsArg = { units: { type: 'string', pattern: UNITS.source, description: 'Optional: value a pledge of this many share units.' } }

/** Each tool is one GET. `path` gets arguments already checked against the schema's patterns. */
const TOOLS = [
  {
    name: 'list_facilities',
    description: 'Every lending facility Orma tracks, worst grade first: grade, outlook, reported and held unit value, and the gap between them in basis points.',
    inputSchema: { type: 'object', properties: {} },
    path: () => '/api/vaults',
  },
  {
    name: 'get_valuation',
    description: 'What one unit of a facility is worth (orma.nav/1): the held value a lender should use, the reported value the vault states, the gap, an advisory grade, and the ledger fields to recompute it.',
    inputSchema: { type: 'object', properties: vaultArg, required: ['vaultId'] },
    path: (a) => `/api/vaults/${a.vaultId}/nav`,
  },
  {
    name: 'get_valuation_by_share',
    description: 'The same valuation, from the share token alone, optionally valuing a pledge of a number of units.',
    inputSchema: { type: 'object', properties: { ...mptArg, ...unitsArg }, required: ['mptIssuanceId'] },
    path: (a) => `/api/mpt/${a.mptIssuanceId}/nav${a.units ? `?units=${a.units}` : ''}`,
  },
  {
    name: 'get_facility',
    description: 'Everything about one facility: vault, loan broker, loans and their status, the score with every notch, alerts, redemption cliff.',
    inputSchema: { type: 'object', properties: vaultArg, required: ['vaultId'] },
    path: (a) => `/api/vaults/${a.vaultId}`,
  },
  {
    name: 'get_manager_conduct',
    description: "What the facility's manager actually did, reconstructed from the ledger: defaults, impairments, cover withdrawals, the order losses were declared in, and a conduct grade.",
    inputSchema: { type: 'object', properties: vaultArg, required: ['vaultId'] },
    path: (a) => `/api/vaults/${a.vaultId}/broker-history`,
  },
]

const PATTERNS = { vaultId: VAULT, mptIssuanceId: MPT, units: UNITS }

/** Arguments come from a model: anything that is not exactly the expected shape is refused before it reaches a URL. */
function checkArgs(tool, args) {
  for (const k of tool.inputSchema.required ?? []) if (args[k] === undefined) return `missing ${k}`
  for (const [k, v] of Object.entries(args)) {
    if (!(k in tool.inputSchema.properties)) return `unknown argument ${k}`
    if (typeof v !== 'string' || !PATTERNS[k].test(v)) return `${k} does not match ${PATTERNS[k].source}`
  }
  return null
}

async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { isError: true, content: [{ type: 'text', text: `no tool ${name}` }] }
  const bad = checkArgs(tool, args)
  if (bad) return { isError: true, content: [{ type: 'text', text: bad }] }
  // 30 s: the API sleeps when idle and takes about 22 s to wake.
  const res = await fetch(API + tool.path(args), { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
  const text = await res.text()
  return { isError: !res.ok, content: [{ type: 'text', text }] }
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return {
        // The version the client asked for: this server uses nothing that differs between them.
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'orma', version: '1.0.0' },
        instructions: 'Read-only credit readings of XRP Ledger lending vaults on Devnet. Use the held unit value, not the reported one, to value a pledge. Amounts are decimal strings; never parse them into floats.',
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
    case 'tools/call':
      try {
        return await callTool(params?.name, params?.arguments)
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e?.name === 'TimeoutError' ? 'the API did not answer within 30 s' : 'the API could not be reached' }] }
      }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601, id })
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  const write = (m) => output.write(JSON.stringify(m) + '\n')
  createInterface({ input }).on('line', async (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    if (msg.id === undefined) return // a notification, such as notifications/initialized: no answer
    try {
      write({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) })
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve()
