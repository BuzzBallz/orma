// Check of the margin call (step 20, addendum A11). Offline by default, no network:
//   node src/dev/check-margin-call.mjs                 judgeMarginCall: NONE, ISSUED with sharesToAdd exact to
//                                                     the unit (a property, its seed printed), CURED, EXPIRED,
//                                                     a new episode, a closed loan, an inconsistent snapshot;
//                                                     then the step-20 block in memory on a fake ledger: the
//                                                     call issued once, no duplicate, a restart from the log,
//                                                     the cure pledge counted, the expiry, the I2 re-read;
//                                                     greps: no PreviousFields, Orma never the subject
//   node src/dev/check-margin-call.mjs --seed <n>      replay a draw
//   node src/dev/check-margin-call.mjs --live          GET /api/desk/margin-calls and /api/desk/positions against
//                                                     API_BASE (run under with-api.mjs), read only
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet, hashes } from 'xrpl'
import { num, Decimal } from '../num.mjs'
import { createApi } from '../api.mjs'
import { createNyc } from '../nyc/index.mjs'
import { SCHEMAS, decisionHash, marginPolicyHash } from '../nyc/contracts.mjs'
import { issuanceIdOf } from '../ticket/inputs.mjs'
import { judgeMarginCall, sharesToRestore, valueOfUnits, isLoggedTransition } from '../desk/margin-call.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const hex64 = (c) => c.repeat(64).slice(0, 64)
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const POLICY = readJson('demo/margin-policy-desk-1.json')
const MANDATE = readJson('demo/mandate-desk-1.json')
const MAX = MANDATE.limits.maxLtvBps
const CT = 846300000
const ltvOf = (p, h) => JSON.parse(num(p).times(10000).div(h).floor().toFixed(0))

// --- the pure judgment ---------------------------------------------------------------------------------------

const position = ({ principal = '2000000', held = '4000000', perShare = '0.800000', scale = 0, loanId = hex64('A7') } = {}) => ({
  loanId, vaultId: hex64('5'), principalOutstanding: principal, collateralHeldDrops: held,
  ltvHeldBps: num(held).gt(0) ? ltvOf(principal, held) : null,
  usage: [{ limit: 'maxLtvBps', value: null, threshold: String(MAX) }],
  withdrawalValuePerShare: perShare, shareScale: scale,
})
const snap = (L, closeTime = CT, consistent = true) => ({ ledgerIndex: L, ledgerHash: hex64(L.toString(16).toUpperCase()), closeTime, consistent })
const withEntry = (c) => (c.status === 'NONE' ? c : { ...c, entryHash: hex64('E') })

function pure() {
  console.log('judgeMarginCall, pure')
  eq('the margin policy on file hashes to its own hash and names the mandate on file', [POLICY.hash === marginPolicyHash(POLICY), POLICY.mandateHash, SCHEMAS.marginPolicy(POLICY)], [true, MANDATE.hash, []])
  const healthy = judgeMarginCall({ position: position(), policy: POLICY, mandate: MANDATE, snapshot: snap(100) })
  eq('within the limit (5000 bps against 5344): NONE, no deadline, no shortfall', [healthy.status, healthy.issuedLedger, healthy.cureBy, healthy.shortfall, healthy.ltvHeldBps], ['NONE', null, null, null, 5000])
  eq('a NONE call passes SCHEMAS.marginCall', SCHEMAS.marginCall(healthy), [])

  // a further impairment: 0.7 per share, 3,500,000 drops held, 5714 bps
  const breach = position({ held: '3500000', perShare: '0.700000' })
  const issued = judgeMarginCall({ position: breach, policy: POLICY, mandate: MANDATE, snapshot: snap(101), previous: healthy, moved: { perShareBefore: '0.800000', triggerTx: hex64('D1') } })
  eq('above the limit: ISSUED at this ledger, cureBy = close time + 600 s', [issued.status, issued.issuedLedger, issued.issuedAt, issued.cureBy, issued.ltvHeldBps],
    ['ISSUED', 101, new Date((CT + 946684800) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), new Date((CT + 600 + 946684800) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), 5714])
  eq('the shortfall: 345450 share units, 241815 drops, at 0.700000', issued.shortfall, { collateralValueDrops: '241815', sharesToAdd: '345450', withdrawalValuePerShare: '0.700000' })
  eq('345450 more units restore the limit and 345449 do not', [ltvOf('2000000', num('3500000').plus(valueOfUnits('345450', '0.7'))), ltvOf('2000000', num('3500000').plus(valueOfUnits('345449', '0.7')))], [5344, 5345])
  eq('the reasons name the limit, the LTV, what moved and the cure, in facts',
    [issued.reasons.length, issued.reasons.some((r) => r.includes('0.800000 to 0.700000')), issued.reasons.some((r) => r.includes(hex64('D1'))), issued.reasons.some((r) => r.includes('pledge 345450 more share units'))], [5, true, true, true])
  eq('an ISSUED call, given its log entry, passes SCHEMAS.marginCall', SCHEMAS.marginCall(withEntry(issued)), [])
  eq('NONE → ISSUED is a transition the log records', isLoggedTransition(healthy, issued), true)

  const still = judgeMarginCall({ position: breach, policy: POLICY, mandate: MANDATE, snapshot: snap(102, CT + 300), previous: issued })
  eq('still above before cureBy: ISSUED, the same episode (issuedLedger, cureBy unchanged), not a new entry',
    [still.status, still.issuedLedger, still.cureBy === issued.cureBy, isLoggedTransition(issued, still)], ['ISSUED', 101, true, false])
  const cured = judgeMarginCall({ position: position({ held: '3741815', perShare: '0.700000' }), policy: POLICY, mandate: MANDATE, snapshot: snap(103, CT + 400), previous: still })
  eq('back within the limit before cureBy: CURED, no shortfall, the episode kept', [cured.status, cured.shortfall, cured.issuedLedger, cured.ltvHeldBps], ['CURED', null, 101, 5344])
  eq('a CURED call passes SCHEMAS.marginCall', SCHEMAS.marginCall(withEntry(cured)), [])
  const expired = judgeMarginCall({ position: breach, policy: POLICY, mandate: MANDATE, snapshot: snap(104, CT + 601), previous: still })
  eq('still above once the close time passes cureBy: EXPIRED, the policy\'s after-expiry sentence', [expired.status, expired.reasons.some((r) => r.includes(POLICY.afterExpiry))], ['EXPIRED', true])
  eq('an EXPIRED call passes SCHEMAS.marginCall', SCHEMAS.marginCall(withEntry(expired)), [])
  const stillExpired = judgeMarginCall({ position: breach, policy: POLICY, mandate: MANDATE, snapshot: snap(105, CT + 700), previous: expired })
  eq('EXPIRED stays EXPIRED while the breach lasts', [stillExpired.status, isLoggedTransition(expired, stillExpired)], ['EXPIRED', false])
  const after = judgeMarginCall({ position: position(), policy: POLICY, mandate: MANDATE, snapshot: snap(106, CT + 800), previous: expired })
  eq('back within the limit after the expiry: NONE, not a CURED', after.status, 'NONE')
  const again = judgeMarginCall({ position: breach, policy: POLICY, mandate: MANDATE, snapshot: snap(107, CT + 900), previous: cured })
  eq('a breach after a cure: a new episode, ISSUED at the new ledger', [again.status, again.issuedLedger, isLoggedTransition(cured, again)], ['ISSUED', 107, true])
  const closed = judgeMarginCall({ position: position({ principal: '0', held: '3500000', perShare: '0.700000' }), policy: POLICY, mandate: MANDATE, snapshot: snap(108), previous: issued })
  eq('a loan no longer open (principal 0): NONE, with the reason', [closed.status, closed.reasons.some((r) => r.includes('no longer open'))], ['NONE', true])
  const noCollateral = judgeMarginCall({ position: { ...position(), collateralHeldDrops: '0', ltvHeldBps: null }, policy: POLICY, mandate: MANDATE, snapshot: snap(109) })
  eq('no collateral read: NONE, no LTV, never a breach', [noCollateral.status, noCollateral.ltvHeldBps], ['NONE', null])

  // I7: no figure on an inconsistent snapshot
  const keep = judgeMarginCall({ position: position({ held: '1', perShare: '0.000001' }), policy: POLICY, mandate: MANDATE, snapshot: snap(110, CT, false), previous: issued })
  eq('an inconsistent snapshot: the previous status stands, read where it was read, no new figure', [keep.status, keep.ledgerIndex, keep.ltvHeldBps, keep.shortfall, keep.reasons.at(-1).includes('inconsistent')], ['ISSUED', 101, 5714, issued.shortfall, true])
  const keepNone = judgeMarginCall({ position: position(), policy: POLICY, mandate: MANDATE, snapshot: snap(111, CT, false) })
  eq('an inconsistent snapshot with no previous call: NONE, no LTV', [keepNone.status, keepNone.ltvHeldBps], ['NONE', null])

  const words = [issued, still, cured, expired, again].flatMap((c) => c.reasons).join(' ')
  eq('Orma is never the subject, and nothing liquidates or seizes', [/\bOrma\b/.test(words), /liquidat|seiz/i.test(words.replace(POLICY.afterExpiry, ''))], [false, false])
}

async function properties() {
  console.log('the shares to add, exact to the unit')
  const { forAll, seedFrom } = await import('./property.mjs')
  const seed = seedFrom()
  const ok = forAll({
    name: 'sharesToAdd is the least whole number of units that restores the limit, collateralValueDrops the least value',
    seed, cases: 2000,
    gen: (rand) => ({
      principal: String(1 + Math.floor(rand() * 1e9)),
      held: String(Math.floor(rand() * 2e9)),
      perShare: (Math.floor(rand() * 1e7) / 1e6 + 0.000001).toFixed(6),
      scale: Math.floor(rand() * 4),
      max: 500 + Math.floor(rand() * 9000),
    }),
    prop: ({ principal, held, perShare, scale, max }) => {
      const within = (h) => num(h).gt(0) && ltvOf(principal, h) <= max
      const r = sharesToRestore({ principalDrops: principal, heldDrops: held, perShare, scale, maxLtvBps: max })
      if (!r) return 'null for a share worth more than 0'
      if (within(held)) return r.sharesToAdd === '0' && r.collateralValueDrops === '0' ? true : `within the limit yet ${r.sharesToAdd} units asked`
      const x = num(r.sharesToAdd)
      if (!within(num(held).plus(valueOfUnits(x, perShare, scale)))) return `${r.sharesToAdd} units do not restore the limit`
      if (x.gt(0) && within(num(held).plus(valueOfUnits(x.minus(1), perShare, scale)))) return `${x.minus(1).toFixed(0)} units already restore it`
      const v = num(r.collateralValueDrops)
      if (!within(num(held).plus(v)) || within(num(held).plus(v).minus(1))) return `${r.collateralValueDrops} drops is not the least value that restores it`
      return true
    },
  })
  eq('property: sharesToAdd and collateralValueDrops exact, 2000 cases', ok, true)
  eq('a share worth 0 at the withdrawal value: no number of units restores the limit', sharesToRestore({ principalDrops: '2000000', heldDrops: '3500000', perShare: '0', maxLtvBps: MAX }), null)
}

// --- the step-20 block, in memory ------------------------------------------------------------------------------

const DESK = readJson('demo/desk.json')
const SPARE = readJson('demo/spare.json')
const COL = DESK.collateral
const notFound = () => Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })

/**
 * A fake ledger for one desk loan of 2,000,000 drops against 5,000,000 units of a Harbor-like share, its
 * escrow named by the LoanSet, its 2-of-3 account conforming. `w` is mutable: lu (LossUnrealized),
 * closeTime, L, the cure escrow, and `flip` to make the second read of a ledger disagree.
 */
function world() {
  const pseudo = Wallet.generate().address
  const share = issuanceIdOf({ Issuer: pseudo, Sequence: 1 })
  const vaultId = hex64('C5')
  const loanId = hex64('A7')
  const named = hex64('E7')
  const acct1 = COL.accounts['harbor-1'][1]
  const acct2 = COL.accounts['harbor-1'][2]
  const cureSeq = 777
  const cureIndex = hashes.hashEscrow(COL.borrower, cureSeq).toUpperCase()
  const w = { L: 2000, closeTime: CT, lu: '10000000', cure: false, flip: 0, reads: 0 }
  const vault = () => ({ index: vaultId, Account: pseudo, Owner: DESK.owner, ShareMPTID: share, Asset: { currency: 'XRP' }, VaultKind: 1, LEVersion: 1, AssetsTotal: '50000000', AssetsAvailable: '30000000', LossUnrealized: w.lu, Scale: 0, RedemptionDate: 847598400 })
  const issuance = { index: hex64('D5'), Issuer: pseudo, Sequence: 1, mpt_issuance_id: share, OutstandingAmount: '50000000', Flags: 0x38 }
  const escrow = (index, dest, units) => ({ index, LedgerEntryType: 'Escrow', Account: COL.borrower, Destination: dest, Amount: { mpt_issuance_id: share, value: units } })
  const loan = { index: loanId, LedgerEntryType: 'Loan', LoanBrokerID: DESK.loanBrokerId, LoanSequence: 1, Borrower: COL.borrower, PrincipalOutstanding: '2000000', Flags: 0 }
  const signerList = { SignerQuorum: 2, SignerEntries: [COL.borrower, COL.desk, COL.agent].map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })) }
  const memo = (type, data) => [{ Memo: { MemoType: Buffer.from(type).toString('hex').toUpperCase(), MemoData: data } }]
  const txs = () => [
    { hash: hex64('99'), ledger_index: 1900, validated: true, tx_json: { TransactionType: 'LoanSet', Account: COL.borrower, LoanBrokerID: DESK.loanBrokerId, Memos: memo('orma.escrow', named) }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: loanId, NewFields: { LoanBrokerID: DESK.loanBrokerId } } }] } },
    ...(w.cure ? [{ hash: hex64('98'), ledger_index: w.L - 1, validated: true, tx_json: { TransactionType: 'EscrowCreate', Account: COL.borrower, Sequence: cureSeq, Destination: acct2, Amount: { mpt_issuance_id: share, value: '345450' }, Memos: memo('orma.cure', loanId) }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] } }] : []),
  ]
  // the Reader's connection: its last validated ledger moves with the world, as the Reader's ticks move it
  const xrpl = {
    get lastLedger() { return w.L },
    get lastLedgerHash() { return hex64(w.L.toString(16).toUpperCase()) },
    get lastCloseTime() { return w.closeTime },
    async closeTime() { return w.closeTime },
    async accountTxWindow() { return { transactions: [], ledgerMin: 1, ledgerMax: w.L, truncated: false } },
    async req(p) {
      const L = p.ledger_index ?? w.L
      if (p.command === 'vault_info') {
        w.reads++
        const v = vault()
        // flip: the second read of the same ledger sees the vault healthy again
        if (w.flip && w.reads % 2 === 0) v.LossUnrealized = '10000000'
        return { result: { vault: { ...v, shares: issuance }, ledger_index: L } }
      }
      if (p.command === 'ledger_entry') {
        let node = null
        if (p.mpt_issuance) node = p.mpt_issuance === share ? issuance : null
        else if (p.loan) node = p.loan.loan_broker_id === DESK.loanBrokerId && p.loan.loan_seq === 1 ? loan : null
        else if (p.mptoken) node = [acct1, acct2].includes(p.mptoken.account) && p.mptoken.mpt_issuance_id === share ? { Account: p.mptoken.account, MPTokenIssuanceID: share } : null
        else if (p.index === DESK.loanBrokerId) node = { index: DESK.loanBrokerId, LoanSequence: 2 }
        else if (p.index === SPARE.loanBrokerId) node = { index: SPARE.loanBrokerId, LoanSequence: 1 }
        else if (p.index === named) node = escrow(named, acct1, '5000000')
        else if (p.index === cureIndex && w.cure) node = escrow(cureIndex, acct2, '345450')
        if (!node) throw notFound()
        return { result: { node, ledger_index: L } }
      }
      if (p.command === 'account_objects') {
        if (p.type === 'loan_broker') return { result: { account_objects: [], ledger_index: L } }
        const items = p.account === acct1 ? [escrow(named, acct1, '5000000')] : p.account === acct2 && w.cure ? [escrow(cureIndex, acct2, '345450')] : []
        return { result: { account_objects: items, ledger_index: L } }
      }
      if (p.command === 'account_info') {
        if (![acct1, acct2].includes(p.account)) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } })
        return { result: { account_data: { Account: p.account, Flags: 0x00100000, OwnerCount: 2 }, signer_lists: [signerList], ledger_index: L } }
      }
      if (p.command === 'account_tx') return { result: { transactions: p.account === COL.borrower ? txs() : [] } }
      throw new Error(`fake ledger: no ${p.command}`)
    },
  }
  const reader = {
    xrpl, vaultIds: [vaultId], snapshots: new Map([[vaultId, { vaultId, vault: { vaultId, shareMptId: share } }]]), missing: new Set(), passes: 1,
    serverTime: '2026-10-25T12:00:00Z', get ledgerIndex() { return w.L },
    all() { return [...this.snapshots.values()] },
    getByShareMpt(id) { return String(id).toUpperCase() === share ? this.snapshots.get(vaultId) : null },
    get: (id) => (id === vaultId ? { vaultId, vault: { vaultId, shareMptId: share } } : null),
    subscribe: () => () => {},
  }
  return { w, xrpl, reader, loanId, share, cureIndex }
}

async function api(fx, logPath) {
  const nyc = createNyc({ reader: fx.reader, env: { DESK_LOG_PATH: logPath } })
  const server = createApi(fx.reader, { port: 0, nyc })
  await server.listen()
  const base = `http://127.0.0.1:${server.server.address().port}`
  const get = async (path) => {
    const r = await fetch(base + path)
    return { status: r.status, body: await r.json() }
  }
  return { get, close: () => server.close() }
}
const entriesOf = (logPath) => {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function block() {
  console.log('the step-20 block, in memory')
  const logPath = join(mkdtempSync(join(tmpdir(), 'orma-margin-')), 'decisions.jsonl')
  const fx = world()
  let a = await api(fx, logPath)
  let r = await a.get('/api/desk/margin-calls')
  eq('healthy: 200, the policy on file, the loan NONE, SCHEMAS.marginCalls passes, nothing logged',
    [r.status, r.body.policy?.hash, r.body.marginCalls?.map((c) => c.status), SCHEMAS.marginCalls(r.body), entriesOf(logPath).length], [200, POLICY.hash, ['NONE'], [], 0])
  const pos = await a.get('/api/desk/positions')
  eq('every position carries its marginCall', [pos.status, pos.body.positions?.map((p) => p.marginCall?.status)], [200, ['NONE']])

  fx.w.lu = '15000000' // a further impairment: 0.7 per share
  fx.w.L = 2001
  r = await a.get('/api/desk/margin-calls')
  const call = r.body.marginCalls?.[0]
  const log1 = entriesOf(logPath)
  eq('after the impairment: ISSUED at ledger 2001, 345450 units to add, logged once', [call?.status, call?.issuedLedger, call?.shortfall?.sharesToAdd, log1.length, log1[0]?.kind, log1[0]?.status], ['ISSUED', 2001, '345450', 1, 'margin-call', 'ISSUED'])
  eq('the entry records the shortfall the call demands, so a restart serves it whole', [log1[0]?.shortfall, SCHEMAS.marginCallEntry(log1[0] ?? {})], [call?.shortfall, []])
  eq('the call carries its log entry, the entry chains and hashes as a decision does',
    [call?.entryHash === log1[0]?.hash, Boolean(log1[0]) && log1[0].hash === decisionHash(log1[0]), log1[0] ? SCHEMAS.decision(log1[0]) : null, SCHEMAS.marginCalls(r.body)], [true, true, [], []])
  const feed = await a.get('/api/feed')
  const ev = feed.body.events?.find((e) => e.type === 'MARGIN_CALL_ISSUED')
  eq('the Feed carries MARGIN_CALL_ISSUED, DECLARED, with its entry, and it passes SCHEMAS.feedEvent',
    [Boolean(ev), ev?.provenance, ev?.entryHash === log1[0]?.hash, ev ? SCHEMAS.feedEvent(ev) : null, /\bOrma\b/.test(ev?.why ?? '')], [true, 'DECLARED', true, [], false])
  const posIssued = await a.get('/api/desk/positions')
  eq('the positions route carries the same call', [posIssued.body.positions?.[0]?.marginCall?.status, posIssued.body.positions?.[0]?.marginCall?.entryHash], ['ISSUED', call?.entryHash])

  fx.w.L = 2002
  r = await a.get('/api/desk/margin-calls')
  eq('the same breach a ledger later: still ISSUED, no second entry', [r.body.marginCalls?.[0]?.status, entriesOf(logPath).length], ['ISSUED', 1])
  await a.close()

  // a restart: a new process on the same log
  a = await api(fx, logPath)
  fx.w.L = 2003
  r = await a.get('/api/desk/margin-calls')
  eq('after a restart the log is the memory: ISSUED, the same entry, no duplicate', [r.body.marginCalls?.[0]?.status, r.body.marginCalls?.[0]?.entryHash, r.body.marginCalls?.[0]?.issuedLedger, entriesOf(logPath).length], ['ISSUED', call?.entryHash, 2001, 1])

  // the cure: 345450 units pledged into a second 2-of-3 account, the EscrowCreate naming the loan
  fx.w.cure = true
  fx.w.L = 2004
  fx.w.closeTime = CT + 300
  r = await a.get('/api/desk/margin-calls')
  const log2 = entriesOf(logPath)
  eq('the cure pledge counts: CURED within the deadline, a second entry, chained to the first',
    [r.body.marginCalls?.[0]?.status, r.body.marginCalls?.[0]?.ltvHeldBps, log2.length, log2[1]?.status, log2[1]?.prevHash === log2[0]?.hash], ['CURED', 5344, 2, 'CURED', true])
  eq('a CURED entry keeps no shortfall', 'shortfall' in (log2[1] ?? {}), false)
  const posCured = await a.get('/api/desk/positions')
  eq('the cure escrow is on the line as collateral, flagged cure, its account conforming',
    [posCured.body.positions?.[0]?.collateral?.map((c) => [c.escrowId === fx.cureIndex, Boolean(c.cure), c.account?.conforming])], [[[false, false, true], [true, true, true]]])
  const feed2 = await a.get('/api/feed')
  // the Feed lives in each process (the log is what persists): the restarted one carries the cure only
  eq('the Feed of the restarted process carries MARGIN_CALL_CURED, with its entry', feed2.body.events?.filter((e) => e.type.startsWith('MARGIN_CALL_')).map((e) => [e.type, e.entryHash === log2[1]?.hash]), [['MARGIN_CALL_CURED', true]])
  await a.close()

  // the expiry, on a fresh world: issued, then the close time passes cureBy with the breach still there
  const logX = join(mkdtempSync(join(tmpdir(), 'orma-margin-')), 'decisions.jsonl')
  const fy = world()
  fy.w.lu = '15000000'
  const b = await api(fy, logX)
  await b.get('/api/desk/margin-calls')
  fy.w.L = 2005
  fy.w.closeTime = CT + 601
  r = await b.get('/api/desk/margin-calls')
  eq('the deadline passed with the breach still there: EXPIRED, logged, in the Feed',
    [r.body.marginCalls?.[0]?.status, entriesOf(logX).map((e) => e.status), (await b.get('/api/feed')).body.events?.filter((e) => e.type.startsWith('MARGIN_CALL_')).map((e) => e.type)],
    ['EXPIRED', ['ISSUED', 'EXPIRED'], ['MARGIN_CALL_ISSUED', 'MARGIN_CALL_EXPIRED']])
  await b.close()

  // I2: the second read of the same ledger disagrees, so nothing is logged
  const logF = join(mkdtempSync(join(tmpdir(), 'orma-margin-')), 'decisions.jsonl')
  const fz = world()
  fz.w.lu = '15000000'
  fz.w.flip = 1
  const c = await api(fz, logF)
  r = await c.get('/api/desk/margin-calls')
  eq('a re-read at the same ledger that disagrees: no entry written, NONE served with the reason',
    [entriesOf(logF).length, r.body.marginCalls?.[0]?.status, r.body.marginCalls?.[0]?.reasons?.at(-1)?.includes('disagreed'), SCHEMAS.marginCalls(r.body)], [0, 'NONE', true, []])
  await c.close()
}

function greps() {
  console.log('greps')
  const sources = ['src/desk/margin-call.mjs', 'src/nyc/index.mjs']
  const block20 = (() => {
    const s = readFileSync('src/nyc/index.mjs', 'utf8')
    return s.slice(s.indexOf('// --- step 20: margin-call ---'), s.indexOf('  return {', s.indexOf('// --- step 20: margin-call ---')))
  })()
  eq('the step-20 block exists in src/nyc/index.mjs', block20.length > 100, true)
  eq('no PreviousFields in src/desk/margin-call.mjs nor in the step-20 block', [readFileSync(sources[0], 'utf8').includes('PreviousFields'), block20.includes('PreviousFields')], [false, false])
  eq('no Number( nor parseFloat( on an amount in src/desk/margin-call.mjs', /\bNumber\(|parseFloat\(/.test(readFileSync(sources[0], 'utf8')), false)
}

// --- --live -----------------------------------------------------------------------------------------------

async function live() {
  const base = process.env.API_BASE
  if (!base) {
    console.log('  API_BASE is not set: run under src/dev/with-api.mjs')
    process.exitCode = 2
    return
  }
  console.log(`--live against ${base}`)
  const r = await fetch(`${base}/api/desk/margin-calls`)
  const d = await r.json()
  eq('GET /api/desk/margin-calls: 200 at a numeric ledger, the policy on file', [r.status, Number.isSafeInteger(d.ledgerIndex), d.policy?.hash], [200, true, POLICY.hash])
  eq('the document passes SCHEMAS.marginCalls', SCHEMAS.marginCalls(d), [])
  const p = await (await fetch(`${base}/api/desk/positions`)).json()
  const open = (p.positions ?? []).filter((x) => num(x.principalOutstanding).gt(0))
  eq('every open position carries a marginCall with a status', open.every((x) => ['NONE', 'ISSUED', 'CURED', 'EXPIRED'].includes(x.marginCall?.status)), true)
  console.log(`  ${open.length} open position(s), calls: ${open.map((x) => x.marginCall?.status).join(', ') || 'none'}`)
  void Decimal
}

// --- dispatch (last) -----------------------------------------------------------------------------------------

if (process.argv.includes('--live')) {
  await live()
} else {
  pure()
  await properties()
  await block()
  greps()
}
console.log(bad ? `\n  ${bad} failed` : '\n  all ok')
if (bad) process.exitCode = 1
void writeFileSync
