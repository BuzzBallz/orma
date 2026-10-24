/**
 * The XRP/USD price a loan in the test dollar is valued at (step 21, addendum A11). The risk officer's terms
 * name the price sources, never a price: XLS-47 Oracle documents, each read by ledger_entry at the ledger L
 * of the decision. A source is fresh when its LastUpdateTime is at most maxAgeSeconds before close_time(L);
 * the price is the median of the fresh ones, provided there are at least minSources of them and they lie
 * within maxSpreadBps of each other; then the ledger's own get_aggregate_price over the same documents at L
 * must give the same median. Anything less is no price, and no dollar figure: PriceUnavailableError, with
 * the sentence (the I7 rule, applied to the price).
 *
 * On Devnet the documents are relayed from public exchange quotes by a test account of the desk
 * (src/demo/fx-relay.mjs), standing in for independent oracle providers, since none publishes XRP/USD there.
 * On mainnet the terms name independent providers and nothing here changes.
 *
 * get_aggregate_price alone would not do: it answers from documents months old, and its time_threshold is
 * counted from the newest document, not from the ledger's close (both read on Devnet, 24 Oct 2026).
 */
import { num } from '../num.mjs'
import { decodePrice } from '../oracle.mjs'
import { medianOf, spreadBpsOf, RIPPLE_EPOCH_OFFSET } from '../nyc/contracts.mjs'

/** No usable XRP/USD price at this ledger: no dollar figure is computed. */
export class PriceUnavailableError extends Error {
  /** @param {string} message @param {{ sources?: any[], ledgerIndex?: number|null }} [detail] */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'PriceUnavailableError'
    this.code = 'PRICE_UNAVAILABLE'
    this.sources = detail.sources ?? []
    this.ledgerIndex = detail.ledgerIndex ?? null
  }
}

const isoOfUnix = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * The base/quote pair of an Oracle object as rippled stores it: AssetPrice a UInt64 in hex, scaled by
 * 10^-Scale. Null when the document carries no price for the pair (a pair listed without AssetPrice is one
 * whose price was withdrawn).
 * @returns {{ price: string, lastUpdateTime: number } | null}
 */
export function pairOf(node, base = 'XRP', quote = 'USD') {
  const d = (node?.PriceDataSeries ?? []).map((e) => e.PriceData).find((x) => x?.BaseAsset === base && x?.QuoteAsset === quote && x.AssetPrice !== undefined)
  if (!d || !Number.isSafeInteger(node.LastUpdateTime)) return null
  return { price: num(decodePrice(d.AssetPrice).toString()).div(num(10).pow(d.Scale ?? 0)).toFixed(), lastUpdateTime: node.LastUpdateTime }
}

/**
 * Pure: the price of the terms' sources at close_time(L), or why there is none. A source is fresh when it
 * was updated at most maxAgeSeconds before the close and not after it (rippled lets a document be dated up
 * to 300 s ahead of its ledger; a date after the ledger read is not an age, and is not fresh). A source that
 * could not be read (`unread`, with the reason) has no price; the others still decide.
 * @param {{ source: import('../nyc/contracts.mjs').OracleSource, node: any|null, unread?: string }[]} reads
 * @param {import('../nyc/contracts.mjs').XrpUsdOracle} oracle
 * @param {{ ledgerIndex: number, ledgerHash: string|null, closeTime: number }} at
 * @returns {{ usable: true, reference: object, used: object[] } | { usable: false, reason: string, sources: object[] }}
 */
export function judgePrice(reads, oracle, at) {
  const closeUnix = at.closeTime + RIPPLE_EPOCH_OFFSET
  const unread = []
  const ahead = []
  const sources = reads.map(({ source, node, unread: why }) => {
    if (why) unread.push(`${source.provider} (${why})`)
    const pair = why ? null : pairOf(node, oracle.baseAsset, oracle.quoteAsset)
    const age = pair ? closeUnix - pair.lastUpdateTime : null
    if (age !== null && age < 0) ahead.push(`${source.provider} ${-age} s`)
    const fresh = pair !== null && age >= 0 && age <= oracle.maxAgeSeconds
    return {
      account: source.account, documentId: source.documentId, provider: source.provider, uri: source.uri,
      price: pair?.price ?? null, lastUpdateTime: pair ? isoOfUnix(pair.lastUpdateTime) : null, ageSeconds: age === null ? null : String(age),
      fresh, used: fresh, ledgerIndex: at.ledgerIndex, ledgerHash: at.ledgerHash,
    }
  })
  const used = sources.filter((s) => s.used)
  const of = `${sources.length} XRP/USD oracle document${sources.length === 1 ? '' : 's'} of the terms`
  if (used.length < oracle.minSources) {
    const stale = sources.filter((s) => s.price !== null && !s.fresh && !s.ageSeconds?.startsWith('-')).map((s) => `${s.provider} ${s.ageSeconds} s old`)
    const unreadNames = new Set(unread.map((u) => u.split(' ')[0]))
    const missing = sources.filter((s) => s.price === null && !unreadNames.has(s.provider)).map((s) => s.provider)
    const why = [
      stale.length && `stale: ${stale.join(', ')}`, ahead.length && `dated after the ledger: ${ahead.join(', ')}`,
      missing.length && `no price: ${missing.join(', ')}`, unread.length && `not read: ${unread.join(', ')}`,
    ].filter(Boolean).join('; ')
    return { usable: false, sources, reason: `Only ${used.length} of the ${of} ${used.length === 1 ? 'is' : 'are'} fresh at ledger ${at.ledgerIndex} (at most ${oracle.maxAgeSeconds} s old), and the terms need ${oracle.minSources}${why ? ` (${why})` : ''}. No dollar figure is computed.` }
  }
  const prices = used.map((s) => s.price)
  const spreadBps = spreadBpsOf(prices)
  if (spreadBps > oracle.maxSpreadBps) {
    return { usable: false, sources, reason: `The fresh XRP/USD sources disagree by ${spreadBps} bps at ledger ${at.ledgerIndex}, more than the terms' ${oracle.maxSpreadBps} bps (${used.map((s) => `${s.provider} ${s.price}`).join(', ')}). No dollar figure is computed.` }
  }
  const oldest = used.map((s) => s.lastUpdateTime).sort()[0]
  return {
    usable: true,
    used,
    reference: {
      value: medianOf(prices), provenance: 'REAL',
      method: 'median of the fresh XLS-47 oracle documents the terms name, each read at the ledger of the ticket',
      asOf: oldest, ageSeconds: String(closeUnix - Date.parse(oldest) / 1000),
      sources, spreadBps, maxSpreadBps: oracle.maxSpreadBps, minSources: oracle.minSources, maxAgeSeconds: oracle.maxAgeSeconds,
      note: oracle.note,
    },
  }
}

const notFound = (e) => e?.data?.error === 'entryNotFound' || e?.data?.error === 'objectNotFound'

/**
 * The XRP/USD price of the terms at one ledger: each document by ledger_entry at L, judged, then the
 * ledger's get_aggregate_price over the used documents at L, which must agree. Throws PriceUnavailableError.
 * @param {any} xrpl
 * @param {import('../nyc/contracts.mjs').UsdTerms} terms
 * @param {{ ledgerIndex: number, ledgerHash: string|null, closeTime: number }} at
 */
export async function readXrpUsd(xrpl, terms, at) {
  const oracle = terms.xrpUsdOracle
  const L = at.ledgerIndex
  const reads = []
  for (const source of oracle.sources) {
    // one source that cannot be read at L (not found, another ledger, a node error, a dropped socket) has no
    // price, and the others still decide
    try {
      const r = await xrpl.req({ command: 'ledger_entry', oracle: { account: source.account, oracle_document_id: source.documentId }, ledger_index: L })
      if (r.result.ledger_index !== L) reads.push({ source, node: null, unread: `answered at ledger ${r.result.ledger_index}, not ${L}` })
      else reads.push({ source, node: r.result.node })
    } catch (e) {
      reads.push({ source, node: null, ...(!notFound(e) && { unread: String(e?.data?.error ?? e?.message ?? e).slice(0, 80) }) })
    }
  }
  const judged = judgePrice(reads, oracle, at)
  if (!judged.usable) throw new PriceUnavailableError(judged.reason, { sources: judged.sources, ledgerIndex: L })
  let agg
  try {
    agg = (await xrpl.req({
      command: 'get_aggregate_price', base_asset: oracle.baseAsset, quote_asset: oracle.quoteAsset, ledger_index: L,
      oracles: judged.used.map((s) => ({ account: s.account, oracle_document_id: s.documentId })),
    })).result
  } catch (e) {
    throw new PriceUnavailableError(`The ledger's get_aggregate_price refused the XRP/USD documents at ledger ${L} (${e?.data?.error ?? e?.message ?? e}). No dollar figure is computed.`, { sources: judged.sources, ledgerIndex: L })
  }
  const size = agg?.entire_set?.size
  if (agg?.ledger_index !== L || typeof agg.median !== 'string' || !num(agg.median).eq(judged.reference.value) || size !== judged.used.length) {
    throw new PriceUnavailableError(`The ledger's get_aggregate_price at ledger ${agg?.ledger_index ?? L} gives a median of ${agg?.median ?? 'nothing'} over ${size ?? 0} documents, not the ${judged.reference.value} read from the ${judged.used.length} documents themselves. No dollar figure is computed.`, { sources: judged.sources, ledgerIndex: L })
  }
  return { ...judged.reference, ledgerAggregate: { median: agg.median, size, ledgerIndex: agg.ledger_index, ledgerHash: agg.ledger_hash ?? at.ledgerHash } }
}
