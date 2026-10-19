/**
 * The valuation endpoint a vault share's own metadata points at, and the resolver that
 * walks the pointer for someone who holds nothing but the token.
 *
 * WHY THIS IS THE PRODUCT AND NOT A ROUTE. Everything else here reads a vault for
 * someone who already knows the vault. This reads a vault for someone who does not: a
 * second broker, handed vault shares as collateral, holding an MPT issuance id. They
 * have no relationship with the facility, no access to its reporting, and no reason to
 * trust a figure we hand them. What they have is a token, and a token that says where
 * its honest valuation lives is a token they can lend against.
 *
 * That is the difference between a dashboard and a primitive. The dashboard is something
 * you have to know about. The primitive is reachable from the asset itself.
 *
 * THE SHAPE IS DELIBERATELY SMALL AND STABLE. The metadata carrying this URL can never
 * be rewritten (Appendix D1), so the contract at the end of it is effectively permanent.
 * Fields may be added. Nothing here may ever be renamed, retyped or removed.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { num, wholeShares, amountStr } from './num.mjs'
import { parseShareMetadata, navPointerFrom, xls89Report } from './metadata.mjs'
import { logger } from './log.mjs'

const log = logger('nav')

export const NAV_SCHEMA = 'orma.nav/1'

// Anyone can mint a share whose pointer names a host inside our network. The resolver
// follows only hosts every address of which is public, and reads at most this much.
const NOT_PUBLIC = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) NOT_PUBLIC.addSubnet(net, bits, 'ipv4')
// No ::ffff:0:0/96 rule: BlockList already checks an IPv4-mapped address against the IPv4
// rules, and such a rule would match every IPv4 address.
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]]) NOT_PUBLIC.addSubnet(net, bits, 'ipv6')
const MAX_POINTER_BYTES = 64 * 1024

// shortcut: the address is checked, then fetch resolves the name again, so a DNS rebinding
// in between gets through; pin the checked address in an http agent if that matters.
async function isPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '')
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true })
  return addrs.length > 0 && addrs.every((a) => !NOT_PUBLIC.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))
}

async function readCapped(res) {
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_POINTER_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The valuation itself, from a reader snapshot.
 *
 * Reports BOTH readings on purpose. Handing over only the honest number asks the
 * consumer to take our word for it; handing over both, with the gap named, lets them see
 * what the naive computation would have told them and decide for themselves. The whole
 * finding is that those two numbers differ and that one of them is silently wrong.
 */
export function presentNav(snap, opts = {}) {
  const v = snap.vault
  const naive = snap.navNaive
  const correct = snap.navCorrect
  return {
    schema: NAV_SCHEMA,
    // The reader stamps time and ledger on the envelope, so this repeats them inside the
    // document on purpose: a consumer who caches or forwards just this object must still
    // be able to say how old the figure is. A valuation without an as-of is not a
    // valuation.
    asOf: opts.asOf ?? null,
    ledgerIndex: opts.ledgerIndex ?? null,

    instrument: {
      kind: 'vault-share',
      vaultId: v.vaultId,
      shareMptId: v.shareMptId,
      unitsOutstanding: v.sharesOutstanding.toFixed(0),
      asset: v.asset,
      vaultKind: v.vaultKind,
      phase: v.phase,
      redemptionAt: v.redemptionAt,
    },

    // The number a lender should use.
    unitValue: {
      held: correct,
      reported: naive,
      divergenceBps: snap.navDivergenceBps,
      basis: 'assets net of recognised loss, divided by units outstanding',
    },

    // What one unit is worth, and what a pledge of N units is worth, so a consumer does
    // not have to reimplement decimal arithmetic to use this. Integer drops, as strings.
    valuation: {
      currency: v.asset?.kind === 'XRP' ? 'XRP' : v.asset?.currency ?? null,
      scale: 6,
      perUnitHeld: correct,
      perUnitReported: naive,
    },

    // The grade, so a consumer gets the credit view in the same call. Advisory: the
    // number above is a measurement, this is an opinion, and they are labelled apart.
    assessment: opts.score
      ? { grade: opts.score.grade, gradeNumeric: opts.score.gradeNumeric, methodVersion: opts.score.methodVersion, advisory: true }
      : null,

    // Never make a consumer trust us: name the ledger state this was computed from so
    // they can recompute it themselves.
    provenance: {
      network: opts.network ?? 'devnet',
      source: opts.source ?? 'devnet',
      assetsTotal: amountStr(v.assetsTotal, v.asset),
      lossUnrealized: amountStr(v.lossUnrealized, v.asset),
      unitsOutstanding: v.sharesOutstanding.toFixed(0),
      scale: v.scale ?? 0,
      recompute: '(assetsTotal - lossUnrealized) / (unitsOutstanding / 10^scale)',
      buildVersion: opts.buildVersion ?? null,
    },
  }
}

/**
 * Value a specific quantity of units against this valuation.
 * Pure string arithmetic: a caller must never be pushed through a float to use this.
 */
export function valuePledge(nav, units) {
  // Total on purpose. The document reaching here came off a URL written into a token by
  // a third party, so it may be any shape at all, including a valid 200 that is not a
  // valuation. A lender's collateral tool must say "I could not value this" rather than
  // throw -- and this already caught a real one: an early version of the pointer route
  // resolved to the diagnostic rather than to the valuation, returned a perfectly good
  // 200 with no unitValue on it, and crashed the caller.
  const uv = nav?.unitValue
  if (!uv || uv.held === undefined || uv.reported === undefined) {
    return {
      units: num(units).toFixed(0),
      valueHeld: null,
      valueReported: null,
      overstatement: null,
      unpriced: 'the document at the pointer carries no unitValue, so this pledge cannot be valued',
    }
  }
  // The unit value is per whole share; a pledge counts raw share units. A document without a
  // scale is an XRP or MPT vault (Scale 0), whose amounts are integers.
  const scale = Number(nav.provenance?.scale ?? 0)
  const u = num(units)
  const whole = wholeShares(u, scale)
  const held = whole.times(num(uv.held))
  const reported = whole.times(num(uv.reported))
  const fmt = (d) => (scale ? d.toFixed() : d.toFixed(0))
  return {
    units: u.toFixed(0),
    valueHeld: fmt(held),
    valueReported: fmt(reported),
    overstatement: fmt(reported.minus(held)),
  }
}

/**
 * Resolve a valuation from an MPT issuance id alone.
 *
 * This is the loop a second broker actually runs, and every step of it is on the ledger
 * or on a URL the ledger names:
 *
 *   1. read the MPTokenIssuance
 *   2. decode its metadata
 *   3. follow orma.nav_url
 *
 * It never throws. Each step reports what it found, including that the token says
 * nothing at all, because "this collateral is opaque" is a legitimate and useful answer
 * to give a lender, and a far better one than an exception.
 *
 * @param {import('./xrpl.mjs').Xrpl} xrpl
 * @param {string} issuanceId
 * @param {{resolve?: boolean, fetchImpl?: Function, localBase?: string, allowPrivate?: boolean}} [opts]
 *   allowPrivate: follow a pointer to a private host. For the operator's own bake, never the API.
 */
export async function resolveFromIssuance(xrpl, issuanceId, opts = {}) {
  const steps = []
  const step = (name, ok, detail) => { steps.push({ step: name, ok, detail }); return ok }

  let node
  try {
    node = await xrpl.mptIssuance(issuanceId)
    step('read MPTokenIssuance', true, `issuer ${node.Issuer}, ${node.OutstandingAmount} units outstanding`)
  } catch (e) {
    step('read MPTokenIssuance', false, (e?.data?.error ?? String(e)).slice(0, 120))
    return { issuanceId, resolved: false, steps, metadata: null, nav: null }
  }

  const parsed = parseShareMetadata(node.MPTokenMetadata)
  if (!parsed.meta) {
    step('decode metadata', false, parsed.reason)
    return {
      issuanceId,
      issuer: node.Issuer,
      unitsOutstanding: String(node.OutstandingAmount ?? '0'),
      resolved: false,
      opaque: true,
      steps,
      metadata: { present: parsed.present, reason: parsed.reason, raw: parsed.raw ?? null },
      nav: null,
    }
  }
  step('decode metadata', true, 'valid JSON')

  const conformance = xls89Report(parsed.meta)
  step('XLS-89 conformance', conformance.conformant,
    conformance.conformant ? `asset_class ${conformance.assetClass}` : `missing ${conformance.missing.join(', ') || 'nothing'}, asset_class ${conformance.assetClass ?? 'absent'}`)

  const pointer = navPointerFrom(parsed.meta, issuanceId)
  if (!pointer) {
    step('find valuation pointer', false, 'no orma.nav_url in the metadata')
    return {
      issuanceId,
      issuer: node.Issuer,
      unitsOutstanding: String(node.OutstandingAmount ?? '0'),
      resolved: false,
      steps,
      metadata: { present: true, meta: parsed.meta, conformance },
      nav: null,
    }
  }
  step('find valuation pointer', true, pointer)

  const out = {
    issuanceId,
    issuer: node.Issuer,
    unitsOutstanding: String(node.OutstandingAmount ?? '0'),
    resolved: true,
    navUrl: pointer,
    steps,
    metadata: { present: true, meta: parsed.meta, conformance },
    nav: null,
  }
  if (opts.resolve === false) return out

  // Following the pointer is the last step and the only one that leaves the ledger. It
  // is a URL written by a third party, so it is bounded and its failure is data.
  // Its failures are reported in fixed words: a detail that echoes the error or the body
  // tells the caller what answers inside our network.
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 2500)
  try {
    if (!opts.allowPrivate && !(await isPublicHost(new URL(pointer).hostname))) {
      step('follow pointer', false, 'not followed: the host is not a public address')
      return out
    }
    const res = await fetchImpl(pointer, { signal: ctl.signal, redirect: 'manual', headers: { accept: 'application/json' } })
    if (res.status >= 300 && res.status < 400) {
      step('follow pointer', false, `HTTP ${res.status}, redirect not followed`)
      return out
    }
    if (!res.ok) {
      step('follow pointer', false, `HTTP ${res.status}`)
      return out
    }
    const text = await readCapped(res)
    let body = null
    try { body = text === null ? null : JSON.parse(text) } catch { /* reported below */ }
    if (text === null) {
      step('follow pointer', false, `answered, but over ${MAX_POINTER_BYTES / 1024} KB`)
    } else if (body === null) {
      step('follow pointer', false, 'answered, but not JSON')
    } else if (!body?.unitValue?.held) {
      // A 200 that is not a valuation. Reporting this as success is how a caller ends up
      // trusting a document that says nothing.
      step('follow pointer', false, 'answered, but the document carries no unitValue')
    } else {
      out.nav = body
      step('follow pointer', true, `unit value ${body.unitValue.held}`)
    }
  } catch (e) {
    step('follow pointer', false, e?.name === 'AbortError' ? 'timeout' : 'no answer')
    log.warn('nav pointer did not answer', { pointer, err: String(e).slice(0, 80) })
  } finally {
    clearTimeout(timer)
  }
  return out
}
