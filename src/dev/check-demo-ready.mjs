/**
 * Is the demonstration presentable right now?
 *
 * Exits 2 when something would embarrass you on stage, so start-demo.sh can say so
 * rather than printing four green lines over a facility whose window closed an hour ago.
 *
 * Two things it refuses to let pass:
 *   a negative countdown, which shows a redemption date in the past and reads as a bug;
 *   the gate facility outside Subscription, where a live deposit returns tecEXPIRED for
 *   the phase and the credential is never consulted, so the demonstration shows the
 *   phase rule instead of the gate.
 *
 * --nyc judges the New York demo on Devnet directly, without the API: each Harbor in time (played, or
 * ready now: L1 impaired and declared, L2 defaultable), the desk's phase and the loans desk and spare can
 * still make, the chain test receipt, the mandate's Memo, no repayment and no lifted impairment by a role
 * account (Halden still impaired), the collateral accounts and the shares. Exit 0 ready, 2 not ready.
 * --nyc --self-test judges fixed cases offline. The API mode below is dispatched only without --nyc,
 * because it asks API_BASE as soon as it runs.
 */
import { num } from '../num.mjs'

// --- the NYC demo, read on Devnet (no API) -----------------------------------------------------------------

/** The Harbor slots, Sun 25 Oct 2026 08:00, 14:15 and 17:00 ET, in Ripple seconds. NYC_SLOTS moves them. */
const DEFAULT_SLOTS = { 'harbor-1': 846244800, 'harbor-2': 846267300, 'harbor-3': 846277200 }
/** The desk's Investment phase opens by Sun 08:00 ET and its last demo loan may be validated by 17:00 ET. */
const DESK_OPEN_BY = 846244800
const DESK_LAST_LOANSET = 846277200
const DESK_REDEMPTION_FLOOR = 846388800
const LSF_LOAN_DEFAULT = 0x00010000
const LSF_LOAN_IMPAIRED = 0x00020000
const TF_LOAN_UNIMPAIR = 0x00040000

if (process.argv.includes('--nyc')) {
  process.exitCode = await nyc(process.argv.includes('--self-test'))
} else {
// --- the API mode, unchanged --------------------------------------------------------------------------
const BASE = process.env.API_BASE ?? 'http://localhost:8787'

let book
try {
  book = await (await fetch(`${BASE}/api/vaults`)).json()
} catch (e) {
  console.log(`  the reader did not answer on ${BASE}: ${String(e).slice(0, 70)}`)
  process.exit(2)
}

let blocking = 0
for (const v of book.vaults ?? []) {
  const hours = v.secondsToRedemption / 3600
  let flag = ''
  if (v.secondsToRedemption < 0) { flag = '  WINDOW EXPIRED'; blocking++ }
  else if (hours < 3) flag = `  expires in ${hours.toFixed(1)}h`
  console.log(
    '  ' + String(v.label).padEnd(30) + String(v.grade).padEnd(4) +
    String(v.phase).padEnd(13) + 'oracle ' + String(v.oraclePublished).padEnd(6) + flag,
  )
}

const gate = (book.vaults ?? []).find((v) => /Thorne/.test(v.label ?? ''))
if (gate && gate.phase !== 'Subscription') {
  console.log(`\n  STOP  the gate facility is in ${gate.phase}, not Subscription.`)
  console.log('        A live deposit there returns tecEXPIRED for the phase and the')
  console.log('        credential is never consulted. Rebake before demonstrating it.')
  blocking++
}

if (blocking) {
  console.log('\n  Rebake, in order:')
  console.log('    node src/demo/rebake-all.mjs --hours 18')
  console.log('    node src/index.mjs')
  console.log('    node src/demo/repair-resolution.mjs')
}
process.exit(blocking ? 2 : 0)
}

/**
 * The slots, with any NYC_SLOTS override (`harbor-1:<s>,harbor-2:<s>,harbor-3:<s>`, Ripple seconds; one
 * or more of them). Throws on a malformed value: a slot read wrong judges the wrong Harbor.
 * @param {string|undefined} env
 * @returns {Record<string, number>}
 */
export function slotsFrom(env) {
  const slots = { ...DEFAULT_SLOTS }
  if (env === undefined || env.trim() === '') return slots
  for (const part of env.split(',')) {
    const m = /^\s*(harbor-[123]):(\d{9,10})\s*$/.exec(part)
    if (!m) throw new RangeError(`NYC_SLOTS: ${JSON.stringify(part)} is not harbor-N:<Ripple seconds>`)
    slots[m[1]] = Number(m[2])
  }
  return slots
}

/**
 * A Harbor's verdict in time. Played once its slot is at or before the validated close_time, its loans
 * not judged (the rehearsal defaults L2 of Harbor-1 at its slot). For a slot still to come, ready only if,
 * now, L1 is impaired (the flag on the Loan, LossUnrealized above zero on the Vault) and L2 can be
 * defaulted (not in default, its payment due and its grace period over), never waiting for the slot.
 * @param {{ slot: number, loans: { L1: any, L2: any }, vault: any }} harbor raw ledger objects at one ledger
 * @param {number} closeTime the validated close_time, Ripple seconds
 * @returns {{ verdict: 'played'|'ready'|'not-ready', detail: string }}
 */
export function judgeHarbor({ slot, loans, vault }, closeTime) {
  if (slot <= closeTime) return { verdict: 'played', detail: `slot ${slot} is at or before the ledger's close_time ${closeTime}` }
  const why = []
  const l1 = loans?.L1
  const l2 = loans?.L2
  if (!l1) why.push('L1 is not on the ledger')
  else if ((Number(l1.Flags ?? 0) & LSF_LOAN_IMPAIRED) === 0) why.push('L1 is not impaired')
  if (!num(vault?.LossUnrealized).gt(0)) why.push('the vault carries no LossUnrealized')
  if (!l2) why.push('L2 is not on the ledger')
  else if ((Number(l2.Flags ?? 0) & LSF_LOAN_DEFAULT) !== 0) why.push('L2 is already in default')
  else if (l2.NextPaymentDueDate === undefined) why.push('L2 has no payment due')
  else if (!(closeTime > Number(l2.NextPaymentDueDate) + Number(l2.GracePeriod ?? 0))) {
    why.push(`L2 can be defaulted only after ${Number(l2.NextPaymentDueDate) + Number(l2.GracePeriod ?? 0)}`)
  }
  return why.length
    ? { verdict: 'not-ready', detail: why.join('; ') }
    : { verdict: 'ready', detail: `L1 impaired and L2 defaultable at close_time ${closeTime}, ${slot - closeTime}s before the slot` }
}

async function nyc(selfTest) {
  const { judgeCollateralShare } = await import('../nyc/contracts.mjs')
  if (selfTest) return nycSelfTest(judgeCollateralShare)
  try {
    return await nycLive()
  } catch (e) {
    console.log(`  NOT READY  the check could not finish: ${String(e?.data?.error ?? e?.message ?? e).slice(0, 160)}`)
    return 2
  }
}

function nycSelfTest(judgeCollateralShare) {
  let bad = 0
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
  }
  const ct = 846200000
  const vault = { LossUnrealized: '10000000' }
  const L1 = { Flags: LSF_LOAN_IMPAIRED, NextPaymentDueDate: ct - 900, GracePeriod: 60 }
  const L2 = { Flags: 0, NextPaymentDueDate: ct - 880, GracePeriod: 60 }
  eq('a slot passed, L2 in default: played', judgeHarbor({ slot: ct - 10, loans: { L1, L2: { ...L2, Flags: LSF_LOAN_DEFAULT } }, vault }, ct).verdict, 'played')
  eq('a slot to come, L1 not impaired (LossUnrealized 0): not-ready', judgeHarbor({ slot: ct + 3600, loans: { L1: { ...L1, Flags: 0 }, L2 }, vault: {} }, ct).verdict, 'not-ready')
  eq('a slot to come, L1 impaired, L2 defaultable: ready', judgeHarbor({ slot: ct + 3600, loans: { L1, L2 }, vault }, ct).verdict, 'ready')
  eq('a slot to come, L2 still in its grace period: not-ready', judgeHarbor({ slot: ct + 3600, loans: { L1, L2: { ...L2, NextPaymentDueDate: ct - 30 } }, vault }, ct).verdict, 'not-ready')
  const share = (flags) => judgeCollateralShare({ vault: { Asset: { currency: 'XRP' }, VaultKind: 1 }, issuance: { Flags: flags }, mptoken: { Flags: 0 } })
  eq('a share issuance at 0x00000038: eligible', share(0x38).eligible, true)
  eq('a share issuance at 0x0000003C (private vault): refused', [share(0x3C).eligible, share(0x3C).reasons], [false, ['share issuance flags are outside the proven set']])
  const moved = slotsFrom(`harbor-2:${ct - 5}`)
  eq('NYC_SLOTS moves Harbor-2 before close_time: played', [judgeHarbor({ slot: moved['harbor-2'], loans: { L1, L2 }, vault }, ct).verdict, moved['harbor-1'], moved['harbor-3']], ['played', DEFAULT_SLOTS['harbor-1'], DEFAULT_SLOTS['harbor-3']])
  let refused = false
  try { slotsFrom('harbor-2:soon') } catch { refused = true }
  eq('a malformed NYC_SLOTS is refused', refused, true)
  console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
  return bad ? 1 : 0
}

async function nycLive() {
  const { readFileSync, existsSync } = await import('node:fs')
  const { Xrpl } = await import('../xrpl.mjs')
  const { Decimal } = await import('../num.mjs')
  const c = await import('../nyc/contracts.mjs')
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
  const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

  let blocking = 0
  const line = (ok, what, detail = '') => {
    if (!ok) blocking++
    console.log(`  ${ok ? 'ok  ' : 'STOP'}  ${what}${detail ? `: ${detail}` : ''}`)
  }

  const HARBORS = ['harbor-1', 'harbor-2', 'harbor-3']
  for (const f of [...HARBORS, 'desk', 'spare', 'mandate-desk-1'].map((n) => `demo/${n}.json`)) {
    if (!existsSync(f)) {
      console.log(`  NOT READY  ${f} is missing: the NYC bake has not run`)
      return 2
    }
  }
  const files = Object.fromEntries([...HARBORS, 'desk', 'spare'].map((n) => [n, read(`demo/${n}.json`)]))
  const mandate = read('demo/mandate-desk-1.json')
  const desk = files.desk
  const receiptFile = '.demo/bake-nyc-receipt.json'
  const receipt = existsSync(receiptFile) ? read(receiptFile) : null
  const rolesFile = process.env.ROLES_FILE || '.demo/roles.json'
  // addresses only: the seeds beside them are never read into anything that prints
  const roles = existsSync(rolesFile) ? Object.fromEntries(Object.entries(read(rolesFile).accounts ?? {}).map(([r, a]) => [r, a.address])) : null
  const slots = slotsFrom(process.env.NYC_SLOTS)

  const x = new Xrpl(process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233')
  await x.connect()
  try {
    const closeTime = await x.closeTime()
    const L = x.lastLedger
    const H = x.lastLedgerHash
    console.log(`\n  NYC demo at ledger ${L} (${H}), close_time ${closeTime}\n`)
    const entry = async (index) => {
      try { return (await x.req({ command: 'ledger_entry', index, ledger_index: L })).result.node } catch (e) {
        if (e?.data?.error === 'entryNotFound' || e?.data?.error === 'objectNotFound') return null
        throw e
      }
    }
    const tokenOf = async (account, mptId) => (await x.accountObjects(account, 'mptoken', L)).find((o) => String(o.MPTokenIssuanceID).toUpperCase() === mptId.toUpperCase()) ?? null
    const txByHash = async (hash) => {
      try { return (await x.req({ command: 'tx', transaction: hash })).result } catch { return null }
    }
    const history = async (account) => {
      const h = await x.accountTxWindow(account, { limit: 400, maxPages: 50 })
      if (h.truncated) throw new Error(`the history of ${account} is longer than 50 pages; nothing can be said about it`)
      return h.transactions
    }
    const tjson = (t) => t.tx_json ?? t.tx ?? t
    const plannedUnits = num(desk.plannedLoan?.units)

    // --- the Harbors in time, their statement, their holders, their share ---------------------------------
    for (const label of HARBORS) {
      const f = files[label]
      const vault = await x.vaultInfo(f.vaultId, L)
      const loans = { L1: await entry(f.loans.L1), L2: await entry(f.loans.L2) }
      const judged = judgeHarbor({ slot: slots[label], loans, vault }, closeTime)
      line(judged.verdict !== 'not-ready', `${label.padEnd(9)} ${judged.verdict}`, judged.detail)

      const doc = c.parseStatement(vault.Data)
      const check = c.statementConsistency(doc, [{ ...(loans.L1 ?? {}), index: f.loans.L1, label: 'L1' }], { ledgerIndex: L, ledgerHash: H })
      line(check.status === 'CONSISTENT', `${label.padEnd(9)} manager statement ${check.status}`, check.detail)
      const set = f.statementTx ? await txByHash(f.statementTx) : null
      const setOk = set && set.validated && tjson(set).TransactionType === 'VaultSet' && tjson(set).Account === f.owner && set.meta?.TransactionResult === 'tesSUCCESS'
      line(Boolean(setOk), `${label.padEnd(9)} statementTx is a validated VaultSet of the broker`, f.statementTx ?? 'none')

      const holder = roles ? await tokenOf(roles.holder, f.shareMptId) : null
      const borrower = roles ? await tokenOf(roles.borrower, f.shareMptId) : null
      line(num(holder?.MPTAmount).gt(0) && num(borrower?.MPTAmount).gt(0), `${label.padEnd(9)} holder and borrower both hold shares`, `holder ${num(holder?.MPTAmount).toFixed()}, borrower ${num(borrower?.MPTAmount).toFixed()}`)
      if (judged.verdict !== 'played') {
        const want = plannedUnits.times(label === 'harbor-1' ? 2 : 3)
        line(num(borrower?.MPTAmount).gte(want), `${label.padEnd(9)} borrower shares free for the runs left`, `${num(borrower?.MPTAmount).toFixed()} free, ${want.toFixed()} needed`)
      }

      const share = c.judgeCollateralShare({ vault, issuance: await x.mptIssuance(f.shareMptId, L), mptoken: borrower })
      line(share.eligible, `${label.padEnd(9)} share eligible as collateral`, share.reasons.join('; '))
    }

    // --- desk and spare: phase, dates, and the loans they still have to make ----------------------------
    {
      const d = await x.vaultInfo(desk.vaultId, L)
      const sub = Number(d.SubscriptionDate), red = Number(d.RedemptionDate)
      line(sub <= DESK_OPEN_BY && red > DESK_LAST_LOANSET && red >= DESK_REDEMPTION_FLOOR, 'desk      Investment open by Sun 08:00 ET and covering past 17:00', `SubscriptionDate ${sub}, RedemptionDate ${red}`)
    }
    for (const label of ['desk', 'spare']) {
      const f = files[label]
      const v = await x.vaultInfo(f.vaultId, L)
      const b = await x.loanBroker(f.loanBrokerId, L)
      const n = Number(b.OwnerCount ?? 0)
      const r = Math.max(0, 3 - n)
      const principal = num(desk.plannedLoan?.principalDrops)
      const cash = num(v.AssetsAvailable)
      const coverNeed = num(b.DebtTotal).plus(principal.times(r * 2)).times(Number(b.CoverRateMinimum ?? 0)).div(1e5).ceil()
      const time = Number(v.RedemptionDate) - closeTime
      const timeNeed = Number(desk.plannedLoan?.paymentInterval ?? 0) * 1 + 60 + 3600
      line(cash.gte(principal.times(r)) && num(b.CoverAvailable).gte(coverNeed) && (r === 0 || time >= timeNeed),
        `${label.padEnd(9)} can still make its ${r} loan(s)`,
        `AssetsAvailable ${cash.toFixed()} ≥ ${principal.times(r).toFixed()}, CoverAvailable ${num(b.CoverAvailable).toFixed()} ≥ ${coverNeed.toFixed()}, ${time}s to RedemptionDate ≥ ${timeNeed}`)
    }

    // --- the planned OTC buy ------------------------------------------------------------------------------
    {
      const buy = desk.plannedBuy
      const held = roles ? num((await tokenOf(roles.holder, files.spare.shareMptId))?.MPTAmount) : new Decimal(0)
      const units = typeof buy?.units === 'string' && /^[0-9]+$/.test(buy.units) ? num(buy.units) : null
      line(Boolean(buy && buy.share === files.spare.shareMptId && units && units.gt(0) && units.lte(held)), 'plannedBuy names the spare share, within what holder holds', `${buy?.units ?? 'none'} of ${held.toFixed()}`)
    }

    // --- the mandate's Memo on the ledger ----------------------------------------------------------------
    {
      const hash = c.mandateHash(mandate)
      const t = await txByHash(mandate.anchorTx)
      const memos = (t ? tjson(t).Memos ?? [] : []).map((m) => m.Memo)
      const found = memos.some((m) => m.MemoType === hex('orma.mandate/1') && m.MemoData === hex(`orma.mandate/1:${hash}`))
      line(Boolean(t?.validated && tjson(t).TransactionType === 'AccountSet' && tjson(t).Account === mandate.riskOfficer && found && hash === mandate.hash && desk.mandate?.hash === hash),
        'mandate desk-1 anchored by the risk officer, hash recomputed', `${hash.slice(0, 16)}… in ${String(mandate.anchorTx).slice(0, 16)}…`)
    }

    // --- the chain test, as the bake recorded it ----------------------------------------------------------
    {
      const t = receipt?.chainTest ?? {}
      const want = { escrowCreate: 'tesSUCCESS', loanSet: 'tesSUCCESS', earlyFinish: 'tecNO_PERMISSION', earlyCancel: 'tecNO_PERMISSION', shortFinish: 'tesSUCCESS', shortCancel: 'tesSUCCESS', multisignPayment: 'tesSUCCESS' }
      const off = Object.entries(want).filter(([k, v]) => t[k]?.result !== v).map(([k, v]) => `${k} ${t[k]?.result ?? 'missing'} (want ${v})`)
      line(off.length === 0, 'chain test receipt', off.length ? off.join(', ') : 'multisigned Payment, third-party finish and cancel tesSUCCESS; early finish and cancel tecNO_PERMISSION')
    }

    // --- I5: nothing repays a demo loan, nothing lifts an impairment; Halden stays impaired ---------------
    if (!roles) line(false, 'role accounts', `${rolesFile} is missing`)
    else {
      const bad = []
      for (const [role, address] of Object.entries(roles)) {
        for (const e of await history(address)) {
          const t = tjson(e)
          if (t.Account !== address) continue
          if (t.TransactionType === 'LoanPay') bad.push(`${role} LoanPay ${e.hash ?? t.hash}`)
          if (t.TransactionType === 'LoanManage' && (Number(t.Flags ?? 0) & TF_LOAN_UNIMPAIR) !== 0) bad.push(`${role} tfLoanUnimpair ${e.hash ?? t.hash}`)
        }
      }
      line(bad.length === 0, 'no LoanPay and no tfLoanUnimpair by a role account', bad.join(', '))
    }
    {
      const halden = read('demo/showcase-vault.json')
      const loan = await entry(halden.loanId)
      line(Boolean(loan) && (Number(loan.Flags ?? 0) & LSF_LOAN_IMPAIRED) !== 0, 'Halden loan still carries lsfLoanImpaired', loan ? `Flags ${loan.Flags}` : 'loan not found')
    }

    // --- each 2-of-3 collateral account, in the state the ledger gives it -----------------------------------
    {
      const col = desk.collateral ?? {}
      for (const label of HARBORS) {
        const shareMptId = files[label].shareMptId
        let free = 0
        const off = []
        for (const address of col.accounts?.[label] ?? []) {
          const accountRoot = (await x.req({ command: 'account_info', account: address, ledger_index: L })).result.account_data
          const signerList = (await x.accountObjects(address, 'signer_list', L))[0] ?? null
          const mptoken = await tokenOf(address, shareMptId)
          const escrows = (await x.accountObjects(address, 'escrow', L)).filter((e) => e.Destination === address)
          const pledges = (await history(address))
            .filter((e) => tjson(e).TransactionType === 'EscrowCreate' && tjson(e).Destination === address && tjson(e).Account === col.borrower && e.meta?.TransactionResult === 'tesSUCCESS'
              && String(tjson(e).Amount?.mpt_issuance_id ?? '').toUpperCase() === shareMptId.toUpperCase())
            .map((e) => ({ account: tjson(e).Account, sequence: tjson(e).Sequence }))
          const { stage, namedEscrow } = c.collateralStageOf({ escrows, mptoken, pledges }, { borrower: col.borrower, shareMptId })
          if (stage === 'free') free++
          const judged = c.judgeCollateralAccount({ accountRoot, signerList, mptoken, escrows }, { borrower: col.borrower, desk: col.desk, agent: col.agent, shareMptId, ...c.COLLATERAL_STAGES[stage], namedEscrow })
          if (!judged.conforming) off.push(`${address} (${stage}): ${judged.reasons.join('; ')}`)
        }
        line(off.length === 0, `${label.padEnd(9)} collateral accounts conforming to their state`, off.join(' | '))
        console.log(`          ${free} free of ${(col.accounts?.[label] ?? []).length} in the pool (an exhausted pool creates an account at pledge time)`)
      }
    }
  } finally {
    await x.disconnect()
  }
  console.log(blocking ? `\n  NOT READY  ${blocking} check(s) above` : '\n  ready')
  return blocking ? 2 : 0
}
