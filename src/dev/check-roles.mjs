// Offline check of the role engine: the write policy, the request contract, the closed allow-list, the
// previews, the serial queue of each account, the kill switch and the collateral pool, on a fake ledger
// client with a fake simulate and a fake submit. No Devnet.
//   node src/dev/check-roles.mjs
import { request } from 'node:http'
import { Wallet, hashes } from 'xrpl'
import { TRANSACTION_TYPES } from 'ripple-binary-codec'
import { createApi } from '../api.mjs'
import { createRoleEngine } from '../roles/engine.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const names = [...TRANSACTION_TYPES]
const required = ['Payment', 'DelegateSet', 'EscrowCreate', 'Batch', 'CheckCreate', 'TicketCreate']
if (!required.every((n) => names.includes(n))) {
  console.log(`  FAIL TRANSACTION_TYPES lacks one of ${required.join(', ')}`)
  process.exitCode = 1
} else {
  await main()
}

async function main() {
  const ORIGIN = 'https://ormaprotocol.com'
  const W = Object.fromEntries(['holder', 'borrower', 'broker', 'deskOwner', 'agent'].map((r) => [r, Wallet.generate()]))
  const SHARE = { 'harbor-1': '11'.repeat(24), 'harbor-2': '12'.repeat(24), 'harbor-3': '13'.repeat(24), desk: '14'.repeat(24), spare: '15'.repeat(24) }
  const BROKER = { 'harbor-1': 'B1'.repeat(32), 'harbor-2': 'B2'.repeat(32), 'harbor-3': 'B3'.repeat(32), desk: 'BD'.repeat(32), spare: 'B5'.repeat(32) }
  const POOL = [Wallet.generate().address, Wallet.generate().address, Wallet.generate().address]
  const T = 846000000
  const PLAN = { units: '5000000', principalDrops: '2000000', paymentInterval: 86400, gracePeriod: 3600 }
  const POLICY = { finishAfterMarginSeconds: 14400, cancelAfterOffsetSeconds: 86400 }
  const vault = (label, owner, loans) => ({ label, vaultId: label.length.toString(16).padStart(2, '0').repeat(32), shareMptId: SHARE[label], loanBrokerId: BROKER[label], owner, loans })
  const VAULTS = {
    'harbor-1': vault('harbor-1', W.broker.address, { L1: 'A1'.repeat(32), L2: 'A2'.repeat(32) }),
    'harbor-2': vault('harbor-2', W.broker.address, { L1: 'C1'.repeat(32), L2: 'C2'.repeat(32) }),
    'harbor-3': vault('harbor-3', W.broker.address, { L1: 'D1'.repeat(32), L2: 'D2'.repeat(32) }),
    desk: {
      ...vault('desk', W.deskOwner.address, { L1: null, L2: null }), plannedLoan: PLAN,
      collateral: { agent: W.agent.address, borrower: W.borrower.address, desk: W.deskOwner.address, quorum: 2, accounts: { 'harbor-1': POOL, 'harbor-2': [], 'harbor-3': [] } },
    },
    spare: vault('spare', W.deskOwner.address, { L1: null, L2: null }),
  }
  const pledgeOf = (share, units = PLAN.units) => ({ mpt_issuance_id: share, value: units })
  /** A conforming free collateral account: master disabled, the 2-of-3 list, the MPToken, OwnerCount 2. */
  const conforming = (a) => ({
    root: { Account: a, Flags: 0x00100000, OwnerCount: 2, Sequence: 7 },
    objects: [
      { LedgerEntryType: 'SignerList', SignerQuorum: 2, SignerEntries: [W.borrower, W.deskOwner, W.agent].map((s) => ({ SignerEntry: { Account: s.address, SignerWeight: 1 } })) },
      { LedgerEntryType: 'MPToken', Account: a, MPTokenIssuanceID: SHARE['harbor-1'], MPTAmount: '0' },
    ],
    txs: [],
  })

  /** A fake ledger, a fake simulate and a fake submit, an engine on them, and the API around it. */
  async function setup({ pool = 'free' } = {}) {
    const w = { L: 1000, accounts: new Map(), simulated: [], submitted: [], gate: null, simResult: () => 'tesSUCCESS', signedLoanSets: 0 }
    w.accounts.set(W.borrower.address, { root: { Account: W.borrower.address, Sequence: 10 }, objects: [], txs: [] })
    for (const a of POOL) if (pool === 'free') w.accounts.set(a, conforming(a))
    const page = (list, p) => {
      const at = Number(p.marker ?? 0)
      const next = at + (p.limit ?? 200)
      return { items: list.slice(at, next), marker: next < list.length ? String(next) : undefined }
    }
    const xrpl = {
      lastLedger: null,
      closeTime: async () => { xrpl.lastLedger = w.L; return T },
      req: async (p) => {
        const acct = w.accounts.get(p.account)
        if (p.command === 'account_info') {
          if (!acct) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } })
          return { result: { account_data: acct.root } }
        }
        if (p.command === 'account_objects') {
          const { items, marker } = page(acct?.objects ?? [], p)
          return { result: { account_objects: items, marker } }
        }
        if (p.command === 'account_tx') {
          const { items, marker } = page(acct?.txs ?? [], p)
          return { result: { transactions: items, marker } }
        }
        throw new Error(`unexpected ${p.command}`)
      },
      client: {
        autofill: async (tx) => ({ ...tx, Sequence: w.accounts.get(tx.Account)?.root.Sequence ?? 1, Fee: '12', LastLedgerSequence: tx.LastLedgerSequence ?? w.L + 20 }),
      },
    }
    const borrower = Object.assign(Object.create(Object.getPrototypeOf(W.borrower)), W.borrower)
    borrower.sign = (tx) => {
      if (tx.TransactionType === 'LoanSet') w.signedLoanSets++
      return W.borrower.sign(tx)
    }
    const engine = createRoleEngine({
      reader: {}, xrpl, env: { ALLOWED_WRITE_ORIGINS: ORIGIN },
      accounts: { ...W, borrower }, vaults: VAULTS, mandate: () => ({ policy: POLICY }),
      simulate: async (tx) => {
        w.simulated.push(tx)
        return { engine_result: w.simResult(tx) }
      },
      submit: async (tx, wallet) => {
        if (w.gate) await w.gate
        w.submitted.push({ tx, by: wallet.address })
        const acct = w.accounts.get(tx.Account)
        if (acct) acct.root.Sequence++
        return { txHash: String(w.submitted.length).padStart(64, '0'), engineResult: 'tesSUCCESS', ledgerIndex: w.L + 1 }
      },
    })
    const fakeReader = { serverTime: '2026-10-24T00:00:00Z', ledgerIndex: 1000, snapshots: new Map(), vaultIds: [], missing: new Set(), all: () => [] }
    const demo = { run: async () => engine.newRun(), kill: async () => { engine.kill(); return {} }, unkill: async () => { engine.unkill(); return {} } }
    const api = createApi(fakeReader, { port: 0, nyc: engine, demo })
    await api.listen()
    const port = api.server.address().port
    const call = (method, path, { token, origin, body } = {}) => new Promise((resolve, reject) => {
      const headers = { 'content-type': 'application/json' }
      if (token) headers.authorization = `Bearer ${token}`
      if (origin) headers.origin = origin
      const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let s = ''
        res.on('data', (c) => { s += c })
        res.on('end', () => {
          let json = null
          try { json = s ? JSON.parse(s) : null } catch { /* a 204 has no body */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json })
        })
      })
      r.on('error', reject)
      r.end(body === undefined ? undefined : JSON.stringify(body))
    })
    const newRun = async () => (await call('POST', '/api/demo/run')).body
    const post = (run, role, action, body, o = {}) => call('POST', `/api/roles/${run.runId}/${role}/${action}`, { token: run.token, body, ...o })
    const confirm = (run, actionId, o = {}) => call('POST', `/api/roles/${run.runId}/actions/${actionId}/confirm`, { token: run.token, ...o })
    const get = async (run, actionId) => (await call('GET', `/api/roles/${run.runId}/actions/${actionId}`)).body
    /** Waits for a state, never for a delay. Every validated read seen on the way is kept. */
    const waitState = async (run, actionId, states, seen = []) => {
      for (let i = 0; i < 400; i++) {
        const a = await get(run, actionId)
        seen.push(a)
        if (states.includes(a?.state)) return a
        await new Promise((r) => setTimeout(r, 5))
      }
      return get(run, actionId)
    }
    const hold = () => {
      let open
      w.gate = new Promise((r) => { open = r })
      return () => { w.gate = null; open() }
    }
    return { w, engine, api, call, newRun, post, confirm, get, waitState, hold }
  }

  const ticket = (vaultLabel, share = SHARE['harbor-1'], extra = {}) => ({ vault: vaultLabel, share, ticketId: 'E'.repeat(64), inputsDigest: 'F'.repeat(64), units: PLAN.units, ...extra })
  const lastEscrowCreate = (w) => w.simulated.filter((t) => t.TransactionType === 'EscrowCreate').at(-1)

  // --- the allow-list, the request contract ------------------------------------------------------
  {
    const s = await setup()
    const run = await s.newRun()
    let all404 = true
    for (const role of ['holder', 'borrower', 'broker', 'riskOfficer', 'buyer', 'deskOwner', 'agent']) {
      for (const name of names) {
        const r = await s.post(run, role, name, { vault: 'harbor-1' })
        if (r.status !== 404 || r.body?.error?.code !== 'NOT_FOUND') all404 = false
      }
    }
    eq(`allow-list: every role × each of the ${names.length} TRANSACTION_TYPES is 404 NOT_FOUND`, all404, true)
    const before = s.w.simulated.length
    const codes = [
      await s.post(run, 'holder', 'simulateWithdraw', {}),
      await s.post(run, 'holder', 'simulateWithdraw', { vault: 'harbor-9' }),
      await s.post(run, 'borrower', 'requestLoan', ticket('harbor-1', SHARE['harbor-1'], { pledgeActionId: 'x' })),
      await s.post(run, 'borrower', 'pledgeEscrow', ticket('harbor-1')),
      await s.post(run, 'borrower', 'pledgeEscrow', { ...ticket('desk'), inputsDigest: undefined }),
    ].map((r) => [r.status, r.body?.error?.code])
    eq('contract: no vault, harbor-9, a requestLoan or pledgeEscrow on harbor-1, no inputsDigest: 400 BAD_REQUEST, nothing previewed',
      [codes, s.w.simulated.length - before], [Array(5).fill([400, 'BAD_REQUEST']), 0])
    eq('requestLoan: no pledgeActionId is 400, an unknown one is 404',
      [(await s.post(run, 'borrower', 'requestLoan', ticket('desk'))).status, (await s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: 'nope' }))).status], [400, 404])
    await s.api.close()
  }

  // --- previews: simulated, declared, nothing submitted -------------------------------------------
  {
    const s = await setup()
    s.w.simResult = (tx) => (tx.TransactionType === 'LoanManage' && tx.Flags === 0x20000 ? 'tecNO_PERMISSION' : tx.TransactionType === 'VaultWithdraw' ? 'tecTOO_SOON' : 'tesSUCCESS')
    const run = await s.newRun()
    const w1 = await s.post(run, 'holder', 'simulateWithdraw', { vault: 'harbor-1' })
    eq('simulateWithdraw: 202, SIMULATED with its engineResult, nothing submitted',
      [w1.status, w1.body.preview.provenance, w1.body.preview.engineResult, s.w.submitted.length], [202, 'SIMULATED', 'tecTOO_SOON', 0])
    const sims = s.w.simulated.length
    const wait = await s.post(run, 'broker', 'wait', { vault: 'harbor-2' })
    eq('wait: 202, not-simulated (no transaction), DECLARED, no money, no simulate call',
      [wait.status, wait.body.preview, s.w.simulated.length - sims], [202, { engineResult: 'not-simulated (no transaction)', provenance: 'DECLARED' }, 0])
    const imp = await s.post(run, 'broker', 'impairL1', { vault: 'harbor-1' })
    eq('impairL1 on a Harbor: the preview is not tesSUCCESS', [imp.status, imp.body.preview.provenance, imp.body.preview.engineResult], [202, 'SIMULATED', 'tecNO_PERMISSION'])
    await s.confirm(run, imp.body.actionId)
    const impDone = await s.waitState(run, imp.body.actionId, ['failed', 'validated'])
    eq('impairL1 on a Harbor: its confirm ends failed, nothing submitted', [impDone.state, impDone.engineResult, s.w.submitted.length], ['failed', 'tecNO_PERMISSION', 0])
    const confirmedWait = await s.confirm(run, wait.body.actionId)
    eq('wait and simulateWithdraw: a confirm answers 202 in their state, nothing submitted',
      [confirmedWait.status, confirmedWait.body.state, (await s.confirm(run, w1.body.actionId)).body.state, s.w.submitted.length], [202, 'previewed', 'previewed', 0])
    eq('desk and spare carry no L1: impairL1 there is 400', (await s.post(run, 'broker', 'impairL1', { vault: 'desk' })).status, 400)
    await s.api.close()
  }

  // --- the pledge, the escrow, the loan request ------------------------------------------------------
  {
    const s = await setup()
    const run = await s.newRun()
    const p = await s.post(run, 'borrower', 'pledgeEscrow', ticket('desk'))
    const esc = lastEscrowCreate(s.w)
    const finishAfter = T + PLAN.paymentInterval + PLAN.gracePeriod + POLICY.finishAfterMarginSeconds
    eq('pledgeEscrow: 202 SIMULATED, an EscrowCreate of the borrower to the first free pool account, FinishAfter and CancelAfter from the plan and the mandate',
      [p.status, p.body.preview.provenance, esc.Account, esc.Destination, esc.Amount, esc.FinishAfter, esc.CancelAfter],
      [202, 'SIMULATED', W.borrower.address, POOL[0], pledgeOf(SHARE['harbor-1']), finishAfter, finishAfter + POLICY.cancelAfterOffsetSeconds])
    const open = s.hold()
    const c = await s.confirm(run, p.body.actionId)
    const seen = []
    const submitted = await s.waitState(run, p.body.actionId, ['submitted'], seen)
    open()
    const validated = await s.waitState(run, p.body.actionId, ['validated', 'failed'], seen)
    const sent = s.w.submitted.at(-1).tx
    eq('confirm: queued, then submitted, then validated with txHash, engineResult and escrow',
      [c.status, c.body.state, submitted.state, validated.state, Boolean(validated.txHash), validated.engineResult], [202, 'queued', 'submitted', 'validated', true, 'tesSUCCESS'])
    eq('confirm: the escrow index is hashEscrow(owner, offerSequence), on every validated read',
      [validated.escrow, seen.filter((a) => a.state === 'validated').every((a) => a.escrow?.index)],
      [{ owner: W.borrower.address, offerSequence: sent.Sequence, index: hashes.hashEscrow(W.borrower.address, sent.Sequence), destination: POOL[0] }, true])
    eq('a confirmed action carries change null (orma.change/1 from step 12)', validated.change, null)

    const sims = s.w.simulated.length
    const r1 = await s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: p.body.actionId }))
    const kept = s.engine.loanSetOf(r1.body.actionId)
    const memos = kept.tx.Memos.map((m) => [Buffer.from(m.Memo.MemoType, 'hex').toString(), m.Memo.MemoData])
    eq('requestLoan: 202, no simulate call, not-simulated (awaiting countersignature), DECLARED, its money from the signed LoanSet',
      [r1.status, s.w.simulated.length - sims, r1.body.preview],
      [202, 0, { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED', money: { principalDrops: PLAN.principalDrops, escrowIndex: validated.escrow.index, lastLedgerSequence: 1600 } }])
    eq('requestLoan: a signed LoanSet, LastLedgerSequence 1600, PaymentTotal 1, the planned principal, the desk broker, the escrow Memo',
      [kept.tx.TransactionType, kept.tx.LastLedgerSequence, kept.tx.PaymentTotal, kept.tx.PrincipalRequested, kept.tx.LoanBrokerID, kept.tx.Counterparty, memos, typeof kept.tx_blob],
      ['LoanSet', 1600, 1, PLAN.principalDrops, BROKER.desk, W.deskOwner.address, [['orma.ticket', 'E'.repeat(64)], ['orma.escrow', validated.escrow.index]], 'string'])
    const r1Action = await s.get(run, r1.body.actionId)
    eq('requestLoan: pending-approval, with the ticket of its body and the escrow of its pledge',
      [r1Action.state, r1Action.ticket, r1Action.escrow, r1Action.pledgeActionId],
      ['pending-approval', { share: SHARE['harbor-1'], ticketId: 'E'.repeat(64), inputsDigest: 'F'.repeat(64), units: PLAN.units }, validated.escrow, p.body.actionId])
    eq('requestLoan: a confirm answers 202 pending-approval, nothing submitted', [(await s.confirm(run, r1.body.actionId)).body.state, s.w.submitted.length], ['pending-approval', 1])
    const signedBefore = s.w.signedLoanSets
    const r2 = await s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: p.body.actionId }))
    eq('requestLoan: a second one on the same pledge is 409 ESCROW_POLICY naming the first, nothing signed',
      [r2.status, r2.body.error.code, r2.body.error.requestActionId, r2.body.error.message.endsWith('Use Re-request with a fresh ticket.'), s.w.signedLoanSets - signedBefore],
      [409, 'ESCROW_POLICY', r1.body.actionId, true, 0])
    eq('requestLoan: units other than the planned loan\'s is 400, nothing signed',
      [(await s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: p.body.actionId, units: '4' }))).status, s.w.signedLoanSets - signedBefore], [400, 0])
    s.engine.action(run.runId, r1.body.actionId).state = 'failed'
    const r3 = await s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: p.body.actionId }))
    eq('requestLoan: after the first one failed, a second passes', r3.status, 202)
    s.engine.action(run.runId, r3.body.actionId).state = 'failed'
    const both = await Promise.all([1, 2].map(() => s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: p.body.actionId }))))
    eq('requestLoan: two sent together on one pledge give a 202 and a 409 ESCROW_POLICY, one LoanSet signed',
      [both.map((r) => r.status).sort(), s.w.signedLoanSets - signedBefore], [[202, 409], 2])

    // a pledge on spare: the LoanSet names the broker of the vault in its body
    const ps = await s.post(run, 'borrower', 'pledgeEscrow', ticket('spare'))
    await s.confirm(run, ps.body.actionId)
    await s.waitState(run, ps.body.actionId, ['validated'])
    const rs = await s.post(run, 'borrower', 'requestLoan', ticket('spare', SHARE['harbor-1'], { pledgeActionId: ps.body.actionId }))
    eq('requestLoan on spare: the LoanSet names spare\'s loanBrokerId', s.engine.loanSetOf(rs.body.actionId).tx.LoanBrokerID, BROKER.spare)
    eq('requestLoan: vault, share or units other than its pledge\'s is 400',
      (await s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: ps.body.actionId }))).status, 400)

    // a LoanSet asked for while a borrower transaction is in its queue is signed after it, with the next Sequence
    const p3 = await s.post(run, 'borrower', 'pledgeEscrow', ticket('desk'))
    const openP3 = s.hold()
    await s.confirm(run, p3.body.actionId)
    await s.waitState(run, p3.body.actionId, ['submitted'])
    const p4 = await s.post(run, 'borrower', 'pledgeEscrow', ticket('desk'))
    openP3()
    await s.waitState(run, p3.body.actionId, ['validated'])
    const openP4 = s.hold()
    await s.confirm(run, p4.body.actionId)
    await s.waitState(run, p4.body.actionId, ['submitted'])
    let answered = false
    const pending = s.post(run, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: p3.body.actionId })).then((r) => { answered = true; return r })
    await new Promise((r) => setTimeout(r, 30))
    const signedWhileSubmitted = answered
    openP4()
    const late = await pending
    const p4Sequence = s.w.submitted.at(-1).tx.Sequence
    eq('requestLoan: while a borrower transaction is submitted, its LoanSet waits; then it takes the next Sequence',
      [signedWhileSubmitted, late.status, s.engine.loanSetOf(late.body.actionId).tx.Sequence], [false, 202, p4Sequence + 1])
    await s.api.close()
  }

  // --- the collateral pool: which account is free -----------------------------------------------------
  {
    const pick = async (bend) => {
      const s = await setup()
      bend(s.w)
      const run = await s.newRun()
      await s.post(run, 'borrower', 'pledgeEscrow', ticket('desk'))
      const d = lastEscrowCreate(s.w)?.Destination ?? null
      await s.api.close()
      return d
    }
    const pledgeEscrow = (a) => ({ LedgerEntryType: 'Escrow', Account: W.borrower.address, Destination: a, Amount: pledgeOf(SHARE['harbor-1']), index: 'EE'.repeat(32) })
    const thirdParty = (a, i) => ({ LedgerEntryType: 'Escrow', Account: W.holder.address, Destination: a, Amount: '1', index: i.toString(16).padStart(64, '0') })
    eq('pool: an escrow of the borrower on the first account sends the pledge to the second',
      await pick((w) => w.accounts.get(POOL[0]).objects.push(pledgeEscrow(POOL[0]))), POOL[1])
    eq('pool: a pledge EscrowCreate in the first account\'s history, its escrow cancelled since, sends it to the second',
      await pick((w) => w.accounts.get(POOL[0]).txs.push({ tx_json: { TransactionType: 'EscrowCreate', Account: W.borrower.address, Destination: POOL[0], Amount: pledgeOf(SHARE['harbor-1']) }, meta: { TransactionResult: 'tesSUCCESS' } })), POOL[1])
    eq('pool: an XRP escrow of a third party keeps the first account free',
      await pick((w) => w.accounts.get(POOL[0]).objects.push(thirdParty(POOL[0], 1))), POOL[0])
    eq('pool: 400 one-drop escrows of a third party, before the pledge on a later page, never make the first account free',
      await pick((w) => w.accounts.get(POOL[0]).objects.push(...Array.from({ length: 400 }, (_, i) => thirdParty(POOL[0], i + 1)), pledgeEscrow(POOL[0]))), POOL[1])

    const s = await setup()
    const run = await s.newRun()
    const two = await Promise.all([1, 2].map(() => s.post(run, 'borrower', 'pledgeEscrow', ticket('desk'))))
    const dests = s.w.simulated.filter((t) => t.TransactionType === 'EscrowCreate').map((t) => t.Destination)
    eq('pool: two concurrent pledges take two different free accounts',
      [two.map((r) => r.status), new Set(dests).size === 2 && dests.every((d) => POOL.includes(d))], [[202, 202], true])
    await s.api.close()
  }

  // --- an exhausted pool: the desk creates the account at confirm --------------------------------------
  {
    const s = await setup({ pool: 'none' })
    const run = await s.newRun()
    const p = await s.post(run, 'borrower', 'pledgeEscrow', ticket('desk'))
    eq('exhausted pool: the preview says so without simulate, the desk paying the reserve',
      [p.status, p.body.preview, s.w.simulated.length],
      [202, { engineResult: 'not-simulated (collateral account created at confirm)', provenance: 'DECLARED', money: { reserveDrops: '2000000', payer: 'deskOwner' } }, 0])
    await s.confirm(run, p.body.actionId)
    const done = await s.waitState(run, p.body.actionId, ['validated', 'failed'])
    const order = s.w.submitted.map(({ tx, by }) => [tx.TransactionType, tx.Account === by ? 'self' : 'other'])
    const [pay, list, token, flag, escrow] = s.w.submitted.map((x) => x.tx)
    const created = pay?.Destination
    eq('exhausted pool: Payment of 2 XRP by deskOwner, then SignerListSet, MPTokenAuthorize, AccountSet SetFlag 4 by the account created, then the borrower\'s EscrowCreate to it',
      [done.state, order.map((o) => o[0]), pay?.Account, pay?.Amount, [list, token, flag].every((t) => t?.Account === created), flag?.SetFlag, escrow?.Account, escrow?.Destination, done.escrow?.destination],
      ['validated', ['Payment', 'SignerListSet', 'MPTokenAuthorize', 'AccountSet', 'EscrowCreate'], W.deskOwner.address, '2000000', true, 4, W.borrower.address, created, created])
    eq('exhausted pool: its signer list is {borrower, desk, agent}, quorum 2, weight 1',
      [list?.SignerQuorum, list?.SignerEntries.map((e) => [e.SignerEntry.Account, e.SignerEntry.SignerWeight])],
      [2, [[W.borrower.address, 1], [W.deskOwner.address, 1], [W.agent.address, 1]]])
    await s.api.close()
  }

  // --- the serial queue, the rebuild at confirm, the kill switch -----------------------------------------
  {
    const s = await setup()
    const run = await s.newRun()
    const d1 = await s.post(run, 'broker', 'defaultL2', { vault: 'harbor-1' })
    const d2 = await s.post(run, 'broker', 'defaultL2', { vault: 'harbor-2' })
    const open = s.hold()
    await s.confirm(run, d1.body.actionId)
    await s.confirm(run, d2.body.actionId)
    await s.waitState(run, d1.body.actionId, ['submitted'])
    const second = (await s.get(run, d2.body.actionId)).state
    open()
    await s.waitState(run, d2.body.actionId, ['validated'])
    eq('queue: two confirmations on one account, the second queued until the first validated',
      [second, s.w.submitted.map((x) => x.tx.LoanID)], ['queued', [VAULTS['harbor-1'].loans.L2, VAULTS['harbor-2'].loans.L2]])

    const d3 = await s.post(run, 'broker', 'defaultL2', { vault: 'harbor-3' })
    s.w.L = 1030
    await s.confirm(run, d3.body.actionId)
    const d3done = await s.waitState(run, d3.body.actionId, ['validated', 'failed'])
    eq('confirm 30 ledgers after the preview: rebuilt with LastLedgerSequence ≥ 1050, validated',
      [d3done.state, s.w.submitted.at(-1).tx.LastLedgerSequence >= 1050], ['validated', true])

    const a = await s.post(run, 'broker', 'defaultL2', { vault: 'harbor-1' })
    const b = await s.post(run, 'broker', 'defaultL2', { vault: 'harbor-2' })
    const openKill = s.hold()
    await s.confirm(run, a.body.actionId)
    await s.waitState(run, a.body.actionId, ['submitted'])
    await s.confirm(run, b.body.actionId)
    await s.waitState(run, b.body.actionId, ['queued'])
    const count = s.w.submitted.length
    await s.call('POST', '/api/demo/kill')
    openKill()
    const bDone = await s.waitState(run, b.body.actionId, ['failed', 'validated'])
    eq('kill: an entry queued after its 202 ends failed with LOCKED, never submitted',
      [bDone.state, bDone.engineResult, s.w.submitted.length - count], ['failed', 'LOCKED', 1])

    const locked = await s.post(run, 'holder', 'simulateWithdraw', { vault: 'harbor-1' })
    const read = await s.call('GET', `/api/roles/${run.runId}/actions/${a.body.actionId}`)
    eq('kill: a POST is 423 LOCKED; GET of an action is 200 with no token and no Origin', [locked.status, locked.body.error.code, read.status], [423, 'LOCKED', 200])
    await s.call('POST', '/api/demo/unkill')
    eq('unkill: writes answer again', (await s.post(run, 'holder', 'simulateWithdraw', { vault: 'harbor-1' })).status, 202)
    await s.api.close()
  }

  // --- the write policy, CORS, the operator routes ------------------------------------------------------
  {
    const s = await setup()
    const run1 = await s.newRun()
    const run2 = await s.newRun()
    const body = { vault: 'harbor-1' }
    eq('a token stays valid after a later run is created', (await s.post(run1, 'holder', 'simulateWithdraw', body)).status, 202)
    const foreign = await s.post(run1, 'holder', 'simulateWithdraw', body, { origin: 'https://evil.example' })
    eq('a foreign Origin is 403 FORBIDDEN, with no Access-Control-Allow-Origin', [foreign.status, foreign.body.error.code, foreign.headers['access-control-allow-origin'] ?? null], [403, 'FORBIDDEN', null])
    eq('no token, or another run\'s token, is 401 UNAUTHORIZED',
      [(await s.post({ runId: run1.runId }, 'holder', 'simulateWithdraw', body)).status, (await s.post({ runId: run1.runId, token: run2.token }, 'holder', 'simulateWithdraw', body)).status], [401, 401])
    const allowed = await s.post(run1, 'holder', 'simulateWithdraw', body, { origin: ORIGIN })
    const allowed400 = await s.post(run1, 'holder', 'simulateWithdraw', { vault: 'harbor-9' }, { origin: ORIGIN })
    const preflight = await s.call('OPTIONS', `/api/roles/${run1.runId}/holder/simulateWithdraw`, { origin: ORIGIN })
    const cors = (r) => [r.status, r.headers['access-control-allow-origin'], r.headers.vary]
    eq('an allowed Origin: the 202, a 400 and the preflight carry its Access-Control-Allow-Origin and Vary: Origin',
      [cors(allowed), cors(allowed400), cors(preflight), preflight.headers['access-control-allow-methods']],
      [[202, ORIGIN, 'Origin'], [400, ORIGIN, 'Origin'], [204, ORIGIN, 'Origin'], 'POST,GET,OPTIONS'])
    const huge = await s.post(run1, 'holder', 'simulateWithdraw', { vault: 'harbor-1', pad: 'x'.repeat(70 * 1024) })
    eq('a body over 64 KB is 400 BAD_REQUEST', [huge.status, huge.body?.error?.code], [400, 'BAD_REQUEST'])
    const kill = await s.call('POST', '/api/demo/kill', { origin: ORIGIN })
    eq('POST /api/demo/kill with an Origin is 403, as before the engine', kill.status, 403)

    s.engine.register('riskOfficer', 'approve', {
      preview: async () => ({ preview: { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED' } }),
      confirm: async () => ({ code: 'BREACHED', message: 'ltv over the mandate', breaches: ['maxLtvBps'] }),
    })
    const p = await s.post(run1, 'borrower', 'pledgeEscrow', ticket('desk'))
    await s.confirm(run1, p.body.actionId)
    await s.waitState(run1, p.body.actionId, ['validated'])
    const req = await s.post(run1, 'borrower', 'requestLoan', ticket('desk', SHARE['harbor-1'], { pledgeActionId: p.body.actionId }))
    eq('register: approve needs a requestActionId awaiting approval (400, 404)',
      [(await s.post(run1, 'riskOfficer', 'approve', { vault: 'desk' })).status, (await s.post(run1, 'riskOfficer', 'approve', { vault: 'desk', requestActionId: 'x' })).status], [400, 404])
    const ap = await s.post(run1, 'riskOfficer', 'approve', { vault: 'desk', requestActionId: req.body.actionId })
    const refused = await s.confirm(run1, ap.body.actionId)
    eq('register: a confirm that answers a code is a 409 with its fields, the action refused',
      [ap.status, refused.status, refused.body.error.code, refused.body.error.breaches, (await s.get(run1, ap.body.actionId)).state], [202, 409, 'BREACHED', ['maxLtvBps'], 'refused'])
    await s.api.close()
  }

  // --- not configured -----------------------------------------------------------------------------
  {
    const engine = createRoleEngine({ reader: {}, xrpl: {}, env: {}, accounts: {}, vaults: {} })
    const api = createApi({ serverTime: 'x', ledgerIndex: 0 }, { port: 0, nyc: engine })
    await api.listen()
    const r = await fetch(`http://127.0.0.1:${api.server.address().port}/api/roles/r1/holder/simulateWithdraw`, { method: 'POST' })
    eq('no roles, no desk seed, no vaults: a POST from loopback is 503 NOT_CONFIGURED', [r.status, (await r.json()).error.code], [503, 'NOT_CONFIGURED'])
    await api.close()
  }

  console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
  process.exitCode = bad ? 1 : 0
}
