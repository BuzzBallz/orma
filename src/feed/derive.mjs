/**
 * The credit-event feed. Every event comes from comparing two full re-reads of a vault, composed with
 * the vault's share escrows and its Data at the same ledger; never from transaction metadata, so this
 * module reads no PreviousFields.
 */
import { num } from '../num.mjs'
import { logger } from '../log.mjs'
import { parseStatement, statementConsistency } from '../nyc/contracts.mjs'

const log = logger('feed')

const LATE = ['overdue', 'defaultable']
const IMPAIRED = 0x00020000
const DEFAULTED = 0x00010000
const KEEP = 500

const has = (flags, bit) => (Number(flags ?? 0) & bit) !== 0
const pad = (L) => String(L).padStart(19, '0')
const drops = (d) => ({ value: d.toFixed(0), unit: 'drops' })
const HEX64 = /^[0-9A-Fa-f]{64}$/

/** A cursor `<ledger on 19 digits>-<counter>`, compared as numbers: lexicographic order breaks at counter 10. */
export const CURSOR = /^(\d{19})-(\d+)$/
export function cursorKey(id) {
  const m = CURSOR.exec(id)
  return m ? [Number(m[1]), Number(m[2])] : null
}
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])

/**
 * The events between two composed snapshots of one vault. `prev` null: the first composed snapshot, which
 * is a baseline and yields only the STATEMENT of a Data already present.
 * @param {any} prev @param {any} next @param {number} [counter] the first counter of this ledger
 */
export function derive(prev, next, counter = 0) {
  const L = next.ledgerIndex
  const at = { vaultId: next.vaultId, ledgerIndex: L, ledgerHash: next.ledgerHash }
  const events = []
  const push = (e) => events.push({ id: `${pad(L)}-${counter + events.length}`, ...e, ...at, ...(e.txHash && HEX64.test(e.txHash) ? {} : { txHash: undefined }) })

  if (next.vaultData && (prev ? prev.vaultData !== next.vaultData : true)) {
    const doc = parseStatement(next.vaultData)
    push({
      type: 'STATEMENT', provenance: 'DECLARED',
      why: doc ? `The vault owner declared on the ledger: "${doc.text}"` : 'The vault owner wrote a Data that is not a readable orma.stmt/1 statement',
      moneyEffect: null, txHash: next.statementTxHash,
      receipts: [{ object: 'Vault', field: 'Data', before: prev?.vaultData ?? null, after: next.vaultData }],
      statement: {
        provenance: 'DECLARED', raw: next.vaultData, owner: next.vault.owner, doc,
        consistency: statementConsistency(doc, next.loans, { ledgerIndex: L, ledgerHash: next.ledgerHash }),
      },
    })
  }
  if (!prev) return events.map(clean)

  const was = new Map(prev.loans.map((l) => [l.loanId, l]))
  let firstDefault = null
  for (const l of next.loans) {
    const p = was.get(l.loanId)
    if (!p) {
      push({ type: 'LOAN_ORIGINATED', provenance: 'REAL', loanId: l.loanId, txHash: l.previousTxnId, why: `A loan of ${l.principalOutstanding.toFixed(0)} drops was originated`, moneyEffect: drops(l.principalOutstanding), receipts: [{ object: 'Loan', field: 'PrincipalOutstanding', before: null, after: l.principalOutstanding.toFixed(0) }] })
      continue
    }
    if (LATE.includes(l.status) && !LATE.includes(p.status)) {
      push({ type: 'LOAN_LATE', provenance: 'REAL', loanId: l.loanId, why: `The loan missed its payment due ${l.nextPaymentDueAt}`, moneyEffect: drops(l.principalOutstanding), receipts: [{ object: 'Loan', field: 'NextPaymentDueDate', before: p.nextPaymentDueAt, after: l.nextPaymentDueAt }] })
    }
    if (has(l.flags, IMPAIRED) && !has(p.flags, IMPAIRED)) {
      push({ type: 'IMPAIRMENT', provenance: 'REAL', loanId: l.loanId, txHash: l.previousTxnId, why: 'The broker impaired the loan: the vault now recognises it as an unrealised loss', moneyEffect: drops(next.vault.lossUnrealized.minus(prev.vault.lossUnrealized)), receipts: [{ object: 'Loan', field: 'Flags', before: p.flags, after: l.flags }, { object: 'Vault', field: 'LossUnrealized', before: prev.vault.lossUnrealized.toFixed(0), after: next.vault.lossUnrealized.toFixed(0) }] })
    }
    if (has(l.flags, DEFAULTED) && !has(p.flags, DEFAULTED)) {
      firstDefault ??= l
      push({ type: 'DEFAULT', provenance: 'REAL', loanId: l.loanId, txHash: l.previousTxnId, why: 'The broker defaulted the loan: the vault wrote its loss off its assets', moneyEffect: drops(next.vault.assetsTotal.minus(prev.vault.assetsTotal)), receipts: [{ object: 'Loan', field: 'Flags', before: p.flags, after: l.flags }, { object: 'Vault', field: 'AssetsTotal', before: prev.vault.assetsTotal.toFixed(0), after: next.vault.assetsTotal.toFixed(0) }] })
    }
  }
  if (firstDefault) {
    const brokers = new Map(prev.brokers.map((b) => [b.loanBrokerId, b]))
    for (const b of next.brokers) {
      const p = brokers.get(b.loanBrokerId)
      if (p && b.coverAvailable.lt(p.coverAvailable)) {
        push({ type: 'COVER_DRAWN', provenance: 'REAL', loanId: firstDefault.loanId, txHash: firstDefault.previousTxnId, why: 'The default drew on the broker\'s first-loss cover', moneyEffect: drops(b.coverAvailable.minus(p.coverAvailable)), receipts: [{ object: 'LoanBroker', field: 'CoverAvailable', before: p.coverAvailable.toFixed(0), after: b.coverAvailable.toFixed(0) }] })
      }
    }
  }
  const held = new Set(prev.escrows.map((e) => e.index))
  for (const e of next.escrows) {
    if (held.has(e.index)) continue
    const units = num(e.Amount?.value).toFixed(0)
    push({ type: 'SHARES_PLEDGED', provenance: 'REAL', txHash: e.PreviousTxnID, why: `${units} share units were pledged into escrow to ${e.Destination}`, moneyEffect: { value: units, unit: 'share-units' }, receipts: [{ object: 'Escrow', field: 'Amount', before: null, after: { mpt_issuance_id: e.Amount.mpt_issuance_id, value: units } }] })
  }
  return events.map(clean)
}

const clean = (e) => {
  if (e.txHash === undefined) delete e.txHash
  return e
}

/**
 * The feed of every vault the Reader reads. Each snapshot is composed with the borrower's share escrows
 * (one read per ledger, shared by the vaults of that ledger) and, when the vault changed, its Data; a
 * ledger whose reads fail or overflow a page is skipped, so the next snapshot compares with the last
 * composed one and an escrow missed then found again is never a new pledge.
 * @param {any} reader @param {{ xrpl?: any, escrowAccounts: string[] }} opts
 */
export function createFeed(reader, { xrpl = reader.xrpl, escrowAccounts }) {
  const last = new Map()
  const events = []
  const listeners = new Set()
  const counters = new Map()
  let ledgerEscrows = null
  let chain = Promise.resolve()

  function escrowsAt(L) {
    if (ledgerEscrows?.L !== L) {
      ledgerEscrows = {
        L,
        read: (async () => {
          const out = []
          for (const account of escrowAccounts) {
            const r = (await xrpl.req({ command: 'account_objects', account, type: 'escrow', limit: 400, ledger_index: L })).result
            if (r.marker) throw new Error(`more than 400 escrows on ${account}`)
            out.push(...(r.account_objects ?? []).filter((e) => e.Account === account))
          }
          return out
        })(),
      }
      ledgerEscrows.read.catch(() => {})
    }
    return ledgerEscrows.read
  }

  async function vaultData(snap, prev) {
    if (prev && prev.vault.lastChangeLedger === snap.vault.lastChangeLedger) return { vaultData: prev.vaultData, statementTxHash: prev.statementTxHash }
    const node = (await xrpl.req({ command: 'ledger_entry', index: snap.vaultId, ledger_index: snap.ledgerIndex })).result.node
    const data = node.Data ?? null
    if (data === (prev?.vaultData ?? null)) return { vaultData: data, statementTxHash: prev?.statementTxHash }
    let statementTxHash
    if (data && node.PreviousTxnID) {
      const tx = (await xrpl.req({ command: 'tx', transaction: node.PreviousTxnID })).result
      const j = tx.tx_json ?? tx
      if (j.TransactionType === 'VaultSet' && j.Account === node.Owner && j.Data === data) statementTxHash = tx.hash ?? node.PreviousTxnID
    }
    return { vaultData: data, statementTxHash }
  }

  async function compose(snap) {
    const prev = last.get(snap.vaultId)
    let escrows, data
    try {
      const share = snap.vault.shareMptId
      const seen = new Map()
      for (const e of await escrowsAt(snap.ledgerIndex)) if (e.Amount?.mpt_issuance_id === share) seen.set(e.index, e)
      escrows = [...seen.values()]
      data = await vaultData(snap, prev)
    } catch (e) {
      log.warn('ledger skipped by the feed', { vault: snap.vaultId.slice(0, 12), ledgerIndex: snap.ledgerIndex, err: String(e?.message ?? e).slice(0, 120) })
      return
    }
    const next = { ...snap, escrows, ...data }
    const fresh = derive(prev ?? null, next, counters.get(snap.ledgerIndex) ?? 0)
    last.set(snap.vaultId, next)
    if (fresh.length) {
      counters.clear()
      counters.set(snap.ledgerIndex, Number(CURSOR.exec(fresh.at(-1).id)[2]) + 1)
    }
    for (const ev of fresh) {
      events.push(ev)
      if (events.length > KEEP) events.shift()
      for (const fn of listeners) fn(ev)
      log.info('credit event', { type: ev.type, vault: ev.vaultId.slice(0, 12), ledgerIndex: ev.ledgerIndex })
    }
  }

  reader.subscribe((snap) => {
    chain = chain.then(() => compose(snap)).catch((e) => log.error('feed failed on a snapshot', { err: String(e).slice(0, 200) }))
    return chain
  })

  return {
    /** The events after a cursor, in order; no cursor: all of those kept. */
    after(cursor) {
      const k = cursor ? cursorKey(cursor) : null
      return k ? events.filter((e) => before(k, cursorKey(e.id))) : [...events]
    },
    onEvent(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
