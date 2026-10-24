/**
 * The browser's only write surface: named role actions, previewed by `simulate`, confirmed, then
 * submitted through one serial queue per signing account. Every submission of the API goes through
 * `enqueue`: two submissions from one account in parallel steal each other's Sequence.
 *
 *   POST /api/roles/{runId}/{role}/{action}             -> 202 { actionId, preview }, nothing submitted
 *   POST /api/roles/{runId}/actions/{actionId}/confirm  -> 202, the action queued on its account
 *   GET  /api/roles/{runId}/actions/{actionId}          -> the action, public (no Origin, token or kill check)
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Wallet, hashes } from 'xrpl'
import { num } from '../num.mjs'
import { FLAG } from '../history.mjs'
import { logger } from '../log.mjs'
import { COLLATERAL_POLICY, COLLATERAL_STAGES, judgeCollateralAccount } from '../nyc/contracts.mjs'

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
/** A requestLoan holds its escrow unless it failed; a refused one is replayed by rerequest. */
const RELEASED = ['failed']

const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
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

/**
 * @param {{ reader: any, xrpl: any, env: Record<string, string | undefined>, accounts: Record<string, any>,
 *   vaults?: Record<string, any>, mandate?: () => any, submit?: Function, simulate?: Function }} deps
 */
export function createRoleEngine({ reader, xrpl, env, accounts, vaults = loadVaults(), mandate = readMandateFile, submit, simulate }) {
  const allowedOrigins = new Set((env.ALLOWED_WRITE_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const configured = Boolean(accounts.holder && accounts.borrower && accounts.broker && accounts.deskOwner && Object.keys(vaults).length)

  /** @type {Map<string, { runId: string, operatorTokenHash: string, killed: boolean, actions: Map<string, any> }>} */
  const runs = new Map()
  /** actionId -> what the public action does not show: the transaction to rebuild, the signed LoanSet */
  const internals = new Map()
  /** collateral account -> the pledgeEscrow that took it, while that action is previewed or confirming */
  const reserved = new Map()
  const queues = new Map()
  let killed = false
  const stopped = () => killed

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
    for (const [address, holder] of reserved) if (holder === actionId) reserved.delete(address)
  }

  /** The first free account of the pool, reserved for this action; null when the pool is exhausted. */
  async function takeFree(pool, shareMptId, actionId, L, collateral) {
    for (const address of pool) {
      if (reserved.has(address) && reserved.get(address) !== actionId) continue
      if (!(await isFree(address, shareMptId, L, collateral))) continue
      // Checked again after the reads: a concurrent pledge may have taken it meanwhile.
      if (reserved.has(address) && reserved.get(address) !== actionId) continue
      release(actionId)
      reserved.set(address, actionId)
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
    destination ??= await takeFree(pool, act.ticket.share, act.actionId, L, collateral)
    const finishAfter = t0 + plan.paymentInterval + plan.gracePeriod + policy.finishAfterMarginSeconds
    return {
      L,
      tx: {
        TransactionType: 'EscrowCreate', Account: accounts.borrower.address, Destination: destination,
        Amount: { mpt_issuance_id: act.ticket.share, value: act.ticket.units },
        FinishAfter: finishAfter, CancelAfter: finishAfter + policy.cancelAfterOffsetSeconds,
      },
    }
  }

  const finish = (act, fields) => {
    Object.assign(act, fields) // one assignment: a GET never sees `validated` without what validation produced
    if (act.action === 'pledgeEscrow') release(act.actionId)
    log.info(`action ${act.state}`, { runId: act.runId, actionId: act.actionId, ledgerIndex: act.ledgerIndex ?? null, engineResult: act.engineResult ?? null })
  }
  const locked = (act) => finish(act, { state: 'failed', engineResult: 'LOCKED' })

  /** Rebuild, re-autofill, re-simulate, then submit; anything but tesSUCCESS fails the action, nothing submitted after it. */
  async function submitRebuilt(act, build, wallet, extra = () => ({})) {
    if (stopped()) return locked(act)
    const tx = await prepare(await build())
    const sim = await simulate(tx)
    if (sim?.engine_result !== 'tesSUCCESS') return finish(act, { state: 'failed', engineResult: sim?.engine_result ?? 'not simulated' })
    if (stopped()) return locked(act)
    act.state = 'submitted'
    const r = await submit(tx, wallet)
    const outcome = { txHash: r.txHash, engineResult: r.engineResult, ledgerIndex: r.ledgerIndex }
    return finish(act, r.engineResult === 'tesSUCCESS' ? { state: 'validated', ...outcome, ...extra(tx) } : { state: 'failed', ...outcome })
  }

  /** One setup transaction of a collateral account created at confirm: true when it validated. */
  async function setupStep(act, tx, wallet) {
    if (stopped()) {
      locked(act)
      return false
    }
    const r = await submit(await prepare(tx), wallet)
    if (r.engineResult === 'tesSUCCESS') return true
    finish(act, { state: 'failed', txHash: r.txHash, engineResult: r.engineResult, ledgerIndex: r.ledgerIndex })
    return false
  }

  /**
   * The pledge's confirm. A free account is chosen again at the ledger now; when the pool is exhausted the
   * desk creates one: its Payment through the desk owner's queue, then the account's own setup and the
   * borrower's EscrowCreate through the borrower's queue (the desk pays the account's reserve, the
   * borrower its escrow's).
   */
  async function confirmPledge(act) {
    const borrower = accounts.borrower
    const escrowOf = (tx) => {
      const index = hashes.hashEscrow(tx.Account, tx.Sequence)
      return { escrow: { owner: tx.Account, offerSequence: tx.Sequence, index, destination: tx.Destination } }
    }
    if ((await pledgeTx(act)).tx.Destination) {
      return enqueue(borrower.address, () => submitRebuilt(act, async () => {
        const { tx } = await pledgeTx(act)
        if (!tx.Destination) throw new Error('no free collateral account is left in the pool')
        return tx
      }, borrower, escrowOf))
    }
    const collateral = collateralOf()
    const created = Wallet.generate() // its seed is kept nowhere: the account is governed by its signer list
    const funded = await enqueue(accounts.deskOwner.address, () =>
      setupStep(act, { TransactionType: 'Payment', Account: accounts.deskOwner.address, Destination: created.address, Amount: RESERVE_DROPS }, accounts.deskOwner))
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
    return enqueue(borrower.address, () => submitRebuilt(act, async () => (await pledgeTx(act, created.address)).tx, borrower, escrowOf))
  }

  const simulated = async (tx) => {
    const r = await simulate(tx)
    return { engineResult: r?.engine_result ?? null, engineResultMessage: r?.engine_result_message ?? null, provenance: 'SIMULATED' }
  }

  const loanManage = (flag, key) => ({
    async preview({ vault }) {
      const loanId = vault.loans?.[key]
      if (!loanId) throw bad(`The vault ${vault.label} has no loan ${key}`)
      const tx = { TransactionType: 'LoanManage', Account: accounts.broker.address, LoanID: loanId, Flags: flag }
      return { tx, preview: await simulated(tx) }
    },
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
          const plan = vaults.desk?.plannedLoan
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
            throw new HttpError(409, 'ESCROW_POLICY', 'The pledged escrow is already named by another loan request. Nothing was signed. Use Re-request with a fresh ticket.', { requestActionId: rival.actionId })
          }
          act.pledgeActionId = body.pledgeActionId
          act.ticket = pick(body)
          act.escrow = pledge.escrow
          const borrower = accounts.borrower
          const signed = await enqueue(borrower.address, async () => {
            await xrpl.closeTime()
            const tx = await xrpl.client.autofill({
              TransactionType: 'LoanSet', Account: borrower.address, LoanBrokerID: vault.loanBrokerId, Counterparty: vault.owner,
              PrincipalRequested: plan.principalDrops, PaymentInterval: plan.paymentInterval, GracePeriod: plan.gracePeriod, PaymentTotal: 1,
              LastLedgerSequence: xrpl.lastLedger + LOANSET_WINDOW,
              Memos: [
                { Memo: { MemoType: hex('orma.ticket'), MemoData: body.ticketId.toUpperCase() } },
                { Memo: { MemoType: hex('orma.escrow'), MemoData: pledge.escrow.index } },
              ],
            })
            tx.Fee = num(tx.Fee).times(2).toFixed(0) // two signatures on one transaction
            return { tx, ...borrower.sign(tx) }
          })
          internals.set(act.actionId, { loanSet: signed })
          act.state = 'pending-approval'
          return {
            preview: {
              engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED',
              money: { principalDrops: signed.tx.PrincipalRequested, escrowIndex: pledge.escrow.index, lastLedgerSequence: signed.tx.LastLedgerSequence },
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
    const ticketed = ['pledgeEscrow', 'requestLoan', 'settle'].includes(action)
    if (['pledgeEscrow', 'requestLoan'].includes(action) && !LENDERS.includes(body.vault)) throw bad('vault must be the lending vault, desk or spare')
    if (['authorize', 'settle'].includes(action) && body.vault !== 'spare') throw bad('vault must be spare')
    if ((ticketed || action === 'authorize') && !HEX48.test(body.share ?? '')) throw bad('share must be 48 hex characters')
    if (ticketed && !(HEX64.test(body.ticketId ?? '') && HEX64.test(body.inputsDigest ?? ''))) throw bad('ticketId and inputsDigest must be 64 hex characters')
    if (ticketed && !UNITS.test(body.units ?? '')) throw bad('units must be 1 to 30 digits')
    if (action === 'requestLoan' && typeof body.pledgeActionId !== 'string') throw bad('pledgeActionId is required')
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
    runs.set(runId, { runId, operatorTokenHash: sha256(token), killed, actions: new Map() })
    log.info('run created', { runId })
    return { runId, token }
  }
  function kill() {
    killed = true
    for (const run of runs.values()) run.killed = true
    log.warn('kill switch on: every write refused, queued entries fail')
  }
  function unkill() {
    killed = false
    for (const run of runs.values()) run.killed = false
    log.info('kill switch off')
  }

  function tokenOk(req, run) {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')
    if (!m || !run) return false
    const got = Buffer.from(sha256(m[1]), 'hex')
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
    run.actions.set(act.actionId, act)
    try {
      const out = await handler.preview({ run, body, vault: vaults[body.vault], enqueue, submit, stopped, action: act })
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
    helpers.send(202, helpers.stamp({ actionId: act.actionId, preview: act.preview }))
  }

  async function confirmAction(run, act, helpers) {
    const handler = handlers[act.role][act.action]
    if (handler.confirm) {
      const out = await handler.confirm({ run, action: act, enqueue, submit, stopped })
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
        : enqueue(act.account, () => submitRebuilt(act, async () => tx, accounts[act.role]))
      done.catch((e) => {
        finish(act, { state: 'failed', engineResult: String(e?.message ?? e).slice(0, 120) })
        log.error('submission threw', { runId: run.runId, actionId: act.actionId, err: String(e).slice(0, 200) })
      })
    }
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
      const post = /^\/api\/roles\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
      const run = runs.get((confirm ?? post)?.[1])
      if (!tokenOk(req, run)) throw new HttpError(401, 'UNAUTHORIZED', 'A valid operator token for this run is required')
      if (stopped()) throw new HttpError(423, 'LOCKED', 'The kill switch is on; nothing was signed')
      if (confirm) {
        const act = run.actions.get(confirm[2])
        if (!act) throw new HttpError(404, 'NOT_FOUND', 'No such action in this run')
        await confirmAction(run, act, helpers)
      } else if (post) {
        await postAction(req, run, post[2], post[3], helpers)
      } else {
        throw new HttpError(404, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`)
      }
    } catch (e) {
      if (!(e instanceof HttpError)) throw e
      helpers.send(e.status, { error: { code: e.code, message: e.message, retryable: e.status === 503 || e.status === 423, ...e.extra } })
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
    req.on('data', (c) => {
      s += c
      if (s.length > BODY_MAX_BYTES) reject(bad('The body is over 64 KB'))
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
