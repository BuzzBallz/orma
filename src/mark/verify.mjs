/**
 * orma-mark: a third party checks a vault share from its MPT id alone, and a pointer copied onto
 * another share is rejected. Every step reads the ledger itself; nothing is taken from the service
 * that serves the valuation except the valuation being checked.
 *
 *   node src/mark/verify.mjs <shareMptId> [--ws <url>] [--domain <host>]
 *
 * Exit: 0 agree, 4 disagree, 64 invalid usage, 1 the node could not be reached at all.
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { num, Decimal } from '../num.mjs'
import { Reader } from '../poll.mjs'
import { Xrpl, normaliseVault, DEVNET_WS } from '../xrpl.mjs'
import { parseShareMetadata, navPointerFrom } from '../metadata.mjs'
import { spoofReason } from '../nav.mjs'
import { oracleDocId, decodePrice } from '../oracle.mjs'
import { MARK_STEPS } from '../nyc/contracts.mjs'

const MAX_BODY = 64 * 1024
const RIPPLE_TO_UNIX = 946684800
const HEX48 = /^[A-Fa-f0-9]{48}$/

/** A step that ends the chain: the reason the verdict is disagree, and what to tell the reader. */
class Stop extends Error {
  constructor(reason, detail) {
    super(detail)
    this.reason = reason
  }
}

export const exitCodeFor = (mark) => (mark.verdict === 'agree' ? 0 : 4)

export function defaultPublisherDomain(env = process.env) {
  try {
    const u = new URL(env.PUBLIC_BASE ?? '')
    if (u.protocol === 'https:') return u.host
  } catch { /* no PUBLIC_BASE, or not a URL */ }
  return 'ormaprotocol.com'
}

/** The share's valuation lives at the publisher's domain, under one of two paths, and nowhere else. */
function pointerFormOk(url, token, domain) {
  let u
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && u.host === domain.toLowerCase() && !u.username && !u.password && !u.search && !u.hash
    && new RegExp(`^/(?:v|api/mpt)/${token}/nav$`, 'i').test(u.pathname)
}

async function getText(fetchImpl, url, what) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'manual', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Stop('UNREACHABLE', `${what}: HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_BODY) throw new Stop('UNREACHABLE', `${what}: answered, but over ${MAX_BODY / 1024} KB`)
  return text
}

/** The devnet [[ACCOUNTS]] of an xrp-ledger.toml: only `address` and `network` are read. */
function accountsFromToml(text) {
  const out = []
  let cur = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      cur = line === '[[ACCOUNTS]]' ? {} : null
      if (cur) out.push(cur)
      continue
    }
    const m = cur && /^(address|network)\s*=\s*"([^"]*)"/.exec(line)
    if (m) cur[m[1]] = m[2]
  }
  return out.filter((a) => a.network === 'devnet' && a.address).map((a) => a.address)
}

const withinTolerance = (a, b, tolerance) => num(a).minus(num(b)).abs().lte(new Decimal(tolerance))

/**
 * @param {string} mptId
 * @param {{ xrpl: import('../xrpl.mjs').Xrpl, fetchImpl?: Function, overrideUrl?: string, tolerance?: string, publisherDomain?: string, publisherAccount?: string }} opts
 * @returns {Promise<import('../nyc/contracts.mjs').Mark>}
 */
export async function verify(mptId, { xrpl, fetchImpl = globalThis.fetch, overrideUrl, tolerance = '0.000001', publisherDomain = defaultPublisherDomain(), publisherAccount } = {}) {
  if (!HEX48.test(String(mptId))) throw new TypeError('verify takes a 48-hex share MPT id')
  const token = String(mptId).toUpperCase()
  await xrpl.closeTime()
  const L = xrpl.lastLedger
  const H = xrpl.lastLedgerHash

  const steps = []
  let stopped = null
  const stage = async (name, fn) => {
    if (stopped) return
    try {
      steps.push({ step: name, ok: true, detail: await fn() })
    } catch (e) {
      const detail = e instanceof Stop ? e.message : String(e?.data?.error ?? e?.message ?? e).slice(0, 120)
      steps.push({ step: name, ok: false, detail })
      stopped = { name, reason: e instanceof Stop ? e.reason : 'UNREACHABLE' }
    }
  }

  let node, pointer, doc, vaultId, vaultRaw
  await stage('read MPTokenIssuance', async () => {
    node = await xrpl.mptIssuance(token, L)
    return `issuer ${node.Issuer}, ${node.OutstandingAmount} units outstanding`
  })
  await stage('decode metadata', async () => {
    const parsed = parseShareMetadata(node.MPTokenMetadata)
    if (!parsed.meta) throw new Stop('UNREACHABLE', parsed.reason)
    pointer = navPointerFrom(parsed.meta, token)
    if (!pointer) throw new Stop('UNREACHABLE', 'no orma.nav_url in the metadata')
    return pointer
  })
  await stage('fetch nav', async () => {
    const url = overrideUrl ?? pointer
    // Judged before any request: otherwise the service would fetch whatever URL a share names.
    if (!pointerFormOk(url, token, publisherDomain)) {
      throw new Stop('SPOOFED', `SPOOFED: the pointer is not https://${publisherDomain}/v/<token>/nav nor /api/mpt/<token>/nav`)
    }
    const text = await getText(fetchImpl, url, 'fetch nav')
    try { doc = JSON.parse(text) } catch { throw new Stop('UNREACHABLE', 'answered, but not JSON') }
    if (!doc?.unitValue?.held) throw new Stop('UNREACHABLE', 'answered, but the document carries no unitValue')
    return `unit value ${doc.unitValue.held}`
  })
  await stage('anti-spoof', async () => {
    const why = await spoofReason(xrpl, token, node.Issuer, doc)
    if (why) throw new Stop('SPOOFED', `SPOOFED: ${why}`)
    vaultId = doc.instrument.vaultId
    return `issuer ${node.Issuer} holds vault ${vaultId}, which issues this share`
  })
  await stage('recompute', async () => {
    if (!Number.isInteger(doc.ledgerIndex)) throw new Stop('RECOMPUTE_MISMATCH', 'the document names no ledger to recompute at')
    vaultRaw = await xrpl.vaultInfo(vaultId, doc.ledgerIndex)
    const mine = Reader.nav(normaliseVault({ ...vaultRaw, index: vaultRaw.index ?? vaultId }, 0)).navCorrect
    if (!withinTolerance(mine, doc.unitValue.held, tolerance)) {
      throw new Stop('RECOMPUTE_MISMATCH', `the document says ${doc.unitValue.held}, the vault at ledger ${doc.ledgerIndex} gives ${mine}`)
    }
    return `${mine} at ledger ${doc.ledgerIndex}`
  })
  await stage('oracle cross-check', async () => {
    const at = doc.ledgerIndex
    let account = publisherAccount
    if (!account) {
      const tomlUrl = `https://${publisherDomain}/.well-known/xrp-ledger.toml`
      const unresolved = `no oracle published: publisher not resolved from ${tomlUrl}`
      let candidates = []
      try { candidates = accountsFromToml(await getText(fetchImpl, tomlUrl, 'toml')) } catch { return unresolved }
      for (const address of candidates) {
        try {
          const root = (await xrpl.req({ command: 'account_info', account: address, ledger_index: at })).result.account_data
          if (root?.Domain && Buffer.from(root.Domain, 'hex').toString('utf8') === publisherDomain) { account = address; break }
        } catch { /* an account that cannot be read is not the publisher */ }
      }
      if (!account) return unresolved
    }
    const docId = oracleDocId(vaultId)
    let oracle
    try {
      oracle = (await xrpl.req({ command: 'ledger_entry', oracle: { account, oracle_document_id: docId }, ledger_index: at })).result.node
    } catch (e) {
      if (e?.data?.error === 'entryNotFound' || e?.data?.error === 'objectNotFound') return 'no oracle published'
      throw e
    }
    const pair = (oracle.PriceDataSeries ?? []).map((e) => e.PriceData).find((d) => d?.QuoteAsset === 'NAV' && d.AssetPrice !== undefined)
    if (!pair) return 'no oracle published: the object carries no NAV'
    const nav = new Decimal(decodePrice(pair.AssetPrice).toString()).div(new Decimal(10).pow(Number(pair.Scale ?? 0))).toFixed(6)
    const named = `oracle ${account} doc ${docId} NAV ${nav}`
    if (withinTolerance(nav, doc.unitValue.held, tolerance)) return `${named} agrees`

    // The publisher computes its NAV on a snapshot older than its OracleSet, so a publication
    // validated just after a change to the Vault can still carry the value from before it.
    const changed = vaultRaw.PreviousTxnLgrSeq
    if (Number.isInteger(changed) && changed > 1) {
      const closed = Number((await xrpl.req({ command: 'ledger', ledger_index: changed })).result.ledger.close_time)
      if (Number(oracle.LastUpdateTime) < closed + RIPPLE_TO_UNIX) {
        const before = Reader.nav(normaliseVault({ ...(await xrpl.vaultInfo(vaultId, changed - 1)), index: vaultId }, 0)).navCorrect
        if (withinTolerance(nav, before, tolerance)) return 'oracle pending: last publish precedes this ledger'
      }
    }
    throw new Stop('ORACLE_MISMATCH', `${named} agrees with neither ${doc.unitValue.held} nor the value before the vault's last change`)
  })

  // A chain that stops early still reports all six steps, except a pointer refused before any request.
  if (stopped && !(stopped.reason === 'SPOOFED' && stopped.name === 'fetch nav')) {
    for (const name of MARK_STEPS.slice(steps.length)) steps.push({ step: name, ok: false, detail: `not run: ${stopped.name} failed` })
  }
  return {
    schema: 'orma.mark/1',
    shareMptId: token,
    verdict: stopped ? 'disagree' : 'agree',
    ...(stopped ? { reason: stopped.reason } : {}),
    tolerance,
    steps,
    ledgerIndex: L,
    ledgerHash: H,
    node: xrpl.url,
  }
}

async function main(argv) {
  const args = argv.slice(2)
  let id, ws = process.env.XRPL_WS ?? DEVNET_WS, publisherDomain
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ws' && args[i + 1]) ws = args[++i]
    else if (args[i] === '--domain' && args[i + 1]) publisherDomain = args[++i]
    else if (id === undefined && !args[i].startsWith('--')) id = args[i]
    else id = null
  }
  if (!id || !HEX48.test(id)) {
    console.error('usage: node src/mark/verify.mjs <shareMptId, 48 hex> [--ws <url>] [--domain <host>]')
    process.exitCode = 64
    return
  }
  const xrpl = new Xrpl(ws)
  try {
    await xrpl.client.connect()
    const mark = await verify(id, { xrpl, ...(publisherDomain ? { publisherDomain } : {}) })
    console.log(JSON.stringify(mark))
    process.exitCode = exitCodeFor(mark)
  } catch (e) {
    console.error(`could not verify: ${String(e?.message ?? e).slice(0, 200)}`)
    process.exitCode = 1
  } finally {
    await xrpl.disconnect()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv)
