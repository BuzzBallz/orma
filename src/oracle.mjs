/**
 * Publishing the honest valuation as a native XLS-47 Price Oracle object.
 *
 * Why this and not a REST endpoint: an Oracle is a first-class ledger object that any
 * rippled node serves and any contract can read, and `get_aggregate_price` computes a
 * median and standard deviation across independent publishers INSIDE THE LEDGER. So
 * our number is contestable by construction: a second publisher who disagrees with us
 * changes the aggregate without asking our permission. A REST API cannot be contested,
 * only trusted. XLS-47 is also live on MAINNET today, unlike the lending amendments,
 * so this is the one component with a production path right now.
 *
 * FOUR INVARIANTS, each of which corrupts data silently rather than erroring:
 *
 *  1. Do not rely on OracleSet merging or on it stripping. It was believed to strip a pair
 *     omitted from the transaction; on Devnet 3.4.1, on 23 Oct 2026, a one-pair OracleSet on an
 *     Oracle that held six left the other five prices in place (check-oracle, exit 0, rehearsal
 *     journal D116). That measurement is still to be confirmed. publish() always sends all of
 *     its pairs, so no code depends on either behaviour.
 *  2. LastUpdateTime must STRICTLY INCREASE. Equal or lower gives
 *     tecINVALID_UPDATE_TIME, burning a fee and a sequence number. One update per
 *     second per object, maximum.
 *  3. LastUpdateTime must sit within 300 s of the validated ledger's close, either side
 *     (measured with simulate on Devnet). Ledger time decides, never this host's clock:
 *     a clock-skewed laptop on stage would take the oracle offline.
 *  4. AssetPrice is a UInt64 serialised as a HEX string. Writing "100" means 256.
 *     Every read and write goes through encodePrice/decodePrice below.
 *
 * LastUpdateTime is UNIX epoch, not Ripple epoch, and must be close to ledger time.
 */
import { createHash } from 'node:crypto'
import { num, Decimal } from './num.mjs'
import { logger } from './log.mjs'

const log = logger('oracle')

/**
 * The three-character quote code of each dimension, one PriceData entry each: NAV (loss-adjusted assets
 * per share, the number a lender needs), HDL, LIQ, COV, CNC, DDL. NAV carries six decimals; the
 * normalised 0..1 dimensions carry four.
 */
const SCALE = { NAV: 6, HDL: 4, LIQ: 4, COV: 4, CNC: 4, DDL: 4 }

/** AssetPrice is a UInt64 rendered as hex. Invariant 4. */
export const encodePrice = (n) => BigInt(n).toString(16).toUpperCase()
export const decodePrice = (hex) => BigInt(`0x${hex}`)

/**
 * The Oracle document id of a vault: the first four bytes of sha256(VaultID) as a big-endian
 * UInt32. A pure function of the id, so an Oracle is found from its vault alone, whatever the
 * order the vaults were read in.
 */
export const oracleDocId = (vaultId) => createHash('sha256').update(vaultId.toUpperCase()).digest().readUInt32BE(0)

/**
 * Derive a 40-hex currency code from a VaultID so the oracle is keyed to the vault.
 *
 * Two traps: an all-zero code means XRP, and a code whose bytes 12..14 spell ASCII is
 * rendered back by rippled as a 3-character code. Forcing the first byte non-zero
 * avoids the first and makes the second vanishingly unlikely.
 */
export function vaultToBaseAsset(vaultId) {
  let hex = vaultId.replace(/^0x/i, '').toUpperCase().slice(0, 40).padEnd(40, '0')
  if (/^0{2}/.test(hex)) hex = 'A' + hex.slice(1)
  return hex
}

/**
 * Build the six PriceData entries from a presented vault payload.
 * Everything is clamped to [0,1] except NAV, which is a price and may exceed 1.
 */
export function buildPriceData(detail) {
  const dims = Object.fromEntries(detail.score.dimensions.map((d) => [d.key, d]))
  const clamp01 = (v) => Decimal.min(1, Decimal.max(0, num(v)))
  const base = vaultToBaseAsset(detail.vault.vaultId)

  /** @type {Array<{code:string, value:import('decimal.js').Decimal}>} */
  const series = [
    { code: 'NAV', value: num(detail.vault.navCorrect) },
    { code: 'HDL', value: num(detail.score.gradeNumeric).div(100) },
    { code: 'LIQ', value: clamp01(dims.LIQUIDITY?.value) },
    { code: 'COV', value: clamp01(dims.COVER?.value) },
    { code: 'CNC', value: clamp01(dims.CONCENT?.value) },
    { code: 'DDL', value: clamp01(num(dims.DEADLINE?.value).div(100)) },
  ]

  return series.map(({ code, value }) => {
    const scale = SCALE[code]
    const scaled = value.times(new Decimal(10).pow(scale)).toFixed(0)
    return {
      PriceData: {
        BaseAsset: base,
        QuoteAsset: code,
        AssetPrice: encodePrice(scaled),
        Scale: scale,
      },
    }
  })
}

/**
 * Publisher. One instance per publishing account.
 *
 * OracleDocumentIDs are oracleDocId(VaultID). The id is a UInt32 scoped to (account, id), so a
 * collision would silently overwrite another vault's scores: publish() refuses a second vault
 * on a document id already taken.
 */
export class OraclePublisher {
  /**
   * @param {import('xrpl').Client} client
   * @param {import('xrpl').Wallet} wallet
   * @param {{provider?:string, assetClass?:string}} [opts]
   */
  constructor(client, wallet, opts = {}) {
    this.client = client
    this.wallet = wallet
    this.provider = opts.provider ?? process.env.ORACLE_PROVIDER ?? 'Orma'
    this.assetClass = opts.assetClass ?? 'risk'
    /** @type {Map<number, string>} OracleDocumentID -> the vault that published under it */
    this._docOwners = new Map()
    /** @type {Map<string, number>} vaultId -> ledger_index of its last validated OracleSet */
    this._publishedAt = new Map()
    /** last LastUpdateTime per docId, to enforce invariant 2 without a round trip */
    this._lastUpdate = new Map()
    /** one in-flight publish per document, so two ticks cannot race the timestamp */
    this._locks = new Map()
  }

  docIdFor(vaultId) {
    return oracleDocId(vaultId)
  }

  /**
   * Publish the full six-dimension vector for one vault.
   * @param {object} detail presented vault payload
   * @param {number} ledgerCloseUnix UNIX seconds from the validated ledger
   */
  async publish(detail, ledgerCloseUnix) {
    const vaultId = detail.vault.vaultId
    const docId = this.docIdFor(vaultId)
    const owner = this._docOwners.get(docId)
    if (owner !== undefined && owner !== vaultId) {
      log.error('oracle document id collision, not publishing', { vault: vaultId.slice(0, 12), other: owner.slice(0, 12), docId })
      return { skipped: true, reason: 'collision' }
    }
    this._docOwners.set(docId, vaultId)

    // Invariant 2, enforced locally: LastUpdateTime must strictly increase, so we
    // bump rather than reject: two publishes on the same ledger close get consecutive
    // timestamps. We only skip once the bump would run far ahead of the ledger,
    // invariant 3. The goal is never to burn a fee on tecINVALID_UPDATE_TIME, not to
    // rate-limit for its own sake.
    const prev = this._lastUpdate.get(docId) ?? 0
    // Invariant 3: rippled accepts a LastUpdateTime within 300 s of the ledger's close and refuses
    // it otherwise (measured with simulate on Devnet: -290 and +290 pass, -400 and +400 fail). So
    // ledger time alone decides. Clamping it to this host's clock, as before, made a host six minutes
    // slow publish timestamps the ledger refused, at a fee each, every tick. A bump stays within 60 s.
    const lut = Math.max(ledgerCloseUnix, prev + 1)
    if (lut > ledgerCloseUnix + 60) {
      log.debug('publish skipped, the bump would run too far ahead of the ledger', { docId })
      return { skipped: true, reason: 'rate' }
    }

    if (this._locks.get(docId)) return { skipped: true, reason: 'inflight' }
    this._locks.set(docId, true)
    try {
      const tx = {
        TransactionType: 'OracleSet',
        Account: this.wallet.address,
        OracleDocumentID: docId,
        Provider: Buffer.from(this.provider, 'utf8').toString('hex').toUpperCase(),
        AssetClass: Buffer.from(this.assetClass, 'utf8').toString('hex').toUpperCase(),
        LastUpdateTime: lut,
        // Invariant 1: ALWAYS the full set. Omitting a pair strips its price.
        PriceDataSeries: buildPriceData(detail),
      }
      let r = await this.client.submitAndWait(tx, { wallet: this.wallet, autofill: true })
      let result = r.result.meta.TransactionResult

      // tecARRAY_TOO_LARGE means this document id is carrying pairs from a previous life.
      //
      // Invariant 1 again, from the other side: OracleSet does not REMOVE a pair it
      // omits, it keeps it with the price stripped. So reusing a document id for a
      // different set of assets -- which is exactly what happens when the demo vaults are
      // rebaked and the publisher account is stable -- accumulates the old pairs under
      // the new ones until the series passes the ledger's ceiling and nothing can be
      // published at all. The object is not corrupt, it is full of ghosts.
      //
      // A pair CAN be removed one at a time, by listing it with no AssetPrice: OracleSet.cpp
      // erases it. We delete and recreate because we do not know what the stale pairs were,
      // which is the situation any publisher that reuses a document id is in.
      if (result === 'tecARRAY_TOO_LARGE') {
        log.warn('document id carries stale pairs, recreating', { docId })
        try {
          await this.client.submitAndWait(
            { TransactionType: 'OracleDelete', Account: this.wallet.address, OracleDocumentID: docId },
            { wallet: this.wallet, autofill: true },
          )
          r = await this.client.submitAndWait(tx, { wallet: this.wallet, autofill: true })
          result = r.result.meta.TransactionResult
        } catch (e) {
          log.warn('could not recreate the oracle document', { docId, err: String(e).slice(0, 90) })
        }
      }

      if (result === 'tesSUCCESS') {
        this._lastUpdate.set(docId, lut)
        this._publishedAt.set(vaultId, r.result.ledger_index)
        log.info('published', { vault: vaultId.slice(0, 12), docId, nav: detail.vault.navCorrect, grade: detail.score.grade })
      } else {
        log.warn('publish failed', { vault: vaultId.slice(0, 12), docId, result })
      }
      return { ok: result === 'tesSUCCESS', result, hash: r.result.hash, docId, lastUpdateTime: lut, ledgerIndex: r.result.ledger_index }
    } finally {
      this._locks.set(docId, false)
    }
  }

  /**
   * Read back what is actually on the ledger, decoding the hex prices. At `ledgerIndex`, else at
   * the ledger of this vault's last validated OracleSet, else at the latest validated ledger,
   * found first and then read by number.
   */
  async read(vaultId, ledgerIndex) {
    const docId = this.docIdFor(vaultId)
    const at = ledgerIndex ?? this._publishedAt.get(vaultId)
      ?? (await this.client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
    const r = await this.client.request({
      command: 'ledger_entry',
      oracle: { account: this.wallet.address, oracle_document_id: docId },
      ledger_index: at,
    })
    const node = r.result.node
    const dims = (node.PriceDataSeries ?? []).map((e) => {
      const d = e.PriceData
      const scale = Number(d.Scale ?? 0)
      return {
        key: d.QuoteAsset,
        raw: d.AssetPrice ?? null,
        value: d.AssetPrice === undefined
          ? null
          : new Decimal(decodePrice(d.AssetPrice).toString()).div(new Decimal(10).pow(scale)).toFixed(scale),
        scale,
      }
    })
    return {
      published: true,
      oracleDocumentId: docId,
      publisher: this.wallet.address,
      objectIndex: node.index ?? null,
      baseAssetHex: vaultToBaseAsset(vaultId),
      lastUpdateAt: node.LastUpdateTime ? new Date(node.LastUpdateTime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
      ageSeconds: node.LastUpdateTime ? Math.max(0, Math.floor(Date.now() / 1000) - node.LastUpdateTime) : null,
      stale: node.LastUpdateTime ? Math.floor(Date.now() / 1000) - node.LastUpdateTime > 60 : true,
      // The transaction that last wrote this object, NOT the object index. devnet.xrpl.org
      // has no route for a bare ledger index: /objects/<index> renders a client-side 404,
      // which on stage is worse than no link at all. A transaction page always resolves.
      lastPublishTx: node.PreviousTxnID ?? null,
      explorerUrl: node.PreviousTxnID
        ? `https://devnet.xrpl.org/transactions/${node.PreviousTxnID}`
        : `https://devnet.xrpl.org/accounts/${this.wallet.address}`,
      dimensionsOnChain: dims,
      aggregate: null,
    }
  }

  /**
   * The decentralisation beat: ask the LEDGER to aggregate across publishers.
   * Returns null when fewer than two publishers have posted, which is honest.
   */
  async aggregate(vaultId, publishers, quote = 'NAV') {
    const oracles = publishers
      .map((p) => ({ account: p.account, oracle_document_id: p.docId }))
      .filter((o) => o.oracle_document_id !== undefined)
    if (oracles.length < 2) return null
    try {
      const r = await this.client.request({
        command: 'get_aggregate_price',
        base_asset: vaultToBaseAsset(vaultId),
        quote_asset: quote,
        oracles,
      })
      const e = r.result.entire_set ?? {}
      return {
        publisherCount: oracles.length,
        median: r.result.median ?? null,
        mean: e.mean ?? null,
        stdDev: e.standard_deviation ?? null,
      }
    } catch (err) {
      log.debug('aggregate unavailable', { err: (err?.data?.error ?? String(err)).slice(0, 60) })
      return null
    }
  }
}
