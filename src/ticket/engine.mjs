/**
 * orma.ticket/1 and the desk's positions, pure: everything an operation can cost, at one ledger, each
 * figure with its closed formula and its inputs. Collateral is valued at its withdrawal value only (I1);
 * a manager's statement enters no figure (I6). No network: the inputs come from src/ticket/inputs.mjs.
 * Ledger integers are kept as rippled sends them and amounts go through Decimal; flags are tested as
 * BigInt.
 */
import { num, Decimal, wholeShares, isoToRipple } from '../num.mjs'
import { normaliseLoan } from '../xrpl.mjs'
import { FORMULAS, canonical, sha256Hex, parseStatement, statementConsistency, USD_COLLATERAL_RULE, usdTermsHash } from '../nyc/contracts.mjs'

const LSF_LOAN_DEFAULT = 0x00010000n
const LSF_LOAN_IMPAIRED = 0x00020000n
const RIPPLE_EPOCH = 946684800

/** The escrow policy as the ticket states it (D-W88): the window, the 2-of-3 account, the agent's rule. */
export const ESCROW_POLICY_TEXT = "anyone may finish the escrow between FinishAfter and CancelAfter; the shares then sit in a 2-of-3 collateral account {borrower, desk, Orma agent} whose master key is disabled, so no single party can move them; the Orma agent's published rule: it co-signs their transfer to the desk only if the loan is in default, back to the borrower only if it is repaid without default, and nothing otherwise; borrower and desk together can always move them"

const flag = (flags, bit) => (BigInt(num(flags).toFixed(0)) & bit) !== 0n
const ledgerInt = (v) => (Number.isSafeInteger(v) ? v : 0)
/** A whole number of bps as a JSON number (a ratio, never an amount). */
const bpsOf = (d) => JSON.parse(d.floor().toFixed(0))
const rippleIso = (t) => (Number.isSafeInteger(t) ? new Date((t + RIPPLE_EPOCH) * 1000).toISOString() : null)

/**
 * The value of a Figure: exactly its formula (FORMULAS[formulaId]) and its rounding, on its named inputs
 * alone. The only function that computes a figure of a ticket, and the one RECOMPUTE replays.
 *   s = wholeShares(OutstandingAmount, Scale), u = wholeShares(units, Scale)
 *   perUnit(x) = (x / s).toFixed(6) ROUND_HALF_UP (0 when s is 0, as Reader.nav)
 *   value(p) = (u × p).toFixed(0) ROUND_HALF_UP (valuePledge at Scale 0)
 *   floor(x) = x.toFixed(0, ROUND_DOWN)
 *   exp = PrincipalOutstanding when LEVersion is 1, else TotalValueOutstanding − ManagementFeeOutstanding
 * @param {import('../nyc/contracts.mjs').FormulaId} formulaId
 * @param {{ name: string, value: string }[]} inputs
 * @returns {string}
 */
export function evaluateFormula(formulaId, inputs) {
  const formula = FORMULAS[formulaId]
  if (!formula) throw new RangeError(`no formula ${JSON.stringify(formulaId)}`)
  const named = new Map(inputs.map((i) => [i.name, i.value]))
  for (const name of formula.inputs) if (!named.has(name)) throw new RangeError(`${formulaId} needs the input ${name}`)
  const v = (name) => num(named.get(name))
  const s = () => wholeShares(v('OutstandingAmount'), v('Scale'))
  const u = () => wholeShares(v('units'), v('Scale'))
  const perUnit = (x) => (s().isZero() ? new Decimal(0) : new Decimal(x.div(s()).toFixed(6)))
  const value = (p) => new Decimal(u().times(p).toFixed(0))
  const floor = (x) => x.toFixed(0, Decimal.ROUND_DOWN)
  const exp = () => (v('LEVersion').eq(1) ? v('PrincipalOutstanding') : v('TotalValueOutstanding').minus(v('ManagementFeeOutstanding')))
  const cover = () => Decimal.min(v('DebtTotal').times(v('CoverRateMinimum').div(1e5)).times(v('CoverRateLiquidation').div(1e5)).ceil(), exp(), v('CoverAvailable'))
  const impaired = () => flag(v('Flags'), LSF_LOAN_IMPAIRED)
  const held = () => value(perUnit(v('AssetsTotal').minus(v('LossUnrealized'))))
  const ifDefault = () => perUnit(v('AssetsTotal').minus(exp().minus(cover())).minus(v('LossUnrealized').minus(impaired() ? exp() : 0)))
  // usd(d): d drops at the XRP/USD price of the terms' oracles, less the haircut, rounded down to a millionth of a dollar
  const usd = (d) => new Decimal(d.div(1e6).times(v('xrpUsd')).times(new Decimal(1).minus(v('fxHaircutBps').div(10000))).toFixed(6, Decimal.ROUND_DOWN))
  switch (formulaId) {
    case 'heldValue':
    case 'claim':
      return held().toFixed(0)
    case 'naiveValue':
      return value(perUnit(v('AssetsTotal'))).toFixed(0)
    case 'n1Overpayment':
      return value(perUnit(v('AssetsTotal'))).minus(held()).toFixed(0)
    case 'cover':
      return cover().toFixed(0)
    case 'heldPerUnitIfDefault':
      return ifDefault().toFixed(6)
    case 'lossAfterCover':
      return impaired() ? '0' : held().minus(value(ifDefault())).toFixed(0)
    case 'maxLoan':
      return floor(v('maxLtvBps').times(held()).div(10000))
    case 'maxUnits': {
      const p = perUnit(v('AssetsTotal').minus(v('LossUnrealized')))
      return p.isZero() ? '0' : floor(v('maxSingleLoanDrops').times(new Decimal(10).pow(v('Scale'))).div(p))
    }
    case 'requested':
      return v('principalDrops').toFixed(0)
    case 'ltvHeld': {
      const h = held()
      if (h.isZero()) throw new RangeError('these units are worth 0 at the withdrawal value: a pledge worth nothing has no LTV')
      return floor(v('principalDrops').times(10000).div(h))
    }
    case 'lender1to1': {
      const par = wholeShares(v('units'), v('Scale'))
      if (par.isZero()) throw new RangeError('no units: no LTV at 1:1')
      return floor(v('principalDrops').times(10000).div(par))
    }
    case 'cashAvailable':
      return v('AssetsAvailable').toFixed(0)
    case 'lockedUntil':
      return v('RedemptionDate').minus(v('close_time')).toFixed(0)
    // step 21: the same shares against a loan in the test dollar
    case 'collateralHeldUsd':
      return usd(held()).toFixed(6)
    case 'maxLoanUsd':
      return v('maxLtvBps').times(usd(held())).div(10000).toFixed(6, Decimal.ROUND_DOWN)
    case 'requestedUsd':
      return v('principalUsd').toFixed()
    case 'ltvHeldUsd': {
      const h = usd(held())
      if (h.isZero()) throw new RangeError('these units are worth 0 dollars at the withdrawal value: a pledge worth nothing has no LTV')
      return floor(v('principalUsd').times(10000).div(h))
    }
    case 'lender1to1Usd': {
      const par = usd(wholeShares(v('units'), v('Scale')))
      if (par.isZero()) throw new RangeError('no units: no LTV at 1:1')
      return floor(v('principalUsd').times(10000).div(par))
    }
    case 'priceAge':
      return v('close_time').minus(v('priceAsOf')).toFixed(0)
    // step 22: how long a loan is past its due date
    case 'pastDue':
      return Decimal.max(0, v('close_time').minus(v('NextPaymentDueDate'))).toFixed(0)
    default:
      throw new RangeError(`no evaluation for ${formulaId}`)
  }
}

/**
 * The ticket of one operation on a share, at the ledger its inputs were read at.
 *
 * Step 21 (addendum A11): with `usd`, a pledge against a loan in the test dollar, at `usd.price`, the
 * XRP/USD price readXrpUsd of src/fx/price.mjs read at the same ledger (REAL: the median of the terms'
 * oracle documents). Its loan figures are in dollars (maxLoanUsd, requestedUsd, collateralHeldUsd, ltvHeldUsd,
 * lender1to1Usd, priceAge) in place of maxLoan, requested, ltvHeld and lender1to1; the collateral figures are
 * the same; the verdicts judge the dollar loan; the ticket carries the usd block. Without `usd`, the ticket
 * is what it was.
 * @param {Awaited<ReturnType<import('./inputs.mjs').readTicketInputs>>} inputs
 * @param {{ op: 'pledge'|'buy', units: string, mandate: import('../nyc/contracts.mjs').Mandate, principalDrops?: string,
 *   usd?: { terms: import('../nyc/contracts.mjs').UsdTerms, principalUsd: string, price: import('../nyc/contracts.mjs').UsdReference, planId?: string } | null }} req
 * @returns {import('../nyc/contracts.mjs').Ticket}
 */
export function buildTicket(inputs, { op, units, mandate, principalDrops, usd = null }) {
  if (op !== 'pledge' && op !== 'buy') throw new RangeError(`op ${JSON.stringify(op)} is not pledge or buy`)
  if (usd && op !== 'pledge') throw new RangeError('a loan in dollars is a pledge: a buy has no loan currency')
  const L = inputs.ledgerIndex
  const H = inputs.ledgerHash
  const share = inputs.issuance.id
  const vault = inputs.vault.fields
  const input = (name, object, id, field, value) => ({ name, value: String(value ?? '0'), object, field, id, ledgerIndex: L, ledgerHash: H })
  const onVault = (name) => () => input(name, 'Vault', inputs.vault.id, name, vault[name])
  const sources = {
    AssetsTotal: onVault('AssetsTotal'),
    LossUnrealized: onVault('LossUnrealized'),
    AssetsAvailable: onVault('AssetsAvailable'),
    Scale: onVault('Scale'),
    LEVersion: onVault('LEVersion'),
    RedemptionDate: onVault('RedemptionDate'),
    OutstandingAmount: () => input('OutstandingAmount', 'MPTokenIssuance', share, 'OutstandingAmount', inputs.issuance.fields.OutstandingAmount),
    units: () => input('units', 'Request', share, 'units', units),
    principalDrops: () => input('principalDrops', 'Plan', mandate.id, 'plannedLoan.principalDrops', principalDrops),
    maxLtvBps: () => input('maxLtvBps', 'Mandate', mandate.id, 'limits.maxLtvBps', mandate.limits.maxLtvBps),
    maxSingleLoanDrops: () => input('maxSingleLoanDrops', 'Mandate', mandate.id, 'limits.maxSingleLoanDrops', mandate.limits.maxSingleLoanDrops),
    close_time: () => input('close_time', 'Ledger', String(L), 'close_time', inputs.closeTime),
    // step 21: the XRP/USD median of the terms' oracles read at L (REAL), the haircut of the terms (DECLARED), the dollar plan
    ...(usd && {
      xrpUsd: () => input('xrpUsd', 'OracleAggregate', usd.terms.id, 'median', usd.price.value),
      fxHaircutBps: () => input('fxHaircutBps', 'UsdTerms', usd.terms.id, 'fxHaircutBps', usd.terms.fxHaircutBps),
      priceAsOf: () => input('priceAsOf', 'OracleAggregate', usd.terms.id, 'asOf', isoToRipple(usd.price.asOf)),
      principalUsd: () => input('principalUsd', 'Plan', usd.planId ?? 'desk-usd', 'plannedLoan.principalUsd', usd.principalUsd),
    }),
  }
  /** A Figure: the inputs FORMULAS names, its value from evaluateFormula alone. */
  const figure = (formulaId, provenance, meaning, extra = {}) => {
    const formula = FORMULAS[formulaId]
    const used = formula.inputs.map((name) => (extra[name] ?? sources[name])())
    return { value: evaluateFormula(formulaId, used), unit: formula.unit, meaning, formula: formula.text, formulaId, inputs: used, provenance }
  }

  const figures = {
    heldValue: figure('heldValue', 'MODELLED', 'Withdrawal value of these shares (XLS-65 withdraw rate)'),
    naiveValue: figure('naiveValue', 'MODELLED', 'Value read by all (AssetsTotal / shares)'),
    n1Overpayment: figure('n1Overpayment', 'MODELLED', 'What a lender overpays by valuing the shares as read by all'),
    n2: [],
    n3: {
      lockedUntil: figure('lockedUntil', 'REAL', 'Seconds until the vault lets a holder redeem'),
      redemptionAt: rippleIso(vault.RedemptionDate),
      cashAvailable: figure('cashAvailable', 'REAL', 'Cash the vault holds today'),
      claim: figure('claim', 'MODELLED', 'What the shares claim at redemption, at the withdrawal value'),
    },
  }

  // N2: each late loan (past its grace period, not in default) defaulted alone, now.
  for (const b of inputs.brokers) {
    for (const loan of b.loans) {
      const f = loan.fields
      if (flag(f.Flags, LSF_LOAN_DEFAULT) || f.NextPaymentDueDate === undefined) continue
      if (!num(f.NextPaymentDueDate).plus(num(f.GracePeriod)).lt(inputs.closeTime)) continue
      const onBroker = (name) => () => input(name, 'LoanBroker', b.id, name, b.fields[name])
      const onLoan = (name) => () => input(name, 'Loan', loan.id, name, f[name])
      const extra = {
        DebtTotal: onBroker('DebtTotal'), CoverRateMinimum: onBroker('CoverRateMinimum'),
        CoverRateLiquidation: onBroker('CoverRateLiquidation'), CoverAvailable: onBroker('CoverAvailable'),
        PrincipalOutstanding: onLoan('PrincipalOutstanding'), TotalValueOutstanding: onLoan('TotalValueOutstanding'),
        ManagementFeeOutstanding: onLoan('ManagementFeeOutstanding'), Flags: onLoan('Flags'),
      }
      const alreadyInHeld = flag(f.Flags, LSF_LOAN_IMPAIRED)
      figures.n2.push({
        loanId: loan.id,
        label: loan.label,
        scenario: `if ${loan.label} defaults alone`,
        lossAfterCover: figure('lossAfterCover', 'MODELLED', alreadyInHeld ? 'already in the withdrawal value (impaired)' : `What these shares lose if ${loan.label} defaults alone, after cover`, extra),
        cover: figure('cover', 'MODELLED', 'First-loss cover the vault liquidates on this default', extra),
        heldPerUnitIfDefault: figure('heldPerUnitIfDefault', 'MODELLED', `Withdrawal value per share if ${loan.label} defaults alone`, extra),
        alreadyInHeld,
      })
    }
  }

  if (op === 'pledge' && !usd) {
    figures.maxLoan = figure('maxLoan', 'MODELLED', 'The largest loan the mandate allows against these shares')
    figures.requested = figure('requested', 'DECLARED', 'The principal the planned loan asks for')
    figures.ltvHeld = figure('ltvHeld', 'MODELLED', 'LTV at withdrawal value')
    figures.lender1to1 = figure('lender1to1', 'MODELLED', 'The same LTV for a lender at 1:1')
  } else if (op === 'buy') {
    figures.maxUnits = figure('maxUnits', 'MODELLED', 'The most share units the mandate lets the desk buy, at the withdrawal value')
  }
  if (usd) {
    // step 21: the same shares against dollars, in place of the drops figures of an XRP loan
    figures.maxLoanUsd = figure('maxLoanUsd', 'MODELLED', 'The largest dollar loan the mandate allows against these shares')
    figures.requestedUsd = figure('requestedUsd', 'DECLARED', 'The dollars the planned loan asks for')
    figures.collateralHeldUsd = figure('collateralHeldUsd', 'MODELLED', 'Withdrawal value of these shares in dollars, at the XRP/USD median of the oracles, less the haircut')
    figures.ltvHeldUsd = figure('ltvHeldUsd', 'MODELLED', 'LTV at withdrawal value, in dollars')
    figures.lender1to1Usd = figure('lender1to1Usd', 'MODELLED', 'The same dollar LTV for a lender at 1:1')
    figures.priceAge = figure('priceAge', 'REAL', 'Seconds since the oldest XRP/USD oracle document used was updated')
  }

  // step 22: the payment record of every loan of the vault not closed, read from the Loan objects at L
  const record = paymentsOf(inputs, input, figure)
  figures.payments = record.payments
  figures.paymentSummary = record.summary

  const worstN2 = figures.n2.reduce((m, e) => Decimal.max(m, num(e.lossAfterCover.value)), new Decimal(0))
  const lockup = num(mandate.limits.maxLockupDays).times(86400)
  const rowsFor = (ltv) => [
    ...(op === 'pledge' && usd
      ? [['maxLtvBps', num(ltv), num(mandate.limits.maxLtvBps)], ['maxSingleLoanUsd', num(figures.requestedUsd.value), num(usd.terms.maxSingleLoanUsd)]]
      : op === 'pledge'
        ? [['maxLtvBps', num(ltv), num(mandate.limits.maxLtvBps)], ['maxSingleLoanDrops', num(figures.requested.value), num(mandate.limits.maxSingleLoanDrops)]]
        : []),
    ['maxN2LossDrops', worstN2, num(mandate.limits.maxN2LossDrops)],
    ['maxLockupDays', num(figures.n3.lockedUntil.value), lockup],
  ]
  const verdictOf = (rows) => {
    const breaches = rows.filter(([, value, threshold]) => value.gt(threshold)).map(([limit, value, threshold]) => ({ limit, value: value.toFixed(), threshold: threshold.toFixed() }))
    return { status: breaches.length ? 'BREACHED' : 'PASS', breaches }
  }

  const shareDoc = { mptId: share, vaultId: inputs.vault.id, units, shareScale: ledgerInt(vault.Scale) }
  const ticket = {
    schema: 'orma.ticket/1',
    // step 21: a USD ticket also hashes its loan's asset and the terms; an XRP ticket's id is what it was
    ticketId: sha256Hex(canonical({ share: shareDoc, op, units, mandateHash: mandate.hash, ledgerIndex: L, ledgerHash: H, ...(usd && { loanAsset: { currency: 'USD', issuer: usd.terms.loanAsset.issuer }, usdTermsHash: usd.terms.hash }) })),
    inputsDigest: inputsDigest(figures),
    asOf: rippleIso(inputs.closeTime),
    ledgerIndex: L,
    ledgerHash: H,
    op,
    share: shareDoc,
    mandate: { id: mandate.id, hash: mandate.hash, anchorTx: mandate.anchorTx },
    figures,
    conduct: inputs.conduct,
    escrowPolicy: {
      finishAfter: `close_time + PaymentInterval + GracePeriod + ${mandate.policy.finishAfterMarginSeconds} s at the pledge; at approval, at least close_time(L) + PaymentInterval + GracePeriod + ${mandate.policy.approvalSlackSeconds} s`,
      cancelAfter: `FinishAfter + ${mandate.policy.cancelAfterOffsetSeconds} s`,
      text: ESCROW_POLICY_TEXT,
    },
    statement: statementOf(inputs),
    verdict: verdictOf(rowsFor(op === 'pledge' ? (usd ? figures.ltvHeldUsd.value : figures.ltvHeld.value) : '0')),
  }
  if (op === 'pledge') ticket.verdict1to1 = verdictOf(rowsFor(usd ? figures.lender1to1Usd.value : figures.lender1to1.value))
  if (usd) ticket.usd = usdBlockOf(usd.terms, figures, usd.price)
  return ticket
}

/**
 * The payment record of a ticket (step 22, addendum A12), one entry per loan of the vault that is not closed,
 * in the order the ticket reads them, with the labels of n2. The status is the reader's ladder
 * (normaliseLoan); paymentsMissed counts the payment due at NextPaymentDueDate and every scheduled payment
 * since, because NextPaymentDueDate advances only when a payment is made, at most PaymentRemaining. A
 * defaulted loan has no due date: rippled deletes it.
 */
function paymentsOf(inputs, input, figure) {
  const payments = []
  let pastGrace = 0
  for (const b of inputs.brokers) {
    for (const loan of b.loans) {
      const f = loan.fields
      const { status } = normaliseLoan(f, inputs.closeTime)
      if (status === 'closed') continue
      const dated = status !== 'defaulted' && Number.isSafeInteger(f.NextPaymentDueDate)
      const remaining = ledgerInt(f.PaymentRemaining)
      const interval = ledgerInt(f.PaymentInterval)
      let missed = null
      if (dated) {
        const late = num(inputs.closeTime).minus(num(f.NextPaymentDueDate))
        missed = late.lte(0) ? 0 : JSON.parse(Decimal.min(num(remaining), interval > 0 ? late.div(interval).floor().plus(1) : num(1)).toFixed(0))
        if (num(inputs.closeTime).gt(num(f.NextPaymentDueDate).plus(num(ledgerInt(f.GracePeriod))))) pastGrace++
      }
      payments.push({
        loanId: loan.id, label: loan.label, status,
        nextPaymentDueAt: dated ? rippleIso(f.NextPaymentDueDate) : null,
        graceEndsAt: dated ? rippleIso(f.NextPaymentDueDate + ledgerInt(f.GracePeriod)) : null,
        pastDue: dated
          ? figure('pastDue', 'REAL', `How long ${loan.label} is past its due date`, { NextPaymentDueDate: () => input('NextPaymentDueDate', 'Loan', loan.id, 'NextPaymentDueDate', f.NextPaymentDueDate) })
          : null,
        paymentsMissed: missed,
        paymentRemaining: remaining,
        paymentIntervalSeconds: interval,
        recognitionLagSeconds: status === 'impaired' ? inputs.recognitionLags?.[String(loan.id).toUpperCase()] ?? null : null,
      })
    }
  }
  const late = payments.filter((p) => p.pastDue && num(p.pastDue.value).gt(0))
  const worst = late.reduce((w, p) => (!w || num(p.pastDue.value).gt(num(w.pastDue.value)) ? p : w), null)
  return {
    payments,
    summary: {
      loans: payments.length, pastDue: late.length, pastGrace,
      impaired: payments.filter((p) => p.status === 'impaired').length, defaulted: payments.filter((p) => p.status === 'defaulted').length,
      worstLoanId: worst?.loanId ?? null, worstPastDueSeconds: worst ? worst.pastDue.value : '0',
    },
  }
}

/** The terms a dollar figure was computed on, as a ticket or a position names them. */
const termsRefOf = (t) => ({ id: t.id, hash: t.hash, anchorTx: t.anchorTx, fxHaircutBps: t.fxHaircutBps, maxSingleLoanUsd: t.maxSingleLoanUsd })

/** The usd block of a USD ticket: each number the value of its figure, the price as it was read at L. */
function usdBlockOf(terms, figures, price) {
  return {
    loanAsset: { currency: 'USD', issuer: terms.loanAsset.issuer, label: terms.loanAsset.label },
    requestedUsd: figures.requestedUsd.value,
    collateralHeldUsd: figures.collateralHeldUsd.value,
    ltvHeldBps: JSON.parse(figures.ltvHeldUsd.value),
    reference: price,
    terms: termsRefOf(terms),
    collateralRule: USD_COLLATERAL_RULE,
  }
}

/**
 * usd(d) of FORMULAS: d drops at an XRP/USD price, less the haircut, rounded down to a millionth of a
 * dollar. The one conversion a position and a margin call make; a ticket's figures make it through
 * evaluateFormula.
 * @param {Decimal|string} drops
 * @param {string} xrpUsd
 * @param {number|string} fxHaircutBps
 */
export function dropsToUsd(drops, xrpUsd, fxHaircutBps) {
  return new Decimal(num(drops).div(1e6).times(num(xrpUsd)).times(new Decimal(1).minus(num(fxHaircutBps).div(10000))).toFixed(6, Decimal.ROUND_DOWN))
}

/**
 * The digest STALE compares: every { object, id, field, value } a figure read, off the ledger header and,
 * on a dollar ticket (step 21), off the XRP/USD oracle median, which move without the request changing (the
 * approval judges again at its own ledger, at the price of that ledger), and off the payment record (step 22),
 * derived from the same Loan objects and ledger,
 * sorted by object, id then field, without duplicates. It does not move when only the ledger does.
 * @param {object} figures
 * @returns {string}
 */
export function inputsDigest(figures) {
  const seen = new Map()
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      if (typeof v.formulaId === 'string' && Array.isArray(v.inputs)) {
        for (const i of v.inputs) if (i.object !== 'Ledger' && i.object !== 'OracleAggregate') seen.set(`${i.object}\u0000${i.id}\u0000${i.field}`, { object: i.object, id: i.id, field: i.field, value: i.value })
      } else {
        Object.values(v).forEach(walk)
      }
    }
  }
  walk(Object.fromEntries(Object.entries(figures).filter(([k]) => k !== 'payments' && k !== 'paymentSummary')))
  const entries = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e)
  return sha256Hex(canonical(entries))
}

/** The manager's statement in Vault.Data, DECLARED, with its consistency at L, REAL. Never a figure (I6). */
function statementOf(inputs) {
  const raw = inputs.vault.raw?.Data
  if (!raw) return null
  const doc = parseStatement(raw)
  const loans = inputs.brokers.flatMap((b) => b.loans.map((l) => ({ ...l.raw, index: l.id, label: l.label })))
  return {
    provenance: 'DECLARED', raw, owner: inputs.vault.raw.Owner, doc,
    consistency: statementConsistency(doc, loans, { ledgerIndex: inputs.ledgerIndex, ledgerHash: inputs.ledgerHash }),
  }
}

/**
 * The desk's positions at one ledger: for each desk loan, its collateral (the escrow its LoanSet names
 * and the 2-of-3 account it pays into), the withdrawal value of the shares in escrow, the LTV at that
 * value, and the use of each limit of the mandate. Pure.
 * @param {Awaited<ReturnType<import('./inputs.mjs').readPositions>>} p
 * @param {import('../nyc/contracts.mjs').Mandate} mandate
 */
export function buildPositions(p, mandate) {
  // step 21: a loan of the desk's dollar broker is valued in dollars, on the terms and the XRP/USD price
  // readPositions read with it at the same ledger; with no usable terms or price, no dollar figure, and why,
  // and the XRP positions as they are
  const termsOk = Boolean(p.usdTerms) && usdTermsHash(p.usdTerms) === p.usdTerms.hash && p.usdTerms.mandateHash === mandate.hash
  const terms = termsOk ? p.usdTerms : null
  const price = terms ? p.usdPrice ?? null : null
  const noPrice = p.usdTerms && !termsOk
    ? 'demo/usd-terms-desk-1.json does not hash to its own hash, or names another mandate: no dollar position is valued on it.'
    : p.usdPriceError ?? 'No XRP/USD price was read at this ledger.'
  const positions = p.loans.map((loan) => {
    const isUsd = loan.currency === 'USD'
    let held = new Decimal(0)
    let worstN2 = null
    let lockedUntil = null
    const collateral = loan.collateral.map((c) => {
      // op buy: the same withdrawal value, N2 and lock-up as a pledge, without the LTV a 0 value refuses
      const t = buildTicket(c.ticketInputs, { op: 'buy', units: c.units, mandate, principalDrops: loan.principalOutstanding })
      held = held.plus(num(t.figures.heldValue.value))
      const n2 = t.figures.n2.reduce((m, e) => Decimal.max(m, num(e.lossAfterCover.value)), new Decimal(0))
      worstN2 = worstN2 === null ? n2 : Decimal.max(worstN2, n2)
      const lock = num(t.figures.n3.lockedUntil.value)
      lockedUntil = lockedUntil === null ? lock : Decimal.max(lockedUntil, lock)
      const { raw: _raw, ...account } = c.account
      void _raw
      return { escrowId: c.escrowId, shareMptId: c.shareMptId, units: c.units, account, ...(c.cure && { cure: true }) }
    })
    const principal = num(loan.principalOutstanding)
    // in dollars for a dollar loan: the collateral's withdrawal value in XRP at the oracles' median, less the haircut
    const heldUsd = isUsd && price ? dropsToUsd(held, price.value, terms.fxHaircutBps) : null
    const ltvHeldBps = !collateral.length || !held.gt(0) ? null
      : isUsd ? (heldUsd?.gt(0) ? bpsOf(principal.times(10000).div(heldUsd)) : null)
        : bpsOf(principal.times(10000).div(held))
    const usage = [
      { limit: 'maxLtvBps', value: ltvHeldBps === null ? null : String(ltvHeldBps), threshold: String(mandate.limits.maxLtvBps) },
      { limit: 'maxSingleLoanDrops', value: principal.toFixed(0), threshold: String(mandate.limits.maxSingleLoanDrops) },
      { limit: 'maxN2LossDrops', value: worstN2 === null ? null : worstN2.toFixed(0), threshold: String(mandate.limits.maxN2LossDrops) },
      { limit: 'maxLockupDays', value: lockedUntil === null ? null : lockedUntil.toFixed(0), threshold: num(mandate.limits.maxLockupDays).times(86400).toFixed(0) },
    ]
    // maxSingleLoanUsd of the terms in place of the mandate's maxSingleLoanDrops
    if (isUsd) usage[1] = { limit: 'maxSingleLoanUsd', value: principal.toFixed(), threshold: terms ? String(terms.maxSingleLoanUsd) : null }
    return {
      loanId: loan.loanId, loanSetTxHash: loan.loanSetTxHash, vaultId: loan.vaultId, borrower: loan.borrower,
      // the loan's PrincipalOutstanding as the ledger states it, in the loan's asset: drops for XRP, dollars for USD
      principalOutstanding: isUsd ? principal.toFixed() : principal.toFixed(0), collateral, collateralHeldDrops: held.toFixed(0), ltvHeldBps, usage,
      currency: isUsd ? 'USD' : 'XRP',
      ...(isUsd && {
        usd: {
          loanAsset: terms ? { currency: 'USD', issuer: terms.loanAsset.issuer, label: terms.loanAsset.label } : p.usdLoanAsset ?? null,
          principalOutstandingUsd: principal.toFixed(), collateralHeldUsd: heldUsd ? heldUsd.toFixed(6) : null, ltvHeldBps,
          reference: price, terms: terms ? termsRefOf(terms) : null,
          ...(!price && { priceUnavailable: noPrice }),
        },
      }),
    }
  })
  return { ledgerIndex: p.ledgerIndex, ledgerHash: p.ledgerHash, positions }
}
