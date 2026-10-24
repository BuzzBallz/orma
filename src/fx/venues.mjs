/**
 * The three public XRP/USD quotes the Devnet relay (src/demo/fx-relay.mjs) turns into XLS-47 Oracle
 * documents, one document per venue, and that the risk officer's terms name (src/demo/anchor-usd-terms.mjs).
 * Each answers without a key, its price a decimal string; read 24 Oct 2026. On mainnet the terms name
 * independent oracle providers instead and this list is not used.
 */
import { num } from '../num.mjs'
import { encodePrice } from '../oracle.mjs'

const DEC = /^\d+(?:\.\d+)?$/

/**
 * @typedef {{ documentId: number, provider: string, uri: string, read: (body: any) => { price?: unknown, at?: unknown } }} Venue
 * @type {readonly Venue[]}
 */
export const FX_VENUES = Object.freeze([
  // Kraken's ticker: c = [last trade price, lot volume]; no timestamp
  { documentId: 1, provider: 'kraken', uri: 'https://api.kraken.com/0/public/Ticker?pair=XRPUSD', read: (b) => ({ price: b?.result?.XXRPZUSD?.c?.[0] }) },
  // Bitstamp's ticker: last trade, its UNIX timestamp as a string
  { documentId: 2, provider: 'bitstamp', uri: 'https://www.bitstamp.net/api/v2/ticker/xrpusd/', read: (b) => ({ price: b?.last, at: b?.timestamp }) },
  // Coinbase Exchange's ticker: last trade, its ISO time
  { documentId: 3, provider: 'coinbase', uri: 'https://api.exchange.coinbase.com/products/XRP-USD/ticker', read: (b) => ({ price: b?.price, at: b?.time }) },
])

/** A venue's quote older than this is not relayed as fresh. */
export const MAX_QUOTE_AGE_SECONDS = 120

/**
 * One venue's last XRP/USD trade, as a decimal string, or why there is none. Never a number: the price is
 * kept as the venue sent it.
 * @param {Venue} venue
 * @param {{ fetchImpl?: typeof fetch, nowMs?: number }} [o]
 * @returns {Promise<{ ok: true, price: string, at: string|null } | { ok: false, reason: string }>}
 */
export async function quoteOf(venue, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  let body
  try {
    const res = await fetchImpl(venue.uri, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json', 'user-agent': 'orma-devnet-fx-relay' } })
    if (res.status !== 200) return { ok: false, reason: `${venue.provider} answered HTTP ${res.status}` }
    body = await res.json()
  } catch (e) {
    return { ok: false, reason: `${venue.provider} did not answer (${String(e?.message ?? e).slice(0, 80)})` }
  }
  const { price, at } = venue.read(body)
  if (typeof price !== 'string' || !DEC.test(price) || !num(price).gt(0)) return { ok: false, reason: `${venue.provider} sent no price we can read (${JSON.stringify(price)?.slice(0, 40)})` }
  let atMs = null
  if (typeof at === 'string' && /^\d+$/.test(at)) atMs = Number.parseInt(at, 10) * 1000 // a UNIX time, not an amount
  else if (typeof at === 'string') atMs = Date.parse(at)
  if (atMs !== null && Number.isFinite(atMs) && nowMs - atMs > MAX_QUOTE_AGE_SECONDS * 1000) {
    return { ok: false, reason: `${venue.provider}'s last trade is ${Math.round((nowMs - atMs) / 1000)} s old, more than ${MAX_QUOTE_AGE_SECONDS} s` }
  }
  return { ok: true, price: num(price).toFixed(), at: atMs !== null && Number.isFinite(atMs) ? new Date(atMs).toISOString() : null }
}

/**
 * A decimal XRP/USD price as an XLS-47 PriceData stores it: AssetPrice a UInt64 in hex, scaled by 10^-Scale,
 * exact (at most 10 decimals kept, rounded down). pairOf of src/fx/price.mjs reads it back to the same string.
 * @param {string} price
 */
export function priceDataOf(price) {
  const p = num(price).toDecimalPlaces(10, 1) // ROUND_DOWN
  const scale = Math.max(0, p.decimalPlaces())
  return { BaseAsset: 'XRP', QuoteAsset: 'USD', AssetPrice: encodePrice(p.times(num(10).pow(scale)).toFixed(0)), Scale: scale }
}
