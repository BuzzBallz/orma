// Offline check of the desk's write path under failure: a torn last line of the decision log, an approval
// that cannot open its log, a decline or rerequest confirm racing an approve, the kill switch's 423 as the
// contract states it, and an escrow scan that fails. Fakes only. No Devnet.
//   node src/dev/check-desk-hardening.mjs
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLog } from '../desk/decision-log.mjs'
import { createSigner, registerDeskActions, DeskError } from '../desk/signer.mjs'
import { createRoleEngine } from '../roles/engine.mjs'
import { findShareEscrows } from '../collateral.mjs'
import { SCHEMAS } from '../nyc/contracts.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const hex64 = (c) => c.repeat(64).slice(0, 64)
const entry = (ticket) => ({ ticketId: hex64(ticket), mandateHash: hex64('8'), decision: 'declined', ledgerIndex: 100, ledgerHash: hex64('1') })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
const settle = async (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, status: e?.status ?? null, code: e?.code ?? String(e) }))

console.log('the decision log: a torn last line')
{
  const dir = mkdtempSync(join(tmpdir(), 'orma-hardening-'))
  const path = join(dir, 'decisions.jsonl')
  const j = openLog(path)
  j.append(entry('A'))
  j.append(entry('B'))
  eq('control: two appends chain', j.verifyChain(), { ok: true })
  appendFileSync(path, '{"seq":3,"prevH') // a crash mid-append: no newline, never acknowledged
  const third = j.append(entry('C'))
  eq('the append after a torn line is seq 3, chained to seq 2, and the chain holds', [third.seq, third.prevHash === j.entries()[1].hash, j.verifyChain(), j.entries().length], [3, true, { ok: true }, 3])
  j.appendMarginCall({ status: 'ISSUED', loanId: hex64('7'), mandateHash: hex64('8'), policyHash: hex64('9'), issuedLedger: 101, issuedAt: '2026-10-25T12:00:00Z', cureBy: '2026-10-25T12:10:00Z', ltvHeldBps: 6000, maxLtvBps: 5344, ledgerIndex: 101, ledgerHash: hex64('2') })
  eq('a margin-call append after an intact tail changes nothing before it', [j.verifyChain(), j.entries().length], [{ ok: true }, 4])
}

console.log('an approval whose decision log cannot be opened')
{
  const dir = mkdtempSync(join(tmpdir(), 'orma-hardening-'))
  const file = join(dir, 'not-a-dir')
  writeFileSync(file, 'x')
  let reads = 0
  const xrpl = { req: async () => { reads++; throw new Error('no ledger') }, closeTime: async () => { reads++ } }
  const signer = createSigner({ xrpl, reader: {}, wallet: null, logPath: join(file, 'decisions.jsonl'), submit: async () => { throw new Error('never submitted') } })
  const r = await settle(signer.approve({ actionOfRequest: { actionId: 'a1', ticket: { ticketId: hex64('A') } } }))
  eq('refused 503 NOT_CONFIGURED before any read, signature or submission', [r.ok, r.status, r.code, reads], [false, 503, 'NOT_CONFIGURED', 0])
}

console.log('a decline or rerequest confirm racing an approve')
{
  const handlers = {}
  const actions = new Map()
  const engine = { register: (role, action, h) => { handlers[`${role}/${action}`] = h }, action: (_run, id) => actions.get(id) ?? null }
  let gate = deferred()
  const calls = { approve: 0, decline: 0, rerequest: 0 }
  const signer = {
    async decline() { calls.decline++; await gate.promise; return { L: { ledgerIndex: 100 } } },
    async rerequest() { calls.rerequest++; await gate.promise; return { signed: { tx: { LastLedgerSequence: 700 } } } },
    async approve() { calls.approve++; return { txHash: hex64('C'), engineResult: 'tesSUCCESS', ledgerIndex: 101 } },
  }
  registerDeskActions(engine, { signer, deskAddress: () => 'rDesk', borrower: () => ({ address: 'rBorrower' }) })
  const run = { runId: 'run' }
  const req = { actionId: 'r1', action: 'requestLoan', state: 'pending-approval', ticket: { ticketId: hex64('A') } }
  actions.set('r1', req)
  const act = (name) => ({ actionId: `${name}-${Math.random()}`, action: name, requestActionId: 'r1', state: 'previewed' })
  const enqueue = (_a, fn) => fn()

  const d = act('decline')
  const declining = settle(handlers['riskOfficer/decline'].confirm({ run, action: d }))
  const approveDuring = await settle(handlers['riskOfficer/approve'].confirm({ run, action: act('approve'), enqueue, stopped: () => false }))
  const declineAgain = await settle(handlers['riskOfficer/decline'].confirm({ run, action: d }))
  gate.resolve()
  const declined = await declining
  eq('an approve confirm during the decline answers 404 and signs nothing; a second confirm of the decline answers 404',
    [approveDuring.status, calls.approve, declineAgain.status, calls.decline, declined.ok, req.state], [404, 0, 404, 1, true, 'refused'])

  gate = deferred()
  const req2 = { actionId: 'r2', action: 'requestLoan', state: 'pending-approval', ticket: { ticketId: hex64('B') } }
  actions.set('r2', req2)
  const rr = { ...act('rerequest'), requestActionId: 'r2' }
  const rerequesting = settle(handlers['riskOfficer/rerequest'].confirm({ run, action: rr, enqueue }))
  const approveDuring2 = await settle(handlers['riskOfficer/approve'].confirm({ run, action: { ...act('approve'), requestActionId: 'r2' }, enqueue, stopped: () => false }))
  gate.resolve()
  await rerequesting
  const approveAfter = await settle(handlers['riskOfficer/approve'].confirm({ run, action: { ...act('approve'), requestActionId: 'r2' }, enqueue, stopped: () => false }))
  eq('an approve confirm during the rerequest answers 404; after it, the request awaits approval and approve goes through (control)',
    [approveDuring2.status, approveAfter.ok, calls.approve, req2.state], [404, true, 1, 'validated'])
}

console.log('the kill switch through the role engine')
{
  const accounts = Object.fromEntries(['holder', 'borrower', 'broker', 'deskOwner'].map((r) => [r, { address: `r${r}` }]))
  const engine = createRoleEngine({ reader: {}, xrpl: {}, env: {}, accounts, vaults: { desk: {} } })
  const { runId, token } = engine.newRun()
  const post = async () => {
    let out = null
    const helpers = { send: (status, body) => { out = { status, body } }, stamp: (b) => b, fail: () => {} }
    const req = { method: 'POST', headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '127.0.0.1' } }
    await engine.handle(req, { setHeader() {}, removeHeader() {} }, new URL(`http://x/api/roles/${runId}/borrower/pledgeEscrow`), helpers)
    return out
  }
  engine.kill()
  const locked = await post()
  eq('423 LOCKED is served retryable:false, as the contract states, and the error validator accepts it', [locked.status, locked.body.error.code, locked.body.error.retryable, SCHEMAS.error(locked.body)], [423, 'LOCKED', false, []])
  engine.unkill()
}

console.log('the escrow scan of a collateral route')
{
  const share = 'CD'.repeat(24)
  const one = { index: 'E1', Account: 'rP', Amount: { mpt_issuance_id: share, value: '5' }, FinishAfter: 815000000, CancelAfter: 815086400 }
  const fails = (error) => ({ accountObjects: async (a) => { if (a === 'rBad') throw Object.assign(new Error(error), { data: { error } }); return [one] } })
  const timeout = await settle(findShareEscrows(fails('timeout'), share, ['rP', 'rBad'], 100))
  const absent = await settle(findShareEscrows(fails('actNotFound'), share, ['rP', 'rBad'], 100))
  eq('a scan that fails throws, never a total of 0; an account that does not exist owns no escrow (control)', [timeout.ok, absent.ok, absent.v?.length], [false, true, 1])
}

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
