/**
 * Writes the risk officer's terms for loans in the test dollar once (step 21, addendum A11):
 * demo/usd-terms-desk-1.json, orma.usdterms/1, DECLARED, hashed like the mandate (over its own keys, without
 * hash and anchorTx) and anchored by an AccountSet of the risk officer whose Memo is orma.usdterms/1:<hash>,
 * as the margin policy is. The terms name the price sources, never a price: the three XLS-47 documents of
 * the Devnet relay (src/demo/fx-relay.mjs, src/fx/venues.mjs), the median of the fresh ones, at least
 * MIN_SOURCES of them, at most MAX_AGE_SECONDS old, within MAX_SPREAD_BPS of each other. On mainnet the same
 * document names independent providers' documents instead.
 *
 * Before anything is anchored the sources are read on Devnet at the validated ledger exactly as the desk
 * reads them (src/fx/price.mjs): terms whose sources give no usable price are refused, never anchored.
 * Refuses (exit 2, nothing written or submitted) when the file already carries an anchorTx, when the
 * mandate does not hash to its own hash, without the dollar pool, the relay's address or the risk officer's
 * key. The key is read from .demo/roles.json in this process only, never printed.
 *
 *   node --env-file-if-exists=.env src/demo/anchor-usd-terms.mjs --dry-run   the document, its price now and its Memo; nothing sent
 *   node --env-file-if-exists=.env src/demo/anchor-usd-terms.mjs             anchor on Devnet, then write the file
 * Exit: 0 written (or the dry run printed), 1 the anchor failed, 2 refused.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Client, Wallet } from 'xrpl'
import { mandateHash, usdTermsHash, SCHEMAS, USD_LABEL } from '../nyc/contracts.mjs'
import { FX_VENUES } from '../fx/venues.mjs'
import { readXrpUsd, PriceUnavailableError } from '../fx/price.mjs'

const OUT = 'demo/usd-terms-desk-1.json'
const MANDATE = 'demo/mandate-desk-1.json'
const POOL = 'demo/desk-usd.json'
const ROLES = '.demo/roles.json'
const RELAY_FILE = '.demo/fx-relay.json'
const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const dry = process.argv.includes('--dry-run')

/** The risk officer's choices, beside the haircut and the cap of addendum A11. */
const MIN_SOURCES = 2
const MAX_AGE_SECONDS = 300
const MAX_SPREAD_BPS = 100
const NOTE = 'Devnet stand-in: three XLS-47 documents relayed every 60 s from the last trades of Kraken, Bitstamp and Coinbase by a test account of the desk (src/demo/fx-relay.mjs), because no XRP/USD oracle is maintained on Devnet. On mainnet the terms name independent oracle providers; nothing else changes.'

function refuse(sentence) {
  console.log(`  refused: ${sentence}`)
  process.exitCode = 2
}

async function main() {
  if (existsSync(OUT)) {
    let anchored = false
    try {
      anchored = typeof JSON.parse(readFileSync(OUT, 'utf8')).anchorTx === 'string'
    } catch { /* an unreadable file is refused below, never overwritten blindly */ }
    return refuse(anchored ? `${OUT} already carries an anchorTx; declared terms are never rewritten.` : `${OUT} exists but is unreadable; remove it by hand after checking it.`)
  }
  const mandate = JSON.parse(readFileSync(MANDATE, 'utf8'))
  if (mandateHash(mandate) !== mandate.hash) return refuse(`${MANDATE} does not hash to its own hash.`)
  if (!existsSync(POOL)) return refuse(`${POOL} is missing: run src/demo/bake-usd.mjs first.`)
  const pool = JSON.parse(readFileSync(POOL, 'utf8'))
  const relay = process.env.FX_RELAY_ADDRESS ?? (existsSync(RELAY_FILE) ? JSON.parse(readFileSync(RELAY_FILE, 'utf8')).fxRelay?.address : null)
  if (!relay) return refuse(`no relay address: run src/demo/fx-relay.mjs --init, or set FX_RELAY_ADDRESS.`)

  const body = {
    schema: 'orma.usdterms/1', id: mandate.id, mandateHash: mandate.hash,
    loanAsset: { currency: 'USD', issuer: pool.usdIssuer, label: USD_LABEL },
    xrpUsdOracle: {
      baseAsset: 'XRP', quoteAsset: 'USD',
      sources: FX_VENUES.map((v) => ({ account: relay, documentId: v.documentId, provider: v.provider, uri: v.uri })),
      aggregation: 'median', minSources: MIN_SOURCES, maxAgeSeconds: MAX_AGE_SECONDS, maxSpreadBps: MAX_SPREAD_BPS, note: NOTE,
    },
    fxHaircutBps: 1000, maxSingleLoanUsd: '10',
    issuedAt: new Date().toISOString(),
  }
  const hash = usdTermsHash(body)
  const client = new Client(WS, { connectionTimeout: 20000, timeout: 20000 })
  await client.connect()
  try {
    // the sources, read as the desk reads them, at the validated ledger now
    const ledger = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result
    const at = { ledgerIndex: ledger.ledger_index, ledgerHash: ledger.ledger_hash, closeTime: ledger.ledger.close_time }
    let price
    try {
      price = await readXrpUsd({ req: (p) => client.request(p) }, body, at)
    } catch (e) {
      if (e instanceof PriceUnavailableError) return refuse(`the sources give no usable price at ledger ${at.ledgerIndex}: ${e.message}`)
      throw e
    }
    console.log(`  USD terms ${body.id}: ${body.xrpUsdOracle.sources.length} sources of ${relay}, median of at least ${MIN_SOURCES}, at most ${MAX_AGE_SECONDS} s old, within ${MAX_SPREAD_BPS} bps; hash ${hash}`)
    console.log(`  at ledger ${at.ledgerIndex}: XRP/USD ${price.value} (${price.sources.map((s) => `${s.provider} ${s.price}, ${s.ageSeconds} s`).join('; ')}), spread ${price.spreadBps} bps, the ledger's aggregate ${price.ledgerAggregate.median}`)
    const tx = { TransactionType: 'AccountSet', Account: mandate.riskOfficer, Memos: [{ Memo: { MemoType: hex('orma.usdterms/1'), MemoData: hex(`orma.usdterms/1:${hash}`) } }] }
    if (dry) {
      console.log(`  dry run: the AccountSet of the risk officer ${mandate.riskOfficer} would carry orma.usdterms/1:${hash}; nothing sent`)
      return
    }
    let wallet
    try {
      const seed = JSON.parse(readFileSync(ROLES, 'utf8')).accounts?.riskOfficer?.seed
      if (!seed) return refuse(`${ROLES} carries no riskOfficer key.`)
      wallet = Wallet.fromSeed(seed)
    } catch (e) {
      return refuse(`${ROLES} could not be read (${e.code ?? e.name}).`)
    }
    if (wallet.address !== mandate.riskOfficer) return refuse('the riskOfficer key of the roles file is not the risk officer the mandate names.')
    const r = await client.submitAndWait(tx, { wallet, autofill: true })
    const result = r.result.meta?.TransactionResult
    if (result !== 'tesSUCCESS') {
      console.log(`  the anchor ended ${result}; nothing written`)
      process.exitCode = 1
      return
    }
    const doc = { ...body, hash, anchorTx: r.result.hash }
    const problems = SCHEMAS.usdTerms(doc)
    if (problems.length) {
      console.log(`  the anchored document does not pass SCHEMAS.usdTerms: ${problems.join('; ')}`)
      process.exitCode = 1
      return
    }
    writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
    console.log(`  anchored by ${r.result.hash} at ledger ${r.result.ledger_index}; wrote ${OUT}`)
  } catch (e) {
    console.log(`  the anchor failed: ${String(e?.message ?? e).slice(0, 160)}; nothing written`)
    process.exitCode = 1
  } finally {
    await client.disconnect().catch(() => {})
  }
}

await main()
