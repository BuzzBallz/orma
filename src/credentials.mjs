/**
 * The gate. Where the grade stops being advice and starts being enforcement.
 *
 * Everything else here measures a facility and says so. This module is the part that
 * makes the measurement bind: an LP whose credential we have not issued cannot deposit
 * into a gated vault at all. The ledger refuses the transaction. Nobody has to read our
 * report, agree with it, or act on it.
 *
 * THE CHAIN, and the four things about it that are not obvious:
 *
 *   CredentialCreate     we issue a credential naming an LP as its subject
 *   CredentialAccept     the LP OPTS IN. Issuance alone grants nothing: without the
 *                        accept, a deposit is still tecNO_AUTH. A credential is not
 *                        something that can be done TO someone.
 *   PermissionedDomainSet  the VAULT OWNER names our issuer in their domain. We sign
 *                        nothing, we are not asked, and we cannot refuse. A rater being
 *                        cited without their consent is the correct shape for a rating:
 *                        it is also how S&P works.
 *   VaultCreate          tfVaultPrivate (0x00010000) is REQUIRED alongside DomainID.
 *                        A DomainID without the flag does not gate anything.
 *
 * And the one that bites hardest: DomainID is NOT stored on the Vault ledger entry. It
 * lives on the share MPTokenIssuance. Reading the Vault object to find out whether a
 * vault is gated returns nothing, which reads exactly like "not gated".
 *
 * REVOCATION IS ASYMMETRIC, and it is the sharpest thing in the demo. CredentialDelete
 * bounces the LP's next deposit immediately, but their existing position is untouched:
 * they can still withdraw in full. The gate controls who may ENTER, never who may leave.
 * That is the right design and it is worth saying out loud, because the alternative
 * would be a rater who can trap capital.
 */
import { logger } from './log.mjs'

const log = logger('gate')

export const TF_VAULT_PRIVATE = 0x00010000

/** CredentialType is a hex blob, 1..64 bytes. Anything outside that is temMALFORMED. */
export const hexType = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
export const readType = (hex) => Buffer.from(String(hex), 'hex').toString('utf8')

/**
 * The credential we issue, keyed to the bar it certifies rather than to a grade.
 *
 * Keyed to the BAR and not to the facility: a credential saying "this LP may enter
 * investment-grade facilities" is reusable across every vault that accepts our issuer,
 * which is the whole point of a domain. One per facility would be a whitelist wearing a
 * credential's clothes.
 */
export const BARS = {
  IG: { name: 'ORMA-IG', says: 'may enter facilities graded BBB- or better' },
  SPEC: { name: 'ORMA-SPEC', says: 'may enter speculative-grade facilities' },
}

/**
 * Submit and read the VALIDATED result, never the engine result.
 *
 * rippled's `submit` returns a provisional `engine_result`, and we have observed an
 * engine result of tecNO_AUTH go on to validate as tesSUCCESS. A gate that reports on
 * the provisional answer reports the opposite of what happened, which on this particular
 * feature is the difference between "the ledger refused them" and "the ledger let them
 * in". So every call here waits for validation and reads `meta.TransactionResult`.
 */
export async function submitValidated(client, wallet, tx, { timeoutMs = 45000 } = {}) {
  const t0 = Date.now()
  let prepared
  try {
    prepared = await client.autofill({ ...tx, Account: wallet.address })
  } catch (e) {
    return { ok: false, code: e?.data?.error ?? 'AUTOFILL_ERROR', error: String(e?.message ?? e).slice(0, 160) }
  }
  const signed = wallet.sign(prepared)
  let sub
  try {
    // The local-check layer THROWS rather than returning a result, so this is not
    // defensive padding: a malformed transaction never reaches the catch below.
    sub = await client.request({ command: 'submit', tx_blob: signed.tx_blob })
  } catch (e) {
    return { ok: false, code: e?.data?.error ?? 'SUBMIT_ERROR', error: String(e?.data?.error_message ?? e.message).slice(0, 160) }
  }
  const engine = sub.result.engine_result
  const hash = signed.hash
  if (!(engine === 'tesSUCCESS' || String(engine).startsWith('tec'))) {
    return { ok: false, code: engine, error: sub.result.engine_result_message, hash }
  }
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const r = await client.request({ command: 'tx', transaction: hash })
      if (r.result.validated) {
        const code = r.result.meta.TransactionResult
        return { ok: code === 'tesSUCCESS', code, hash, meta: r.result.meta, engine, seconds: +((Date.now() - t0) / 1000).toFixed(1) }
      }
    } catch { /* txnNotFound until it lands */ }
  }
  return { ok: false, code: 'TIMEOUT', hash }
}

/** We issue. The subject is named but has granted nothing yet. */
export const issueCredential = (client, issuer, subject, type) =>
  submitValidated(client, issuer, { TransactionType: 'CredentialCreate', Subject: subject, CredentialType: hexType(type) })

/** The subject opts in. Without this the credential grants nothing at all. */
export const acceptCredential = (client, subject, issuerAddress, type) =>
  submitValidated(client, subject, { TransactionType: 'CredentialAccept', Issuer: issuerAddress, CredentialType: hexType(type) })

/** We revoke. Their next deposit bounces; their existing position is untouched. */
export const revokeCredential = (client, issuer, subject, type) =>
  submitValidated(client, issuer, { TransactionType: 'CredentialDelete', Subject: subject, CredentialType: hexType(type) })

/**
 * A vault owner builds a domain naming the issuers they trust.
 * We are named here. We are not consulted, and we cannot decline.
 */
export async function createDomain(client, owner, accepted) {
  const r = await submitValidated(client, owner, {
    TransactionType: 'PermissionedDomainSet',
    AcceptedCredentials: accepted.map((a) => ({
      Credential: { Issuer: a.issuer, CredentialType: hexType(a.type) },
    })),
  })
  if (!r.ok) return r
  const node = (r.meta.AffectedNodes ?? [])
    .map((n) => n.CreatedNode)
    .find((n) => n?.LedgerEntryType === 'PermissionedDomain')
  return { ...r, domainId: node?.LedgerIndex ?? null }
}

/**
 * Is this vault gated, and by whom?
 *
 * Reads the SHARE ISSUANCE, not the Vault. DomainID is not on the Vault ledger entry, so
 * the obvious lookup returns undefined and reads exactly like "open to everyone".
 */
export async function gateStatus(xrpl, vault) {
  const out = {
    gated: false, private: false, domainId: null, acceptedCredentials: [], domainOwner: null,
    note: null,
  }
  out.private = Boolean(vault.isPrivate)
  if (!vault.shareMptId) {
    out.note = 'no share issuance to read a domain from'
    return out
  }
  let issuance
  try {
    issuance = await xrpl.mptIssuance(vault.shareMptId)
  } catch (e) {
    out.note = `share issuance unreadable: ${String(e?.data?.error ?? e).slice(0, 80)}`
    return out
  }
  const domainId = issuance.DomainID ?? null
  if (!domainId) {
    out.note = out.private
      ? 'marked private but carries no domain, so nothing is enforced'
      : 'open to any depositor'
    return out
  }
  out.domainId = domainId
  try {
    const dom = await xrpl.req({ command: 'ledger_entry', index: domainId })
    const node = dom.result.node
    out.domainOwner = node.Owner ?? null
    out.acceptedCredentials = (node.AcceptedCredentials ?? []).map((a) => ({
      issuer: a.Credential?.Issuer ?? null,
      type: a.Credential?.CredentialType ? readType(a.Credential.CredentialType) : null,
      typeHex: a.Credential?.CredentialType ?? null,
    }))
    out.gated = out.private && out.acceptedCredentials.length > 0
    if (!out.private) out.note = 'carries a domain but is not flagged private, so nothing is enforced'
  } catch (e) {
    out.note = `domain unreadable: ${String(e?.data?.error ?? e).slice(0, 80)}`
  }
  return out
}

/** Does this issuer appear in the domain? The question a rater asks about themselves. */
export function isNamedIn(status, issuerAddress) {
  return status.acceptedCredentials.some((a) => a.issuer === issuerAddress)
}

export { log as gateLog }
