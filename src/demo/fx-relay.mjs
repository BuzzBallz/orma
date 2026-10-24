/**
 * The Devnet stand-in for independent XRP/USD oracle providers (step 21, addendum A11). One test account of
 * the desk relays three public exchange quotes into three XLS-47 Oracle documents, one per venue, each round:
 * 1 Kraken, 2 Bitstamp, 3 Coinbase Exchange, their last trade (src/fx/venues.mjs). The desk never trusts this
 * account's price as a price: it reads the documents the risk officer's terms name at the ledger of each
 * decision and takes the median of the fresh ones (src/fx/price.mjs), as it would read independent providers
 * on mainnet, where this script does not exist. No XRP/USD oracle is maintained on Devnet (read 24 Oct 2026:
 * two documents with the pair, 89 and 118 days old).
 *
 * One account, one running relay: two relays on one account steal each other's Sequence. The key comes from
 * FX_RELAY_SEED or .demo/fx-relay.json (gitignored), is read in this process only and never printed.
 * LastUpdateTime follows the validated ledger's close, as src/oracle.mjs does: rippled refuses one more than
 * 300 s away from it, and it must rise strictly per document.
 *
 *   node --env-file-if-exists=.env src/demo/fx-relay.mjs --init      create and fund the relay account, then one round
 *   node --env-file-if-exists=.env src/demo/fx-relay.mjs --once      one round: fetch the three quotes, publish each
 *   node --env-file-if-exists=.env src/demo/fx-relay.mjs             one round every 60 s until stopped (Ctrl-C, SIGTERM)
 *   node --env-file-if-exists=.env src/demo/fx-relay.mjs --dry-run   fetch the quotes and print the OracleSets, nothing sent
 * Exit: 0 done, 1 a round published nothing, 2 refused (no key; --init with a key already on file), 64 bad usage.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Client, Wallet } from 'xrpl'
import { logger } from '../log.mjs'
import { FX_VENUES, quoteOf, priceDataOf } from '../fx/venues.mjs'
import { RIPPLE_EPOCH_OFFSET } from '../nyc/contracts.mjs'

const log = logger('fx:relay')
const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const KEY_FILE = '.demo/fx-relay.json'
const PERIOD_MS = 60_000
const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

const args = process.argv.slice(2)
const known = ['--init', '--once', '--dry-run']
const bad = args.find((a) => !known.includes(a))
const mode = { init: args.includes('--init'), once: args.includes('--once'), dry: args.includes('--dry-run') }

/** The relay's key: FX_RELAY_SEED, else .demo/fx-relay.json; null when neither holds one. */
function keyOnFile() {
  if (process.env.FX_RELAY_SEED) return Wallet.fromSeed(process.env.FX_RELAY_SEED)
  if (!existsSync(KEY_FILE)) return null
  const seed = JSON.parse(readFileSync(KEY_FILE, 'utf8')).fxRelay?.seed
  return seed ? Wallet.fromSeed(seed) : null
}

/** One round: the three quotes, then one OracleSet per venue that answered, one after the other. */
async function round(client, wallet, last) {
  const quotes = await Promise.all(FX_VENUES.map(async (v) => ({ v, q: await quoteOf(v) })))
  const closeRipple = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time
  const closeUnix = closeRipple + RIPPLE_EPOCH_OFFSET
  let published = 0
  for (const { v, q } of quotes) {
    if (!q.ok) {
      log.warn('quote skipped', { provider: v.provider, documentId: v.documentId, reason: q.reason })
      continue
    }
    const lut = Math.max(closeUnix, (last.get(v.documentId) ?? 0) + 1)
    const tx = {
      TransactionType: 'OracleSet', Account: wallet?.address ?? 'rDryRun', OracleDocumentID: v.documentId,
      Provider: hex(v.provider), URI: hex(v.uri), AssetClass: hex('currency'), LastUpdateTime: lut,
      PriceDataSeries: [{ PriceData: priceDataOf(q.price) }],
    }
    if (mode.dry) {
      console.log(`  ${v.provider.padEnd(9)} ${q.price.padEnd(12)} -> OracleSet document ${v.documentId}, AssetPrice ${tx.PriceDataSeries[0].PriceData.AssetPrice} at Scale ${tx.PriceDataSeries[0].PriceData.Scale}, LastUpdateTime ${lut}`)
      continue
    }
    try {
      const r = await client.submitAndWait(tx, { wallet, autofill: true })
      const result = r.result.meta?.TransactionResult
      if (result === 'tesSUCCESS') {
        last.set(v.documentId, lut)
        published++
        log.info('published', { provider: v.provider, documentId: v.documentId, price: q.price, lastUpdateTime: lut, ledgerIndex: r.result.ledger_index, txHash: r.result.hash })
      } else {
        log.warn('OracleSet not applied', { provider: v.provider, documentId: v.documentId, result, txHash: r.result.hash })
      }
    } catch (e) {
      log.warn('OracleSet failed', { provider: v.provider, documentId: v.documentId, err: String(e?.message ?? e).slice(0, 160) })
    }
  }
  return published
}

async function main() {
  if (bad) {
    console.log(`  usage: node src/demo/fx-relay.mjs [--init | --once | --dry-run]  (unknown ${JSON.stringify(bad)})`)
    return 64
  }
  let wallet = null
  if (mode.init) {
    if (keyOnFile()) {
      console.log(`  refused: a relay key is already on file (${process.env.FX_RELAY_SEED ? 'FX_RELAY_SEED' : KEY_FILE}); the relay account is created once.`)
      return 2
    }
    if (!mode.dry) {
      wallet = Wallet.generate()
      mkdirSync('.demo', { recursive: true })
      // the key first, before any funding: a run that dies later must not lose the account it paid for
      writeFileSync(KEY_FILE, JSON.stringify({ fxRelay: { address: wallet.address, seed: wallet.seed } }, null, 2) + '\n')
    }
  } else if (!mode.dry) {
    wallet = keyOnFile()
    if (!wallet) {
      console.log(`  refused: no relay key (set FX_RELAY_SEED, or run --init to create ${KEY_FILE}).`)
      return 2
    }
  }
  const client = new Client(WS, { connectionTimeout: 20000, timeout: 20000 })
  await client.connect()
  let stop = false
  const halt = () => { stop = true }
  process.once('SIGINT', halt)
  process.once('SIGTERM', halt)
  try {
    if (mode.init && wallet) {
      await client.fundWallet(wallet)
      console.log(`  relay account ${wallet.address} funded at the faucet; its key is in ${KEY_FILE}`)
    }
    const last = new Map()
    if (wallet) {
      // resume above what is already on the ledger: LastUpdateTime must rise strictly per document
      const objs = (await client.request({ command: 'account_objects', account: wallet.address, type: 'oracle', ledger_index: 'validated' })).result.account_objects
      for (const o of objs) last.set(o.OracleDocumentID, o.LastUpdateTime)
      log.info('relay starting', { account: wallet.address, documents: FX_VENUES.map((v) => `${v.documentId}:${v.provider}`), onLedger: objs.length })
    }
    if (mode.dry || mode.once || mode.init) return (await round(client, wallet, last)) > 0 || mode.dry ? 0 : 1
    while (!stop) {
      const started = Date.now()
      let n = 0
      try {
        // Devnet closes a socket now and then: reconnect before the round, and a failed round waits for the next
        if (!client.isConnected()) await client.connect()
        n = await round(client, wallet, last)
      } catch (e) {
        log.warn('round failed, the next one tries again', { err: String(e?.message ?? e).slice(0, 160) })
      }
      if (n === 0) log.warn('a round published nothing', {})
      while (!stop && Date.now() - started < PERIOD_MS) await new Promise((r) => setTimeout(r, 500))
    }
    log.info('relay stopped', {})
    return 0
  } finally {
    await client.disconnect().catch(() => {})
  }
}

process.exitCode = await main().catch((e) => {
  console.log(`  the relay failed: ${String(e?.message ?? e).slice(0, 200)}`)
  return 1
})
