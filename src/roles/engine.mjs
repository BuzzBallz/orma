/**
 * The browser's only write surface: named role actions, previewed by `simulate`, confirmed, then
 * submitted through one serial queue per signing account. Every submission of the API goes through
 * `enqueue`: two submissions from one account in parallel steal each other's Sequence.
 *
 *   POST /api/roles/{runId}/{role}/{action}             -> 202 { actionId, preview }, nothing submitted;
 *                                                          a simulated preview is orma.change/1 (src/change/engine.mjs)
 *   POST /api/roles/{runId}/actions/{actionId}/confirm  -> 202, the action queued on its account
 *   GET  /api/roles/{runId}/actions/{actionId}          -> the action, public (no Origin, token or kill check)
 *   POST /api/roles/{runId}/actions/{actionId}/signature -> 202, a browser signature verified and handed on
 *
 * The demo lab (Devnet only): an action whose POST body carries `signer: 'browser'` is built, simulated,
 * re-read and logged here exactly as any other, but each signature it needs is asked of the page
 * (src/roles/remote-signer.mjs): the action goes `awaiting-signature` with its `toSign`, and the work goes
 * on once the posted blob is verified. No HTTP request ever waits for a browser signature.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Wallet, hashes } from 'xrpl'
import { num } from '../num.mjs'
import { FLAG } from '../history.mjs'
import { logger } from '../log.mjs'
import { COLLATERAL_POLICY, COLLATERAL_STAGES, judgeCollateralAccount, NYC_ERRORS, sha256Hex } from '../nyc/contracts.mjs'
import { buildChange, realise, rereadAt, simulateAndRead } from '../change/engine.mjs'
import { readTicketInputs } from '../ticket/inputs.mjs'
import { buildTicket } from '../ticket/engine.mjs'
import { Reader } from '../poll.mjs'
import { normaliseVault } from '../xrpl.mjs'
import { createRemoteSigner, signerFor, PARTIES, SignatureCancelled, SignatureRefused, SignatureTimeout, SIGNATURE_TTL_MS } from './remote-signer.mjs'

const log = logger('roles')

const LABELS = ['harbor-1', 'harbor-2', 'harbor-3', 'desk', 'spare']
const HARBORS = ['harbor-1', 'harbor-2', 'harbor-3']
const LENDERS = ['desk', 'spare']
const HEX48 = /^[A-Fa-f0-9]{48}$/
const HEX64 = /^[A-Fa-f0-9]{64}$/
const UNITS = /^[0-9]{1,30}$/
const MAX_PAGES = 50
/** A rebuilt transaction expires about a minute after it is prepared, as xrpl.js would set it. */
const SUBMIT_WINDOW = 20
/** The borrower-signed LoanSet waits for a human approval: about 30 to 40 minutes. */
const LOANSET_WINDOW = 600
/** Base reserve plus a signer list and an MPToken, paid by the desk for a collateral account it creates. */
const RESERVE_DROPS = '2000000'
/** Any amount does: during the Investment phase every VaultWithdraw is tecTOO_SOON. */
const WITHDRAW_PROBE_DROPS = '1000000'
const BODY_MAX_BYTES = 64 * 1024
/** A requestLoan holds its escrow unless it failed; a declined one keeps it, and its pledge is made again. */
const RELEASED = ['failed']
/** A pledge's collateral account, reserved at preview, is free again for another pledge after this long unconfirmed. */
const RESERVE_TTL_MS = 5 * 60_000
/** The actions a POST may open to browser signing with `signer: 'browser'` (the demo lab). */
const BROWSER_SIGNED = ['pledgeEscrow', 'requestLoan', 'approve', 'rerequest', 'defaultL2', 'impairL1']
/** A browser signature that arrives this close to its LastLedgerSequence is asked again on a rebuilt transaction. */
const LAPSE_MARGIN = 2
/** At most this many signatures for one transaction of a browser-signed action; past it, SIGNATURE_TIMEOUT. */
const MAX_SIGNATURES = 3

const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    Object.assign(this, { status, code, extra })
  }
}
const bad = (message) => new HttpError(400, 'BAD_REQUEST', message)

function loadVaults(dir = 'demo') {
  const vaults = {}
  for (const label of LABELS) {
    try {
      vaults[label] = JSON.parse(readFileSync(join(dir, `${label}.json`), 'utf8'))
    } catch (e) {
      log.warn('baked vault unreadable, its label is not served', { label, err: e.code ?? e.name })
    }
  }
  return vaults
}

const readMandateFile = () => JSON.parse(readFileSync(join('demo', 'mandate-desk-1.json'), 'utf8'))
/** Step 21: the desk's dollar pool, or null on a server where src/demo/bake-usd.mjs has not run. */
const readUsdDeskFile = () => (existsSync(join('demo', 'desk-usd.json')) ? JSON.parse(readFileSync(join('demo', 'desk-usd.json'), 'utf8')) : null)

/**
 * @param {{ reader: any, xrpl: any, env: Record<string, string | undefined>, accounts: Record<string, any>,
 *   vaults?: Record<string, any>, mandate?: () => any, usdDesk?: () => any|null, submit?: Function, simulate?: Function,
 *   signatureTtlMs?: number }} deps
 */
export function createRoleEngine({ reader, xrpl, env, accounts, vaults = loadVaults(), mandate = readMandateFile, usdDesk = readUsdDeskFile, submit, simulate, signatureTtlMs = SIGNATURE_TTL_MS }) {
  const allowedOrigins = new Set((env.ALLOWED_WRITE_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const configured = Boolean(accounts.holder && accounts.borrower && accounts.broker && accounts.deskOwner && Object.keys(vaults).length)

  /** @type {Map<string, { runId: string, operatorTokenHash: string, actions: Map<string, any> }>} */
  const runs = new Map()
  /** actionId -> what the public action does not show: the transaction to rebuild, the signed LoanSet */
  const internals = new Map()
  /** collateral account -> { act, at } of the pledgeEscrow that took it, while that action is previewed or confirming */
  const reserved = new Map()
  const queues = new Map()
  let killed = false
  const stopped = () => killed
  const remote = createRemoteSigner({
    ttlMs: signatureTtlMs,
    onTimeout: (act, requestId) => log.warn('signature request expired', { runId: act.runId, actionId: act.actionId, requestId, ledgerIndex: xrpl.lastLedger ?? null }),
  })
  /** The signer of `role` for `act`: its wallet here, or the page when the action opted in. */
  const signerOfAct = (act, role) => signerFor({ browser: act.signer === 'browser', act, role, wallet: accounts[role], remote })

  submit ??= async (tx, wallet) => {
    if (!xrpl.client.isConnected()) await xrpl.client.connect()
    try {
      const r = await xrpl.client.submitAndWait(typeof tx === 'string' ? tx : wallet.sign(tx).tx_blob)
      return { txHash: r.result.hash, engineResult: r.result.meta?.TransactionResult, ledgerIndex: r.result.ledger_index, meta: r.result.meta }
    } catch (e) {
      return { txHash: null, engineResult: String(e?.data?.engine_result ?? e?.message ?? e).slice(0, 120), ledgerIndex: null }
    }
  }
  simulate ??= async (tx) => (await xrpl.req({ command: 'simulate', tx_json: tx })).result

  /** The account's serial queue: `fn` starts once every earlier entry of that account has settled. */
  function enqueue(address, fn) {
    const next = (queues.get(address) ?? Promise.resolve()).then(() => fn())
    queues.set(address, next.catch(() => {}))
    return next
  }

  /** Autofilled at the validated ledger read now, with an explicit LastLedgerSequence. */
  async function prepare(tx, window = SUBMIT_WINDOW) {
    await xrpl.closeTime()
    return xrpl.client.autofill({ ...tx, LastLedgerSequence: xrpl.lastLedger + window })
  }

  /** A paged read at one ledger: every page or none. Past the cap it answers null, which callers treat as "not usable". */
  async function readAll(payload, key) {
    const out = []
    let marker
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await xrpl.req(marker ? { ...payload, marker } : payload)).result
      out.push(...(r[key] ?? []))
      marker = r.marker
      if (!marker) return out
    }
    log.warn('paged read over the cap, refused', { command: payload.command, account: payload.account, pages: MAX_PAGES })
    return null
  }

  /** Free = conforming in the `free` stage at L, and no pledge EscrowCreate of the borrower ever sent to it. */
  async function isFree(address, shareMptId, L, collateral) {
    let accountRoot
    try {
      accountRoot = (await xrpl.req({ command: 'account_info', account: address, ledger_index: L })).result.account_data
    } catch (e) {
      if (e?.data?.error === 'actNotFound') return false
      throw e
    }
    const objects = await readAll({ command: 'account_objects', account: address, ledger_index: L, limit: 200 }, 'account_objects')
    if (!objects) return false
    const judged = judgeCollateralAccount({
      accountRoot,
      signerList: objects.find((o) => o.LedgerEntryType === 'SignerList') ?? null,
      mptoken: objects.find((o) => o.LedgerEntryType === 'MPToken' && sameId(o.MPTokenIssuanceID, shareMptId)) ?? null,
      escrows: objects.filter((o) => o.LedgerEntryType === 'Escrow' && o.Destination === address),
    }, { borrower: collateral.borrower, desk: collateral.desk, agent: collateral.agent, shareMptId, ...COLLATERAL_STAGES.free })
    if (!judged.conforming) return false
    const txs = await readAll({ command: 'account_tx', account: address, ledger_index_min: -1, ledger_index_max: L, limit: 200 }, 'transactions')
    if (!txs) return false
    return !txs.some((t) => {
      const tx = t.tx_json ?? t.tx
      return tx?.TransactionType === 'EscrowCreate' && t.meta?.TransactionResult === 'tesSUCCESS'
        && tx.Account === collateral.borrower && tx.Destination === address && sameId(tx.Amount?.mpt_issuance_id, shareMptId)
    })
  }

  function release(actionId) {
    for (const [address, holder] of reserved) if (holder.act.actionId === actionId) reserved.delete(address)
  }

  /** The pledge that holds the account, or null; a preview left unconfirmed lets it go after RESERVE_TTL_MS. */
  function holderOf(address) {
    const r = reserved.get(address)
    if (r && r.act.state === 'previewed' && Date.now() - r.at > RESERVE_TTL_MS) reserved.delete(address)
    return reserved.get(address)?.act.actionId ?? null
  }

  /** The first free account of the pool, reserved for this action; null when the pool is exhausted. */
  async function takeFree(pool, shareMptId, act, L, collateral) {
    const mine = (address) => [null, act.actionId].includes(holderOf(address))
    for (const address of pool) {
      if (!mine(address)) continue
      if (!(await isFree(address, shareMptId, L, collateral))) continue
      // Checked again after the reads: a concurrent pledge may have taken it meanwhile.
      if (!mine(address)) continue
      release(act.actionId)
      reserved.set(address, { act, at: Date.now() })
      return address
    }
    return null
  }

  function collateralOf() {
    const collateral = vaults.desk?.collateral
    if (!collateral) throw new HttpError(503, 'NOT_CONFIGURED', 'demo/desk.json carries no collateral pool; writes that pledge are not configured')
    return collateral
  }

  /**
   * The EscrowCreate of a pledge, its dates read at the validated ledger now, to `destination` or else to
   * the first free account of the Harbor's pool. Destination null: none is free.
   */
  async function pledgeTx(act, destination = null) {
    const collateral = collateralOf()
    const plan = vaults.desk.plannedLoan
    const policy = mandate().policy
    const t0 = await xrpl.closeTime()
    const L = xrpl.lastLedger
    const pool = collateral.accounts?.[internals.get(act.actionId).harbor] ?? []
    destination ??= await takeFree(pool, act.ticket.share, act, L, collateral)
    const finishAfter = t0 + plan.paymentInterval + plan.gracePeriod + policy.finishAfterMarginSeconds
    return {
      L,
      tx: {
        TransactionType: 'EscrowCreate', Account: accounts.borrower.address, Destination: destination,
        Amount: { mpt_issuance_id: act.ticket.share, value: act.ticket.units },
        FinishAfter: finishAfter, CancelAfter: finishAfter + policy.cancelAfterOffsetSeconds,
        // step 20: a pledge that cures a margin call names its loan, which is how the positions count it
        ...(act.cureLoanId && { Memos: [{ Memo: { MemoType: hex('orma.cure'), MemoData: act.cureLoanId } }] }),
      },
    }
  }

  const finish = (act, fields) => {
    Object.assign(act, fields) // one assignment: a GET never sees `validated` without what validation produced
    if (act.action === 'pledgeEscrow') release(act.actionId)
    log.info(`action ${act.state}`, { runId: act.runId, actionId: act.actionId, ledgerIndex: act.ledgerIndex ?? null, engineResult: act.engineResult ?? null })
  }
  const locked = (act) => finish(act, { state: 'failed', engineResult: 'LOCKED' })

  /**
   * Rebuild, re-autofill, re-simulate, then submit; anything but tesSUCCESS fails the action, nothing
   * submitted after it. The re-simulation builds the change the action keeps: the confirm's, never the
   * preview's (an object that moved between the two is not a MISMATCH). Once validated, the objects and,
   * for an action with money, the vault are read again at the validation ledger while the action stays
   * `submitted`; then `validated` is published with all of it in one assignment.
   */
  async function submitRebuilt(act, build, wallet, extra = () => ({}), money = null, browser = null) {
    for (let attempt = 1; ; attempt++) {
      if (stopped()) return locked(act)
      const tx = await prepare(await build())
      const { s, change, applied } = await changeOf(tx)
      // The change the action keeps is the confirm's. A simulation without metadata applied nothing: no row to realise.
      if (applied) act.change = change
      else log.warn('confirm simulated without metadata: the action keeps no change', { runId: act.runId, actionId: act.actionId, ledgerIndex: s.ledgerIndex, engineResult: s.simulated?.engine_result ?? null })
      if (money) act.preview = { ...act.preview, money: { ...act.preview?.money, predicted: await money.at(atOf(s)) } }
      if (s.simulated?.engine_result !== 'tesSUCCESS') return finish(act, { state: 'failed', engineResult: s.simulated?.engine_result ?? 'not simulated' })
      if (stopped()) return locked(act)
      const more = extra(tx) // from the transaction alone, before it is sent: nothing after validation can fail it
      let blob = null
      if (browser) {
        // the demo lab: the page signs the transaction built and simulated above, verified before it is used
        const signed = await signedByPage(act, browser, tx)
        if (!signed) return
        if (stopped()) return locked(act)
        if (await lapsed(act, tx, attempt)) {
          if (attempt < MAX_SIGNATURES) continue // rebuilt, re-simulated, and a new signature asked
          return finish(act, { state: 'failed', engineResult: 'SIGNATURE_TIMEOUT' })
        }
        blob = signed.tx_blob
      }
      act.state = 'submitted'
      const r = blob ? await submit(blob, null) : await submit(tx, wallet)
      const outcome = { txHash: r.txHash, engineResult: r.engineResult, ledgerIndex: r.ledgerIndex }
      if (r.engineResult !== 'tesSUCCESS') return finish(act, { state: 'failed', ...outcome })
      return finish(act, { state: 'validated', ...outcome, ...more, ...(await afterValidation(act, r, applied ? change : null, money)) })
    }
  }

  /**
   * One signature of the page for `tx`, or null once the action is finished: SIGNATURE_TIMEOUT when no
   * signature arrived by its expiresAt, LOCKED when the kill switch closed the request.
   */
  async function signedByPage(act, browser, tx) {
    try {
      return await browser.sign(tx, purposeOf(act, tx))
    } catch (e) {
      if (e instanceof SignatureTimeout) {
        finish(act, { state: 'failed', engineResult: 'SIGNATURE_TIMEOUT' })
        return null
      }
      if (e instanceof SignatureCancelled) {
        locked(act)
        return null
      }
      throw e
    }
  }

  /** Whether a transaction the page signed can no longer be included: its LastLedgerSequence is (nearly) past. */
  async function lapsed(act, tx, attempt) {
    await xrpl.closeTime()
    const late = xrpl.lastLedger + LAPSE_MARGIN >= tx.LastLedgerSequence
    if (late) log.warn('browser signature arrived past the window of its transaction', { runId: act.runId, actionId: act.actionId, ledgerIndex: xrpl.lastLedger, lastLedgerSequence: tx.LastLedgerSequence, attempt, asksAgain: attempt < MAX_SIGNATURES })
    return late
  }

  /** The one sentence the page shows above a signature: who signs what, for whom. */
  function purposeOf(act, tx) {
    const vault = vaults[act.vault]
    if (tx.TransactionType === 'EscrowCreate') {
      return `${PARTIES.borrower} pledges ${tx.Amount?.value} share units of ${internals.get(act.actionId)?.harbor ?? 'a Harbor vault'} into escrow toward collateral account ${tx.Destination}.`
    }
    if (tx.TransactionType === 'Payment') {
      return `${PARTIES.deskOwner} pays ${tx.Amount} drops to fund the reserve of the new collateral account ${tx.Destination} for this pledge.`
    }
    if (tx.TransactionType === 'LoanManage') {
      const key = sameId(tx.LoanID, vault?.loans?.L1) ? 'L1' : sameId(tx.LoanID, vault?.loans?.L2) ? 'L2' : 'the loan'
      return tx.Flags === FLAG.DEFAULT
        ? `${PARTIES.broker} defaults loan ${key} (${tx.LoanID}) of ${act.vault}; a default cannot be undone.`
        : `${PARTIES.broker} impairs loan ${key} (${tx.LoanID}) of ${act.vault}.`
    }
    if (tx.TransactionType === 'LoanSet') {
      const amount = act.asset === 'USD' ? `${tx.PrincipalRequested} test dollars` : `${tx.PrincipalRequested} drops of XRP`
      return `${PARTIES.borrower} signs a request to borrow ${amount} from ${PARTIES.deskOwner}, backed by escrow ${act.escrow?.index ?? 'of its pledge'}.`
    }
    return `${PARTIES[act.role] ?? act.role} signs a ${tx.TransactionType} of ${tx.Account}.`
  }

  /**
   * What validation produced, read again at the validation ledger while the action stays `submitted`:
   * the vault first (money.realised), then the change's objects (change.realised). A read that fails
   * leaves change.realised absent and gives money.realised.error, never an absent realised.
   */
  async function afterValidation(act, r, change, money) {
    const ids = { runId: act.runId, actionId: act.actionId, ledgerIndex: r.ledgerIndex }
    const out = {}
    let at
    try {
      at = await ledgerAt(r.ledgerIndex)
    } catch (e) {
      const why = `ledger ${r.ledgerIndex} could not be read: ${String(e?.message ?? e).slice(0, 120)}`
      log.warn('nothing read again after validation', { ...ids, err: why })
      if (money) out.preview = { ...act.preview, money: { ...act.preview?.money, realised: { error: `The ${why}.` } } }
      return out
    }
    let vaultRead = true
    if (money) {
      const realised = await realisedMoney(act.preview?.money?.predicted, at, money)
      vaultRead = !realised.error
      out.preview = { ...act.preview, money: { ...act.preview?.money, realised } }
    }
    if (change && vaultRead) {
      try {
        out.change = realise(change, { txHash: r.txHash, ledgerIndex: at.ledgerIndex, ledgerHash: at.ledgerHash, objects: await rereadAt(xrpl, change, at.ledgerIndex) })
      } catch (e) {
        log.warn('change not realised: the objects could not be read again', { ...ids, err: String(e?.message ?? e).slice(0, 200) })
      }
    } else if (change) {
      log.warn('change not realised: the vault could not be read again at the validation ledger', ids)
    }
    return out
  }

  /** The validated ledger a transaction landed in: its hash and close_time, for the reads after validation. */
  async function ledgerAt(ledgerIndex) {
    if (!Number.isSafeInteger(ledgerIndex)) throw new Error('the submission returned no validation ledger')
    const r = (await xrpl.req({ command: 'ledger', ledger_index: ledgerIndex })).result
    const closeTime = r.ledger?.close_time
    if (!Number.isSafeInteger(closeTime)) throw new Error(`ledger ${ledgerIndex} came back without its close_time`)
    return { ledgerIndex, ledgerHash: r.ledger_hash ?? r.ledger?.ledger_hash ?? null, closeTime }
  }

  const atOf = (s) => ({ ledgerIndex: s.ledgerIndex, ledgerHash: s.ledgerHash, closeTime: s.closeTime })

  /** { predicted, realised, verdict }: the withdrawal value per share read again at the validation ledger, by the same code. */
  async function realisedMoney(predicted, at, money) {
    if (typeof predicted !== 'string') return { error: `The prediction at confirm could not be computed: ${predicted?.error ?? 'none was made.'}` }
    try {
      const realised = await money.realised(at)
      return { predicted, realised, verdict: realised === predicted ? 'MATCH' : 'MISMATCH' }
    } catch (e) {
      return { error: `The vault could not be read again at ledger ${at.ledgerIndex}: ${String(e?.message ?? e).slice(0, 160)}` }
    }
  }

  /** The withdrawal value per share of a vault's share at one ledger (Reader.nav, toFixed(6)). */
  async function heldPerUnit(vault, at) {
    const inputs = await readTicketInputs(xrpl, { shareMptId: vault.shareMptId, reader, at, history: false })
    return Reader.nav(normaliseVault(inputs.vault.raw, inputs.closeTime)).navCorrect
  }

  /**
   * The money of a default of L2 on a Harbor, at one ledger: the planned loan's units of its share,
   * priced by buildTicket (four decimal strings, never Figures), or { error } when it cannot be.
   */
  async function defaultMoney(vault, at) {
    try {
      const plan = vaults.desk?.plannedLoan
      if (!plan?.units) throw new Error('demo/desk.json carries no plannedLoan.units')
      const inputs = await readTicketInputs(xrpl, { shareMptId: vault.shareMptId, reader, at, history: false })
      const ticket = buildTicket(inputs, { op: 'pledge', units: plan.units, mandate: mandate(), principalDrops: plan.principalDrops })
      const n2 = ticket.figures.n2.find((e) => sameId(e.loanId, vault.loans?.L2))
      if (!n2) throw new Error(`L2 of ${vault.label} is not a late loan at ledger ${inputs.ledgerIndex}, so it has no default to price.`)
      return {
        heldPerUnitNow: Reader.nav(normaliseVault(inputs.vault.raw, inputs.closeTime)).navCorrect,
        heldPerUnitIfDefault: n2.heldPerUnitIfDefault.value,
        lossAfterCover: n2.lossAfterCover.value,
        cover: n2.cover.value,
      }
    } catch (e) {
      // a sentence alone: the desk prints it after its own "could not be computed"
      log.warn('defaultL2 money not computed', { vault: vault.label, ledgerIndex: at?.ledgerIndex ?? null, err: String(e?.message ?? e).slice(0, 160) })
      return { error: String(e?.message ?? e).slice(0, 200) }
    }
  }

  /** One setup transaction of a collateral account created at confirm: true when it validated. */
  async function setupStep(act, tx, wallet, browser = null) {
    for (let attempt = 1; ; attempt++) {
      if (stopped()) {
        locked(act)
        return false
      }
      let r
      if (browser) {
        // the demo lab: the page signs; a signature past the window asks again on a rebuilt transaction
        const prepared = await prepare(tx)
        const signed = await signedByPage(act, browser, prepared)
        if (!signed) return false
        if (stopped()) {
          locked(act)
          return false
        }
        if (await lapsed(act, prepared, attempt)) {
          if (attempt < MAX_SIGNATURES) continue
          finish(act, { state: 'failed', engineResult: 'SIGNATURE_TIMEOUT' })
          return false
        }
        r = await submit(signed.tx_blob, null)
      } else {
        r = await submit(await prepare(tx), wallet)
      }
      if (r.engineResult === 'tesSUCCESS') return true
      finish(act, { state: 'failed', txHash: r.txHash, engineResult: r.engineResult, ledgerIndex: r.ledgerIndex })
      return false
    }
  }

  /**
   * The pledge's confirm. A free account is chosen again at the ledger now; when the pool is exhausted the
   * desk creates one: its Payment through the desk owner's queue, then the account's own setup and the
   * borrower's EscrowCreate through the borrower's queue (the desk pays the account's reserve, the
   * borrower its escrow's).
   */
  async function confirmPledge(act) {
    const borrower = accounts.borrower
    // the demo lab: the borrower's escrow and the desk owner's reserve payment are signed by the page
    const browser = act.signer === 'browser'
    const byBorrower = browser ? signerOfAct(act, 'borrower') : null
    const escrowOf = (tx) => {
      const index = hashes.hashEscrow(tx.Account, tx.Sequence)
      return { escrow: { owner: tx.Account, offerSequence: tx.Sequence, index, destination: tx.Destination } }
    }
    if ((await pledgeTx(act)).tx.Destination) {
      return enqueue(borrower.address, () => submitRebuilt(act, async () => {
        const { tx } = await pledgeTx(act)
        if (!tx.Destination) throw new Error('no free collateral account is left in the pool')
        return tx
      }, borrower, escrowOf, null, byBorrower))
    }
    const collateral = collateralOf()
    const created = Wallet.generate() // its seed is kept nowhere: the account is governed by its signer list
    const funded = await enqueue(accounts.deskOwner.address, () =>
      setupStep(act, { TransactionType: 'Payment', Account: accounts.deskOwner.address, Destination: created.address, Amount: RESERVE_DROPS }, accounts.deskOwner, browser ? signerOfAct(act, 'deskOwner') : null))
    if (!funded) return
    const ready = await enqueue(borrower.address, async () => {
      const signers = [collateral.borrower, collateral.desk, collateral.agent]
      return await setupStep(act, {
        TransactionType: 'SignerListSet', Account: created.address, SignerQuorum: COLLATERAL_POLICY.quorum,
        SignerEntries: signers.map((a) => ({ SignerEntry: { Account: a, SignerWeight: COLLATERAL_POLICY.weight } })),
      }, created)
        && await setupStep(act, { TransactionType: 'MPTokenAuthorize', Account: created.address, MPTokenIssuanceID: act.ticket.share }, created)
        && await setupStep(act, { TransactionType: 'AccountSet', Account: created.address, SetFlag: 4 }, created)
    })
    if (!ready) return
    return enqueue(borrower.address, () => submitRebuilt(act, async () => (await pledgeTx(act, created.address)).tx, borrower, escrowOf, null, byBorrower))
  }

  /**
   * L fixed, simulated, the touched objects read again at L, then orma.change/1. A simulate response
   * without metadata (nothing applied: a tem, tef, tel or ter result) gives a document with no row;
   * `applied` says whether there was metadata to build rows from.
   */
  async function changeOf(tx) {
    const s = await simulateAndRead(xrpl, tx, { simulate })
    const change = buildChange({ txJson: tx, before: s.before, simulated: s.simulated ?? {}, ledgerIndex: s.ledgerIndex, ledgerHash: s.ledgerHash })
    return { s, change, applied: Boolean(s.simulated?.meta) }
  }

  /** The preview of a simulated transaction: its orma.change/1. */
  const simulated = async (tx) => (await changeOf(tx)).change

  const loanManage = (flag, key) => ({
    async preview({ vault }) {
      const loanId = vault.loans?.[key]
      if (!loanId) throw bad(`The vault ${vault.label} has no loan ${key}`)
      const tx = { TransactionType: 'LoanManage', Account: accounts.broker.address, LoanID: loanId, Flags: flag }
      if (key !== 'L2') return { tx, preview: await simulated(tx) }
      // defaultL2: what the default does to the money, at the preview's L, beside the change.
      const c = await changeOf(tx)
      return { tx, preview: { ...c.change, money: await defaultMoney(vault, atOf(c.s)) } }
    },
    ...(key === 'L2' && {
      money: (vault) => ({
        // the prediction at the confirm's L: a decimal string, or { error }
        at: async (at) => {
          const m = await defaultMoney(vault, at)
          return m.heldPerUnitIfDefault ?? m
        },
        realised: (at) => heldPerUnit(vault, at),
      }),
    }),
  })

  /** role -> action -> handler. A handler's preview never signs for the desk nor submits. */
  const handlers = {
    holder: {
      simulateWithdraw: {
        previewOnly: true,
        async preview({ vault }) {
          const tx = { TransactionType: 'VaultWithdraw', Account: accounts.holder.address, VaultID: vault.vaultId, Amount: WITHDRAW_PROBE_DROPS }
          return { tx, preview: await simulated(tx) }
        },
      },
    },
    borrower: {
      pledgeEscrow: {
        async preview({ action: act, body }) {
          const harbor = HARBORS.find((l) => sameId(vaults[l]?.shareMptId, body.share))
          if (!harbor) throw bad('The pledged share is not the share of a Harbor vault')
          internals.set(act.actionId, { harbor })
          act.ticket = pick(body)
          if (body.cureLoanId) act.cureLoanId = body.cureLoanId.toUpperCase()
          const { tx } = await pledgeTx(act)
          if (!tx.Destination) {
            return { tx, preview: { engineResult: 'not-simulated (collateral account created at confirm)', provenance: 'DECLARED', money: { reserveDrops: RESERVE_DROPS, payer: 'deskOwner' } } }
          }
          return { tx, preview: await simulated(tx) }
        },
        confirmBuiltIn: confirmPledge,
      },
      requestLoan: {
        async preview({ run, action: act, body, vault }) {
          // step 21: asset USD lends the test dollar from the desk's dollar pool, against the same pledge
          const usd = body.asset === 'USD'
          const pool = usd ? usdDesk() : null
          if (usd && !pool?.plannedLoan?.principalUsd) throw new HttpError(503, 'NOT_CONFIGURED', 'The desk lends no test dollar on this server: demo/desk-usd.json is missing.')
          if (usd && pool.owner !== vault.owner) throw new HttpError(503, 'NOT_CONFIGURED', 'The dollar pool of demo/desk-usd.json is not owned by the desk.')
          const plan = usd ? pool.plannedLoan : vaults.desk?.plannedLoan
          if (body.units !== plan?.units) throw bad(`units must be the planned loan's ${plan?.units}; nothing was signed`)
          const pledge = run.actions.get(body.pledgeActionId)
          if (!pledge || pledge.action !== 'pledgeEscrow' || pledge.state !== 'validated') {
            throw new HttpError(404, 'NOT_FOUND', 'pledgeActionId names no validated pledgeEscrow of this run')
          }
          if (pledge.vault !== body.vault || !sameId(pledge.ticket.share, body.share) || pledge.ticket.units !== body.units) {
            throw bad('vault, share and units must be those of the pledgeEscrow it names; nothing was signed')
          }
          // Reserved before any await: a concurrent request on the same escrow sees this one.
          const rival = [...run.actions.values()].find((a) => a.action === 'requestLoan' && a.pledgeActionId === body.pledgeActionId && !RELEASED.includes(a.state))
          if (rival) {
            // a declined request keeps its escrow and cannot be signed again: only a new pledge can back a new request
            const next = rival.state === 'refused' ? 'That request was declined: pledge again to request a new loan.' : 'Use Re-request with a fresh ticket.'
            throw new HttpError(409, 'ESCROW_POLICY', `The pledged escrow is already named by another loan request. Nothing was signed. ${next}`, { requestActionId: rival.actionId })
          }
          act.pledgeActionId = body.pledgeActionId
          act.ticket = pick(body)
          act.escrow = pledge.escrow
          if (usd) act.asset = 'USD'
          const borrower = accounts.borrower
          const browser = act.signer === 'browser'
          const signed = await enqueue(borrower.address, async () => {
            await xrpl.closeTime()
            const tx = await xrpl.client.autofill({
              TransactionType: 'LoanSet', Account: borrower.address, LoanBrokerID: usd ? pool.loanBrokerId : vault.loanBrokerId, Counterparty: vault.owner,
              PrincipalRequested: usd ? plan.principalUsd : plan.principalDrops, PaymentInterval: plan.paymentInterval, GracePeriod: plan.gracePeriod, PaymentTotal: 1,
              LastLedgerSequence: xrpl.lastLedger + LOANSET_WINDOW,
              Memos: [
                { Memo: { MemoType: hex('orma.ticket'), MemoData: body.ticketId.toUpperCase() } },
                { Memo: { MemoType: hex('orma.escrow'), MemoData: pledge.escrow.index } },
              ],
            })
            tx.Fee = num(tx.Fee).times(2).toFixed(0) // two signatures on one transaction
            // the demo lab: the page signs it after this queue entry, as the LoanSet waits for its approval unsent
            return browser ? { tx } : { tx, ...borrower.sign(tx) }
          })
          if (browser) {
            // the POST answers now, awaiting-signature; the request is pending-approval once its blob is verified
            signerOfAct(act, 'borrower').sign(signed.tx, purposeOf(act, signed.tx), {
              onSigned: (sig) => {
                internals.set(act.actionId, { ...internals.get(act.actionId), loanSet: { tx: signed.tx, ...sig } })
                act.state = 'pending-approval'
                log.info('loan request signed in the browser', { runId: act.runId, actionId: act.actionId, ledgerIndex: xrpl.lastLedger ?? null })
              },
            }).catch((e) => finish(act, {
              state: 'failed',
              engineResult: e instanceof SignatureTimeout ? 'SIGNATURE_TIMEOUT' : e instanceof SignatureCancelled ? 'LOCKED' : String(e?.message ?? e).slice(0, 120),
            }))
          } else {
            internals.set(act.actionId, { loanSet: signed })
            act.state = 'pending-approval'
          }
          return {
            preview: {
              engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED',
              money: usd
                ? { asset: 'USD', loanAsset: pool.asset, principalUsd: signed.tx.PrincipalRequested, escrowIndex: pledge.escrow.index, lastLedgerSequence: signed.tx.LastLedgerSequence }
                : { principalDrops: signed.tx.PrincipalRequested, escrowIndex: pledge.escrow.index, lastLedgerSequence: signed.tx.LastLedgerSequence },
            },
          }
        },
      },
    },
    broker: {
      impairL1: loanManage(FLAG.IMPAIR, 'L1'),
      wait: { async preview() { return { preview: { engineResult: 'not-simulated (no transaction)', provenance: 'DECLARED' } } } },
      defaultL2: loanManage(FLAG.DEFAULT, 'L2'),
    },
  }

  const pick = (b) => ({ share: b.share.toUpperCase(), ticketId: b.ticketId, inputsDigest: b.inputsDigest, units: b.units })

  /** The request contract of §5: 400 for a body outside it, before anything is previewed. */
  function checkBody(run, action, body) {
    if (!LABELS.includes(body.vault) || !vaults[body.vault]) throw bad('vault must be one of harbor-1, harbor-2, harbor-3, desk, spare')
    const ticketed = ['pledgeEscrow', 'requestLoan'].includes(action)
    if (ticketed && !LENDERS.includes(body.vault)) throw bad('vault must be the lending vault, desk or spare')
    if (ticketed && !HEX48.test(body.share ?? '')) throw bad('share must be 48 hex characters')
    if (ticketed && !(HEX64.test(body.ticketId ?? '') && HEX64.test(body.inputsDigest ?? ''))) throw bad('ticketId and inputsDigest must be 64 hex characters')
    if (ticketed && !UNITS.test(body.units ?? '')) throw bad('units must be 1 to 30 digits')
    if (action === 'requestLoan' && typeof body.pledgeActionId !== 'string') throw bad('pledgeActionId is required')
    // step 20: the one optional parameter of pledgeEscrow, the loan a cure pledge names
    if ('cureLoanId' in body && (action !== 'pledgeEscrow' || !HEX64.test(body.cureLoanId ?? ''))) throw bad('cureLoanId is the 64-hex id of a desk loan, on pledgeEscrow only')
    // step 21: the one optional parameter of requestLoan, the loan's currency
    if ('asset' in body && (action !== 'requestLoan' || !['XRP', 'USD'].includes(body.asset))) throw bad('asset is XRP or USD, on requestLoan only')
    if (body.asset === 'USD' && body.vault !== 'desk') throw bad('a loan in the test dollar is lent by the vault desk')
    // the demo lab: the one optional parameter that moves an action's signatures to the page
    if ('signer' in body && (body.signer !== 'browser' || !BROWSER_SIGNED.includes(action))) throw bad(`signer is 'browser', on ${BROWSER_SIGNED.join(', ')} only`)
    if (['approve', 'decline', 'rerequest'].includes(action)) {
      if (typeof body.requestActionId !== 'string') throw bad('requestActionId is required')
      const request = run.actions.get(body.requestActionId)
      if (!request || request.action !== 'requestLoan' || request.state !== 'pending-approval') {
        throw new HttpError(404, 'NOT_FOUND', 'requestActionId names no requestLoan of this run awaiting approval')
      }
    }
  }

  function newRun() {
    const runId = randomBytes(16).toString('hex')
    const token = randomBytes(16).toString('hex')
    runs.set(runId, { runId, operatorTokenHash: sha256Hex(token), actions: new Map() })
    log.info('run created', { runId })
    return { runId, token }
  }
  function kill() {
    killed = true
    remote.cancelAll() // an action awaiting a browser signature fails LOCKED, nothing signed
    log.warn('kill switch on: every write refused, queued entries fail')
  }
  function unkill() {
    killed = false
    log.info('kill switch off')
  }

  function tokenOk(req, run) {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')
    if (!m || !run) return false
    const got = Buffer.from(sha256Hex(m[1]), 'hex')
    return timingSafeEqual(got, Buffer.from(run.operatorTokenHash, 'hex'))
  }

  async function postAction(req, run, role, name, helpers) {
    const handler = Object.hasOwn(handlers, role) && Object.hasOwn(handlers[role], name) ? handlers[role][name] : null
    if (!handler) throw new HttpError(404, 'NOT_FOUND', `No action ${role}/${name}`)
    const body = await readJson(req)
    checkBody(run, name, body)
    const act = {
      actionId: randomBytes(16).toString('hex'), runId: run.runId, role, action: name, vault: body.vault,
      account: accounts[role]?.address ?? null, state: 'previewing', preview: null, change: null,
    }
    if (body.requestActionId) act.requestActionId = body.requestActionId
    if (body.signer === 'browser') act.signer = 'browser'
    run.actions.set(act.actionId, act)
    try {
      const out = await handler.preview({ run, body, vault: vaults[body.vault], enqueue, submit, stopped, action: act, signerFor: signerOfAct })
      internals.set(act.actionId, { ...internals.get(act.actionId), tx: out.tx })
      act.preview = out.preview
      if (act.state === 'previewing') act.state = 'previewed'
    } catch (e) {
      run.actions.delete(act.actionId)
      internals.delete(act.actionId)
      release(act.actionId)
      throw e
    }
    log.info('action previewed', { runId: run.runId, actionId: act.actionId, role, action: name, ledgerIndex: xrpl.lastLedger ?? null })
    if (act.signer === 'browser') {
      // the demo lab: the state too, and the signature asked when the POST already needs one (requestLoan)
      return helpers.send(202, helpers.stamp({ actionId: act.actionId, preview: act.preview, state: act.state, ...(act.toSign && { toSign: act.toSign }) }))
    }
    helpers.send(202, helpers.stamp({ actionId: act.actionId, preview: act.preview }))
  }

  async function confirmAction(run, act, helpers) {
    const handler = handlers[act.role][act.action]
    if (handler.confirm) {
      const out = await handler.confirm({ run, action: act, enqueue, submit, stopped, signerFor: signerOfAct })
      if (out?.code === 'LOCKED') throw new HttpError(423, 'LOCKED', 'The kill switch is on; nothing was signed')
      if (out?.code) {
        act.state = 'refused'
        throw new HttpError(409, out.code, out.message ?? out.code, out.breaches ? { breaches: out.breaches } : {})
      }
      return helpers.send(202, helpers.stamp(act))
    }
    const { tx } = internals.get(act.actionId) ?? {}
    if (act.state === 'previewed' && tx && !handler.previewOnly) {
      act.state = 'queued'
      log.info('action queued', { runId: run.runId, actionId: act.actionId, ledgerIndex: xrpl.lastLedger ?? null })
      const done = handler.confirmBuiltIn
        ? handler.confirmBuiltIn(act)
        : enqueue(act.account, () => submitRebuilt(act, async () => tx, accounts[act.role], undefined, handler.money?.(vaults[act.vault]) ?? null, act.signer === 'browser' ? signerOfAct(act, act.role) : null))
      done.catch((e) => {
        finish(act, { state: 'failed', engineResult: String(e?.message ?? e).slice(0, 120) })
        log.error('submission threw', { runId: run.runId, actionId: act.actionId, err: String(e).slice(0, 200) })
      })
    }
    helpers.send(202, helpers.stamp(act))
  }

  /**
   * The demo lab: a blob the page signed for the action's open request, verified (src/roles/remote-signer.mjs)
   * and handed to the work that waits for it; 202 with the action. A blob that is not the transaction asked,
   * by its account, is 400 SIGNATURE_MISMATCH and the request stays open.
   */
  async function acceptSignature(req, run, actionId, helpers) {
    const act = run.actions.get(actionId)
    if (!act) throw new HttpError(404, 'NOT_FOUND', 'No such action in this run')
    const body = await readJson(req)
    const requestId = act.toSign?.requestId ?? null
    try {
      remote.accept(act, body)
    } catch (e) {
      if (!(e instanceof SignatureRefused)) throw e
      log.warn('browser signature refused', { runId: run.runId, actionId, requestId, code: e.code, ledgerIndex: xrpl.lastLedger ?? null })
      throw new HttpError(e.status, e.code, e.message)
    }
    log.info('browser signature accepted', { runId: run.runId, actionId, requestId, ledgerIndex: xrpl.lastLedger ?? null })
    helpers.send(202, helpers.stamp(act))
  }

  /** The routes of /api/roles/*, with the write policy of §5 in its order. */
  async function handle(req, res, url, helpers) {
    if (!url.pathname.startsWith('/api/roles/')) return false
    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    const read = /^\/api\/roles\/([^/]+)\/actions\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' || req.method === 'HEAD') {
      const act = read && runs.get(read[1])?.actions.get(read[2])
      if (!act) helpers.fail(404, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`, false)
      else helpers.send(200, helpers.stamp(act))
      return true
    }
    if (req.method === 'OPTIONS') {
      if (origin && allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type')
      } else {
        res.removeHeader('Access-Control-Allow-Origin')
      }
      res.writeHead(204).end()
      return true
    }
    try {
      if (req.method !== 'POST') throw new HttpError(404, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`)
      if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'FORBIDDEN', 'This origin may not write')
      const a = req.socket.remoteAddress ?? ''
      if (!origin && !(a.includes('127.0.0.1') || a === '::1')) throw new HttpError(403, 'FORBIDDEN', 'A request without Origin must come from loopback')
      if (!configured) throw new HttpError(503, 'NOT_CONFIGURED', 'Writes are not configured on this server: ROLES_FILE, DESK_SEED and the baked demo/ files are required')
      const confirm = /^\/api\/roles\/([^/]+)\/actions\/([^/]+)\/confirm$/.exec(url.pathname)
      const signature = /^\/api\/roles\/([^/]+)\/actions\/([^/]+)\/signature$/.exec(url.pathname)
      const post = /^\/api\/roles\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
      const run = runs.get((confirm ?? signature ?? post)?.[1])
      if (!tokenOk(req, run)) throw new HttpError(401, 'UNAUTHORIZED', 'A valid operator token for this run is required')
      if (stopped()) throw new HttpError(423, 'LOCKED', 'The kill switch is on; nothing was signed')
      if (confirm) {
        const act = run.actions.get(confirm[2])
        if (!act) throw new HttpError(404, 'NOT_FOUND', 'No such action in this run')
        await confirmAction(run, act, helpers)
      } else if (signature) {
        await acceptSignature(req, run, signature[2], helpers)
      } else if (post) {
        await postAction(req, run, post[2], post[3], helpers)
      } else {
        throw new HttpError(404, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`)
      }
    } catch (e) {
      if (!(e instanceof HttpError)) throw e
      // the contract's table first (423 LOCKED is not retryable), as DeskError reads it
      helpers.send(e.status, { error: { code: e.code, message: e.message, retryable: NYC_ERRORS[e.code]?.retryable ?? e.status === 503, ...e.extra } })
    }
    return true
  }

  return {
    handle,
    register(role, action, handler) {
      handlers[role] ??= {}
      handlers[role][action] = handler
    },
    newRun,
    kill,
    unkill,
    action: (runId, actionId) => runs.get(runId)?.actions.get(actionId) ?? null,
    /** The signed LoanSet a requestLoan keeps for the desk's countersignature (step 10). */
    loanSetOf: (actionId) => internals.get(actionId)?.loanSet ?? null,
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = ''
    let bytes = 0
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > BODY_MAX_BYTES) {
        req.removeAllListeners('data')
        req.pause()
        reject(bad('The body is over 64 KB'))
        return
      }
      s += c
    })
    req.on('end', () => {
      try {
        const v = s ? JSON.parse(s) : {}
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
      } catch {
        reject(bad('The body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}
