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
import { num } from './num.mjs'
import { parseShareMetadata, navPointerFrom, xls89Report } from './metadata.mjs'
import { logger } from './log.mjs'

const log = logger('nav')

export const NAV_SCHEMA = 'orma.nav/1'

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
      assetsTotal: v.assetsTotal.toFixed(0),
      lossUnrealized: v.lossUnrealized.toFixed(0),
      unitsOutstanding: v.sharesOutstanding.toFixed(0),
      recompute: '(assetsTotal - lossUnrealized) / unitsOutstanding',
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
  const u = num(units)
  const held = u.times(num(uv.held))
  const reported = u.times(num(uv.reported))
  return {
    units: u.toFixed(0),
    valueHeld: held.toFixed(0),
    valueReported: reported.toFixed(0),
    overstatement: reported.minus(held).toFixed(0),
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
 * @param {{resolve?: boolean, fetchImpl?: Function, localBase?: string}} [opts]
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
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 2500)
  try {
    const res = await fetchImpl(pointer, { signal: ctl.signal, headers: { accept: 'application/json' } })
    const body = await res.json()
    if (!res.ok) {
      step('follow pointer', false, `HTTP ${res.status}`)
    } else if (!body?.unitValue?.held) {
      // A 200 that is not a valuation. Reporting this as success is how a caller ends up
      // trusting a document that says nothing.
      step('follow pointer', false, 'answered, but the document carries no unitValue')
    } else {
      out.nav = body
      step('follow pointer', true, `unit value ${body.unitValue.held}`)
    }
  } catch (e) {
    step('follow pointer', false, (e?.name === 'AbortError' ? 'timeout' : String(e)).slice(0, 100))
    log.warn('nav pointer did not answer', { pointer, err: String(e).slice(0, 80) })
  } finally {
    clearTimeout(timer)
  }
  return out
}
