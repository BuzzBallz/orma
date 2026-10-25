/**
 * The demo lab's browser signatures (Devnet only, demo only). The server keeps building every transaction;
 * an action that opts in with `signer: 'browser'` gets its signature from the page instead of a wallet of
 * the server. Each signature asked is one request on the action:
 *
 *   act.state  = 'awaiting-signature'
 *   act.toSign = { requestId, kind, role, account, txJson | txBlob, expiresAt, purpose }
 *
 * The page posts { requestId, txBlob } back; the blob is decoded and compared with what was asked before it
 * is used (`checkSigned`), and a request not answered within the TTL rejects with SIGNATURE_TIMEOUT. No key
 * ever reaches this module: only signed blobs.
 */
import { randomBytes } from 'node:crypto'
import { decode, deriveAddress, encode, encodeForSigning, hashes, signLoanSetByCounterparty, verifyKeypairSignature, verifySignature } from 'xrpl'

/** How long one signature request stays open. */
export const SIGNATURE_TTL_MS = 180_000
/** The signing prefix of a counterparty signature (fixCleanup3_4_0), in place of STX\0. */
const CPT_PREFIX = '43505400'
const BLOB = /^[0-9A-Fa-f]+$/
const REQUEST_ID = /^[0-9a-f]{32}$/

/** Who signs, in the words of the demo; the institutions are fictional. */
export const PARTIES = Object.freeze({
  borrower: 'Tidewater Payments (fictional)',
  broker: 'The Harbor vault manager',
  deskOwner: 'Harbor Credit Desk (fictional)',
})

/** A request not answered by its expiresAt. */
export class SignatureTimeout extends Error {
  constructor(requestId) {
    super(`No signature arrived for request ${requestId} before it expired`)
    this.name = 'SignatureTimeout'
    this.code = 'SIGNATURE_TIMEOUT'
  }
}

/** A request closed by the kill switch. */
export class SignatureCancelled extends Error {
  constructor(requestId) {
    super(`The kill switch closed signature request ${requestId}; nothing was signed`)
    this.name = 'SignatureCancelled'
    this.code = 'LOCKED'
  }
}

/** Why a posted signature cannot be used; `status` and `code` are those the route answers. */
export class SignatureRefused extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'SignatureRefused'
    Object.assign(this, { status, code })
  }
}

const strip = (tx, fields) => {
  const c = { ...tx }
  for (const f of fields) delete c[f]
  return c
}

/** The fields of `a` and `b` whose canonical encodings differ, by name. */
function differing(a, b) {
  const ca = decode(encode(a))
  const cb = decode(encode(b))
  return [...new Set([...Object.keys(ca), ...Object.keys(cb)])].filter((k) => JSON.stringify(ca[k]) !== JSON.stringify(cb[k])).sort()
}

/**
 * Whether `txBlob` is the signature asked by `request`: [] when it is, else one sentence per problem.
 * kind sign: decode(txBlob) equals txJson field by field but SigningPubKey and TxnSignature, the signature is
 * single (no Signers), by the key whose address is the request's account (a regular key derives another
 * address), and it verifies. kind countersign: decode(txBlob) without CounterpartySignature is the borrower's
 * blob exactly, CounterpartySignature is single, by the account's own key, and verifies under CPT\0.
 * @param {{ kind: 'sign'|'countersign', account: string, txJson?: any, txBlob?: string }} request
 * @param {unknown} txBlob
 * @returns {string[]}
 */
export function checkSigned(request, txBlob) {
  if (typeof txBlob !== 'string' || !BLOB.test(txBlob) || txBlob.length % 2) return ['txBlob is not a hex transaction blob']
  let tx
  try {
    tx = decode(txBlob)
  } catch {
    return ['txBlob does not decode as a transaction']
  }
  const problems = []
  if (request.kind === 'sign') {
    if (tx.Signers) problems.push('the transaction is multisigned; only a single signature by the account itself is accepted')
    if (typeof tx.SigningPubKey !== 'string' || !tx.SigningPubKey || typeof tx.TxnSignature !== 'string' || !tx.TxnSignature) {
      problems.push('the transaction carries no single signature (SigningPubKey and TxnSignature)')
      return problems
    }
    const by = addressOf(tx.SigningPubKey)
    if (by !== request.account) problems.push(`it is signed by ${by ?? 'an unreadable key'}, not by the master key of ${request.account}`)
    let changed = []
    try {
      changed = differing(strip(tx, ['SigningPubKey', 'TxnSignature']), strip(request.txJson, ['SigningPubKey', 'TxnSignature']))
    } catch {
      changed = ['(the transaction asked could not be compared)']
    }
    if (changed.length) problems.push(`fields differ from the transaction asked: ${changed.join(', ')}`)
    if (!problems.length && !safe(() => verifySignature(tx))) problems.push('the signature does not verify')
    return problems
  }
  // countersign
  const cps = tx.CounterpartySignature
  if (!cps || typeof cps !== 'object') return ['the LoanSet carries no CounterpartySignature']
  if (cps.Signers) problems.push('the countersignature is multisigned; only a single signature by the account itself is accepted')
  if (typeof cps.SigningPubKey !== 'string' || !cps.SigningPubKey || typeof cps.TxnSignature !== 'string' || !cps.TxnSignature) {
    problems.push('the countersignature carries no single signature (SigningPubKey and TxnSignature)')
    return problems
  }
  const by = addressOf(cps.SigningPubKey)
  if (by !== request.account) problems.push(`it is countersigned by ${by ?? 'an unreadable key'}, not by the master key of ${request.account}`)
  const inner = strip(tx, ['CounterpartySignature'])
  let changed = []
  try {
    changed = differing(inner, decode(request.txBlob))
  } catch {
    changed = ['(the LoanSet asked could not be compared)']
  }
  if (changed.length) problems.push(`the LoanSet differs from the one asked to countersign: ${changed.join(', ')}`)
  if (!problems.length && !safe(() => verifyKeypairSignature(CPT_PREFIX + encodeForSigning(inner).slice(8), cps.TxnSignature, cps.SigningPubKey))) {
    problems.push('the countersignature does not verify')
  }
  return problems
}

const addressOf = (publicKey) => {
  try {
    return deriveAddress(publicKey)
  } catch {
    return null
  }
}
const safe = (fn) => {
  try {
    return fn()
  } catch {
    return false
  }
}

/**
 * The open requests of one engine, one at most per action at a time.
 * @param {{ ttlMs?: number, now?: () => number, onTimeout?: (act: any, requestId: string) => void }} [o]
 */
export function createRemoteSigner({ ttlMs = SIGNATURE_TTL_MS, now = () => Date.now(), onTimeout = () => {} } = {}) {
  /** actionId -> { act, request, prior, onSigned, resolve, reject, timer } */
  const open = new Map()

  function close(actionId) {
    const p = open.get(actionId)
    if (!p) return null
    clearTimeout(p.timer)
    open.delete(actionId)
    delete p.act.toSign
    p.act.state = p.prior
    return p
  }

  /**
   * Ask the page for one signature on `act`. Resolves to { tx_blob, hash } once a verified blob arrives;
   * rejects with SignatureTimeout past expiresAt, SignatureCancelled on the kill switch. `onSigned` runs
   * synchronously at acceptance, before the action is served again, so a state it sets is never preceded
   * by the one the action had before the request.
   * @param {any} act
   * @param {{ kind: 'sign'|'countersign', role: string, account: string, txJson?: any, txBlob?: string, purpose: string }} spec
   * @param {{ onSigned?: (signed: { tx_blob: string, hash: string }) => void }} [o]
   */
  function request(act, spec, { onSigned } = {}) {
    close(act.actionId)?.reject(new Error('superseded by a new signature request'))
    const requestId = randomBytes(16).toString('hex')
    const expiresAt = new Date(now() + ttlMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const toSign = {
      requestId, kind: spec.kind, role: spec.role, account: spec.account,
      ...(spec.kind === 'sign' ? { txJson: structuredClone(spec.txJson) } : { txBlob: spec.txBlob }),
      expiresAt, purpose: spec.purpose,
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (open.get(act.actionId)?.request.requestId !== requestId) return
        close(act.actionId)
        onTimeout(act, requestId)
        reject(new SignatureTimeout(requestId))
      }, ttlMs)
      timer.unref?.()
      open.set(act.actionId, { act, request: toSign, prior: act.state, onSigned, resolve, reject, timer })
      act.toSign = toSign
      act.state = 'awaiting-signature'
    })
  }

  /**
   * A signature posted by the page: verified, then handed to the waiting work. Throws SignatureRefused:
   * 404 NOT_FOUND when the action awaits no signature or `requestId` is not its open request, 400
   * BAD_REQUEST for a body without them, 400 SIGNATURE_MISMATCH when the blob is not the transaction asked
   * by its account (the request stays open).
   */
  function accept(act, body) {
    const p = open.get(act.actionId)
    if (!p) throw new SignatureRefused(404, 'NOT_FOUND', 'This action awaits no signature.')
    if (typeof body?.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw new SignatureRefused(400, 'BAD_REQUEST', 'requestId must be the 32 hex characters of the open signature request')
    if (typeof body.txBlob !== 'string') throw new SignatureRefused(400, 'BAD_REQUEST', 'txBlob, the signed transaction blob, is required')
    if (body.requestId !== p.request.requestId) throw new SignatureRefused(404, 'NOT_FOUND', 'requestId names no open signature request of this action; a rebuilt transaction asks for a new one.')
    const problems = checkSigned(p.request, body.txBlob)
    if (problems.length) throw new SignatureRefused(400, 'SIGNATURE_MISMATCH', `The signed blob is not the transaction asked: ${problems.join('; ')}. Nothing was submitted; the request stays open.`)
    const txBlob = body.txBlob.toUpperCase()
    const signed = { tx_blob: txBlob, hash: hashes.hashSignedTx(txBlob) }
    close(act.actionId)
    p.onSigned?.(signed)
    p.resolve(signed)
    return signed
  }

  /** The kill switch: every open request rejects with SignatureCancelled. */
  function cancelAll() {
    for (const id of [...open.keys()]) {
      const p = close(id)
      p?.reject(new SignatureCancelled(p.request.requestId))
    }
  }

  return { request, accept, cancelAll, isOpen: (actionId) => open.has(actionId) }
}

/**
 * The signer of one action for one account: the server's wallet, or the page. `requested` resolves when
 * the first signature is asked of the page (never, on a server-signed action), so that an HTTP handler can
 * answer 202 instead of waiting for it.
 * @param {{ browser: boolean, act: any, role: string, wallet: any, remote: ReturnType<typeof createRemoteSigner> }} o
 */
export function signerFor({ browser, act, role, wallet, remote }) {
  if (!browser) {
    return {
      browser: false,
      requested: new Promise(() => {}),
      sign: async (tx) => wallet.sign(tx),
      countersign: async (blob) => signLoanSetByCounterparty(wallet, blob),
    }
  }
  let asked
  const requested = new Promise((r) => { asked = r })
  const ask = (spec, o) => {
    const p = remote.request(act, { role, account: wallet.address, ...spec }, o)
    asked()
    return p
  }
  return {
    browser: true,
    requested,
    sign: (tx, purpose, o) => ask({ kind: 'sign', txJson: tx, purpose }, o),
    countersign: (blob, purpose, o) => ask({ kind: 'countersign', txBlob: blob, purpose }, o),
  }
}
