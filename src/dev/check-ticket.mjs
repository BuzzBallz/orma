// Offline check of orma.ticket/1 and the desk's positions (step 7): the Meridian and Kestrel fixtures,
// the bake's calibration, the mandate verdicts, the parameter errors and the I7 refusals through an API
// in memory, the manager's statement kept out of every figure (I6), positions attached only through the
// LoanSet's orma.escrow Memo, every Figure replayed by its formula, five properties on 2 000 drawn vaults
// each, and greps that keep src/ticket/ free of Number(, parseFloat( and PreviousFields (I1). No network.
//   node src/dev/check-ticket.mjs                 the fixed seed 0xA4B
//   node src/dev/check-ticket.mjs --seed <n>      replay a draw; --seed random draws a fresh one
//   node src/dev/check-ticket.mjs --live          Harbor-1 against API_BASE (run under with-api.mjs)
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { num, Decimal } from '../num.mjs'
import { Reader } from '../poll.mjs'
import { coverForOrder } from '../history.mjs'
import { createApi } from '../api.mjs'
import { createNyc } from '../nyc/index.mjs'
import { FORMULAS, SCHEMAS, encodeStatement } from '../nyc/contracts.mjs'
import { readTicketInputs, readPositions, readCollateralAccount, judgeSnapshot, issuanceIdOf } from '../ticket/inputs.mjs'
import { buildTicket, buildPositions, evaluateFormula } from '../ticket/engine.mjs'
import { forAll, seedFrom } from './property.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const hex64 = (c) => c.repeat(64).slice(0, 64)
const hashOf = (L) => L.toString(16).toUpperCase().padStart(64, '0')

// --- fixtures ---------------------------------------------------------------------------------------------

const PSEUDO = 'rNd25qaV5J3T1oSuexK1R8881mp9ajVAKv'
const OWNER = 'rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo'
const BORROWER = 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv'
const DESK = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const AGENT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const STRANGER = 'rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh'

/** A share issued by the vault's pseudo-account at Sequence 1, so its id is rippled's. */
const shareIds = new Map()
const shareOf = (issuer, seq = 1) => {
  const key = `${issuer}:${seq}`
  if (!shareIds.has(key)) shareIds.set(key, issuanceIdOf({ Issuer: issuer, Sequence: seq }))
  return shareIds.get(key)
}

/**
 * A vault fixture: its raw objects as rippled serves them. `loans` are raw Loan objects; their broker is
 * the one broker of the vault.
 */
function vaultFixture({ id = hex64('A'), at = 51000000, aa = 41000000, lu = 10000000, shares = 51000000, scale = 0, red = 847598400, loans = [], debt = '0', cover = '0', data, pseudo = PSEUDO, seq = 1 }) {
  const share = shareOf(pseudo, seq)
  const brokerId = hex64(id[0] === 'A' ? 'B' : 'C')
  const vault = {
    index: id, Account: pseudo, Owner: OWNER, ShareMPTID: share, Asset: { currency: 'XRP' }, VaultKind: 1, LEVersion: 1,
    AssetsTotal: String(at), AssetsAvailable: String(aa), ...(lu !== null && { LossUnrealized: String(lu) }), Scale: scale, RedemptionDate: red,
    ...(data !== undefined && { Data: data }),
  }
  const issuance = { index: hex64('D'), Issuer: pseudo, Sequence: seq, mpt_issuance_id: share, OutstandingAmount: String(shares), Flags: 0x38 }
  const broker = { index: brokerId, VaultID: id, Owner: OWNER, LoanSequence: loans.length + 1, DebtTotal: debt, CoverAvailable: cover, CoverRateMinimum: 10000, CoverRateLiquidation: 10000 }
  const loanObjects = loans.map((l, i) => ({ index: hex64(String(i + 1)), LoanBrokerID: brokerId, LoanSequence: i + 1, Borrower: BORROWER, ...l }))
  return { id, share, vault, issuance, broker, loans: loanObjects }
}

const CT = 846200000
/** A Meridian-like vault: 51 XRP in, 10 XRP recognised as lost, the withdrawal value 0.803922. */
const meridian = (o = {}) => vaultFixture({ loans: [{ PrincipalOutstanding: '10000000', TotalValueOutstanding: '10000000', Flags: 0x00020000, NextPaymentDueDate: CT - 600, GracePeriod: 60 }], debt: '10000000', cover: '2000000', ...o })
/** Kestrel: loans of 30 and 10 XRP, both late; DebtTotal 40 XRP, rates 10 %, cover 20 XRP. */
const kestrel = (impair30 = false) => vaultFixture({
  at: 50000000, aa: 10000000, lu: impair30 ? 30000000 : null, shares: 50000000,
  loans: [
    { PrincipalOutstanding: '30000000', TotalValueOutstanding: '30000000', Flags: impair30 ? 0x00020000 : 0, NextPaymentDueDate: CT - 900, GracePeriod: 60 },
    { PrincipalOutstanding: '10000000', TotalValueOutstanding: '10000000', Flags: 0, NextPaymentDueDate: CT - 900, GracePeriod: 60 },
  ],
  debt: '40000000', cover: '20000000',
})

/**
 * A fake rippled for one or more vault fixtures, plus any extra objects, accounts and histories. Each
 * request is recorded; account_objects and account_tx page by `pageSize`.
 */
function fakeXrpl(fixtures, { L = 1000, hash = hashOf(1000), closeTime = CT, objects = {}, accounts = {}, mptokens = {}, owned = {}, txs = {}, pageSize = 10, answerLedger = {} } = {}) {
  const st = { L, hash, closeTime, requests: [] }
  const byIndex = new Map(Object.entries(objects))
  const vaultById = new Map()
  for (const f of fixtures) {
    vaultById.set(f.id, f)
    byIndex.set(f.broker.index, f.broker)
    for (const l of f.loans) byIndex.set(l.index, l)
  }
  const ledgerOf = (cmd) => answerLedger[cmd] ?? st.L
  const page = (items, marker, key) => {
    const start = marker ? Number.parseInt(marker, 10) : 0
    const chunk = items.slice(start, start + pageSize)
    return { [key]: chunk, ...(start + pageSize < items.length && { marker: String(start + pageSize) }) }
  }
  const notFound = () => Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
  const xrpl = {
    lastLedger: null, lastLedgerHash: null, lastCloseTime: null, st,
    async closeTime() {
      this.lastLedger = st.L
      this.lastLedgerHash = st.hash
      this.lastCloseTime = st.closeTime
      return st.closeTime
    },
    async accountTxWindow(account) { return { transactions: txs[account] ?? [], ledgerMin: 1, ledgerMax: st.L, truncated: false } },
    async req(p) {
      st.requests.push(structuredClone(p))
      if (p.command === 'vault_info') {
        const f = vaultById.get(p.vault_id)
        if (!f) throw notFound()
        return { result: { vault: { ...f.vault, shares: f.issuance }, ledger_index: ledgerOf('vault_info'), ledger_hash: st.hash } }
      }
      if (p.command === 'ledger_entry') {
        let node = null
        if (p.mpt_issuance) node = fixtures.find((f) => f.share === p.mpt_issuance)?.issuance ?? null
        else if (p.loan) node = fixtures.flatMap((f) => f.loans).find((l) => l.LoanBrokerID === p.loan.loan_broker_id && l.LoanSequence === p.loan.loan_seq) ?? null
        else if (p.mptoken) node = mptokens[`${p.mptoken.mpt_issuance_id}:${p.mptoken.account}`] ?? null
        else if (p.index) node = byIndex.get(p.index) ?? null
        if (!node) throw notFound()
        return { result: { node, ledger_index: p.mpt_issuance ? ledgerOf('issuance') : ledgerOf('ledger_entry') } }
      }
      if (p.command === 'account_objects') {
        let items
        if (p.type === 'loan_broker') items = fixtures.filter((f) => f.vault.Owner === p.account).map((f) => f.broker)
        else items = owned[p.account] ?? []
        return { result: { ...page(items, p.marker, 'account_objects'), ledger_index: ledgerOf('account_objects') } }
      }
      if (p.command === 'account_info') {
        const a = accounts[p.account]
        if (!a) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } })
        return { result: { account_data: a.account_data, signer_lists: a.signer_lists ?? [], ledger_index: st.L } }
      }
      if (p.command === 'account_tx') return { result: page(txs[p.account] ?? [], p.marker, 'transactions') }
      throw new Error(`fake rippled: no ${p.command}`)
    },
  }
  return xrpl
}

/** A Reader-like object that tracks the fixtures' vaults. */
function fakeReader(fixtures, xrpl) {
  const snapshots = new Map(fixtures.map((f) => [f.id, { vaultId: f.id, vault: { vaultId: f.id, shareMptId: f.share } }]))
  return {
    xrpl, snapshots, vaultIds: fixtures.map((f) => f.id), missing: new Set(), passes: 1, degraded: false,
    serverTime: '2026-10-25T12:00:00Z', ledgerIndex: xrpl.st.L, closeTime: CT,
    all: () => [...snapshots.values()],
    getByShareMpt(id) { return this.all().find((s) => String(s.vault.shareMptId).toUpperCase() === String(id).toUpperCase()) ?? null },
    get(id) { return snapshots.get(id) ?? null },
  }
}

const MANDATE_PASS = {
  schema: 'orma.mandate/1', id: 'desk-1', desk: 'Test desk (fictional)', riskOfficer: STRANGER, hash: hex64('9'), anchorTx: hex64('8'),
  limits: { maxLtvBps: 6000, maxSingleLoanDrops: '1000000', maxN2LossDrops: '1000000', maxLockupDays: 30 },
  policy: { escrowFinish: 'only-after-default', finishAfterMarginSeconds: 14400, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 },
}
const MANDATE_BREAK = { ...MANDATE_PASS, limits: { maxLtvBps: 3000, maxSingleLoanDrops: '100000', maxN2LossDrops: '1', maxLockupDays: 1 } }

const tickets = [] // every ticket built here, replayed formula by formula at the end
const build = (inputs, req) => {
  const t = buildTicket(inputs, req)
  tickets.push(t)
  return t
}
const inputsOf = async (f, o = {}) => readTicketInputs(fakeXrpl([f], o), { shareMptId: f.share, reader: fakeReader([f], fakeXrpl([f], o)) })

// --- offline ---------------------------------------------------------------------------------------------

async function offline() {
  console.log('Meridian')
  const mer = meridian()
  eq('Reader.nav: withdrawal value 0.803922, 1961 bps', Reader.nav({ assetsTotal: num('51000000'), assetsAvailable: num('51000000'), lossUnrealized: num('10000000'), sharesOutstanding: num('51000000'), scale: 0 }), { navNaive: '1.000000', navCorrect: '0.803922', navDivergenceBps: 1961 })
  const merIn = await inputsOf(mer)
  const merT = build(merIn, { op: 'pledge', units: '1000000', mandate: MANDATE_PASS, principalDrops: '400000' })
  eq('heldValue of 1 000 000 Meridian shares: 803922 drops', merT.figures.heldValue.value, '803922')
  eq('naiveValue 1000000, n1Overpayment 196078', [merT.figures.naiveValue.value, merT.figures.n1Overpayment.value], ['1000000', '196078'])
  eq('ltvHeld floored: floor(400000 × 10000 / 803922)', merT.figures.ltvHeld.value, new Decimal(400000).times(10000).div(803922).floor().toFixed())
  eq('the ticket passes SCHEMAS.ticket', SCHEMAS.ticket(merT), [])
  const inputsAll = (t) => [t.figures.heldValue, t.figures.naiveValue, t.figures.n1Overpayment, ...t.figures.n2.flatMap((e) => [e.lossAfterCover, e.cover, e.heldPerUnitIfDefault]), t.figures.n3.lockedUntil, t.figures.n3.cashAvailable, t.figures.n3.claim, t.figures.maxLoan, t.figures.maxUnits, t.figures.requested, t.figures.ltvHeld, t.figures.lender1to1].filter(Boolean).flatMap((f) => f.inputs)
  eq('every input of every Figure at the ticket ledger (I1)', inputsAll(merT).every((i) => i.ledgerIndex === merT.ledgerIndex && i.ledgerHash === merT.ledgerHash), true)
  const merBuy = build(merIn, { op: 'buy', units: '1000000', mandate: MANDATE_PASS })
  eq('a buy ticket carries maxUnits and no 1:1 column', [Boolean(merBuy.figures.maxUnits), 'requested' in merBuy.figures, 'ltvHeld' in merBuy.figures, 'lender1to1' in merBuy.figures, 'verdict1to1' in merBuy], [true, false, false, false, false])
  eq('the buy ticket passes SCHEMAS.ticket', SCHEMAS.ticket(merBuy), [])

  console.log('Kestrel and N2')
  eq('coverForOrder: 500000 largest first, 700000 smallest first', [coverForOrder([num(30000000), num(10000000)], 40000000, 10000, 10000, 20000000).toFixed(), coverForOrder([num(10000000), num(30000000)], 40000000, 10000, 10000, 20000000).toFixed()], ['500000', '700000'])
  const kesT = build(await inputsOf(kestrel()), { op: 'pledge', units: '1000000', mandate: MANDATE_PASS, principalDrops: '400000' })
  eq('both late loans have an "if Lx defaults alone" entry, MODELLED', kesT.figures.n2.map((e) => [e.scenario, e.cover.provenance]), [['if L1 defaults alone', 'MODELLED'], ['if L2 defaults alone', 'MODELLED']])
  eq('each alone entry carries a cover of 400000', kesT.figures.n2.map((e) => e.cover.value), ['400000', '400000'])
  const kesI = build(await inputsOf(kestrel(true)), { op: 'pledge', units: '1000000', mandate: MANDATE_PASS, principalDrops: '400000' })
  eq('the impaired 30 XRP loan: alreadyInHeld, lossAfterCover 0', [kesI.figures.n2[0].alreadyInHeld, kesI.figures.n2[0].lossAfterCover.value], [true, '0'])
  eq('the 10 XRP loan: not in the withdrawal value, a positive loss', [kesI.figures.n2[1].alreadyInHeld, num(kesI.figures.n2[1].lossAfterCover.value).gt(0)], [false, true])
  const defaulted = vaultFixture({ at: 40000000, aa: 40000000, lu: null, shares: 50000000, loans: [{ Flags: 0x00010000, GracePeriod: 60 }], debt: '0', cover: '0' })
  eq('a loan in default has no n2 entry', build(await inputsOf(defaulted), { op: 'pledge', units: '1000000', mandate: MANDATE_PASS, principalDrops: '1' }).figures.n2.length, 0)

  console.log('mandates')
  eq('a mandate that holds: PASS, PASS at 1:1', [merT.verdict, merT.verdict1to1.status], [{ status: 'PASS', breaches: [] }, 'PASS'])
  const broken = build(merIn, { op: 'pledge', units: '1000000', mandate: MANDATE_BREAK, principalDrops: '400000' })
  eq('a mandate that breaks: BREACHED, each limit in breaches', [broken.verdict.status, broken.verdict.breaches.map((b) => b.limit)], ['BREACHED', ['maxLtvBps', 'maxSingleLoanDrops', 'maxLockupDays']])

  await calibration()
  await statements()
  await digests()
  await positions()
  await api()
  properties()
  formulasAndGreps()
}

/** The bake's calibration, rebuilt from the raw objects it recorded in demo/desk.json. */
async function calibration() {
  console.log('the bake calibration (demo/desk.json)')
  const desk = JSON.parse(readFileSync('demo/desk.json', 'utf8'))
  const mandate = JSON.parse(readFileSync('demo/mandate-desk-1.json', 'utf8'))
  const c = desk.calibration
  const raw = c.objects
  const vault = { ...raw.vault }
  const issuance = raw.vault.shares
  const toInputs = (v, loans) => ({
    ledgerIndex: c.ledgerIndex, ledgerHash: c.ledgerHash, closeTime: c.closeTime,
    vault: { id: v.index, fields: v, raw: v }, issuance: { id: v.ShareMPTID, fields: issuance, raw: issuance },
    brokers: [{ id: raw.broker.index, fields: raw.broker, raw: raw.broker, loans }],
    conduct: { recognitionLagSeconds: [], defaultsWithoutImpairment: 0, coverOrderCostDrops: '0' },
  })
  eq('the recorded objects are a consistent snapshot', judgeSnapshot({ vault, issuance: { ...issuance, Issuer: issuance.Issuer ?? vault.Account }, shareMptId: vault.ShareMPTID, ledgerIndex: c.ledgerIndex, readAt: [c.ledgerIndex] }).consistent, true)
  const loans = [{ id: raw.loans.L1.index, label: 'L1', fields: raw.loans.L1, raw: raw.loans.L1 }, { id: raw.loans.L2.index, label: 'L2', fields: raw.loans.L2, raw: raw.loans.L2 }]
  const req = { op: 'pledge', units: desk.plannedLoan.units, mandate, principalDrops: desk.plannedLoan.principalDrops }
  const now = build(toInputs(vault, loans), req)
  eq('n1Overpayment strictly positive (L1 impaired by the bake)', num(now.figures.n1Overpayment.value).gt(0), true)
  const l1 = now.figures.n2.find((e) => e.label === 'L1')
  eq('L1: alreadyInHeld, lossAfterCover 0', [l1?.alreadyInHeld, l1?.lossAfterCover.value], [true, '0'])
  eq('the withdrawal value now is the recorded heldNow', new Decimal(now.figures.heldValue.value).div(desk.plannedLoan.units).toFixed(6), c.heldNow)
  const l2 = now.figures.n2.find((e) => e.label === 'L2')
  eq('the engine gives the recorded heldIfL2 for L2 alone', l2?.heldPerUnitIfDefault.value, c.heldIfL2)
  eq('at heldNow: verdict PASS, verdict1to1 PASS', [now.verdict.status, now.verdict1to1.status], ['PASS', 'PASS'])
  // L2 defaulted: the vault loses its exposure less the cover, the loan leaves N2
  const exposure = num(raw.loans.L2.PrincipalOutstanding)
  const after = { ...vault, AssetsTotal: num(vault.AssetsTotal).minus(exposure.minus(c.coverL2)).toFixed(0) }
  const l2Defaulted = { ...raw.loans.L2, Flags: 0x00010000 }
  const later = build(toInputs(after, [loans[0], { ...loans[1], fields: l2Defaulted, raw: l2Defaulted }]), req)
  eq('at heldIfL2: BREACHED on maxLtvBps, verdict1to1 still PASS', [later.verdict.status, later.verdict.breaches.map((b) => b.limit), later.verdict1to1.status], ['BREACHED', ['maxLtvBps'], 'PASS'])
  eq('the withdrawal value after L2 is heldIfL2', new Decimal(later.figures.heldValue.value).div(desk.plannedLoan.units).toFixed(6), c.heldIfL2)
}

/** I6: a manager's statement is DECLARED, judged REAL, and enters no figure. */
async function statements() {
  console.log("the manager's statement (I6)")
  const L1 = hex64('1')
  const healthy = meridian({ loans: [{ PrincipalOutstanding: '10000000', TotalValueOutstanding: '10000000', Flags: 0, NextPaymentDueDate: CT - 600, GracePeriod: 60 }] })
  const doc = { s: 'orma.stmt/1', loan: L1, kind: 'impaired', text: 'L1 marked impaired: payment missed by 2 min', at: CT - 30 }
  const req = { op: 'pledge', units: '1000000', mandate: MANDATE_PASS, principalDrops: '400000' }
  const base = build(await inputsOf(meridian()), req)
  eq('no Data: statement null', base.statement, null)
  const cases = [
    ['impaired on an impaired loan', meridian({ data: encodeStatement(doc) }), 'CONSISTENT'],
    ['impaired on a healthy loan', { ...healthy, vault: { ...healthy.vault, Data: encodeStatement(doc) } }, 'INCONSISTENT'],
    ['an unreadable Data', meridian({ data: 'DEADBEEF' }), 'UNPARSEABLE'],
  ]
  const healthyBase = build(await inputsOf(healthy), req)
  for (const [name, f, status] of cases) {
    const t = build(await inputsOf(f), req)
    const ref = f === cases[1][1] ? healthyBase : base
    eq(`${name}: DECLARED, ${status}`, [t.statement?.provenance, t.statement?.consistency.status, t.statement?.consistency.provenance], ['DECLARED', status, 'REAL'])
    eq(`${name}: the same inputsDigest and figures as without Data`, [t.inputsDigest, JSON.stringify(t.figures)], [ref.inputsDigest, JSON.stringify(ref.figures)])
  }
}

/** inputsDigest moves with the objects, never with the ledger alone; ticketId moves with both. */
async function digests() {
  console.log('inputsDigest and ticketId')
  const req = { op: 'pledge', units: '1000000', mandate: MANDATE_PASS, principalDrops: '400000' }
  const a = build(await inputsOf(meridian(), { L: 1000, hash: hashOf(1000), closeTime: CT }), req)
  const b = build(await inputsOf(meridian(), { L: 1005, hash: hashOf(1005), closeTime: CT + 20 }), req)
  eq('the same objects at L and L+5: one inputsDigest, two ticketIds', [a.inputsDigest === b.inputsDigest, a.ticketId !== b.ticketId], [true, true])
  const c = build(await inputsOf(meridian({ lu: 9999999 }), { L: 1005, hash: hashOf(1005), closeTime: CT + 20 }), req)
  eq('a LossUnrealized changed: another inputsDigest', c.inputsDigest !== b.inputsDigest, true)
}

/** Collateral accounts read at L, and positions attached only through the LoanSet's Memo. */
async function positions() {
  console.log('collateral accounts and positions')
  const mer = meridian()
  const index = hex64('E')
  const L = 1000
  const at = { ledgerIndex: L, ledgerHash: hashOf(L), closeTime: CT }
  const signerList = { SignerQuorum: 2, SignerEntries: [BORROWER, DESK, AGENT].map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })) }
  const account = (address, flags = 0x00100000) => ({ account_data: { Account: address, Flags: flags, OwnerCount: 2 }, signer_lists: [signerList] })
  const pledge = (dest, idx = index) => ({ index: idx, LedgerEntryType: 'Escrow', Account: BORROWER, Destination: dest, Amount: { mpt_issuance_id: mer.share, value: '1000000' } })
  const dust = (dest, i) => ({ index: hex64('F').slice(0, 56) + String(i).padStart(8, '0'), LedgerEntryType: 'Escrow', Account: STRANGER, Destination: dest, Amount: '1' })
  const col = 'rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1'
  const who = { borrower: BORROWER, desk: DESK, agent: AGENT, shareMptId: mer.share, at, namedEscrow: index }
  const token = { [`${mer.share}:${col}`]: { Account: col, MPTokenIssuanceID: mer.share } }
  const read = (owned, accounts = { [col]: account(col) }) => {
    const x = fakeXrpl([mer], { owned: { [col]: owned }, accounts, mptokens: token })
    return readCollateralAccount(x, { address: col, ...who }).then((r) => ({ r, x }))
  }
  let { r, x } = await read([pledge(col)])
  eq('a conforming account', [r.conforming, r.reasons], [true, []])
  eq('every read of readCollateralAccount at ledger_index L', x.st.requests.every((p) => p.ledger_index === L), true)
  ;({ r } = await read([pledge(col), { index: hex64('3'), LedgerEntryType: 'Escrow', Account: STRANGER, Destination: col, Amount: '1' }]))
  eq("a third party's XRP escrow beside it: still conforming", r.conforming, true)
  ;({ r, x } = await read([...Array.from({ length: 400 }, (_, i) => dust(col, i)), pledge(col)]))
  eq('400 dust escrows before the pledge: marker followed, the named escrow found, conforming', [r.conforming, x.st.requests.filter((p) => p.command === 'account_objects').length], [true, 41])
  ;({ r } = await read(Array.from({ length: 600 }, (_, i) => dust(col, i))))
  eq('past 50 pages: not conforming, with the refusal', [r.conforming, /runs past 50 pages/.test(r.reasons[0] ?? '')], [false, true])
  ;({ r } = await read([pledge(col)], { [col]: account(col, 0) }))
  eq('its master key active: reasons not empty', [r.conforming, r.reasons], [false, ['master key enabled']])

  // two loans of one borrower, three escrows of one amount, share and destination; each LoanSet names one
  const dir = mkdtempSync(join(tmpdir(), 'orma-positions-'))
  const deskBroker = hex64('7')
  const spareBroker = hex64('6')
  writeFileSync(join(dir, 'desk.json'), JSON.stringify({ vaultId: hex64('5'), loanBrokerId: deskBroker, collateral: { borrower: BORROWER, desk: DESK, agent: AGENT } }))
  writeFileSync(join(dir, 'spare.json'), JSON.stringify({ vaultId: hex64('4'), loanBrokerId: spareBroker }))
  const e1 = hex64('A1'), e2 = hex64('A2'), e3 = hex64('A3')
  const loanA = { index: hex64('L1'), LoanBrokerID: deskBroker, LoanSequence: 1, Borrower: BORROWER, PrincipalOutstanding: '40000000' }
  const loanB = { index: hex64('L2'), LoanBrokerID: deskBroker, LoanSequence: 2, Borrower: BORROWER, PrincipalOutstanding: '400000' }
  const memo = (idx) => [{ Memo: { MemoType: Buffer.from('orma.escrow').toString('hex').toUpperCase(), MemoData: idx } }]
  const loanSet = (loan, idx, hash) => ({ hash, ledger_index: 900, validated: true, tx_json: { TransactionType: 'LoanSet', Account: BORROWER, LoanBrokerID: deskBroker, Memos: memo(idx) }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: loan.index, NewFields: { LoanBrokerID: deskBroker } } }] } })
  const objects = {
    [deskBroker]: { index: deskBroker, LoanSequence: 3 }, [spareBroker]: { index: spareBroker, LoanSequence: 1 },
    [e1]: pledge(col, e1), [e2]: pledge(col, e2), [e3]: pledge(col, e3),
  }
  const fx = fakeXrpl([mer, { ...mer, loans: [loanA, loanB], broker: { index: hex64('Z9'), LoanSequence: 0 }, id: hex64('Q'), share: 'none', vault: { ...mer.vault, Owner: 'rNobody' } }], {
    objects, owned: { [col]: [pledge(col, e1), pledge(col, e2), pledge(col, e3)] }, accounts: { [col]: account(col) }, mptokens: token,
    txs: { [BORROWER]: [loanSet(loanA, e1, hex64('91')), loanSet(loanB, e2, hex64('92'))] },
  })
  const p = await readPositions(fx, { reader: fakeReader([mer], fx), demoDir: dir })
  const built = buildPositions(p, MANDATE_PASS)
  eq('two desk loans, one ledgerIndex on every line', [built.positions.length, built.ledgerIndex], [2, L])
  eq('each loan carries only the escrow its LoanSet names', built.positions.map((x) => x.collateral.map((c) => c.escrowId)), [[e1], [e2]])
  eq('the third escrow, named by no LoanSet, is on no line', built.positions.some((x) => x.collateral.some((c) => c.escrowId === e3)), false)
  eq('each line carries the hash of the LoanSet that created its loan', built.positions.map((x) => x.loanSetTxHash), [hex64('91'), hex64('92')])
  const held = new Decimal(1000000).times('0.803922').toFixed(0)
  eq('ltvHeldBps = floor(40000000 × 10000 / held value), one usage entry per limit', [built.positions[0].collateralHeldDrops, built.positions[0].ltvHeldBps, built.positions[0].usage.map((u) => u.limit)], [held, JSON.parse(new Decimal(40000000).times(10000).div(held).floor().toFixed(0)), ['maxLtvBps', 'maxSingleLoanDrops', 'maxN2LossDrops', 'maxLockupDays']])
  eq('the collateral account on the line, without its raw objects', 'raw' in built.positions[0].collateral[0].account, false)
  const lonely = buildPositions({ ...p, loans: [{ ...p.loans[0], collateral: [] }] }, MANDATE_PASS)
  eq('a loan with no escrow: ltvHeldBps null', lonely.positions[0].ltvHeldBps, null)
}

/** The routes, through an API in memory. */
async function api() {
  console.log('the routes, in memory')
  const mer = meridian()
  const x = fakeXrpl([mer], { L: 1000 })
  x.lastLedger = 1000
  const reader = fakeReader([mer], x)
  const nyc = createNyc({ reader, env: {} })
  const server = createApi(reader, { port: 0, nyc })
  await server.listen()
  const base = `http://127.0.0.1:${server.server.address().port}`
  const units = JSON.parse(readFileSync('demo/desk.json', 'utf8')).plannedLoan.units
  const get = async (q) => { const r = await fetch(`${base}${q}`); return { status: r.status, body: await r.json() } }
  const t = (o) => `/api/tickets?share=${o.share ?? mer.share}&op=${o.op ?? 'pledge'}&units=${o.units ?? units}&mandate=${o.mandate ?? 'desk-1'}`
  try {
    const ok = await get(t({}))
    eq('GET /api/tickets: 200, orma.ticket/1 at one ledger', [ok.status, ok.body.schema, ok.body.ledgerIndex], [200, 'orma.ticket/1', 1000])
    tickets.push(ok.body)
    const errors = await Promise.all([get(t({ op: 'swap' })), get(t({ units: '1e9' })), get(t({ share: 'F'.repeat(48) })), get(t({ mandate: 'desk-9' })), get(t({ units: '0' }))])
    eq('the parameter errors: BAD_OP, BAD_UNITS, SHARE_NOT_TRACKED, MANDATE_NOT_FOUND, and a pledge worth 0', errors.map((e) => [e.status, e.body.error?.code]), [[400, 'BAD_OP'], [400, 'BAD_UNITS'], [404, 'SHARE_NOT_TRACKED'], [404, 'MANDATE_NOT_FOUND'], [400, 'BAD_UNITS']])
    eq('each error message is a sentence', errors.every((e) => /^[A-Z].*[a-z.]$/.test(e.body.error?.message ?? '') && e.body.error.message.includes(' ')), true)
    const lower = await get(t({ share: mer.share.toLowerCase() }))
    eq('the share in lower case: 200, the same inputsDigest', [lower.status, lower.body.inputsDigest], [200, ok.body.inputsDigest])
    const before = x.st.requests.filter((p) => p.command === 'vault_info').length
    x.lastLedger = 1001 // a new ledger: nothing cached for it
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) => get(t({ units: String(1000 + i) }))))
    eq('40 parallel requests of distinct units: all 200, one ledger walk', [many.every((m) => m.status === 200), x.st.requests.filter((p) => p.command === 'vault_info').length - before], [true, 1])
    const m = await get('/api/desk/mandates/desk-1')
    const file = JSON.parse(readFileSync('demo/mandate-desk-1.json', 'utf8'))
    eq('GET /api/desk/mandates/desk-1: 200, the hash, deskPlan of five labels and the planned loan', [m.status, m.body.hash, m.body.deskPlan?.vaults.map((v) => v.label), JSON.stringify(m.body.deskPlan?.plannedLoan)], [200, file.hash, ['harbor-1', 'harbor-2', 'harbor-3', 'desk', 'spare'], JSON.stringify(JSON.parse(readFileSync('demo/desk.json', 'utf8')).plannedLoan)])
    eq('the mandate passes SCHEMAS.mandate', SCHEMAS.mandate(m.body), [])
    eq('an unknown mandate: 404 MANDATE_NOT_FOUND', (await get('/api/desk/mandates/desk-9')).body.error?.code, 'MANDATE_NOT_FOUND')
  } finally {
    await server.close()
  }
  await snapshotRefusals()
  await positionsRoute()
}

/** I7 through the route: one case per rule, each a 409 without figures and an error line naming it. */
async function snapshotRefusals() {
  console.log('I7, through /api/tickets')
  const cases = [
    ['zeroShares', 'no shares, AssetsTotal not 0', { shares: 0, at: 1000, aa: 0, lu: 0 }],
    ['zeroShares', 'no shares, AssetsAvailable not 0', { shares: 0, at: 1000, aa: 1000, lu: 0 }],
    ['availableRange', 'AssetsAvailable negative', { aa: -1, lu: 0 }],
    ['availableRange', 'AssetsAvailable above AssetsTotal', { aa: 52000000, lu: 0 }],
    ['lossGap', 'LossUnrealized a drop above AssetsTotal − AssetsAvailable', { aa: 41000000, lu: 10000001 }],
    ['lossNonNegative', 'LossUnrealized negative', { lu: -1 }],
    ['totalNonNegative', 'AssetsTotal negative', { at: -1, aa: -2, lu: 0, shares: 1 }],
  ]
  const run = async (f, o = {}) => {
    const x = fakeXrpl([f], o)
    const reader = fakeReader([f], x)
    const server = createApi(reader, { port: 0, nyc: createNyc({ reader, env: {} }) })
    await server.listen()
    const lines = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return write(chunk, ...rest) }
    try {
      const r = await fetch(`http://127.0.0.1:${server.server.address().port}/api/tickets?share=${f.share}&op=pledge&units=1000&mandate=desk-1`)
      return { status: r.status, body: await r.json(), lines }
    } finally {
      process.stderr.write = write
      await server.close()
    }
  }
  const refused = (r, rule) => r.status === 409 && r.body.error?.code === 'INCONSISTENT_SNAPSHOT' && !('figures' in r.body)
    && r.lines.some((l) => l.includes('"level":"error"') && l.includes(rule) && l.includes('"ledgerIndex":1000'))
  for (const [rule, name, o] of cases) eq(`${rule}: ${name} → 409, no figures, an error line naming it`, refused(await run(meridian(o)), rule), true)
  eq('lossGap: LossUnrealized exactly AssetsTotal − AssetsAvailable is accepted', (await run(meridian({ aa: 41000000, lu: 10000000 }))).status, 200)
  const other = meridian()
  eq("shareId: the vault's ShareMPTID is another share", refused(await run({ ...other, vault: { ...other.vault, ShareMPTID: shareOf(STRANGER) }, share: other.share }), 'shareId'), true)
  eq('shareId: the issuance has another Issuer', refused(await run({ ...other, issuance: { ...other.issuance, Issuer: STRANGER } }), 'shareId'), true)
  eq('sameLedger: the issuance answered at L+1', refused(await run(other, { answerLedger: { issuance: 1001 } }), 'sameLedger'), true)
}

/** /api/desk/positions through the API: 200, and 409 when a pledged share's vault is inconsistent. */
async function positionsRoute() {
  console.log('/api/desk/positions, in memory')
  const desk = JSON.parse(readFileSync('demo/desk.json', 'utf8'))
  const spare = JSON.parse(readFileSync('demo/spare.json', 'utf8'))
  const col = desk.collateral
  const serve = async (f) => {
    const escrowIndex = hex64('E7')
    const loan = { index: hex64('L7'), LoanBrokerID: desk.loanBrokerId, LoanSequence: 1, Borrower: col.borrower, PrincipalOutstanding: '2000000' }
    const address = col.accounts['harbor-1'][1]
    const x = fakeXrpl([f], {
      objects: {
        [desk.loanBrokerId]: { index: desk.loanBrokerId, LoanSequence: 2 }, [spare.loanBrokerId]: { index: spare.loanBrokerId, LoanSequence: 1 },
        [escrowIndex]: { index: escrowIndex, LedgerEntryType: 'Escrow', Account: col.borrower, Destination: address, Amount: { mpt_issuance_id: f.share, value: '5000000' } },
      },
      owned: { [address]: [{ index: escrowIndex, LedgerEntryType: 'Escrow', Account: col.borrower, Destination: address, Amount: { mpt_issuance_id: f.share, value: '5000000' } }] },
      accounts: { [address]: { account_data: { Account: address, Flags: 0x00100000, OwnerCount: 2 }, signer_lists: [{ SignerQuorum: 2, SignerEntries: [col.borrower, col.desk, col.agent].map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })) }] } },
      mptokens: { [`${f.share}:${address}`]: { Account: address, MPTokenIssuanceID: f.share } },
      txs: { [col.borrower]: [{ hash: hex64('99'), ledger_index: 900, validated: true, tx_json: { TransactionType: 'LoanSet', Account: col.borrower, LoanBrokerID: desk.loanBrokerId, Memos: [{ Memo: { MemoType: Buffer.from('orma.escrow').toString('hex').toUpperCase(), MemoData: escrowIndex } }] }, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'Loan', LedgerIndex: loan.index, NewFields: { LoanBrokerID: desk.loanBrokerId } } }] } }] },
    })
    // the desk loan, served beside the pledged vault's own loans
    const original = x.req.bind(x)
    x.req = async (p) => (p.command === 'ledger_entry' && p.loan?.loan_broker_id === desk.loanBrokerId
      ? (p.loan.loan_seq === 1 ? { result: { node: loan, ledger_index: x.st.L } } : Promise.reject(Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })))
      : original(p))
    const reader = fakeReader([f], x)
    const server = createApi(reader, { port: 0, nyc: createNyc({ reader, env: {} }) })
    await server.listen()
    try {
      const r = await fetch(`http://127.0.0.1:${server.server.address().port}/api/desk/positions`)
      return { status: r.status, body: await r.json() }
    } finally {
      await server.close()
    }
  }
  const okR = await serve(meridian())
  eq('200, one line backed by its escrow, conforming', [okR.status, okR.body.positions?.length, okR.body.positions?.[0]?.collateral?.[0]?.account?.conforming], [200, 1, true])
  const badR = await serve(meridian({ aa: 41000000, lu: 10000001 }))
  eq('a pledged share whose vault is inconsistent: 409 INCONSISTENT_SNAPSHOT', [badR.status, badR.body.error?.code], [409, 'INCONSISTENT_SNAPSHOT'])
}

// --- properties P1 to P5 -----------------------------------------------------------------------------------

/** A consistent XRP vault at Scale 0, 0 to 3 loans, units worth something, a mandate and a principal. */
function draw(rand, { noYield = false } = {}) {
  const big = (max) => BigInt(Math.floor(rand() * Number(max))) // a draw below max; only the drawn digits are kept
  const shares = 1n + big(10n ** 12n)
  const at = noYield ? big(shares + 1n) : big(10n ** 15n)
  const aa = at === 0n ? 0n : big(at + 1n)
  const lu = at - aa === 0n ? 0n : big(at - aa + 1n)
  const maybe = (v) => (v === 0n && rand() < 0.5 ? null : v.toString())
  const loans = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({
    PrincipalOutstanding: big(10n ** 12n).toString(), TotalValueOutstanding: big(10n ** 12n).toString(), ManagementFeeOutstanding: '0',
    Flags: rand() < 0.3 ? 0x00020000 : 0, NextPaymentDueDate: CT - 100 - i, GracePeriod: 60,
  }))
  const units = 1n + big(shares)
  return {
    shares: shares.toString(), at: at.toString(), aa: maybe(aa), lu: maybe(lu), loans, units: units.toString(),
    debt: big(10n ** 13n).toString(), cover: big(10n ** 12n).toString(),
    maxLtvBps: Math.floor(rand() * 10001), maxSingle: big(10n ** 13n).toString(), principal: (1n + big(10n ** 13n)).toString(),
  }
}

/** The ticket inputs of a drawn case, without a network. */
function inputsFromCase(c, { reorder = false } = {}) {
  const f = vaultFixture({ at: c.at, aa: c.aa ?? 0, lu: c.lu, shares: c.shares, loans: c.loans, debt: c.debt, cover: c.cover })
  if (c.aa === null) delete f.vault.AssetsAvailable
  const flip = (o) => (reorder ? Object.fromEntries(Object.entries(o).reverse()) : o)
  return {
    ledgerIndex: 1000, ledgerHash: hashOf(1000), closeTime: CT,
    vault: { id: f.id, fields: flip(f.vault), raw: flip(f.vault) }, issuance: { id: f.share, fields: flip(f.issuance), raw: f.issuance },
    brokers: [{ id: f.broker.index, fields: flip(f.broker), raw: f.broker, loans: (reorder ? [...f.loans].reverse() : f.loans).map((l) => ({ id: l.index, label: `L${l.LoanSequence}`, fields: flip(l), raw: l })) }],
    conduct: { recognitionLagSeconds: [], defaultsWithoutImpairment: 0, coverOrderCostDrops: '0' },
    _fixture: f,
  }
}

const mandateOfCase = (c) => ({ ...MANDATE_PASS, limits: { maxLtvBps: c.maxLtvBps, maxSingleLoanDrops: c.maxSingle, maxN2LossDrops: '1000000000000', maxLockupDays: 3650 } })
const consistent = (c) => {
  const i = inputsFromCase(c)
  return judgeSnapshot({ vault: i._fixture.vault, issuance: i._fixture.issuance, shareMptId: i._fixture.share, ledgerIndex: 1000, readAt: [1000] }).consistent
}
const worthSomething = (c) => num(evaluateFormula('heldValue', [['AssetsTotal', c.at], ['LossUnrealized', c.lu ?? '0'], ['OutstandingAmount', c.shares], ['Scale', '0'], ['units', c.units]].map(([name, value]) => ({ name, value })))).gt(0)
const ticketOf = (c, o) => buildTicket(inputsFromCase(c, o), { op: 'pledge', units: c.units, mandate: mandateOfCase(c), principalDrops: c.principal })

function properties() {
  console.log('properties P1 to P5')
  const seed = seedFrom(process.argv)
  const gen = (rand) => {
    for (;;) {
      const c = draw(rand)
      if (consistent(c) && worthSomething(c)) return c
    }
  }
  const keep = (prop) => (c) => (!consistent(c) || !worthSomething(c) ? true : prop(c)) // a shrunk case must stay a case
  const results = [
    forAll({ name: 'P1 heldValue ≤ naiveValue', seed, gen, prop: keep((c) => {
      const t = ticketOf(c)
      return num(t.figures.heldValue.value).lte(t.figures.naiveValue.value) || `held ${t.figures.heldValue.value} > naive ${t.figures.naiveValue.value}`
    }) }),
    forAll({ name: 'P2 more LossUnrealized never raises heldValue nor maxLoan', seed: seed + 1, gen, prop: keep((c) => {
      const room = num(c.at).minus(c.aa ?? 0).minus(c.lu ?? 0)
      if (room.lte(0)) return true
      const more = { ...c, lu: num(c.lu ?? 0).plus(room.div(2).ceil()).toFixed(0) }
      if (!worthSomething(more)) return true
      const a = ticketOf(c), b = ticketOf(more)
      return (num(b.figures.heldValue.value).lte(a.figures.heldValue.value) && num(b.figures.maxLoan.value).lte(a.figures.maxLoan.value)) || `held ${a.figures.heldValue.value} → ${b.figures.heldValue.value}, maxLoan ${a.figures.maxLoan.value} → ${b.figures.maxLoan.value}`
    }) }),
    forAll({ name: 'P3 PASS ⇒ ltvHeld ≤ maxLtvBps and requested ≤ maxSingleLoanDrops', seed: seed + 2, gen, prop: keep((c) => {
      const t = ticketOf(c)
      if (t.verdict.status !== 'PASS') return true
      return (num(t.figures.ltvHeld.value).lte(c.maxLtvBps) && num(t.figures.requested.value).lte(c.maxSingle)) || `PASS with ltvHeld ${t.figures.ltvHeld.value} over ${c.maxLtvBps}`
    }) }),
    forAll({ name: 'P4 lender1to1 ≤ ltvHeld on a vault without yield', seed: seed + 3, gen: (rand) => {
      for (;;) {
        const c = draw(rand, { noYield: true })
        if (consistent(c) && worthSomething(c)) return c
      }
    }, prop: keep((c) => {
      if (num(c.at).gt(c.shares)) return true
      const t = ticketOf(c)
      return num(t.figures.lender1to1.value).lte(t.figures.ltvHeld.value) || `lender1to1 ${t.figures.lender1to1.value} > ltvHeld ${t.figures.ltvHeld.value}`
    }) }),
    forAll({ name: 'P5 the same inputs ⇒ the same ticketId and inputsDigest', seed: seed + 4, gen, prop: keep((c) => {
      const a = ticketOf(c), b = ticketOf(c, { reorder: true })
      return (a.ticketId === b.ticketId && a.inputsDigest === b.inputsDigest) || 'another ticketId or inputsDigest for the same inputs in another key order'
    }) }),
  ]
  eq('the five properties hold', results, [true, true, true, true, true])
  // P4 is false by construction on a vault that earned interest: it is worth more than par
  const yielding = { shares: '1000000', at: '1500000', aa: '1500000', lu: '0', loans: [], units: '1000000', debt: '0', cover: '0', maxLtvBps: 9000, maxSingle: '10000000', principal: '600000' }
  const y = ticketOf(yielding)
  eq('a fixed counter-example: on a vault with yield, lender1to1 is above ltvHeld', num(y.figures.lender1to1.value).gt(y.figures.ltvHeld.value), true)
}

// --- every figure replayed, and the greps --------------------------------------------------------------

function formulasAndGreps() {
  console.log('every Figure, replayed by its formula')
  const figures = (t) => [t.figures.heldValue, t.figures.naiveValue, t.figures.n1Overpayment, ...t.figures.n2.flatMap((e) => [e.lossAfterCover, e.cover, e.heldPerUnitIfDefault]), t.figures.n3.lockedUntil, t.figures.n3.cashAvailable, t.figures.n3.claim, t.figures.maxLoan, t.figures.maxUnits, t.figures.requested, t.figures.ltvHeld, t.figures.lender1to1].filter(Boolean)
  const off = []
  for (const t of tickets) {
    for (const f of figures(t)) {
      const formula = FORMULAS[f.formulaId]
      const names = f.inputs.map((i) => i.name)
      if (!formula) off.push(`${f.formulaId}: not a formula`)
      else if (names.length !== formula.inputs.length || formula.inputs.some((n) => names.filter((x) => x === n).length !== 1)) off.push(`${f.formulaId}: inputs ${names.join(',')}`)
      else if (!new Decimal(evaluateFormula(f.formulaId, f.inputs)).eq(f.value)) off.push(`${f.formulaId}: ${f.value} is not what its formula gives`)
    }
  }
  eq(`each Figure of the ${tickets.length} tickets: a formula of FORMULAS, one input per name, its value replayed`, off, [])
  eq('no grade key in any ticket', tickets.filter((t) => JSON.stringify(t).includes('"grade"')).length, 0)
  console.log('greps under src/ticket/ (I1)')
  const dir = new URL('../ticket/', import.meta.url)
  const hits = readdirSync(dir).filter((f) => f.endsWith('.mjs')).flatMap((f) => readFileSync(new URL(f, dir), 'utf8').split(/\r?\n/).map((l, i) => [f, i + 1, l]))
    .filter(([, , l]) => /Number\(|parseFloat\(|PreviousFields/.test(l)).map(([f, i]) => `${f}:${i}`)
  eq('no Number(, parseFloat( nor PreviousFields under src/ticket/', hits, [])
}

// --- live ----------------------------------------------------------------------------------------------

async function live() {
  const base = process.env.API_BASE
  if (!base) {
    console.log('  FAIL --live needs API_BASE: run it under src/dev/with-api.mjs')
    bad++
    return
  }
  const h1 = JSON.parse(readFileSync('demo/harbor-1.json', 'utf8'))
  const desk = JSON.parse(readFileSync('demo/desk.json', 'utf8'))
  const r = await fetch(`${base}/api/tickets?share=${h1.shareMptId}&op=pledge&units=${desk.plannedLoan.units}&mandate=desk-1`)
  const t = await r.json()
  eq('Harbor-1 pledge ticket: 200, orma.ticket/1', [r.status, t.schema], [200, 'orma.ticket/1'])
  if (r.status !== 200) return
  eq('it passes SCHEMAS.ticket', SCHEMAS.ticket(t), [])
  const all = JSON.stringify(t)
  const pairs = new Set([...all.matchAll(/"ledgerIndex":(\d+),"ledgerHash":"([0-9A-F]{64})"/g)].map((m) => `${m[1]}:${m[2]}`))
  eq('one ledgerIndex and ledgerHash throughout', [pairs.size, pairs.has(`${t.ledgerIndex}:${t.ledgerHash}`)], [1, true])
  eq('n1Overpayment strictly positive (L1 impaired since the bake)', num(t.figures.n1Overpayment.value).gt(0), true)
  eq("the manager's statement is CONSISTENT", t.statement?.consistency?.status, 'CONSISTENT')
}

// --- run, once everything above is defined ----------------------------------------------------------------

if (process.argv.includes('--live')) await live()
else await offline()

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
