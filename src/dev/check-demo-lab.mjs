// Check of the demo lab's browser signing (/demo, Devnet only, demo only): the server builds every transaction
// and each signature is answered from outside it, as the page does, with the role keys signed in this process.
//   node src/dev/check-demo-lab.mjs           offline: the signing answers below, against the server's own check
//   node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-demo-lab.mjs --live [--vault spare|desk] [--refusal]
//     live, harbor-1 shares only: pledgeEscrow -> requestLoan -> approve with signer 'browser', one wrong-key
//     signature refused SIGNATURE_MISMATCH, the loan in /api/desk/positions. Never defaultL2 nor impairL1.
//     --refusal: the same steps on a ticket that breaches the mandate (harbor-1 after its default): the approve
//     refuses 409 BREACHED and asks no countersignature, logged refused at a ledger.
//
// The keys are the role accounts the API itself signs with, loaded the way src/nyc/index.mjs loads them
// (ROLES_FILE's accounts, DESK_SEED for the desk owner) and never printed. with-api blanks both for the
// command it runs, so in --live, and only for those two keys, a blank value is read again from .env.
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { Wallet, decode, signLoanSetByCounterparty } from 'xrpl'
import { checkSigned } from '../roles/remote-signer.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EXPLORER = 'https://devnet.xrpl.org/transactions/'
/** The page's two answers: wallet.sign(txJson) for kind sign, signLoanSetByCounterparty(wallet, txBlob) for countersign. */
export function answer(toSign, wallets) {
  const w = wallets[toSign.role]
  if (!w) throw new Error(`no key loaded for role ${toSign.role}`)
  if (w.address !== toSign.account) throw new Error(`the ${toSign.role} key loaded is ${w.address}, the request asks ${toSign.account}`)
  return toSign.kind === 'sign' ? w.sign(toSign.txJson).tx_blob : signLoanSetByCounterparty(w, toSign.txBlob).tx_blob
}

// --- offline ---------------------------------------------------------------------------------------------

function offline() {
  console.log('the answers of this check, against the server\'s verification (throwaway wallets)')
  const W = { borrower: Wallet.generate(), broker: Wallet.generate(), deskOwner: Wallet.generate() }
  const stranger = Wallet.generate()
  const escrow = {
    TransactionType: 'EscrowCreate', Account: W.borrower.address, Destination: stranger.address,
    Amount: { mpt_issuance_id: '0000000100000000000000000000000000000000000000AB', value: '5000000' },
    FinishAfter: 846300000, CancelAfter: 846386400, Sequence: 41, Fee: '12', LastLedgerSequence: 6400020,
  }
  const sign = { requestId: 'a'.repeat(32), kind: 'sign', role: 'borrower', account: W.borrower.address, txJson: escrow }
  eq('kind sign: the borrower\'s answer is accepted', checkSigned(sign, answer(sign, W)), [])
  eq('kind sign: a key of another role refused before anything is signed', (() => {
    try { answer({ ...sign, role: 'broker' }, W); return 'signed' } catch (e) { return /asks/.test(e.message) }
  })(), true)
  eq('kind sign: a blob of another key is refused by the server', checkSigned(sign, stranger.sign(escrow).tx_blob).length > 0, true)
  const loanSet = {
    TransactionType: 'LoanSet', Account: W.borrower.address, Counterparty: W.deskOwner.address, LoanBrokerID: 'B'.repeat(64),
    PrincipalRequested: '2000000', PaymentInterval: 86400, GracePeriod: 3600, Sequence: 42, Fee: '24', LastLedgerSequence: 6400600,
  }
  const blob = W.borrower.sign(loanSet).tx_blob
  const cs = { requestId: 'b'.repeat(32), kind: 'countersign', role: 'deskOwner', account: W.deskOwner.address, txBlob: blob }
  const counter = answer(cs, W)
  eq('kind countersign: the desk owner\'s answer is accepted, the borrower\'s signature kept', [checkSigned(cs, counter), decode(counter).TxnSignature === decode(blob).TxnSignature], [[], true])
  eq('kind countersign: a countersignature by another key is refused by the server', checkSigned(cs, signLoanSetByCounterparty(stranger, blob).tx_blob).length > 0, true)
}

// --- live ------------------------------------------------------------------------------------------------

/** ROLES_FILE and DESK_SEED as src/nyc/index.mjs reads them; with-api blanks them for its command, so .env fills a blank. */
function loadKeys() {
  const env = { ROLES_FILE: process.env.ROLES_FILE, DESK_SEED: process.env.DESK_SEED }
  if ((!env.ROLES_FILE || !env.DESK_SEED) && existsSync('.env')) {
    const file = parseEnv(readFileSync('.env', 'utf8'))
    for (const k of ['ROLES_FILE', 'DESK_SEED']) if (!env[k]) env[k] = file[k]
  }
  if (!env.ROLES_FILE || !env.DESK_SEED || !existsSync(env.ROLES_FILE)) return null
  const wallets = {}
  for (const [role, a] of Object.entries(JSON.parse(readFileSync(env.ROLES_FILE, 'utf8')).accounts ?? {})) {
    if (['borrower', 'broker'].includes(role)) wallets[role] = Wallet.fromSeed(a.seed)
  }
  wallets.deskOwner = Wallet.fromSeed(env.DESK_SEED) // the desk owner signs only with DESK_SEED, as on the server
  return wallets
}

async function live() {
  const base = process.env.API_BASE
  const vaultArg = process.argv.includes('--vault') ? process.argv[process.argv.indexOf('--vault') + 1] : 'spare'
  const refusal = process.argv.includes('--refusal')
  if (!base || !['spare', 'desk'].includes(vaultArg)) {
    console.log('  FAIL --live runs under src/dev/with-api.mjs, with --vault spare (the default) or desk')
    bad++
    return
  }
  const wallets = loadKeys()
  if (!wallets?.borrower || !wallets.deskOwner) {
    console.log('  FAIL ROLES_FILE and DESK_SEED are needed: the borrower and the desk owner sign here')
    bad++
    return
  }
  console.log(`live, lending vault ${vaultArg}, harbor-1 shares; keys: borrower ${wallets.borrower.address}, desk owner ${wallets.deskOwner.address}`)
  const read = (n) => JSON.parse(readFileSync(`demo/${n}.json`, 'utf8'))
  const h1 = read('harbor-1')
  const desk = read('desk')
  const call = async (method, path, { token, body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  // requestLoan takes the planned units only, so the pledge is the planned one. --refusal plays the same three
  // steps on a ticket that breaches the mandate: the approve must refuse 409 and ask no countersignature.
  const units = desk.plannedLoan.units
  const verdictWanted = refusal ? 'BREACHED' : 'PASS'
  console.log(`  pledging ${units} share units of harbor-1 for the planned loan of ${desk.plannedLoan.principalDrops} drops; ticket expected ${verdictWanted}`)
  const ticket = await call('GET', `/api/tickets?share=${h1.shareMptId}&op=pledge&units=${units}&mandate=desk-1`)
  if (!eq(`harbor-1 pledge ticket ${verdictWanted} (otherwise nothing is pledged${refusal ? '' : '; --refusal plays a BREACHED ticket'})`, ticket.body.verdict?.status ?? ticket.body.error?.code, verdictWanted)) {
    console.log(`         ${JSON.stringify(ticket.body.verdict?.breaches ?? ticket.body.error ?? null)}`)
    return
  }
  if (refusal) console.log(`         breaches: ${JSON.stringify(ticket.body.verdict?.breaches ?? null)}`)
  const { body: run } = await call('POST', '/api/demo/run')
  if (!run?.runId || !run?.token) {
    console.log(`  FAIL no operator run: ${JSON.stringify(run?.error ?? run)}`)
    bad++
    return
  }
  const t = run.token
  const role = (r, a, body) => call('POST', `/api/roles/${run.runId}/${r}/${a}`, { token: t, body: { ...body, signer: 'browser' } })
  const confirm = (id) => call('POST', `/api/roles/${run.runId}/actions/${id}/confirm`, { token: t })
  const signature = (id, body) => call('POST', `/api/roles/${run.runId}/actions/${id}/signature`, { token: t, body })
  const get = async (id) => (await call('GET', `/api/roles/${run.runId}/actions/${id}`)).body
  const until = async (id, states, ms = 240_000) => {
    const end = Date.now() + ms
    for (;;) {
      const a = await get(id)
      if (states.includes(a.state) || Date.now() > end) return a
      await sleep(2000)
    }
  }
  /** Answers every signature the action asks, in order, until it reaches one of `states`; the requests answered. */
  const signThrough = async (id, states, { wrongFirst = false } = {}) => {
    const answered = []
    for (;;) {
      const a = await until(id, ['awaiting-signature', ...states])
      if (a.state !== 'awaiting-signature') return { act: a, answered }
      const ts = a.toSign
      if (answered.some((x) => x.requestId === ts.requestId)) { await sleep(1500); continue }
      if (wrongFirst && answered.length === 0) {
        const stranger = Wallet.generate()
        const wrong = ts.kind === 'sign' ? stranger.sign({ ...ts.txJson, Account: ts.account }).tx_blob : signLoanSetByCounterparty(stranger, ts.txBlob).tx_blob
        const r = await signature(id, { requestId: ts.requestId, txBlob: wrong })
        const after = await get(id)
        eq('a wrong-key signature is refused 400 SIGNATURE_MISMATCH, not retryable, and the request stays open',
          [r.status, r.body.error?.code, r.body.error?.retryable, after.state, after.toSign?.requestId === ts.requestId], [400, 'SIGNATURE_MISMATCH', false, 'awaiting-signature', true])
        wrongFirst = false
      }
      const r = await signature(id, { requestId: ts.requestId, txBlob: answer(ts, wallets) })
      eq(`${ts.role} ${ts.kind}s ${ts.kind === 'sign' ? ts.txJson.TransactionType : 'the LoanSet'}: 202`, [r.status, r.body.error?.code ?? null], [202, null])
      console.log(`         ${ts.purpose}`)
      answered.push(ts)
      if (r.status !== 202) return { act: await get(id), answered }
    }
  }
  const verdicts = (a) => (a.change?.realised?.rows ?? []).map((r) => r.verdict)

  // 1. the pledge: previewed by the server, confirmed, the borrower's EscrowCreate signed here
  const body = { vault: vaultArg, share: h1.shareMptId, ticketId: ticket.body.ticketId, inputsDigest: ticket.body.inputsDigest, units }
  const p = await role('borrower', 'pledgeEscrow', body)
  if (!eq('pledgeEscrow (signer browser) previewed: 202, signer browser, nothing asked yet', [p.status, p.body.state, 'toSign' in p.body], [202, 'previewed', false])) return console.log(`         ${JSON.stringify(p.body.error)}`)
  const pc = await confirm(p.body.actionId)
  eq('pledgeEscrow confirmed: 202 at once, the HTTP answer never waits for the page', pc.status, 202)
  const pledge = await signThrough(p.body.actionId, ['validated', 'failed', 'refused'], { wrongFirst: true })
  const pv = verdicts(pledge.act)
  eq('pledgeEscrow validated tesSUCCESS, its escrow known, every re-read row MATCH',
    [pledge.act.state, pledge.act.engineResult, /^[0-9A-F]{64}$/.test(pledge.act.escrow?.index ?? ''), pv.length > 0 && pv.every((v) => v === 'MATCH')], ['validated', 'tesSUCCESS', true, true])
  if (pledge.act.state !== 'validated') return console.log(`         ${JSON.stringify({ state: pledge.act.state, engineResult: pledge.act.engineResult })}`)
  console.log(`         EscrowCreate ${EXPLORER}${pledge.act.txHash}`)

  // 2. the loan request: the borrower signs the LoanSet here, at the POST
  const rq = await role('borrower', 'requestLoan', { ...body, pledgeActionId: p.body.actionId })
  eq('requestLoan answers 202 awaiting-signature, a sign of the LoanSet by the borrower',
    [rq.status, rq.body.state, rq.body.toSign?.kind, rq.body.toSign?.role, rq.body.toSign?.txJson?.TransactionType, rq.body.toSign?.account], [202, 'awaiting-signature', 'sign', 'borrower', 'LoanSet', wallets.borrower.address])
  if (rq.status !== 202) return console.log(`         ${JSON.stringify(rq.body.error)}`)
  const request = await signThrough(rq.body.actionId, ['pending-approval', 'failed', 'refused', 'validated'])
  eq('requestLoan pending-approval once its LoanSet is signed (nothing submitted until the desk countersigns)', request.act.state, 'pending-approval')
  if (request.act.state !== 'pending-approval') return console.log(`         ${JSON.stringify({ state: request.act.state, engineResult: request.act.engineResult })}`)

  // 3. the approval: the desk re-reads, recomputes and checks the mandate first; then the desk owner countersigns here
  const ap = await role('riskOfficer', 'approve', { vault: vaultArg, requestActionId: rq.body.actionId })
  eq(`approve previewed: ${verdictWanted}, escrow ok, collateral conforming`, [ap.status, ap.body.preview?.money?.verdict?.status, ap.body.preview?.money?.escrow, ap.body.preview?.money?.collateral?.conforming], [202, verdictWanted, 'ok', true])
  if (ap.status !== 202) return console.log(`         ${JSON.stringify(ap.body.error)}`)
  const c = await confirm(ap.body.actionId)
  if (refusal) {
    // I2: the review runs first, at a logged ledger; a refusal asks for no signature and submits nothing
    const after = await get(ap.body.actionId)
    const req = await get(rq.body.actionId)
    eq('approve confirm refused 409 BREACHED, the action refused, no countersignature asked, the request back to pending-approval',
      [c.status, c.body.error?.code, after.state, 'toSign' in after, 'txHash' in after, req.state], [409, 'BREACHED', 'refused', false, false, 'pending-approval'])
    console.log(`         ${c.body.error?.message ?? ''} ${JSON.stringify(c.body.error?.breaches ?? null)}`)
    const dec = await call('GET', '/api/desk/decisions')
    const last = dec.body.entries?.at(-1) ?? null
    eq('the decision log: refused BREACHED last, at a ledger, no transaction, the chain whole', [last?.decision, last?.code, Number.isSafeInteger(last?.ledgerIndex), Boolean(last?.txHash), dec.body.chain], ['refused', 'BREACHED', true, false, { ok: true }])
    if (last) console.log(`         logged at ledger ${last.ledgerIndex}`)
    return
  }
  if (c.status === 409) {
    eq('approve confirm refused (no signature asked)', c.body.error?.code ?? null, 'none expected')
    return console.log(`         ${JSON.stringify(c.body.error)}`)
  }
  eq('approve confirm: 202 awaiting-signature, a countersign of the borrower\'s LoanSet by the desk owner',
    [c.status, c.body.state, c.body.toSign?.kind, c.body.toSign?.role, c.body.toSign?.account], [202, 'awaiting-signature', 'countersign', 'deskOwner', wallets.deskOwner.address])
  const approved = await signThrough(ap.body.actionId, ['validated', 'failed', 'refused'])
  eq('approve validated: the LoanSet tesSUCCESS', [approved.act.state, approved.act.engineResult], ['validated', 'tesSUCCESS'])
  if (approved.act.state !== 'validated') return console.log(`         ${JSON.stringify({ state: approved.act.state, engineResult: approved.act.engineResult })}`)
  console.log(`         LoanSet ${EXPLORER}${approved.act.txHash}`)
  const dec = await call('GET', '/api/desk/decisions')
  const last = dec.body.entries?.findLast?.((e) => e.txHash === approved.act.txHash) ?? null
  eq('the decision log: approved, with the LoanSet hash and its ledger, the chain whole', [last?.decision, Number.isSafeInteger(last?.ledgerIndex), dec.body.chain], ['approved', true, { ok: true }])
  let line = null
  for (let i = 0; i < 10 && !line; i++) {
    const pos = await call('GET', '/api/desk/positions')
    line = pos.body.positions?.find((x) => x.loanSetTxHash === approved.act.txHash) ?? null
    if (!line) await sleep(4000)
  }
  eq('positions list the new loan with its LoanSet hash and the escrow its Memo names', [Boolean(line), line?.collateral?.[0]?.escrowId], [true, pledge.act.escrow.index])
}

// --- run ---------------------------------------------------------------------------------------------------

if (process.argv.includes('--live')) await live()
else offline()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
