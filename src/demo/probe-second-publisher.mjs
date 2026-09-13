/**
 * A second publisher, so the contestability claim stops being a claim.
 *
 * WHY THIS EXISTS. The argument for putting the score on the ledger rather than behind a
 * REST API is that a ledger object can be contested without our permission: anyone may
 * publish their own reading of the same vault, and `get_aggregate_price` makes rippled,
 * not us, compute the median and the spread. With one publisher that is a property of the
 * design and nothing a jury can see. With two it is on the ledger.
 *
 * WHAT THE SECOND PUBLISHER SAYS. The naive reading, 1.000000 -- exactly the number a
 * metadata-diffing indexer arrives at, and exactly the disagreement this protocol exists
 * to expose. So the spread the ledger reports IS the finding, measured by the ledger.
 *
 * This account is a throwaway funded from the Devnet faucet. Its seed is never written
 * anywhere: it publishes once and is not needed again.
 *
 * Run: node src/demo/probe-second-publisher.mjs
 * Out: demo/oracle-aggregate.json  (TRACKED)
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { Client } from 'xrpl'
import { vaultToBaseAsset, encodePrice } from '../oracle.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const API = process.env.ORMA_API ?? 'http://localhost:8787'
const OUT = 'demo/oracle-aggregate.json'
const DOC_ID = 1

const race = JSON.parse(readFileSync('demo/indexer-race.json', 'utf8'))
const vaultId = race.vaultId
const label = race.label
const naive = race.readings.naive.value      // 1.000000, what a metadata diff arrives at
const correct = race.readings.correct.value  // 0.803922, what the vault holds

// Whoever is publishing right now, read from the service rather than assumed.
const detail = await (await fetch(`${API}/api/vaults/${vaultId}`)).json()
const ours = detail.oracle
if (!ours?.published) throw new Error('the service is not publishing; start it with PUBLISH set')

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const buildVersion = (await c.request({ command: 'server_info' })).result.info.build_version
console.log(`\n  rippled ${buildVersion}`)
console.log(`  ${label}\n`)
console.log(`    our publisher     ${ours.publisher}  doc ${ours.oracleDocumentId}  NAV ${correct}`)

// Re-running should not mint a fresh account every time. Once the second reading is on the
// ledger, SECOND_PUBLISHER re-aggregates it instead of publishing another one.
const reuse = process.env.SECOND_PUBLISHER ?? null
let second = null, publishHash = null, publishCode = 'reused'
if (reuse) {
  console.log(`    second publisher  ${reuse}  doc ${DOC_ID}  (already on the ledger, reused)`)
} else {
  ;({ wallet: second } = await c.fundWallet())
  console.log(`    second publisher  ${second.address}  doc ${DOC_ID}  NAV ${naive} (the naive reading)`)
}
const secondAddress = reuse ?? second.address

const base = vaultToBaseAsset(vaultId)
const scaled = (v, s) => encodePrice(BigInt(Math.round(Number(v) * 10 ** s)))
const ledgerClose = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time_iso
const lut = Math.min(Math.floor(new Date(ledgerClose).getTime() / 1000), Math.floor(Date.now() / 1000))

const r = reuse ? null : await c.submitAndWait(
  {
    TransactionType: 'OracleSet',
    Account: secondAddress,
    OracleDocumentID: DOC_ID,
    Provider: Buffer.from('Naive metadata indexer', 'utf8').toString('hex').toUpperCase(),
    AssetClass: Buffer.from('risk', 'utf8').toString('hex').toUpperCase(),
    LastUpdateTime: lut,
    PriceDataSeries: [{ PriceData: { BaseAsset: base, QuoteAsset: 'NAV', AssetPrice: scaled(naive, 6), Scale: 6 } }],
  },
  { wallet: second, autofill: true },
)
if (r) {
  publishCode = r.result.meta.TransactionResult
  publishHash = r.result.hash
  console.log(`    OracleSet  ${publishCode}  ${publishHash}`)
  if (publishCode !== 'tesSUCCESS') { await c.disconnect(); throw new Error(`second publish returned ${publishCode}`) }
}

// THE BEAT. rippled computes this, across two accounts that have no relationship.
const oracles = [
  { account: ours.publisher, oracle_document_id: ours.oracleDocumentId },
  { account: secondAddress, oracle_document_id: DOC_ID },
]
let agg = null, aggError = null
try {
  const a = await c.request({ command: 'get_aggregate_price', base_asset: base, quote_asset: 'NAV', oracles })
  agg = a.result
} catch (e) { aggError = (e?.data?.error ?? String(e)).slice(0, 120) }

const out = {
  probedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  probedDuring: 'XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026',
  network: 'devnet',
  buildVersion,
  label,
  vaultId,
  baseAsset: base,
  quoteAsset: 'NAV',
  question: 'Can a second publisher contest our reading without our permission, and does the ledger report the spread?',
  publishers: [
    { role: 'this service', account: ours.publisher, oracleDocumentId: ours.oracleDocumentId, provider: 'BuzzBallz Vault Solvency', nav: correct, basis: 're-reads the vault object' },
    { role: 'an independent second reader', account: secondAddress, oracleDocumentId: DOC_ID, provider: 'Naive metadata indexer', nav: naive, basis: 'diffs transaction metadata', publishHash },
  ],
  aggregate: agg
    ? {
        median: agg.median ?? null,
        mean: agg.entire_set?.mean ?? null,
        standardDeviation: agg.entire_set?.standard_deviation ?? null,
        size: agg.entire_set?.size ?? null,
        ledgerIndex: agg.ledger_index ?? null,
        computedBy: 'rippled, from get_aggregate_price. Neither publisher computed it and neither can alter it.',
      }
    : null,
  aggregateError: aggError,
  answer: agg
    ? `Yes. Two publishers, no relationship between them, and rippled reports a median of ${agg.median} across a spread neither of them controls.`
    : `INCONCLUSIVE: get_aggregate_price returned ${aggError}. Do not cite this.`,
  reproduce: {
    command: 'get_aggregate_price',
    base_asset: base,
    quote_asset: 'NAV',
    oracles,
  },
  redacted: ['The second publisher is a throwaway Devnet faucet account. Its seed was never written to disk.'],
}
mkdirSync('demo', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(`\n  ${out.answer}`)
if (agg) console.log(`    median ${agg.median}   sd ${agg.entire_set?.standard_deviation}   size ${agg.entire_set?.size}`)
console.log(`  -> ${OUT}\n`)
await c.disconnect()
if (!agg) process.exit(1)
