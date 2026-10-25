/**
 * What a ticket reads, at one validated ledger L: the vault of a share, its share issuance, its
 * LoanBrokers and their loans, and each broker's history for its conduct; and what the desk's positions
 * read: the desk's loans, the LoanSet that created each, the escrow its Memo names, the 2-of-3 account
 * that escrow pays into, and the vault of the pledged share. Every state read carries ledger_index L and
 * keeps the ledger_index of its response. I7 is judged here, before any figure exists.
 *
 * account_tx is the one read that is not pinned to L by a ledger_index: it reads history up to L.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeAccountID, hashes } from 'xrpl'
import { num } from '../num.mjs'
import { normaliseBroker, normaliseVault } from '../xrpl.mjs'
import { readBrokerHistory, analyseOrdering } from '../history.mjs'
import { judgeCollateralAccount, judgeCollateralShare, SCHEMAS, usdTermsHash } from '../nyc/contracts.mjs'
import { readXrpUsd, PriceUnavailableError } from '../fx/price.mjs'
import { logger } from '../log.mjs'

/** A paged read follows marker at one ledger for at most this many pages, then refuses. */
export const MAX_PAGES = 50
/** The cure escrows read per loan, the most recent first: a borrower's Memos never make a positions read unbounded. */
export const MAX_CURES_PER_LOAN = 8

const positionsLog = logger('ticket:positions')

const LSF_DISABLE_MASTER = 0x00100000
const LSF_DEPOSIT_AUTH = 0x01000000
const flagSet = (flags, mask) => (BigInt(num(flags).toFixed(0)) & BigInt(mask)) !== 0n

/** The objects read at one ledger do not satisfy I7: no figure may be computed on them. */
export class SnapshotError extends Error {
  /** @param {{ violations: { rule: string, detail: string }[], vaultId: string, ledgerIndex: number, ledgerHash: string|null }} o */
  constructor({ violations, vaultId, ledgerIndex, ledgerHash }) {
    super(`The ledger objects read at ledger ${ledgerIndex} are not consistent with each other (${violations[0]?.rule}: ${violations[0]?.detail}); no figure is shown. Retry on the next ledger.`)
    this.name = 'SnapshotError'
    this.code = 'INCONSISTENT_SNAPSHOT'
    this.violations = violations
    this.vaultId = vaultId
    this.ledgerIndex = ledgerIndex
    this.ledgerHash = ledgerHash
  }
}

/** No tracked vault issues this share. */
export class ShareNotTrackedError extends Error {
  constructor(shareMptId) {
    super(`No facility on this service issues the share ${shareMptId}.`)
    this.name = 'ShareNotTrackedError'
    this.code = 'SHARE_NOT_TRACKED'
  }
}

/** A paged read ran past MAX_PAGES at one ledger: nothing is judged on a partial read. */
export class PageLimitError extends Error {
  constructor(what, ledgerIndex) {
    super(`${what} runs past ${MAX_PAGES} pages at ledger ${ledgerIndex}; nothing is judged on a partial read`)
    this.name = 'PageLimitError'
    this.code = 'PAGE_LIMIT'
  }
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()

/** The 48-hex id of a share issuance, as rippled builds it: its Sequence then its Issuer's AccountID. */
export function issuanceIdOf(node) {
  if (!node?.Issuer || node.Sequence === undefined) return null
  const seq = BigInt(num(node.Sequence).toFixed(0)).toString(16).padStart(8, '0')
  return (seq + Buffer.from(decodeAccountID(node.Issuer)).toString('hex')).toUpperCase()
}

/**
 * I7: the vault state checks xrpld 3.4.1 runs after every transaction on a vault
 * (src/libxrpl/tx/invariants/VaultInvariant.cpp), applied to what Orma read at L, an absent field
 * reading 0, plus Orma's own: the share is the one asked for and is the vault's, and every response came
 * back at L. Pure. A validated ledger never holds such a state: the rule catches a read that straddled
 * two ledgers, or a read gone wrong.
 *   zeroShares        OutstandingAmount 0 ⇒ AssetsTotal and AssetsAvailable 0        (l. 574-588)
 *   availableRange    0 ≤ AssetsAvailable ≤ AssetsTotal                                (l. 597-608)
 *   lossGap           LossUnrealized ≤ AssetsTotal − AssetsAvailable, strictly (XRP)   (l. 609-632)
 *   lossNonNegative   LossUnrealized ≥ 0                                               (l. 634-638)
 *   totalNonNegative  AssetsTotal ≥ 0                                                  (l. 640-644)
 *   shareId           Vault.ShareMPTID = the share asked for = the issuance read (its Sequence and
 *                     Issuer, l. 79-81), whose Issuer is the vault's pseudo-account Vault.Account (l. 547)
 *   sameLedger        every response at the same ledger_index L; none known is a violation
 * @param {{ vault: any, issuance: any, shareMptId: string, ledgerIndex: number, readAt: number[] }} o
 * @returns {{ consistent: boolean, violations: { rule: string, detail: string }[] }}
 */
export function judgeSnapshot({ vault, issuance, shareMptId, ledgerIndex, readAt }) {
  const violations = []
  const add = (rule, detail) => violations.push({ rule, detail })
  const total = num(vault?.AssetsTotal)
  const available = num(vault?.AssetsAvailable)
  const loss = num(vault?.LossUnrealized)
  const shares = num(issuance?.OutstandingAmount)
  if (shares.isZero() && !total.isZero()) add('zeroShares', `no shares outstanding but AssetsTotal ${total.toFixed()}`)
  if (shares.isZero() && !available.isZero()) add('zeroShares', `no shares outstanding but AssetsAvailable ${available.toFixed()}`)
  if (available.lt(0)) add('availableRange', `AssetsAvailable ${available.toFixed()} is negative`)
  if (available.gt(total)) add('availableRange', `AssetsAvailable ${available.toFixed()} is above AssetsTotal ${total.toFixed()}`)
  if (loss.gt(total.minus(available))) add('lossGap', `LossUnrealized ${loss.toFixed()} is above AssetsTotal − AssetsAvailable ${total.minus(available).toFixed()}`)
  if (loss.lt(0)) add('lossNonNegative', `LossUnrealized ${loss.toFixed()} is negative`)
  if (total.lt(0)) add('totalNonNegative', `AssetsTotal ${total.toFixed()} is negative`)
  const issued = issuanceIdOf(issuance) ?? issuance?.mpt_issuance_id ?? null
  if (!same(vault?.ShareMPTID, shareMptId)) add('shareId', `the vault's ShareMPTID ${vault?.ShareMPTID ?? 'absent'} is not the share ${shareMptId}`)
  else if (!same(issued, shareMptId)) add('shareId', `the issuance read is ${issued ?? 'unknown'}, not the share ${shareMptId}`)
  if (issuance && vault?.Account && issuance.Issuer !== vault.Account) add('shareId', `the share is issued by ${issuance.Issuer ?? 'nobody'}, not by the vault's pseudo-account ${vault.Account}`)
  if (!Array.isArray(readAt) || readAt.length === 0) add('sameLedger', 'response ledger unknown')
  else {
    const other = [...new Set(readAt.filter((l) => l !== ledgerIndex))]
    if (other.length) add('sameLedger', `responses at ledger ${other.join(', ')}, not ${ledgerIndex}`)
  }
  return { consistent: violations.length === 0, violations }
}

/** L: the one given, else the validated ledger closeTime() reads now, with its hash and close_time. */
async function ledgerOf(xrpl, at) {
  if (at) return at
  await xrpl.closeTime()
  return { ledgerIndex: xrpl.lastLedger, ledgerHash: xrpl.lastLedgerHash ?? null, closeTime: xrpl.lastCloseTime }
}

/** Every page of a marker-paged read at L, MAX_PAGES at most; the ledger_index of each response kept. */
export async function allPages(xrpl, payload, key, readAt, what = `${payload.command} of ${payload.account}`) {
  const out = []
  let marker
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await xrpl.req({ ...payload, ...(marker !== undefined && { marker }) })
    readAt?.push(r.result.ledger_index)
    out.push(...(r.result[key] ?? []))
    marker = r.result.marker
    if (marker === undefined || marker === null) return out
  }
  throw new PageLimitError(what, payload.ledger_index ?? payload.ledger_index_max)
}

const notFound = (e) => e?.data?.error === 'entryNotFound' || e?.data?.error === 'objectNotFound'

/** A ledger_entry at L, or null when the object is not on that ledger. */
async function entryAt(xrpl, params, L, readAt) {
  try {
    const r = await xrpl.req({ command: 'ledger_entry', ...params, ledger_index: L })
    readAt?.push(r.result.ledger_index)
    return r.result.node
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}

/**
 * The ticket's inputs for a share, at one ledger: the vault (with its raw Data), its issuance, every
 * LoanBroker on it and every loan under them, the close_time, and each broker's conduct from its history.
 * Throws ShareNotTrackedError for a share no tracked vault issues, SnapshotError when I7 fails.
 * @param {any} xrpl
 * @param {{ shareMptId: string, reader: any, at?: { ledgerIndex: number, ledgerHash: string|null, closeTime: number }, history?: boolean }} o
 */
export async function readTicketInputs(xrpl, { shareMptId, reader, at, history = true }) {
  const share = String(shareMptId).toUpperCase()
  const snap = reader.getByShareMpt(share)
  if (!snap) throw new ShareNotTrackedError(share)
  const vaultId = snap.vaultId
  const { ledgerIndex: L, ledgerHash: H, closeTime } = await ledgerOf(xrpl, at)
  const readAt = []
  const v = await xrpl.req({ command: 'vault_info', vault_id: vaultId, ledger_index: L })
  readAt.push(v.result.ledger_index)
  const vault = { ...v.result.vault, index: v.result.vault.index ?? vaultId }
  const issuance = await entryAt(xrpl, { mpt_issuance: String(vault.ShareMPTID ?? share).toUpperCase() }, L, readAt)
  const owned = await allPages(xrpl, { command: 'account_objects', account: vault.Owner, type: 'loan_broker', limit: 400, ledger_index: L }, 'account_objects', readAt)
  const brokers = []
  let n = 0
  for (const b of owned.filter((o) => o.VaultID === vaultId).sort((a, c) => (a.index < c.index ? -1 : 1))) {
    const loans = []
    for (let seq = 1; seq < ledgerInt(b.LoanSequence); seq++) {
      const loan = await entryAt(xrpl, { loan: { loan_broker_id: b.index, loan_seq: seq } }, L, readAt)
      if (loan) loans.push({ id: loan.index, label: `L${++n}`, fields: loan, raw: loan })
    }
    brokers.push({ id: b.index, fields: b, raw: b, loans })
  }
  const judged = judgeSnapshot({ vault, issuance, shareMptId: share, ledgerIndex: L, readAt })
  if (!judged.consistent) throw new SnapshotError({ violations: judged.violations, vaultId, ledgerIndex: L, ledgerHash: H })

  const { lagsByLoan, ...conduct } = history ? await conductOf(xrpl, brokers, vault, closeTime) : { recognitionLagSeconds: [], defaultsWithoutImpairment: 0, coverOrderCostDrops: '0', lagsByLoan: {} }
  return {
    ledgerIndex: L, ledgerHash: H, closeTime,
    vault: { id: vaultId, fields: vault, raw: vault },
    issuance: { id: share, fields: issuance ?? {}, raw: issuance },
    brokers,
    conduct,
    // step 22: each impaired loan's recognition lag, the last impairment on record, for its payment entry
    recognitionLags: lagsByLoan,
    readAt,
  }
}

/**
 * Conduct, in facts and no letter: for each impairment on record, its close_time minus the loan's
 * NextPaymentDueDate (how long the manager took to recognise the loss); the defaults declared with no
 * impairment before them; and what the order of the defaults cost the depositors.
 */
async function conductOf(xrpl, brokers, vault, closeTime) {
  const lags = []
  const lagsByLoan = {}
  let undeclared = 0
  let cost = num(0)
  const v = normaliseVault(vault, closeTime)
  for (const b of brokers) {
    const broker = normaliseBroker(b.raw)
    const { events, window } = await readBrokerHistory(xrpl, broker, v)
    const impaired = new Set(events.filter((e) => e.kind === 'impair').map((e) => e.loanId))
    undeclared += events.filter((e) => e.kind === 'default' && e.loanId && !impaired.has(e.loanId)).length
    for (const e of events.filter((x) => x.kind === 'impair' && x.at)) {
      const loan = b.loans.find((l) => same(l.id, e.loanId))
      if (!loan || loan.fields.NextPaymentDueDate === undefined) continue
      const at = num(Date.parse(e.at)).div(1000).minus(946684800)
      lags.push(at.minus(num(loan.fields.NextPaymentDueDate)).toFixed(0))
      lagsByLoan[String(loan.id).toUpperCase()] = lags.at(-1)
    }
    const ordering = analyseOrdering(events, broker, window)
    if (ordering.applicable) cost = cost.plus(num(ordering.costToDepositors))
  }
  return { recognitionLagSeconds: lags, defaultsWithoutImpairment: undeclared, coverOrderCostDrops: cost.toFixed(0), lagsByLoan }
}

/** demo/<label>.json, read when asked: createNyc starts without demo/. */
export function readDemo(label, dir = 'demo') {
  return JSON.parse(readFileSync(join(dir, `${label}.json`), 'utf8'))
}

/**
 * The desk's lending pools, each with the currency it lends: desk and spare in XRP, and, once
 * src/demo/bake-usd.mjs has run, desk-usd in the test dollar (step 21), whose vault id is usdVaultId.
 * @param {string} [dir]
 * @returns {{ label: string, vaultId: string, loanBrokerId: string, currency: 'XRP'|'USD', loanAsset?: any }[]}
 */
export function deskLenders(dir = 'demo') {
  const out = ['desk', 'spare'].map((label) => {
    const f = readDemo(label, dir)
    return { label, vaultId: f.vaultId, loanBrokerId: f.loanBrokerId, currency: /** @type {const} */ ('XRP') }
  })
  if (existsSync(join(dir, 'desk-usd.json'))) {
    const f = readDemo('desk-usd', dir)
    out.push({ label: 'desk-usd', vaultId: f.usdVaultId, loanBrokerId: f.loanBrokerId, currency: 'USD', loanAsset: f.asset })
  }
  return out
}

/**
 * A 2-of-3 collateral account read at L, and judged: account_info (its signer list and OwnerCount), its
 * MPToken of the pledged share, every object of its directory (the escrows it receives), all at
 * ledger_index L, and, with history, its account_tx up to L for the pledge EscrowCreates it received. A
 * read that runs past MAX_PAGES judges the account non-conforming, with the sentence.
 * @param {any} xrpl
 * @param {{ address: string, shareMptId: string, at: { ledgerIndex: number, ledgerHash: string|null }, borrower?: string, desk?: string, agent?: string, namedEscrow?: string|null, expectEscrows?: 0|'named'|'any', expectShares?: 'none'|'any', history?: boolean, demoDir?: string }} o
 */
export async function readCollateralAccount(xrpl, { address, shareMptId, at, borrower, desk, agent, namedEscrow = null, expectEscrows = 'named', expectShares = 'none', history = false, demoDir = 'demo' }) {
  if (!borrower || !desk || !agent) {
    const c = readDemo('desk', demoDir).collateral ?? {}
    borrower ??= c.borrower
    desk ??= c.desk
    agent ??= c.agent
  }
  const L = at.ledgerIndex
  const base = { address, signers: { borrower, desk, agent }, provenance: 'REAL', ledgerIndex: L, ledgerHash: at.ledgerHash }
  let accountRoot = null
  let signerList = null
  try {
    const r = await xrpl.req({ command: 'account_info', account: address, signer_lists: true, ledger_index: L })
    accountRoot = r.result.account_data
    signerList = (r.result.signer_lists ?? r.result.account_data?.signer_lists ?? [])[0] ?? null
  } catch (e) {
    if (e?.data?.error !== 'actNotFound') throw e
  }
  const mptoken = await entryAt(xrpl, { mptoken: { mpt_issuance_id: String(shareMptId).toUpperCase(), account: address } }, L)
  let escrows = []
  let pledges
  let refused = null
  try {
    if (accountRoot) {
      const objects = await allPages(xrpl, { command: 'account_objects', account: address, limit: 400, ledger_index: L }, 'account_objects', null, `the objects of ${address}`)
      escrows = objects.filter((o) => o.LedgerEntryType === 'Escrow' && o.Destination === address)
      if (history) {
        const txs = await allPages(xrpl, { command: 'account_tx', account: address, ledger_index_min: -1, ledger_index_max: L, limit: 400 }, 'transactions', null, `the history of ${address}`)
        pledges = txs.map((e) => ({ e, t: e.tx_json ?? e.tx ?? {} }))
          .filter(({ e, t }) => t.TransactionType === 'EscrowCreate' && t.Account === borrower && t.Destination === address && e.meta?.TransactionResult === 'tesSUCCESS'
            && same(t.Amount?.mpt_issuance_id, shareMptId))
          .map(({ e, t }) => ({ account: t.Account, sequence: t.Sequence, index: hashes.hashEscrow(t.Account, t.Sequence), txHash: e.hash ?? t.hash, ledgerIndex: e.ledger_index }))
      }
    }
  } catch (e) {
    if (!(e instanceof PageLimitError)) throw e
    refused = e.message
  }
  const judged = refused
    ? { conforming: false, reasons: [refused] }
    : judgeCollateralAccount({ accountRoot, signerList, mptoken, escrows }, { borrower, desk, agent, shareMptId, expectEscrows, expectShares, namedEscrow })
  return {
    raw: { accountRoot, signerList, mptoken, escrows },
    ...base,
    quorum: ledgerInt(signerList?.SignerQuorum),
    masterDisabled: Boolean(accountRoot) && flagSet(accountRoot.Flags, LSF_DISABLE_MASTER),
    regularKey: accountRoot?.RegularKey ?? null,
    depositAuth: Boolean(accountRoot) && flagSet(accountRoot.Flags, LSF_DEPOSIT_AUTH),
    mptAuthorized: Boolean(mptoken),
    sharesHeld: num(mptoken?.MPTAmount).toFixed(0),
    escrowCount: escrows.length,
    ownerCount: ledgerInt(accountRoot?.OwnerCount),
    ...(pledges && { pledges }),
    conforming: judged.conforming,
    reasons: judged.reasons,
  }
}

/** A ledger integer as rippled sends it (a JSON number), absent reading 0; never parsed from a string. */
function ledgerInt(v) {
  return Number.isSafeInteger(v) ? v : 0
}

/**
 * The desk's positions at one ledger: every loan of the desk and spare LoanBrokers, the LoanSet that
 * created it (its CreatedNode of type Loan, read from the borrower's account_tx up to L), the escrow that
 * LoanSet's orma.escrow Memo names (read by its index at L; gone means finished or cancelled), the
 * collateral account it pays into, and the ticket inputs of the pledged share at the same L. An escrow is
 * attached only to the loan whose LoanSet names it, never by borrower, amount or share.
 */
export async function readPositions(xrpl, { reader, demoDir = 'demo', at: pinned = null }) {
  // `at` (step 20): read again at a ledger already read, the margin call's I2 re-read; absent, the validated ledger now
  const at = await ledgerOf(xrpl, pinned)
  const L = at.ledgerIndex
  // step 21: the dollar pool beside desk and spare, and the terms its loans are valued on
  const lenders = deskLenders(demoDir)
  // terms missing or not hashing price no dollar position, and stop nothing else: the XRP positions stand
  let usdTerms = null
  let usdTermsError = null
  const usdLender = lenders.find((f) => f.currency === 'USD') ?? null
  if (usdLender) {
    try {
      const t = readDemo('usd-terms-desk-1', demoDir)
      if (SCHEMAS.usdTerms(t).length || usdTermsHash(t) !== t.hash) usdTermsError = 'demo/usd-terms-desk-1.json does not hash to its own hash: no dollar position is valued on it.'
      else usdTerms = t
    } catch (e) {
      usdTermsError = `demo/usd-terms-desk-1.json is missing or unreadable (${e.code ?? e.name}): no dollar position is valued.`
    }
  }
  const brokerIds = new Set(lenders.map((f) => f.loanBrokerId))
  const loans = []
  for (const f of lenders) {
    const broker = await entryAt(xrpl, { index: f.loanBrokerId }, L)
    if (!broker) continue
    for (let seq = 1; seq < ledgerInt(broker.LoanSequence); seq++) {
      const loan = await entryAt(xrpl, { loan: { loan_broker_id: f.loanBrokerId, loan_seq: seq } }, L)
      if (loan) loans.push({ loan, vaultId: f.vaultId, currency: f.currency })
    }
  }
  // the LoanSets that created the desk's loans, and the escrow each one names
  const createdBy = new Map()
  const MEMO_ESCROW = Buffer.from('orma.escrow', 'utf8').toString('hex').toUpperCase()
  // the desk's gate (step 10) keeps its ticket in the first Memo: a LoanSet without it was countersigned outside the gate
  const MEMO_TICKET = Buffer.from('orma.ticket', 'utf8').toString('hex').toUpperCase()
  // step 20: a pledge that cures a margin call names its loan in an orma.cure Memo of its EscrowCreate
  const MEMO_CURE = Buffer.from('orma.cure', 'utf8').toString('hex').toUpperCase()
  /** loan id -> the cure escrows that name it: { index, borrower } */
  const cures = new Map()
  for (const borrower of [...new Set(loans.map((l) => l.loan.Borrower))]) {
    const txs = await allPages(xrpl, { command: 'account_tx', account: borrower, ledger_index_min: -1, ledger_index_max: L, limit: 400 }, 'transactions', null, `the history of ${borrower}`)
    for (const e of txs) {
      const t = e.tx_json ?? e.tx ?? {}
      if (t.TransactionType === 'EscrowCreate' && e.meta?.TransactionResult === 'tesSUCCESS' && t.Account === borrower) {
        const cure = (t.Memos ?? []).map((m) => m.Memo).find((m) => same(m?.MemoType, MEMO_CURE))
        const seq = ledgerInt(t.Sequence) || ledgerInt(t.TicketSequence)
        if (cure?.MemoData && seq) {
          const loanId = String(cure.MemoData).toUpperCase()
          cures.set(loanId, [...(cures.get(loanId) ?? []), { index: hashes.hashEscrow(t.Account, seq).toUpperCase(), borrower }])
        }
        continue
      }
      if (t.TransactionType !== 'LoanSet' || e.meta?.TransactionResult !== 'tesSUCCESS') continue
      const node = (e.meta.AffectedNodes ?? []).map((a) => a.CreatedNode).find((c) => c?.LedgerEntryType === 'Loan')
      if (!node || !brokerIds.has(node.NewFields?.LoanBrokerID ?? t.LoanBrokerID)) continue
      const memo = (t.Memos ?? []).map((m) => m.Memo).find((m) => same(m?.MemoType, MEMO_ESCROW))
      createdBy.set(String(node.LedgerIndex).toUpperCase(), { txHash: e.hash ?? t.hash, ledgerIndex: e.ledger_index ?? t.ledger_index ?? null, ticketed: (t.Memos ?? []).some((m) => same(m.Memo?.MemoType, MEMO_TICKET)), escrowIndex: memo?.MemoData ? String(memo.MemoData).toUpperCase() : null })
    }
  }
  const out = []
  // one ticket read per pledged share and per call: two escrows of the same share share the vault read
  const inputsByShare = new Map()
  const inputsOf = (shareMptId) => {
    if (!inputsByShare.has(shareMptId)) inputsByShare.set(shareMptId, readTicketInputs(xrpl, { shareMptId, reader, at }))
    return inputsByShare.get(shareMptId)
  }
  // an escrow counts once, on one loan: the LoanSet-named escrows first, a cure Memo never counts them again
  const counted = new Set([...createdBy.values()].map((made) => made.escrowIndex).filter(Boolean))
  for (const { loan, vaultId, currency } of loans) {
    const made = createdBy.get(String(loan.index).toUpperCase()) ?? null
    const collateral = []
    if (made?.escrowIndex) {
      const escrow = await entryAt(xrpl, { index: made.escrowIndex }, L)
      if (escrow && escrow.Amount?.mpt_issuance_id) {
        const shareMptId = String(escrow.Amount.mpt_issuance_id).toUpperCase()
        const account = await readCollateralAccount(xrpl, { address: escrow.Destination, shareMptId, at, namedEscrow: made.escrowIndex, demoDir })
        const ticketInputs = await inputsOf(shareMptId)
        collateral.push({ escrowId: made.escrowIndex, shareMptId, units: String(escrow.Amount.value), account, ticketInputs })
      }
    }
    // step 20: every live cure escrow of the borrower that names this loan, each in its own 2-of-3 account.
    // The Memo is the borrower's own words: a cure counts only when its share is a tracked vault share
    // eligible as collateral (I4) and its account is a conforming 2-of-3 account (I3), at most
    // MAX_CURES_PER_LOAN of them, the most recent first; any other is left out and the log says why.
    let cureReads = 0
    for (const c of made ? cures.get(String(loan.index).toUpperCase()) ?? [] : []) {
      if (c.borrower !== loan.Borrower || counted.has(c.index)) continue
      if (cureReads >= MAX_CURES_PER_LOAN) {
        positionsLog.warn('cure escrows past the cap left out', { loanId: loan.index, ledgerIndex: L, cap: MAX_CURES_PER_LOAN })
        break
      }
      cureReads++
      const escrow = await entryAt(xrpl, { index: c.index }, L)
      if (!escrow?.Amount?.mpt_issuance_id || escrow.Account !== loan.Borrower) continue
      const shareMptId = String(escrow.Amount.mpt_issuance_id).toUpperCase()
      const skip = (why) => positionsLog.warn('cure escrow not counted', { loanId: loan.index, escrowId: c.index, ledgerIndex: L, why })
      if (!reader.getByShareMpt(shareMptId)) {
        skip(`no tracked vault issues the share ${shareMptId}`)
        continue
      }
      // an inconsistent snapshot of a tracked vault still refuses every figure (I7)
      const ticketInputs = await inputsOf(shareMptId)
      const share = judgeCollateralShare({ vault: ticketInputs.vault.raw, issuance: ticketInputs.issuance.raw, mptoken: null })
      if (!share.eligible) {
        skip(`the share is not eligible as collateral: ${share.reasons.join('; ')}`)
        continue
      }
      const account = await readCollateralAccount(xrpl, { address: escrow.Destination, shareMptId, at, namedEscrow: c.index, demoDir })
      if (!account.conforming || escrow.Condition) {
        skip(escrow.Condition ? 'the escrow carries a Condition' : `its account is not a conforming 2-of-3 account: ${account.reasons.join('; ')}`)
        continue
      }
      counted.add(c.index)
      collateral.push({ escrowId: c.index, shareMptId, units: String(escrow.Amount.value), account, ticketInputs, cure: true })
    }
    out.push({
      loanId: loan.index, loanSetTxHash: made?.txHash ?? null, loanSetLedger: made?.ledgerIndex ?? null, loanSetTicket: made ? made.ticketed : null, vaultId, borrower: loan.Borrower,
      // drops of XRP, or dollars of the test dollar, as the ledger states them
      principalOutstanding: currency === 'USD' ? num(loan.PrincipalOutstanding).toFixed() : num(loan.PrincipalOutstanding).toFixed(0), collateral, currency,
    })
  }
  // step 21: the XRP/USD price of the terms' oracles at the same L; none usable is said, never guessed, and a
  // failed price read prices no dollar position without taking the XRP ones down
  let usdPrice = null
  let usdPriceError = usdTermsError
  if (usdTerms && out.some((l) => l.currency === 'USD')) {
    try {
      usdPrice = await readXrpUsd(xrpl, usdTerms, at)
    } catch (e) {
      usdPriceError = e instanceof PriceUnavailableError ? e.message : `The XRP/USD price could not be read at ledger ${L} (${String(e?.message ?? e).slice(0, 120)}).`
    }
  }
  return {
    ledgerIndex: L, ledgerHash: at.ledgerHash, closeTime: at.closeTime, loans: out,
    ...(usdLender && { usdTerms, usdPrice, usdPriceError, usdLoanAsset: usdLender.loanAsset ?? null }),
  }
}
