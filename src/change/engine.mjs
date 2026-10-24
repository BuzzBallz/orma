/**
 * The change engine: orma.change/1, field by field, what a transaction changes on the ledger before it
 * is signed, the fields metadata leaves out included, then whether it happened.
 *
 *   simulateAndRead(xrpl, txJson)            -> L fixed, `simulate` on the open ledger, every object the
 *                                               simulated metadata modifies or deletes read again at L
 *   buildChange({ txJson, before, simulated }) -> orma.change/1, provenance SIMULATED
 *   realise(change, reread)                  -> the same document with `realised`, MATCH or MISMATCH per row
 *
 * Why HIDDEN exists: ApplyStateTable.cpp:202-208 (rippled 3.4.1) saves into PreviousFields only the
 * fields present on the original node. A field absent before the transaction, at its type default, and
 * present after it, changes without leaving a trace in PreviousFields: a reader that diffs metadata
 * never sees it change. Only an object read at L proves the field was absent; an object the preview did
 * not read (a signer's AccountRoot) takes its FinalFields overlaid by its PreviousFields as its values
 * before, and none of its fields is ever HIDDEN.
 *
 * PreviousFields is read for one reason only: to compute `admitted`. A value is never taken from it for
 * an object read at L (CLAUDE.md, rule 4).
 *
 * Limit of the rule, metadata alone cannot tell it apart: a field another transaction set between L and
 * the open ledger, and that this one leaves alone, is a row too (absent from PreviousFields: HIDDEN when it
 * was absent at L, YES otherwise). The rows describe the state the transaction leaves against the state
 * at L.
 */
import { num } from '../num.mjs'
import { logger } from '../log.mjs'

const log = logger('change')
const SOURCE = 'rippled 3.4.1'

/**
 * The fields known to be hidden by metadata, each with the line that sets it, read in the rippled
 * source at tag 3.4.1 (`file` is the base name of the file at that tag, never a path).
 */
export const RULES = Object.freeze({
  // adjustImpreciseNumber(vaultLossUnrealizedProxy, lossUnrealized, ...): the first impairment of a healthy vault
  'Vault.LossUnrealized': Object.freeze({ file: 'LoanManage.cpp', line: 311 }),
  // vault->at(sfData) = tx[sfData]: the first Data of a vault, the manager's statement
  'Vault.Data': Object.freeze({ file: 'VaultSet.cpp', line: 144 }),
  // lockEscrowMPT, sle->setFieldU64(sfLockedAmount, pay): the holder's first lock
  'MPToken.LockedAmount': Object.freeze({ file: 'MPTokenHelpers.cpp', line: 774 }),
  // lockEscrowMPT, sleIssuance->setFieldU64(sfLockedAmount, pay): the issuance's first lock
  'MPTokenIssuance.LockedAmount': Object.freeze({ file: 'MPTokenHelpers.cpp', line: 801 }),
})

/** The rule of a row by the kind of node that carries it (ApplyStateTable.cpp, rippled 3.4.1). */
const NODE_RULES = Object.freeze({
  CreatedNode: Object.freeze({ file: 'ApplyStateTable.cpp', line: 240 }), // NewFields keeps non-default values
  DeletedNode: Object.freeze({ file: 'ApplyStateTable.cpp', line: 183 }), // the FinalFields loop of the branch at :157
  ModifiedNode: Object.freeze({ file: 'ApplyStateTable.cpp', line: 208 }), // PreviousFields keeps changed present fields
})
/** A HIDDEN field RULES does not list: the loop over the original node's fields, which an absent field never enters. */
const UNLISTED_HIDDEN = Object.freeze({ file: 'ApplyStateTable.cpp', line: 203 })

/**
 * The defaults a CreatedNode's NewFields leave out (ApplyStateTable.cpp:240 saves non-default values
 * only) and the created object holds: completed before the rows are built.
 * [field, value, when?]: `when` says whether the created object carries the field at all.
 */
export const DEFAULTS = Object.freeze({
  '*': [['Flags', 0]],
  // OwnerNode is always the sender's directory page; DestinationNode only when Destination is not
  // Account (EscrowCreate.cpp:512-521)
  Escrow: [['OwnerNode', '0'], ['DestinationNode', '0', (o) => o.Destination !== undefined && o.Destination !== o.Account]],
  MPToken: [['OwnerNode', '0']],
  SignerList: [['OwnerNode', '0'], ['SignerListID', 0]],
  AccountRoot: [['OwnerCount', 0]],
})

/** Keys of a node read by ledger_entry, or added by the API: never compared fields. */
const NODE_KEYS = new Set(['index', 'LedgerEntryType', 'LedgerIndex', 'shares'])

/**
 * The five normalisations. Each is named so that a check can show the row it removes.
 *   indexes        the Indexes of a DirectoryNode are ignored
 *   defaults       the NewFields of a CreatedNode are completed with DEFAULTS
 *   noFinalFields  a ModifiedNode without FinalFields is unchanged
 *   mptIssuanceId  the synthetic mpt_issuance_id is removed
 *   previousTxn    PreviousTxnID and PreviousTxnLgrSeq are ignored: they change with every transaction
 *                  that touches the object and are not state fields
 */
export const NORMALISATIONS = Object.freeze(['indexes', 'defaults', 'noFinalFields', 'mptIssuanceId', 'previousTxn'])

/** Money fields: sign and unit of the effect of a change. `asset` is the vault's asset, `amount` the amount's own form. */
const MONEY = Object.freeze({
  'Vault.AssetsTotal': [1, 'asset'],
  'Vault.AssetsAvailable': [1, 'asset'],
  'Vault.LossUnrealized': [-1, 'asset'],
  'LoanBroker.CoverAvailable': [1, 'asset'],
  'LoanBroker.DebtTotal': [1, 'asset'],
  'Loan.PrincipalOutstanding': [1, 'asset'],
  'Loan.TotalValueOutstanding': [1, 'asset'],
  'AccountRoot.Balance': [1, 'drops'],
  'MPToken.MPTAmount': [1, 'share-units'],
  'MPToken.LockedAmount': [1, 'share-units'],
  'MPTokenIssuance.OutstandingAmount': [1, 'share-units'],
  'MPTokenIssuance.LockedAmount': [1, 'share-units'],
  'Escrow.Amount': [1, 'amount'],
})

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** JSON with sorted keys: two ledger values are the same when this form is. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/** Lengths of a hex field whose default is all zeros: UInt64 (16), Hash128 (32), Hash160 (40), Hash192 (48), Hash256 (64). */
const ZERO_HEX_LENGTHS = new Set([16, 32, 40, 48, 64])

/**
 * The default of a field's type, as the ledger stores it: absent, 0, the decimal zero of a NUMBER or an
 * amount, the zero of a UInt64 or a hash, an empty blob or array. A blob of zero bytes ("00") is not a
 * default, nor is an Amount object (an IOU or MPT zero is not STAmount's default).
 */
export function isDefault(v) {
  if (v === undefined || v === null) return true
  if (typeof v === 'number') return v === 0
  if (typeof v === 'boolean') return !v
  if (typeof v === 'string') return v === '' || v === '0' || /^0\.0+$/.test(v) || (/^0+$/.test(v) && ZERO_HEX_LENGTHS.has(v.length))
  if (Array.isArray(v)) return v.length === 0
  return isObject(v) && Object.keys(v).length === 0
}

/** A field absent on one side is at its default there, before as after. */
export const sameValue = (a, b) => (isDefault(a) && isDefault(b)) || stable(a) === stable(b)

/** The fields of a node or object that are compared, the ignored ones taken out. */
function clean(type, fields, skip) {
  const out = {}
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (NODE_KEYS.has(k)) continue
    if (!skip.has('indexes') && type === 'DirectoryNode' && k === 'Indexes') continue
    if (!skip.has('mptIssuanceId') && k === 'mpt_issuance_id') continue
    if (!skip.has('previousTxn') && (k === 'PreviousTxnID' || k === 'PreviousTxnLgrSeq')) continue
    out[k] = v
  }
  return out
}

function completed(type, fields, skip) {
  if (skip.has('defaults')) return fields
  const out = { ...fields }
  for (const [field, value, when] of [...DEFAULTS['*'], ...(DEFAULTS[type] ?? [])]) {
    if (!(field in out) && (!when || when(out))) out[field] = value
  }
  return out
}

/** The unit of the vault's asset, from the first Vault the change sees; null when none is in sight. */
function assetUnit(objects) {
  const asset = objects.find((o) => o.type === 'Vault' && isObject(o.fields?.Asset))?.fields.Asset
  if (!asset) return null
  if (asset.currency === 'XRP' && !asset.issuer) return 'drops'
  if (asset.mpt_issuance_id) return 'mpt-units'
  return String(asset.currency)
}

const amountOf = (v) => (isObject(v) ? v.value : v)
function amountUnit(v) {
  if (typeof v === 'string') return 'drops'
  if (isObject(v) && v.mpt_issuance_id) return 'share-units'
  return isObject(v) && v.currency ? String(v.currency) : null
}

function moneyEffect(type, field, before, after, unitOfAsset) {
  const m = MONEY[`${type}.${field}`]
  if (!m) return null
  const [sign, kind] = m
  const unit = kind === 'asset' ? unitOfAsset : kind === 'amount' ? amountUnit(after ?? before) : kind
  if (!unit) return null
  try {
    const delta = num(amountOf(after) ?? 0).minus(num(amountOf(before) ?? 0)).times(sign)
    return { value: delta.toFixed(), unit }
  } catch (e) {
    log.warn('money effect not computed: an amount is not a decimal', { field: `${type}.${field}`, err: String(e?.message ?? e).slice(0, 120) })
    return null
  }
}

/** Ledger objects keyed by their upper-case index, from an array or an object of objects. */
function byIndex(objects) {
  const list = Array.isArray(objects) ? objects : Object.values(objects ?? {})
  const map = new Map()
  for (const o of list) {
    const index = isObject(o) ? (o.index ?? o.LedgerIndex) : null
    if (typeof index === 'string' && o.LedgerEntryType) map.set(index.toUpperCase(), o)
  }
  return map
}

const nodeOf = (n) => {
  const kind = ['CreatedNode', 'ModifiedNode', 'DeletedNode'].find((k) => isObject(n?.[k]))
  return kind ? { kind, node: n[kind] } : null
}

/**
 * orma.change/1 of a transaction: per object and per field, `before` (the object read at L), `after`
 * (FinalFields or NewFields completed with their defaults), `admitted` and its rippled rule, and the
 * money effect. `before` is an array of ledger objects read at L (or an object of them, as the bake's
 * receipt keeps them, with its ledgerIndex and ledgerHash); `simulated` is a `simulate` response, or
 * `{ engine_result, meta }` taken from a validated transaction.
 *
 * @param {{ txJson: Record<string, unknown>, before: unknown, simulated: { engine_result?: string, meta?: any },
 *   ledgerIndex?: number, ledgerHash?: string }} input
 * @param {{ skip?: Iterable<string> }} [opts] normalisations to leave out, for the check's controls only
 * @returns {import('../nyc/contracts.mjs').Change}
 */
export function buildChange({ txJson, before, simulated, ledgerIndex, ledgerHash }, { skip = [] } = {}) {
  const off = new Set(skip)
  const read = byIndex(before)
  const meta = simulated?.meta
  const nodes = (Array.isArray(meta?.AffectedNodes) ? meta.AffectedNodes : []).map(nodeOf).filter(Boolean)

  // The objects the change sees, their fields before and after, for the money unit and the rows.
  const objects = nodes.map(({ kind, node }) => {
    const type = node.LedgerEntryType
    const index = String(node.LedgerIndex).toUpperCase()
    const at = read.get(index) ?? null
    return { kind, node, type, index, at, fields: { ...(node.PreviousFields ?? {}), ...(node.FinalFields ?? node.NewFields ?? {}), ...(at ?? {}) } }
  })
  const unitOfAsset = assetUnit(objects)

  const rows = []
  for (const { kind, node, type, index, at } of objects) {
    const object = { type, index }
    const push = (field, b, a, admitted, rule) => rows.push({
      object, field, before: b ?? null, after: a ?? null, admitted,
      rule: { source: SOURCE, ...rule }, moneyEffect: moneyEffect(type, field, b, a, unitOfAsset),
    })

    if (kind === 'CreatedNode') {
      const after = clean(type, completed(type, node.NewFields ?? {}, off), off)
      for (const field of Object.keys(after).sort()) push(field, null, after[field], 'YES', NODE_RULES.CreatedNode)
      continue
    }
    if (kind === 'ModifiedNode' && !node.FinalFields && !off.has('noFinalFields')) continue

    const finals = clean(type, node.FinalFields ?? {}, off)
    const prevs = clean(type, node.PreviousFields ?? {}, off)
    // Before: the object read at L; an object the preview did not read, its FinalFields under its PreviousFields.
    const prior = at ? clean(type, at, off) : { ...finals, ...prevs }
    const fields = [...new Set([...Object.keys(finals), ...Object.keys(prevs)])].sort()
    for (const field of fields) {
      const b = prior[field]
      const a = kind === 'DeletedNode' ? undefined : finals[field]
      if (sameValue(b, a)) continue
      if (kind === 'DeletedNode') {
        push(field, b, null, 'YES', NODE_RULES.DeletedNode)
        continue
      }
      const hidden = at !== null && isDefault(at[field]) && field in finals && !(field in prevs)
      push(field, b, a, hidden ? 'HIDDEN' : 'YES', hidden ? (RULES[`${type}.${field}`] ?? UNLISTED_HIDDEN) : NODE_RULES.ModifiedNode)
    }
  }

  return {
    schema: 'orma.change/1',
    txType: String(txJson?.TransactionType ?? ''),
    txJson,
    simulatedAt: { ledgerIndex: ledgerIndex ?? before?.ledgerIndex ?? null, ledgerHash: ledgerHash ?? before?.ledgerHash ?? null },
    engineResult: String(simulated?.engine_result ?? meta?.TransactionResult ?? 'not simulated'),
    rows,
    hiddenCount: rows.filter((r) => r.admitted === 'HIDDEN').length,
    provenance: 'SIMULATED',
  }
}

/** `<type>.<field>` of every HIDDEN row, in row order. */
export const hiddenOf = (change) => change.rows.filter((r) => r.admitted === 'HIDDEN').map((r) => `${r.object.type}.${r.field}`)

/**
 * The change with `realised`: each row compared with the object read again at the validation ledger,
 * MATCH when the reread equals `after` (a field absent on one side at its default there), MISMATCH
 * otherwise. A deleted object is absent from `objects`: its rows match when `after` is null.
 *
 * @param {import('../nyc/contracts.mjs').Change} change
 * @param {{ txHash: string, ledgerIndex: number, ledgerHash: string, objects: unknown }} reread
 * @param {{ skip?: Iterable<string> }} [opts]
 */
export function realise(change, { txHash, ledgerIndex, ledgerHash, objects }, { skip = [] } = {}) {
  const off = new Set(skip)
  const read = byIndex(objects)
  const rows = change.rows.map((row) => {
    const o = read.get(row.object.index.toUpperCase())
    const got = o ? clean(row.object.type, o, off)[row.field] : undefined
    return { ...row, verdict: sameValue(got, row.after) ? 'MATCH' : 'MISMATCH' }
  })
  return { ...change, realised: { txHash, ledgerIndex, ledgerHash, rows } }
}

/** Only these mean "the object does not exist at L"; a ledger the node does not serve (lgrNotFound) is an error, never an absence. */
const notFound = (e) => ['entryNotFound', 'objectNotFound'].includes(e?.data?.error ?? e?.message)

/** One ledger object by its index at ledger L; null when it does not exist there, any other failure thrown. */
export async function entryAt(xrpl, index, L) {
  try {
    return (await xrpl.req({ command: 'ledger_entry', index, ledger_index: L })).result.node ?? null
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}

/**
 * L fixed first (the validated ledger now), then `simulate` on the open ledger, then every object the
 * simulated metadata carries as a ModifiedNode or a DeletedNode read again at L. An object that did not
 * exist at L is left out of `before`: it was created after L, and none of its fields can be HIDDEN.
 *
 * @param {any} xrpl an Xrpl (closeTime, lastLedger, lastLedgerHash, req)
 * @param {Record<string, unknown>} txJson unsigned
 * @param {{ simulate?: (tx: Record<string, unknown>) => Promise<any> }} [opts] the role engine's simulate, when it has one
 */
export async function simulateAndRead(xrpl, txJson, { simulate } = {}) {
  await xrpl.closeTime()
  const ledgerIndex = xrpl.lastLedger
  const ledgerHash = xrpl.lastLedgerHash ?? null
  const closeTime = xrpl.lastCloseTime ?? null
  const simulated = simulate ? await simulate(txJson) : (await xrpl.req({ command: 'simulate', tx_json: txJson })).result
  const touched = (simulated?.meta?.AffectedNodes ?? []).map(nodeOf).filter((it) => it && it.kind !== 'CreatedNode').map((it) => it.node.LedgerIndex)
  return { ledgerIndex, ledgerHash, closeTime, simulated, before: await readAll(xrpl, touched, ledgerIndex) }
}

/** Objects by index at L, read together; an object absent there is left out, any other failure rejects. */
async function readAll(xrpl, indexes, L) {
  const unique = [...new Set(indexes.map((i) => String(i).toUpperCase()))]
  const found = await Promise.all(unique.map((index) => entryAt(xrpl, index, L).then((obj) => obj && { ...obj, index: obj.index ?? index })))
  return found.filter(Boolean)
}

/**
 * The objects of a change read again at one ledger, for `realise`: every object a row names, left out
 * when it no longer exists there. A read that fails rejects: a failure is never a verdict.
 */
export const rereadAt = (xrpl, change, ledgerIndex) => readAll(xrpl, change.rows.map((r) => r.object.index), ledgerIndex)
