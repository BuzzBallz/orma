/**
 * The share token's own metadata, and the pointer that makes it self-describing.
 *
 * THE IDEA, suggested by a Ripple developer advocate and measured within minutes of him
 * saying it: a vault share is a redeemable claim whose value moves with credit
 * performance, and the token itself cannot carry that value. So put a STABLE POINTER to
 * an honest valuation in the token's metadata, and the valuation travels with the token.
 *
 * A second broker who receives those shares as collateral then needs nothing from us and
 * nothing from the depositor. They hold an MPT issuance id, they read its metadata off
 * the ledger, and they follow the pointer. That is the whole primitive.
 *
 * WHY IT MUST BE A POINTER AND NEVER A VALUE. Share metadata is write-once, permanently
 * (Appendix D1): `MPTokenMetadata` is accepted on `VaultCreate`, rejected at
 * deserialization on `VaultSet`, and `MPTokenIssuanceSet` returns `tecNO_PERMISSION`
 * because the issuer is the vault pseudo-account, which carries `lsfDisableMaster` and
 * has no regular key. Nobody can ever update it. A number written there would be a lie
 * within one ledger; a URL stays true for the life of the vault.
 *
 * XLS-89. rippled warns, unprompted, that metadata which is not XLS-89 shaped "might not
 * be discoverable by Explorers and Indexers", and names the fields it expects. We emit
 * those fields, so a vault share built this way is indexable as well as valuable.
 * `asset_class` is the taxonomy's weak point and we say so in Appendix D3: the permitted
 * values are rwa, memes, wrapped, gaming, defi and other, and none of them describes a
 * yield-bearing pooled claim. We use `rwa` because a private-credit facility IS a real
 * world asset, and carry the precise thing in `orma.instrument`.
 */
import { logger } from './log.mjs'

const log = logger('metadata')

/** Ledger cap on MPTokenMetadata. Exceeding it is a malformed transaction, not a warning. */
export const MAX_METADATA_BYTES = 1024

/** The reserved key we hang our own fields under, so nothing collides with XLS-89. */
export const NAMESPACE = 'orma'

const toHex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const fromHex = (h) => Buffer.from(String(h).replace(/^0x/i, ''), 'hex').toString('utf8')

/**
 * Build the metadata object for a vault share.
 *
 * `navUrl` is the pointer and the only field that genuinely has to survive: everything
 * else is descriptive. It is written once and can never be corrected, so it should point
 * at a path you control and are willing to keep, not at a host you might move off.
 *
 * @param {object} o
 * @param {string} o.ticker        short symbol, e.g. ORMA-MTF1
 * @param {string} o.name          the facility's name as a human reads it
 * @param {string} o.navUrl        absolute URL of the valuation endpoint
 * @param {string} [o.icon]        absolute URL of an icon
 * @param {string} [o.issuerName]  who stands behind the valuation
 * @param {string} [o.desc]        one line, what the claim is
 */
export const MPT_PLACEHOLDER = '{mpt_issuance_id}'

export function buildShareMetadata(o) {
  if (!o?.navUrl) throw new Error('navUrl is required: the pointer is the point')
  const meta = {
    // --- XLS-89, in the order rippled names them -----------------------------
    ticker: o.ticker,
    name: o.name,
    icon: o.icon ?? 'https://orma.credit/mark.svg',
    asset_class: 'rwa',
    issuer_name: o.issuerName ?? 'Orma',
    desc: o.desc ?? 'Redeemable claim on a closed-ended private credit facility.',
    // --- ours, namespaced ----------------------------------------------------
    // A vault share has a price the token cannot carry, and XLS-89 has no field for one.
    // Appendix D3 proposes reserving one; until then it lives here, clearly namespaced
    // so that an explorer reading only the standard fields ignores it cleanly.
    [NAMESPACE]: {
      v: 1,
      instrument: 'vault-share',
      // A TEMPLATE, not a finished URL, and not by preference.
      //
      // MPTokenMetadata is only settable on `VaultCreate` (Appendix D1), which is
      // submitted BEFORE the vault and its share issuance exist. Neither the VaultID nor
      // the MPTokenIssuanceID is knowable at the moment the pointer has to be written,
      // and the field can never be corrected afterwards. So the pointer cannot name the
      // object it describes.
      //
      // It does not need to. Whoever reads this metadata got here by holding the token,
      // so they already have its issuance id: the pointer only has to name the service
      // and the substitution. That turns an impossible reference into a trivial one.
      nav_url: o.navUrl,
      nav_url_param: MPT_PLACEHOLDER,
      // Says what the endpoint returns without having to call it, so a consumer can
      // decide whether it is worth a request.
      nav_basis: 'assets net of recognised loss, divided by units outstanding',
      doc: 'https://orma.credit/nav',
    },
  }
  return meta
}

/** Encode for the ledger. Throws rather than emit a blob the transactor will reject. */
export function encodeShareMetadata(meta) {
  const json = JSON.stringify(meta)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > MAX_METADATA_BYTES) {
    throw new Error(`metadata is ${bytes} bytes, over the ${MAX_METADATA_BYTES} ceiling, and it can never be edited afterwards`)
  }
  return toHex(json)
}

/**
 * Read metadata back off an MPTokenIssuance.
 *
 * Deliberately total: this parses a blob written by someone else, possibly not by us and
 * possibly not JSON at all. A share whose metadata we cannot read is a normal state, not
 * an error, and must never throw into a caller who is valuing collateral.
 */
export function parseShareMetadata(hex) {
  if (!hex) return { present: false, reason: 'no metadata on the issuance', meta: null }
  let text
  try {
    text = fromHex(hex)
  } catch {
    return { present: true, reason: 'metadata is not valid hex', meta: null, raw: String(hex).slice(0, 64) }
  }
  try {
    const meta = JSON.parse(text)
    if (meta === null || typeof meta !== 'object') {
      return { present: true, reason: 'metadata is JSON but not an object', meta: null, raw: text.slice(0, 200) }
    }
    return { present: true, reason: null, meta }
  } catch {
    // XLS-89 is explicitly not mandatory, so plain text here is legal and common.
    return { present: true, reason: 'metadata is not JSON, so it is not XLS-89 shaped', meta: null, raw: text.slice(0, 200) }
  }
}

/**
 * The pointer, if there is one.
 *
 * Only http(s) is followed. A share is written by a party we do not control, and this
 * value reaches a fetch: refusing every other scheme here is cheaper than remembering to
 * check at each call site.
 */
export function navPointerFrom(meta, issuanceId) {
  const raw = meta?.[NAMESPACE]?.nav_url
  if (typeof raw !== 'string' || !raw) return null
  // Substitute the token's own id. A template left unresolved is not followed: sending a
  // request to a literal "{mpt_issuance_id}" would be a confusing 404 at best.
  const url = raw.includes(MPT_PLACEHOLDER)
    ? (issuanceId ? raw.replaceAll(MPT_PLACEHOLDER, String(issuanceId).toUpperCase()) : null)
    : raw
  if (!url) {
    log.warn('nav pointer is a template and no issuance id was supplied')
    return null
  }
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      log.warn('nav pointer ignored, unsupported scheme', { scheme: u.protocol })
      return null
    }
    return u.toString()
  } catch {
    log.warn('nav pointer ignored, not a URL')
    return null
  }
}

/**
 * Report XLS-89 conformance the way rippled does, so a consumer can say WHY a share is
 * not indexable instead of only that it is not.
 */
export const XLS89_FIELDS = ['ticker', 'name', 'icon', 'asset_class', 'issuer_name']
export const XLS89_ASSET_CLASSES = ['rwa', 'memes', 'wrapped', 'gaming', 'defi', 'other']

export function xls89Report(meta) {
  if (!meta) return { conformant: false, missing: XLS89_FIELDS, assetClassValid: false }
  const missing = XLS89_FIELDS.filter((f) => !meta[f])
  const assetClassValid = XLS89_ASSET_CLASSES.includes(meta.asset_class)
  return {
    conformant: missing.length === 0 && assetClassValid,
    missing,
    assetClassValid,
    assetClass: meta.asset_class ?? null,
    // Appendix D3. Stated on the wire and not only in the report, because a consumer
    // reading asset_class needs to know it is being told less than it looks.
    taxonomyNote: assetClassValid
      ? 'No XLS-89 asset_class describes a yield-bearing pooled claim; rwa is the closest. See orma.instrument.'
      : null,
  }
}
