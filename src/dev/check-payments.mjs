// Check of step 22 (addendum A12): the payment record of every ticket, read at the ticket's ledger from the
// Loan objects it already reads. Offline, end to end through readTicketInputs on a fake rippled: pastDue 0
// at and before the due date and exact to the second after it; paymentsMissed 1 a second after the due date,
// 2 an interval later, capped at PaymentRemaining; a loan in grace overdue and absent from n2, one past grace
// defaultable and in both under one label; a defaulted loan with no due date; a closed loan absent; the
// recognition lag of an impaired loan from its impairment on record; the summary counting the entries; the
// digest unchanged by the record; a property test over random schedules with its seed; no PreviousFields
// read. --live, read only, under with-api.mjs: the ticket of each Harbor share carries its record, each
// pastDue cites the Loan's NextPaymentDueDate at the ticket's ledger, equal to a fresh read at that ledger.
//   node src/dev/check-payments.mjs
//   node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-payments.mjs --live
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { num, Decimal } from '../num.mjs'
import { SCHEMAS, canonical, sha256Hex } from '../nyc/contracts.mjs'
import { buildTicket, evaluateFormula, inputsDigest } from '../ticket/engine.mjs'
import { readTicketInputs, issuanceIdOf } from '../ticket/inputs.mjs'
import { normaliseLoan } from '../xrpl.mjs'
import { FLAG } from '../history.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const hex64 = (c) => c.repeat(64).slice(0, 64)
const CT = 846200000 // close_time of the fake ledger, Ripple seconds
const L = 1000
const H = hex64('E')
const PSEUDO = 'rNd25qaV5J3T1oSuexK1R8881mp9ajVAKv'
const OWNER = 'rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo'
const BORROWER = 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv'
const VAULT = hex64('A')
const BROKER = hex64('B')
const SHARE = issuanceIdOf({ Issuer: PSEUDO, Sequence: 1 })
const LSF_DEFAULT = 0x00010000
const LSF_IMPAIRED = 0x00020000
const MANDATE = {
  schema: 'orma.mandate/1', id: 'desk-1', desk: 'Test desk (fictional)', riskOfficer: OWNER, hash: hex64('9'), anchorTx: hex64('8'),
  limits: { maxLtvBps: 6000, maxSingleLoanDrops: '1000000', maxN2LossDrops: '100000000', maxLockupDays: 30 },
  policy: { escrowFinish: 'only-after-default', finishAfterMarginSeconds: 14400, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 },
}

/**
 * A vault of one broker and the given loans, as rippled serves them at L, with an impairment history for
 * the loans whose `impairedAt` is set (a LoanManage tfLoanImpair at that Ripple time).
 */
function world(loans, { totalLoss = '0' } = {}) {
  const objects = loans.map((l, i) => {
    const { impairedAt: _a, ...fields } = l
    void _a
    return { index: hex64(String(i + 1)), LoanBrokerID: BROKER, LoanSequence: i + 1, Borrower: BORROWER, PrincipalOutstanding: '1000000', TotalValueOutstanding: '1000000', GracePeriod: 60, PaymentInterval: 600, PaymentRemaining: 3, ...fields }
  })
  const debt = objects.reduce((s, o) => s.plus(num(o.PrincipalOutstanding)), num(0)).toFixed(0)
  const vault = { index: VAULT, Account: PSEUDO, Owner: OWNER, ShareMPTID: SHARE, Asset: { currency: 'XRP' }, VaultKind: 1, LEVersion: 1, AssetsTotal: '51000000', AssetsAvailable: '41000000', LossUnrealized: totalLoss, Scale: 0, RedemptionDate: 847598400 }
  const issuance = { Issuer: PSEUDO, Sequence: 1, mpt_issuance_id: SHARE, OutstandingAmount: '51000000', Flags: 0x38 }
  const broker = { index: BROKER, VaultID: VAULT, Owner: OWNER, LoanSequence: objects.length + 1, DebtTotal: debt, CoverAvailable: '2000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000 }
  const txs = loans.map((l, i) => (l.impairedAt === undefined ? null : {
    hash: hex64(String.fromCharCode(70 + i)), ledger_index: 900 + i, validated: true,
    tx_json: { TransactionType: 'LoanManage', Account: OWNER, LoanID: objects[i].index, Flags: FLAG.IMPAIR, date: l.impairedAt },
    meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'Loan', LedgerIndex: objects[i].index, FinalFields: { LoanBrokerID: BROKER } } }] },
  })).filter(Boolean).reverse()
  const notFound = () => Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
  const xrpl = {
    lastLedger: L, lastLedgerHash: H, lastCloseTime: CT,
    async closeTime() { return CT },
    async accountTxWindow() { return { transactions: txs, ledgerMin: 1, ledgerMax: L, truncated: false } },
    async req(p) {
      if (p.command === 'vault_info') return { result: { vault: { ...vault, shares: issuance }, ledger_index: L } }
      if (p.command === 'ledger_entry') {
        const node = p.mpt_issuance ? issuance : p.loan ? objects.find((o) => o.LoanSequence === p.loan.loan_seq) : null
        if (!node) throw notFound()
        return { result: { node, ledger_index: L } }
      }
      if (p.command === 'account_objects') return { result: { account_objects: [broker], ledger_index: L } }
      throw new Error(`fake rippled: no ${p.command}`)
    },
  }
  const reader = { getByShareMpt: (id) => (String(id).toUpperCase() === SHARE ? { vaultId: VAULT } : null) }
  return { xrpl, reader, objects }
}
const at = { ledgerIndex: L, ledgerHash: H, closeTime: CT }
const ticketOf = async (loans, { history = true, op = 'pledge', o } = {}) => {
  const w = world(loans, o)
  const inputs = await readTicketInputs(w.xrpl, { shareMptId: SHARE, reader: w.reader, at, history })
  return { t: buildTicket(inputs, { op, units: '1000000', mandate: MANDATE, ...(op === 'pledge' && { principalDrops: '300000' }) }), w, inputs }
}
const entry = (t, i = 0) => t.figures.payments[i]

if (process.argv.includes('--live')) await live()
else await offline()
console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0

async function offline() {
  console.log('pastDue and the payments missed, to the second')
  {
    const cases = [['100 s before the due date', 100], ['at the due date', 0], ['1 s after', -1], ['one interval (600 s) after', -600], ['599 s after', -599], ['ten intervals after, 3 payments left', -6000]]
    const got = []
    for (const [, offset] of cases) {
      const { t } = await ticketOf([{ NextPaymentDueDate: CT + offset }])
      got.push([entry(t).pastDue.value, entry(t).paymentsMissed])
    }
    eq(cases.map(([n]) => n).join('; '), got, [['0', 0], ['0', 0], ['1', 1], ['600', 2], ['599', 1], ['6000', 3]])
    const { t } = await ticketOf([{ NextPaymentDueDate: CT - 1 }])
    eq('the pastDue figure: REAL, its formula, its two inputs read at L (the Loan\'s NextPaymentDueDate, the ledger\'s close_time), recomputable',
      [entry(t).pastDue.provenance, entry(t).pastDue.formulaId, entry(t).pastDue.inputs.map((i) => [i.name, i.object, i.value, i.ledgerIndex]), evaluateFormula('pastDue', entry(t).pastDue.inputs)],
      ['REAL', 'pastDue', [['NextPaymentDueDate', 'Loan', String(CT - 1), L], ['close_time', 'Ledger', String(CT), L]], '1'])
    eq('the due date and the end of grace as ISO times; the schedule as the Loan states it',
      [entry(t).nextPaymentDueAt, entry(t).graceEndsAt, entry(t).paymentRemaining, entry(t).paymentIntervalSeconds],
      [new Date((CT - 1 + 946684800) * 1000).toISOString(), new Date((CT + 59 + 946684800) * 1000).toISOString(), 3, 600])
  }

  console.log('the reader\'s ladder, and the default scenarios of n2')
  {
    const { t } = await ticketOf([
      { NextPaymentDueDate: CT + 100000 }, // current
      { NextPaymentDueDate: CT + 30 }, // due soon (the last tenth of a 600 s interval)
      { NextPaymentDueDate: CT - 30 }, // past due, in grace
      { NextPaymentDueDate: CT - 120 }, // past due, grace ended
      { NextPaymentDueDate: CT - 900, Flags: LSF_IMPAIRED }, // impaired
      { Flags: LSF_DEFAULT, PrincipalOutstanding: undefined, TotalValueOutstanding: undefined }, // defaulted: rippled deletes the due date
      { PaymentRemaining: 0, PrincipalOutstanding: '0', TotalValueOutstanding: '0' }, // closed: no due date, not defaulted
    ])
    const p = t.figures.payments
    eq('one entry per loan not closed, in LoanSequence order, with the n2 labels', p.map((e) => [e.label, e.status]),
      [['L1', 'current'], ['L2', 'due_soon'], ['L3', 'overdue'], ['L4', 'defaultable'], ['L5', 'impaired'], ['L6', 'defaulted']])
    eq('a loan in grace is overdue and absent from n2; one past grace is defaultable and in both, same loanId and label',
      [t.figures.n2.some((n) => n.loanId === p[2].loanId), t.figures.n2.find((n) => n.loanId === p[3].loanId)?.label], [false, 'L4'])
    eq('every scenario of n2 is an entry of the record under the same label', t.figures.n2.map((n) => p.find((e) => e.loanId === n.loanId)?.label === n.label), t.figures.n2.map(() => true))
    eq('a defaulted loan: no due date, no end of grace, no pastDue, no payments missed', [p[5].nextPaymentDueAt, p[5].graceEndsAt, p[5].pastDue, p[5].paymentsMissed], [null, null, null, null])
    eq('the closed loan is absent', p.some((e) => e.label === 'L7'), false)
    eq('the summary counts the entries: 6 loans, 3 past due, 2 past grace, 1 impaired, 1 defaulted, the worst L5 at 900 s',
      t.figures.paymentSummary, { loans: 6, pastDue: 3, pastGrace: 2, impaired: 1, defaulted: 1, worstLoanId: p[4].loanId, worstPastDueSeconds: '900' })
    eq('the ticket passes SCHEMAS.ticket', SCHEMAS.ticket(t), [])
    const { t: none } = await ticketOf([{ NextPaymentDueDate: CT + 5000 }])
    eq('nothing past due: worstLoanId null, worstPastDueSeconds "0"', [none.figures.paymentSummary.pastDue, none.figures.paymentSummary.worstLoanId, none.figures.paymentSummary.worstPastDueSeconds], [0, null, '0'])
    const { t: buy } = await ticketOf([{ NextPaymentDueDate: CT - 120 }], { op: 'buy' })
    eq('a buy ticket carries the same record', [buy.figures.payments.length, buy.figures.payments[0].status, SCHEMAS.ticket(buy)], [1, 'defaultable', []])
  }

  console.log('the recognition lag of an impaired loan, from its impairment on record')
  {
    const loans = [{ NextPaymentDueDate: CT - 900, Flags: LSF_IMPAIRED, impairedAt: CT - 900 + 101 }, { NextPaymentDueDate: CT - 120 }]
    const { t } = await ticketOf(loans)
    eq('impaired 101 s after its due date: recognitionLagSeconds "101", the late loan never impaired null', [entry(t, 0).recognitionLagSeconds, entry(t, 1).recognitionLagSeconds], ['101', null])
    eq('the same lag the conduct reports', t.conduct.recognitionLagSeconds, ['101'])
    const { t: bare } = await ticketOf(loans, { history: false })
    eq('without history: null', entry(bare, 0).recognitionLagSeconds, null)
  }

  console.log('the digest covers the same inputs as before')
  {
    const { t } = await ticketOf([{ NextPaymentDueDate: CT - 30 }, { NextPaymentDueDate: CT - 120 }])
    const { payments: _p, paymentSummary: _s, ...rest } = t.figures
    void [_p, _s]
    eq('inputsDigest is the digest of the figures without the payment record', t.inputsDigest, inputsDigest(rest))
    const { t: moved } = await ticketOf([{ NextPaymentDueDate: CT - 50 }, { NextPaymentDueDate: CT - 120 }])
    eq('a loan in grace whose due date moves changes the record, not the digest', [moved.figures.payments[0].pastDue.value !== t.figures.payments[0].pastDue.value, moved.inputsDigest === t.inputsDigest], [true, true])
  }

  console.log('a property test over random schedules')
  {
    const seed = Number(process.env.PAYMENTS_SEED ?? 2201)
    console.log(`    seed ${seed} (PAYMENTS_SEED=${seed} replays it)`)
    let s = seed
    const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
    let wrong = 0
    let invalid = 0
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rand() * 4)
      const loans = Array.from({ length: n }, () => {
        const interval = 60 + Math.floor(rand() * 7200)
        const remaining = 1 + Math.floor(rand() * 12)
        const grace = Math.floor(rand() * 600)
        const offset = Math.floor((rand() - 0.6) * interval * 6)
        const r = rand()
        const flags = r < 0.1 ? LSF_DEFAULT : r < 0.25 ? LSF_IMPAIRED : 0
        return flags === LSF_DEFAULT
          ? { Flags: flags, PaymentInterval: interval, PaymentRemaining: remaining, GracePeriod: grace, PrincipalOutstanding: undefined }
          : { Flags: flags, PaymentInterval: interval, PaymentRemaining: remaining, GracePeriod: grace, NextPaymentDueDate: CT - offset }
      })
      const { t, w } = await ticketOf(loans, { history: false })
      if (SCHEMAS.ticket(t).length) invalid++
      for (const [k, o] of w.objects.entries()) {
        const e = t.figures.payments.find((x) => x.loanId === o.index)
        const status = normaliseLoan(o, CT).status
        if (status === 'closed') { if (e) wrong++; continue }
        if (!e || e.status !== status) { wrong++; continue }
        if (status === 'defaulted') { if (e.pastDue !== null || e.paymentsMissed !== null) wrong++; continue }
        const late = num(CT).minus(o.NextPaymentDueDate)
        const pastDue = Decimal.max(0, late).toFixed(0)
        const missed = late.lte(0) ? 0 : JSON.parse(Decimal.min(o.PaymentRemaining, late.div(o.PaymentInterval).floor().plus(1)).toFixed(0))
        if (e.pastDue.value !== pastDue || e.paymentsMissed !== missed || e.label !== `L${k + 1}`) wrong++
      }
    }
    eq('300 random vaults of 1 to 4 loans: every entry the reader\'s status, pastDue and the missed count recomputed independently, every ticket valid', [wrong, invalid], [0, 0])
  }

  console.log('the source')
  {
    const offenders = readdirSync('src/ticket').filter((f) => f.endsWith('.mjs') && /PreviousFields/.test(readFileSync(join('src/ticket', f), 'utf8')))
    eq('no PreviousFields under src/ticket/ (the record re-reads the Loan objects)', offenders, [])
    const engine = readFileSync('src/ticket/engine.mjs', 'utf8')
    eq('no Number( nor parseFloat( in the ticket engine', /\bNumber\(|parseFloat\(/.test(engine), false)
    // the banned word, built from two halves so that no file of the repository spells it
    const banned = new RegExp(['delin', 'quent'].join(''), 'i')
    eq('the words: never the banned word for a late loan, in the engine or on the desk screen', banned.test(engine + readFileSync('app/src/screens/Desk.tsx', 'utf8')), false)
  }
  void canonical
  void sha256Hex
}

async function live() {
  const base = process.env.API_BASE
  if (!base) {
    console.log('  API_BASE is not set: run under src/dev/with-api.mjs')
    bad++
    return
  }
  const { Xrpl } = await import('../xrpl.mjs')
  const plan = JSON.parse(readFileSync('demo/desk.json', 'utf8')).plannedLoan
  const x = new Xrpl(process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233')
  await x.connect()
  try {
    for (const label of ['harbor-1', 'harbor-2', 'harbor-3']) {
      const share = JSON.parse(readFileSync(`demo/${label}.json`, 'utf8')).shareMptId
      let r = null
      for (let i = 0; i < 6; i++) {
        r = await fetch(`${base}/api/tickets?share=${share}&op=pledge&units=${plan.units}&mandate=desk-1`, { signal: AbortSignal.timeout(60000) })
        if (r.status !== 503) break
        await new Promise((ok) => setTimeout(ok, 5000))
      }
      const t = await r.json()
      console.log(`${label} at ledger ${t.ledgerIndex}`)
      eq(`${label}: the ticket is valid and carries its payment record`, [r.status, SCHEMAS.ticket(t), Array.isArray(t.figures?.payments) && t.figures.payments.length > 0], [200, [], true])
      if (r.status !== 200) continue
      const due = t.figures.payments.filter((e) => e.pastDue)
      const fresh = []
      for (const e of due) {
        const node = (await x.req({ command: 'ledger_entry', index: e.loanId, ledger_index: t.ledgerIndex })).result.node
        const input = e.pastDue.inputs.find((i) => i.name === 'NextPaymentDueDate')
        fresh.push([e.label, input.object === 'Loan' && input.id === e.loanId && input.ledgerIndex === t.ledgerIndex, input.value === String(node.NextPaymentDueDate), evaluateFormula('pastDue', e.pastDue.inputs) === e.pastDue.value])
      }
      eq(`${label}: each pastDue cites the Loan's NextPaymentDueDate at the ticket's ledger, equal to a fresh read there, and recomputes`, fresh.every(([, a, b, c]) => a && b && c), true)
      console.log(`    ${t.figures.payments.map((e) => `${e.label} ${e.status}${e.pastDue ? `, past due ${e.pastDue.value} s, ${e.paymentsMissed} of ${e.paymentRemaining} missed` : ''}`).join('; ')}`)
    }
  } finally {
    await x.disconnect().catch(() => {})
  }
}
