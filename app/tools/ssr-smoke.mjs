/**
 * Render the screens to a string against the REAL payloads the API is serving.
 *
 * Typechecking proves the shapes line up. This proves the components do not throw on
 * the actual bytes, and that the figures the pitch depends on are genuinely in the
 * output rather than merely in the props. Cheap, and it catches the class of mistake
 * that otherwise only shows up in front of a room.
 *
 *   pnpm smoke                          (needs the API on :8787)
 *
 * tsx is invoked through npx rather than added to devDependencies: re-resolving this
 * lockfile mid-event to gain one dev tool is a poor trade, and the binary is cached.
 *
 * The --tsconfig flag in that script is load-bearing: without it tsx falls back to the
 * classic JSX runtime, the components throw "React is not defined", and the failure
 * looks like a bug in the screen rather than in the harness.
 */
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const NL = String.fromCharCode(10)
let bad = 0

// One retry on a network error only: after a long render, fetch can reuse a keep-alive socket the
// server has just closed. An HTTP error is an answer and is never retried.
const grab = async (path, retry = 1) => {
  try {
    const r = await fetch(BASE + path)
    return r.ok ? await r.json() : null
  } catch (e) {
    console.log('  --   ' + path + ': ' + (e.cause?.code ?? e.message) + (retry ? ', retried once' : ''))
    return retry ? grab(path, retry - 1) : null
  }
}

// --- the verification screen ------------------------------------------------
const race = await grab('/api/indexer-race')
if (!race) {
  console.log('  MISS /api/indexer-race returned nothing')
  bad++
} else {
  const { Evidence } = await import('../src/screens/Evidence.tsx')
  const html = renderToString(createElement(Evidence, { d: race }))

  // The screen groups thousands ("1 961 bp"), so the digits are looked for with the
  // spaces taken out: the check follows the page, never the other way round.
  const flat = html.replace(/\s/g, '')
  for (const m of [race.readings.naive.value, race.readings.correct.value, String(race.readings.divergenceBps)]) {
    const ok = flat.includes(m)
    if (!ok) bad++
    console.log('  ' + (ok ? 'ok  ' : 'MISS') + ' ' + m)
  }
  // The empty object is the whole point. If it is not rendered, the screen is decoration.
  const emptyRendered = html.includes('{}')
  if (!emptyRendered) bad++
  console.log('  ' + (emptyRendered ? 'ok  ' : 'MISS') + ' empty PreviousFields object is on screen')
  console.log('  ' + html.length + ' bytes rendered')
}

// --- the credit opinion, with exhibits 3 and 4 -------------------------------
// Both exhibits are optional by design, so "absent" is a pass. What must never happen
// is a throw, or a zero standing in for a figure the ledger did not state.
const list = await grab('/api/vaults')
const id = list?.vaults?.[0]?.vaultId
if (!id) {
  console.log(NL + '  -- no facility on the feed, credit opinion not exercised')
} else {
  const detail = await grab('/api/vaults/' + id)
  const history = await grab('/api/vaults/' + id + '/broker-history')
  const collateral = await grab('/api/vaults/' + id + '/collateral')
  const navHistory = await grab('/api/vaults/' + id + '/nav-history')

  const { Facility } = await import('../src/screens/Facility.tsx')
  const page = renderToString(createElement(Facility, { d: detail, history, collateral, navHistory }))

  const hasConduct = page.includes('Exhibit 3')
  const hasPledges = page.includes('Exhibit 4')
  const hasChart = page.includes('NAV History')
  console.log(NL + '  facility ' + id.slice(0, 10) + ' renders, ' + page.length + ' bytes')
  console.log('  ' + (hasConduct ? 'ok  ' : '--  ') + ' Exhibit 3 manager conduct '
    + (hasConduct ? 'present' : 'omitted, no manager on file'))
  console.log('  ' + (hasPledges ? 'ok  ' : '--  ') + ' Exhibit 4 pledged units   '
    + (hasPledges ? 'present' : 'omitted, nothing pledged'))
  console.log('  ' + (hasChart ? 'ok  ' : '--  ') + ' NAV history chart         '
    + (hasChart ? 'present' : 'omitted, this server has no history for it'))

  // The whole reason the API reports null rather than 0: an unstated book must never
  // print as a figure. If an event says the book is unknown, an em-dash reaches the page.
  if (history?.events?.some((e) => e.debtBefore === null)) {
    const dashed = page.includes(String.fromCharCode(8212))
    if (!dashed) bad++
    console.log('  ' + (dashed ? 'ok  ' : 'MISS') + ' unstated book renders as an em-dash, not 0.00')
  }
}

// --- Orma Desk, layer 1 of the ticket ----------------------------------------
// renderToString puts <!-- --> between adjacent text nodes ({pct}% renders 53.45<!-- -->%): every
// string is looked for in the HTML with them taken out.
const { readFileSync, readdirSync } = await import('node:fs')
// renderToString also escapes an apostrophe: the strings are looked for as a reader sees them.
const plain = (h) => h.replaceAll('<!-- -->', '').replaceAll('&#x27;', "'")
const check = (what, ok) => {
  if (!ok) bad++
  console.log('  ' + (ok ? 'ok  ' : 'MISS') + ' ' + what)
  return ok
}
const { DeskScreen, DESK_TABS, OPERATOR_ACTIONS, rememberOperator, secondsText, recomputeReference } = await import('../src/screens/Desk.tsx')
const { Figure, Recompute } = await import('../src/components/Ledger.tsx')
const api = await import('../src/lib/api.ts')
const { USD_LABEL, USD_COLLATERAL_RULE } = await import('../src/lib/types.ts')
// Step 21: a dollar amount on the page is a number followed by "USD (" + the whole label; the one exception is
// the declared rate "1.29 USD per XRP", which the label follows on its own line. Returns what is left bare.
const LABELLED = new RegExp('\\d USD(?! \\(' + USD_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)| per XRP)', 'g')
const unlabelled = (html) => [...html.matchAll(LABELLED)].map((m) => html.slice(Math.max(0, m.index - 20), m.index + 40))
const LOADING = 'The ledger is being read at a validated ledger. The figures appear on their own.'
const GRADE = />(AAA|AA|A|BBB|BB|B|CCC|CC|C|D)[+-]?</
const render = (props) => plain(renderToString(createElement(DeskScreen, props)))
const count = (html, s) => html.split(s).length - 1
const accessible = (what, html) => {
  check(what + ': one h1', count(html, '<h1') === 1)
  check(what + ': scope="col" on every th', (html.match(/<th\b[^>]*>/g) ?? []).every((t) => t.includes('scope="col"')))
  check(what + ': btn and its variant on every button', (html.match(/<button\b[^>]*>/g) ?? []).every((b) => /class="btn btn-(primary|secondary)"/.test(b)))
  check(what + ': no grade letter', !GRADE.test(html))
}

const harbor = JSON.parse(readFileSync('../demo/harbor-1.json', 'utf8'))
const desk = JSON.parse(readFileSync('../demo/desk.json', 'utf8'))
console.log(NL + '  desk')
const deskPlan = (await grab(api.deskPlanPath))?.deskPlan
check('deskPlan served by ' + api.deskPlanPath, Boolean(deskPlan))
const harbors = deskPlan?.vaults.filter((v) => v.label.startsWith('harbor-')) ?? []
check('deskPlan: harbor-1, harbor-2, harbor-3, desk, spare in order', JSON.stringify(deskPlan?.vaults.map((v) => v.label)) === JSON.stringify(['harbor-1', 'harbor-2', 'harbor-3', 'desk', 'spare']))
check('deskPlan: each Harbor carries impairL1Tx, impairL1Hidden and statementTx', harbors.length === 3 && harbors.every((v) => /^[0-9A-F]{64}$/i.test(v.impairL1Tx ?? '')
  && JSON.stringify(v.impairL1Hidden) === JSON.stringify(['Vault.LossUnrealized']) && /^[0-9A-F]{64}$/i.test(v.statementTx ?? '')))
check('deskPlan: the planned loan of demo/desk.json, a planned buy', deskPlan?.plannedLoan.units === desk.plannedLoan.units && Boolean(deskPlan?.plannedBuy.units))

// Step 19 (addendum A11): both parties named as fictional institutions, the desk's line under every title.
const LENDER = 'Harbor Credit Desk (fictional)'
const BORROWER = 'Tidewater Payments (fictional)'
const REPO_LINE = 'Short-term secured financing against XRPL vault shares, the on-chain equivalent of a repo. The shares stay in escrow; the price is the withdrawal value.'
check('the lender is the mandate\'s desk, ' + LENDER, JSON.parse(readFileSync('../demo/mandate-desk-1.json', 'utf8')).desk === LENDER)

// Each tab with the answer of its own source, the channel App.tsx uses; then with another tab's answer.
const answers = {}
for (const tab of DESK_TABS) {
  const path = tab.source({ deskPlan })
  const data = path ? await grab(path) : null
  answers[tab.id] = data
  if (!check('tab ' + tab.id + ': ' + path + ' answered', data !== null)) continue
  const html = render(tab.id === 'ticket' ? { ticket: data, mark: null, tab: tab.id } : { ticket: null, mark: null, tab: tab.id, data, deskPlan })
  check('tab ' + tab.id + ': read at ledger ' + data.ledgerIndex, html.includes(String(data.ledgerIndex)))
  for (const s of tab.mustContain) check('tab ' + tab.id + ': ' + s, html.includes(s))
  for (const k of tab.mustShowKeys ?? []) check('tab ' + tab.id + ': ' + k, html.includes(String(data[k])))
  accessible('tab ' + tab.id, html)
  check('tab ' + tab.id + ': the desk line under the title', html.includes(REPO_LINE))
  if (tab.id === 'ticket' || tab.id === 'positions') {
    check('tab ' + tab.id + ': both parties, ' + LENDER + ' and ' + BORROWER, html.includes('Lender: ' + LENDER) && html.includes('Borrower: ' + BORROWER))
  }
  if (tab.id === 'positions') {
    check('positions: ' + BORROWER + ' beside each borrower address', data.positions.length === 0 || data.positions.every((p) => html.includes(p.borrower)))
    check('positions: the table in a .tbl-wrap', html.includes('<div class="tbl-wrap"><table'))
    check('positions: every loanSetTxHash', data.positions.every((p) => !p.loanSetTxHash || html.includes(p.loanSetTxHash)))
    check('positions: a 64-hex LoanSet backed by Harbor-1 shares', data.positions.some((p) => /^[0-9A-F]{64}$/i.test(p.loanSetTxHash ?? '')
      && p.collateral.some((c) => c.shareMptId.toUpperCase() === harbor.shareMptId.toUpperCase())))
    // Step 20: an open margin call (ISSUED or EXPIRED) on a live position puts the desk's banner on the tab.
    const open = data.positions.filter((p) => p.marginCall?.status === 'ISSUED' || p.marginCall?.status === 'EXPIRED')
    check('positions: ' + (open.length ? open.length + ' open margin call(s), "Margin call issued by" on the tab' : 'no open margin call, no banner required'),
      open.length === 0 || html.includes('Margin call issued by'))
  }
}
for (const tab of DESK_TABS.filter((t) => t.id !== 'ticket')) {
  const other = DESK_TABS[(DESK_TABS.indexOf(tab) + 1) % DESK_TABS.length]
  check('tab ' + tab.id + ' given the ' + other.id + ' answer: the loading note', render({ ticket: null, mark: null, tab: tab.id, data: answers[other.id], deskPlan }).includes(LOADING))
}

const ticket = answers.ticket
if (ticket) {
  const html = render({ ticket, mark: null, tab: 'ticket' })
  const held = ticket.figures.heldValue.value
  const label = html.indexOf('Withdrawal value')
  const field = html.indexOf('Ledger field', label)
  const verbatim = html.indexOf('<code>' + held + '</code>', field)
  check('the served heldValue ' + held + ' verbatim in Ledger field, under Withdrawal value',
    label >= 0 && field > label && verbatim > field && verbatim < html.indexOf('Value read by all'))
  for (const s of ['XLS-65 withdraw rate', 'Value read by all', 'Test network', 'Source: Orma']) check(s, html.includes(s))
  const served = []
  const walk = (o) => {
    if (o && typeof o === 'object') {
      if (typeof o.formulaId === 'string' && Array.isArray(o.inputs)) served.push(o)
      else Object.values(o).forEach(walk)
    }
  }
  walk(ticket.figures)
  const off = served.filter((f) => !plain(renderToString(createElement(Recompute, { figure: f }))).includes('>MATCH'))
  check('every served figure (' + served.length + ') recomputes MATCH in the browser' + (off.length ? ': not ' + off.map((f) => f.formulaId).join(', ') : ''), served.length > 0 && off.length === 0)

  // Step 22 (addendum A12): the payment record of the live ticket, its bank-practice note and its pastDue figures.
  const { durationText } = await import('../src/lib/duration.ts')
  for (const s of ['Payment record', 'Only loans past their grace period are tested', '30 days past due', 'Art. 178']) check('ticket (step 22): ' + s, html.includes(s))
  const payments = Array.isArray(ticket.figures.payments) ? ticket.figures.payments : null
  const ps = ticket.figures.paymentSummary
  check('ticket (step 22): figures.payments and figures.paymentSummary served', Boolean(payments && ps && typeof ps.loans === 'number'))
  if (payments && ps) {
    const pastDues = payments.filter((p) => p.pastDue)
    const dated = payments.filter((p) => p.status !== 'defaulted')
    const pastDueOff = pastDues.filter((p) => !plain(renderToString(createElement(Recompute, { figure: p.pastDue }))).includes('>MATCH'))
    check('ticket (step 22): every live pastDue figure (' + pastDues.length + ') is formula pastDue and recomputes MATCH, one per loan not defaulted' + (pastDueOff.length ? ': not ' + pastDueOff.map((p) => p.label).join(', ') : ''),
      pastDues.length > 0 && pastDues.length === dated.length && pastDues.every((p) => p.pastDue.formulaId === 'pastDue') && pastDueOff.length === 0)
    check('ticket (step 22): each pastDue in the audit list as "{label}: past due"', pastDues.every((p) => html.includes(p.label + ': past due</td>')))
    const worst = payments.find((p) => p.loanId === ps.worstLoanId)
    const head = ps.pastDue === 0 ? 'No loan in this vault is past due.' : ps.pastDue + ' of ' + ps.loans + ' loans in this vault past due.'
    const worstSaid = (worst ? ' Worst: ' + worst.label + ', past due ' + durationText(ps.worstPastDueSeconds) + ', ' + worst.paymentsMissed + ' of ' + worst.paymentRemaining + ' remaining payments missed, ' + (worst.status === 'impaired' ? 'impaired.' : 'not impaired.') : '')
      + (ps.defaulted > 0 ? ' ' + ps.defaulted + (ps.defaulted === 1 ? ' loan' : ' loans') + ' defaulted.' : '')
    check('ticket (step 22): the summary line, ' + JSON.stringify(head + worstSaid), html.includes('>REAL</span> ' + head + worstSaid))
    const lines = ticket.figures.n2.map((e) => [e, payments.find((p) => p.loanId === e.loanId)])
    check('ticket (step 22): each default scenario (' + lines.length + ') is a loan of the record, with its payment line under it',
      lines.every(([e, p]) => p && p.pastDue && html.includes(e.scenario + '<span class="t-body-s dim block">past due ' + durationText(p.pastDue.value) + ', ' + p.paymentsMissed + ' of ' + p.paymentRemaining + ' remaining payments missed, ' + (p.status === 'impaired' ? 'impaired' : 'not impaired') + '</span>')))
  }

  // The operator's memory, without a browser: a validated pledge reaches requestLoan, a requested loan reaches approve.
  let session = rememberOperator({ runId: 'r1', token: 't0', pledgeActionId: null, requestActionId: null }, { pledgeActionId: 'P'.repeat(32) })
  session = rememberOperator(session, { requestActionId: 'Q'.repeat(32) })
  const ctx = { harbor: 'harbor-1', lending: 'desk', ticket, buyTicket: null, pledgeActionId: session.pledgeActionId, requestActionId: session.requestActionId }
  const bodyOf = (a) => OPERATOR_ACTIONS.find((e) => e.action === a).body(ctx)
  check('session: the pledge reaches requestLoan, the request reaches approve', bodyOf('requestLoan')?.pledgeActionId === 'P'.repeat(32) && bodyOf('approve')?.requestActionId === 'Q'.repeat(32))
}
const approveReq = api.buildActionRequest('approve', 'riskOfficer', 'r1', 't0')
check('buildActionRequest approve: POST /api/roles/r1/riskOfficer/approve, Bearer t0',
  approveReq.url.endsWith('/api/roles/r1/riskOfficer/approve') && approveReq.init.method === 'POST' && approveReq.init.headers.Authorization === 'Bearer t0')
const defaultReq = api.buildActionRequest('defaultL2', 'broker', 'r1', 't0', { vault: 'harbor-1' })
check('buildActionRequest defaultL2: /api/roles/r1/broker/defaultL2, body {"vault":"harbor-1"}', defaultReq.url.endsWith('/api/roles/r1/broker/defaultL2') && defaultReq.init.body === '{"vault":"harbor-1"}')
// Step 20: the cure of a margin call is a pledgeEscrow of the shortfall's units, with the loan it cures.
const cure = api.cureBody({ lending: 'desk', share: 'AB'.repeat(24), ticketId: 'E'.repeat(64), inputsDigest: 'F'.repeat(64), units: '197938', loanId: 'C1'.repeat(32) })
check('cureBody: { vault, share, ticketId, inputsDigest, units, cureLoanId }', JSON.stringify(cure)
  === JSON.stringify({ vault: 'desk', share: 'AB'.repeat(24), ticketId: 'E'.repeat(64), inputsDigest: 'F'.repeat(64), units: '197938', cureLoanId: 'C1'.repeat(32) }))
check('cureTicketPath: a pledge ticket of those units under desk-1', api.cureTicketPath('AB'.repeat(24), '197938') === '/api/tickets?share=' + 'AB'.repeat(24) + '&op=pledge&units=197938&mandate=desk-1')
const lenders = { vaults: [{ label: 'desk', vaultId: 'aa'.repeat(32) }, { label: 'spare', vaultId: 'BB'.repeat(32) }, { label: 'harbor-1', vaultId: 'CC'.repeat(32) }] }
check('lendingVaultOf: desk and spare in any case, null for a Harbor or an unknown vault', api.lendingVaultOf(lenders, 'AA'.repeat(32)) === 'desk'
  && api.lendingVaultOf(lenders, 'bb'.repeat(32)) === 'spare' && api.lendingVaultOf(lenders, 'CC'.repeat(32)) === null && api.lendingVaultOf(lenders, '00'.repeat(32)) === null)

// The desk's channel, the path App takes in production.
if (deskPlan) {
  const h1 = harbors.find((v) => v.label === 'harbor-1')
  const h2 = harbors.find((v) => v.label === 'harbor-2')
  const p1 = api.deskTicketPaths(deskPlan)
  const p2 = api.deskTicketPaths(deskPlan, h2.vaultId)
  const t1 = await grab(p1.pledge)
  const t2 = await grab(p2.pledge)
  check('deskTicketPaths: Harbor-1 and Harbor-2 pledge tickets and the planned buy are served', Boolean(t1 && t2 && (await grab(p1.buy))))
  const mark = await grab('/api/mark/' + h1.shareMptId)
  const positions = await grab('/api/desk/positions')
  check('the Harbor-1 mark and the positions are served', Boolean(mark && positions))
  if (t1 && mark && positions) {
    const html = render({ ticket: t1, mark, tab: 'ticket', deskPlan, positions })
    const layer1 = 3 + t1.figures.n2.reduce((n, e) => n + (e.alreadyInHeld ? 2 : 3), 0) + 3 + ['maxLoan', 'requested', 'ltvHeld', 'lender1to1'].filter((k) => t1.figures[k]).length
    check('Show the work is folded', html.includes('<details class="exh">'))
    check('the pointer chain names every step of the mark', mark.steps.every((st) => html.includes(st.step)))
    check('a provenance badge on every panel: REAL, MODELLED and DECLARED', ['>REAL<', '>MODELLED<', '>DECLARED<'].every((b) => html.includes(b)))
    check('MATCH under every layer-1 figure (' + layer1 + '), no MISMATCH', count(html, 'MATCH') - count(html, 'MISMATCH') >= layer1 && count(html, 'MISMATCH') === 0)
    const demo = api.demoLoanFor(positions, deskPlan)
    for (const s of ['Source: Orma', 'Curator statement', 'DECLARED', t1.statement?.doc?.text, h1.statementTx, 'Consistent with the ledger at', '2-of-3', 'master key disabled',
      String(t1.ledgerIndex), demo?.loanSetTxHash, h1.impairL1Tx, 'Vault.LossUnrealized: absent →', 'not in PreviousFields', 'not played: L1 already impaired (see header)']) {
      check('Harbor-1 ticket: ' + s, Boolean(s) && html.includes(s))
    }
    accessible('Harbor-1 ticket', html)
  }
  if (t2) {
    const html = render({ ticket: t2, mark: null, tab: 'ticket', deskPlan, positions, facility: h2.vaultId })
    check('Harbor-2 under its facility: Harbor-2 in the header, its vaultId in every tab link',
      html.includes('Harbor-2') && count(html, 'href="/desk?facility=' + h2.vaultId + '&amp;tab=') === DESK_TABS.length)
    check('a facility in lower case names the same Harbor', api.deskTicketPaths(deskPlan, h2.vaultId.toLowerCase()).harbor?.label === 'harbor-2'
      && render({ ticket: t2, mark: null, tab: 'ticket', deskPlan, positions, facility: h2.vaultId.toLowerCase() }).includes('Harbor-2'))
  }
  const none = api.deskTicketPaths(deskPlan, '0'.repeat(64))
  const noneHtml = render({ ticket: t1, mark: null, tab: 'ticket', deskPlan, positions, facility: '0'.repeat(64) })
  check('a facility outside the Harbors: no harbor, no pledge, no figure', none.harbor === null && none.pledge === null && noneHtml.includes('is not one of the desk') && !noneHtml.includes('Ledger field'))
  if (t1) {
    const stale = render({ ticket: t1, mark: null, tab: 'ticket', deskPlan, positions, facility: h2.vaultId })
    check('the Harbor-1 ticket under the Harbor-2 facility: the loading note, no figure', stale.includes('Harbor-2') && stale.includes(LOADING) && !stale.includes('Ledger field'))
  }
  if (positions) {
    const html = render({ ticket: null, mark: null, tab: 'positions', data: positions, deskPlan, facility: h1.vaultId })
    check('positions under Harbor-1: Harbor-1 on its rows, the 2-of-3 line under the collateral', html.includes('Harbor-1') && html.includes('Selected facility') && html.includes('2-of-3') && html.includes('master key disabled'))
  }

  // Step 21 (addendum A11): loans in the test dollar, when this server lends it. Absent, no USD UI at all.
  const usdPlan = deskPlan.usd
  if (!usdPlan) {
    console.log('  --   deskPlan.usd not served: this server lends no test dollar, the USD ticket is not exercised')
    const plainHtml = t1 ? render({ ticket: t1, mark: null, tab: 'ticket', deskPlan, positions }) : ''
    check('no deskPlan.usd: no currency choice and no dollar label on the ticket', !plainHtml.includes('Loan currency') && !plainHtml.includes(USD_LABEL))
  } else {
    check('deskPlan.usd: loan asset USD with the whole label, a planned loan in dollars, the risk officer\'s terms',
      usdPlan.loanAsset?.currency === 'USD' && usdPlan.loanAsset?.label === USD_LABEL && /^\d+(\.\d+)?$/.test(usdPlan.plannedLoan?.principalUsd ?? '')
      && usdPlan.terms?.schema === 'orma.usdterms/1' && /^[0-9A-F]{64}$/i.test(usdPlan.terms?.hash ?? ''))
    const usdPath = DESK_TABS[0].source({ deskPlan, asset: 'USD' })
    check('the USD ticket path: the Harbor-1 pledge of the dollar plan, with &asset=USD; the XRP path keeps none',
      usdPath === '/api/tickets?share=' + h1.shareMptId + '&op=pledge&units=' + usdPlan.plannedLoan.units + '&mandate=desk-1&asset=USD'
      && DESK_TABS[0].source({ deskPlan }) === p1.pledge && !p1.pledge.includes('asset='))
    // A price the oracles cannot give (too few fresh sources, or too far apart) is a 409 PRICE_UNAVAILABLE, never a
    // figure: the screen then shows its sentence. This check needs a usable price, so it fails, naming why.
    const usdAnswer = await fetch(BASE + usdPath).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }), (e) => ({ status: 0, body: { error: { code: e.cause?.code ?? e.message } } }))
    const tu = usdAnswer.status === 200 ? usdAnswer.body : null
    if (usdAnswer.status === 409 && usdAnswer.body?.error?.code === 'PRICE_UNAVAILABLE') {
      const h = render({ ticket: null, mark, tab: 'ticket', deskPlan, positions, asset: 'USD', error: 'PRICE_UNAVAILABLE' })
      check('USD ticket refused 409 PRICE_UNAVAILABLE: the screen says ' + JSON.stringify(api.errorSentence('PRICE_UNAVAILABLE')), h.includes(api.errorSentence('PRICE_UNAVAILABLE')) && h.includes('role="alert"') && !h.includes('Ledger field'))
    }
    check('the USD ticket is served with its usd block' + (tu ? '' : ' (answered ' + usdAnswer.status + ' ' + (usdAnswer.body?.error?.code ?? '') + ': ' + (usdAnswer.body?.error?.message ?? '') + ')'), Boolean(tu?.usd))
    if (tu?.usd) {
      const r = tu.usd.reference
      const six = ['maxLoanUsd', 'requestedUsd', 'collateralHeldUsd', 'ltvHeldUsd', 'lender1to1Usd', 'priceAge']
      check('USD ticket: the six dollar figures, none of maxLoan, requested, ltvHeld, lender1to1',
        six.every((k) => tu.figures[k]) && ['maxLoan', 'requested', 'ltvHeld', 'lender1to1'].every((k) => !tu.figures[k]))
      const usdServed = []
      const walkUsd = (o) => {
        if (o && typeof o === 'object') {
          if (typeof o.formulaId === 'string' && Array.isArray(o.inputs)) usdServed.push(o)
          else Object.values(o).forEach(walkUsd)
        }
      }
      walkUsd(tu.figures)
      const usdOff = usdServed.filter((f) => !plain(renderToString(createElement(Recompute, { figure: f }))).includes('>MATCH'))
      check('every served USD-ticket figure (' + usdServed.length + ') recomputes MATCH in the browser' + (usdOff.length ? ': not ' + usdOff.map((f) => f.formulaId).join(', ') : ''), usdServed.length > 0 && usdOff.length === 0)
      const html = render({ ticket: tu, mark, tab: 'ticket', deskPlan, positions, asset: 'USD' })
      check('USD ticket: the reference is REAL, the median of at least minSources used sources, the ledger aggregate the same median',
        r.provenance === 'REAL' && Array.isArray(r.sources) && r.sources.filter((x) => x.used).length >= r.minSources && r.ledgerAggregate?.median === r.value)
      check('USD ticket: the served median and spread recompute MATCH in the browser', recomputeReference(r) === 'MATCH')
      for (const [what, s] of [
        ['the label', USD_LABEL], ['the median', r.value + ' USD per XRP'], ['its method', r.method], ['its time', r.asOf],
        ['its age', secondsText(String(r.ageSeconds)) + ' (' + r.ageSeconds + ' s)'], ['its provenance', '>' + r.provenance + '<'], ['the note', r.note],
        ['the spread', 'Spread between the sources used'], ['the collateral line', USD_COLLATERAL_RULE],
        ['the XRP | USD choice', 'aria-label="Loan currency"'], ['the dollar loan with its label', 'Loan of ' + tu.usd.requestedUsd + ' USD (' + USD_LABEL + ')'],
        ...r.sources.flatMap((x) => [['source ' + x.provider, x.provider], ['its price', x.price === null ? 'no price at this ledger' : x.price + ' USD per XRP'], ['its account', x.account], ['used or not', x.used ? 'used in the median' : 'not used']]),
      ]) check('USD ticket: ' + what + (['the label', 'the collateral line', 'the note', 'its method'].includes(what) ? '' : ', ' + s), html.includes(s))
      const bare = unlabelled(html)
      check('USD ticket: every dollar amount carries the label' + (bare.length ? ' (not: ' + bare.slice(0, 3).join(' | ') + ')' : ''), bare.length === 0)
      check('USD ticket: MATCH under every figure of its audit, no MISMATCH', count(html, 'MISMATCH') === 0 && count(html, 'MATCH') >= usdServed.length)
      accessible('USD ticket', html)
      check('the XRP ticket under a dollar choice is never drawn: the loading note, no figure', Boolean(t1) && (() => {
        const h = render({ ticket: t1, mark, tab: 'ticket', deskPlan, positions, asset: 'USD' })
        return h.includes(LOADING) && !h.includes('Ledger field')
      })())
      const xrpHtml = t1 ? render({ ticket: t1, mark, tab: 'ticket', deskPlan, positions }) : ''
      check('the XRP ticket on this plan: the choice on XRP, no dollar figure', xrpHtml.includes('aria-current="true">XRP</a>') && !xrpHtml.includes(USD_COLLATERAL_RULE) && !xrpHtml.includes('USD per XRP'))
    }
    // The borrower's request carries the currency; the XRP request is the body it always was.
    const reqBody = (asset) => OPERATOR_ACTIONS.find((e) => e.action === 'requestLoan').body({ harbor: 'harbor-1', lending: 'desk', ticket: tu ?? t1, buyTicket: null, pledgeActionId: 'P'.repeat(32), requestActionId: null, ...(asset ? { asset } : {}) })
    check('requestLoan body: asset USD on a dollar request, no asset key on an XRP one', reqBody('USD')?.asset === 'USD' && reqBody('USD')?.vault === 'desk' && reqBody(null) && !('asset' in reqBody(null)))
    check('lendingVaultOf: a loan of the dollar pool is pledged from desk', api.lendingVaultOf(deskPlan, usdPlan.vaultId) === 'desk')
    const usdPositions = positions?.positions.filter((p) => p.currency === 'USD') ?? []
    if (usdPositions.length === 0) console.log('  --   no USD position on the desk yet, the positions in dollars are not exercised live')
    else {
      const html = render({ ticket: null, mark: null, tab: 'positions', data: positions, deskPlan })
      check('positions: each USD loan\'s principal in dollars with the label (' + usdPositions.length + ')', usdPositions.every((p) => html.includes('principal outstanding ' + p.principalOutstanding + ' USD (' + USD_LABEL + ')')))
      check('positions: each USD loan\'s collateral in dollars with the label', usdPositions.every((p) => !p.usd || html.includes(p.usd.collateralHeldUsd + ' USD (' + USD_LABEL + ')')))
      const bare = unlabelled(html)
      check('positions: every dollar amount carries the label' + (bare.length ? ' (not: ' + bare.slice(0, 3).join(' | ') + ')' : ''), bare.length === 0)
    }
  }
}

// The sources: the title template, App's channel, and no import.meta.env. without ?.
const appSrc = readFileSync('src/App.tsx', 'utf8')
const deskSrc = readFileSync('src/screens/Desk.tsx', 'utf8')
check('the title template "Credit desk:" in App.tsx and Desk.tsx', appSrc.includes('deskTitle(') && deskSrc.includes('Credit desk:'))
const bodyFn = appSrc.slice(appSrc.indexOf('function body()'))
check('App.tsx reads deskPlanPath and deskTicketPaths(, imports nothing from demo/, and branches on /desk before if (!vaultId)',
  appSrc.includes('deskPlanPath') && appSrc.includes('deskTicketPaths(') && !/from\s+['"][^'"]*demo\//.test(appSrc)
  && bodyFn.indexOf("path === '/desk'") >= 0 && bodyFn.indexOf("path === '/desk'") < bodyFn.indexOf('if (!vaultId)'))
for (const f of ['src/lib/api.ts', 'src/lib/useRoute.ts']) check(f + ': no import.meta.env. without ?.', !/import\.meta\.env\./.test(readFileSync(f, 'utf8')))

// Recompute on fixed figures: MATCH as served, MISMATCH once the last digit moves.
const meridian = (name, value) => ({ name, value, object: 'Vault', field: name, id: 'AB'.repeat(32), ledgerIndex: 1, ledgerHash: 'CD'.repeat(32) })
const heldInputs = [meridian('AssetsTotal', '51000000'), meridian('LossUnrealized', '10000000'), meridian('OutstandingAmount', '51000000'), meridian('Scale', '0'), meridian('units', '1000000')]
const fig = (formulaId, unit, value, inputs) => ({ value, unit, meaning: 'x', formula: 'x', formulaId, inputs, provenance: 'MODELLED' })
const verdictOf = (f) => {
  const h = plain(renderToString(createElement(Recompute, { figure: f })))
  return h.includes('MISMATCH') ? 'MISMATCH' : h.includes('MATCH') ? 'MATCH' : 'none'
}
const heldFig = fig('heldValue', 'drops', '803922', heldInputs)
const ltvFig = fig('ltvHeld', 'bps', '4975', [...heldInputs, meridian('principalDrops', '400000')])
check('Recompute heldValue in drops: MATCH, then MISMATCH', verdictOf(heldFig) === 'MATCH' && verdictOf({ ...heldFig, value: '803923' }) === 'MISMATCH')
check('Recompute ltvHeld in bps: MATCH, then MISMATCH', verdictOf(ltvFig) === 'MATCH' && verdictOf({ ...ltvFig, value: '4976' }) === 'MISMATCH')
check('Recompute on an unknown formulaId: MISMATCH', verdictOf({ ...heldFig, formulaId: 'noSuchFormula' }) === 'MISMATCH')
const bpsHtml = plain(renderToString(createElement(Figure, { label: 'LTV', meaning: 'x', figure: { ...ltvFig, value: '5345' } })))
check('Figure in bps: 5345 renders 53.45%, and 5345 verbatim in Ledger field', bpsHtml.includes('53.45%') && bpsHtml.includes('<code>5345</code>'))

// No grade and no verdict colour outside Verdict, on the NYC surfaces. The reserved set is read from
// app.css: the four tokens, and every class and data-* attribute of a rule that uses one of them.
const TOKENS = ['--color-ok', '--color-loss', '--color-watch', '--destructive']
const css = readFileSync('src/app.css', 'utf8')
const classes = new Set()
const attrs = new Set()
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!TOKENS.some((t) => m[2].includes('var(' + t))) continue
  for (const c of m[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(c[1])
  for (const a of m[1].matchAll(/\[(data-[\w-]+)/g)) attrs.add(a[1])
}
check('the reserved set read from app.css holds ok, loss and data-danger', classes.has('ok') && classes.has('loss') && attrs.has('data-danger'))
const surfaces = [
  'src/components/Ledger.tsx',
  ...readdirSync('src/screens').filter((n) => /^(Desk|Role).*\.tsx$/.test(n)).map((n) => 'src/screens/' + n),
]
for (const file of surfaces) {
  // LF whatever the checkout: under core.autocrlf (a Windows clone) the end of Verdict is CRLF } CRLF
  let src = readFileSync(file, 'utf8').replace(/\r\n/g, NL)
  const verdict = src.indexOf('export function Verdict')
  if (verdict >= 0) src = src.slice(0, verdict) + src.slice(src.indexOf(NL + '}' + NL, verdict) + 3)
  const found = []
  if (/from\s+['"][^'"]*grades['"]|GradeLetter/.test(src)) found.push('grades or GradeLetter')
  for (const t of TOKENS) if (src.includes(t)) found.push(t)
  if (/destructive/.test(src)) found.push('destructive')
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{\s*[`'"]([^`'"]*)[`'"]\s*\})/g)) {
    for (const w of (m[1] ?? m[2]).split(/\s+/)) if (classes.has(w)) found.push('.' + w)
  }
  for (const a of attrs) if (src.includes(a + '=')) found.push(a)
  check(file + ': no grade, no verdict colour outside Verdict' + (found.length ? ' (' + found.join(', ') + ')' : ''), found.length === 0)
}

// Step 21: the test dollar is never named RLUSD alone. Every RLUSD in every file of app/src, comments included,
// sits inside the whole label. Self-test first: a lone RLUSD is caught, in a string or a comment; the label is not.
const { statSync } = await import('node:fs')
const filesUnder = (dir) => readdirSync(dir).flatMap((n) => (statSync(dir + '/' + n).isDirectory() ? filesUnder(dir + '/' + n) : [dir + '/' + n]))
const loneRlusd = (s) => s.split(USD_LABEL).join('').includes('RLUSD')
check('RLUSD self-test: a lone RLUSD is caught in a string and in a comment; the whole label is not',
  loneRlusd('const x = "RLUSD"') && loneRlusd('/** never RLUSD alone */ const y = 1') && loneRlusd("'" + USD_LABEL + "' // RLUSD") && !loneRlusd("const x = '" + USD_LABEL + "'"))
const srcFiles = filesUnder('src')
const labelled = srcFiles.filter((f) => readFileSync(f, 'utf8').includes(USD_LABEL))
const loneAt = srcFiles.flatMap((f) => readFileSync(f, 'utf8').replace(/\r\n/g, NL).split(NL).flatMap((line, i) => (loneRlusd(line) ? [f + ':' + (i + 1)] : [])))
check('app/src (' + srcFiles.length + ' files, the label in ' + labelled.length + '): every RLUSD inside "' + USD_LABEL + '"' + (loneAt.length ? ' (not at: ' + loneAt.join(', ') + ')' : ''), loneAt.length === 0 && labelled.length > 0)
check('label self-test: a bare "2.322 USD" is caught; with the label, and "1.29 USD per XRP", it is not',
  unlabelled('<p>2.322 USD</p>').length === 1 && unlabelled('2.322 USD (' + USD_LABEL + ')').length === 0 && unlabelled('1.29 USD per XRP').length === 0)

// Step 22: the words of a late loan are past due, missed and late. The one word banks avoid on a desk screen is
// built from two halves, so this file never holds it whole; self-test first: it is caught in any case.
const AVOIDED = new RegExp('delin' + 'quen', 'i')
check('words self-test: the avoided word is caught in any case, "past due" is not', AVOIDED.test('a ' + 'Delin' + 'quent loan') && !AVOIDED.test('a loan past due, 2 payments missed, late'))
const wordFiles = [...readdirSync('src/screens').filter((n) => /^Desk.*\.tsx$/.test(n)).map((n) => 'src/screens/' + n), 'src/lib/duration.ts']
const saidAt = wordFiles.filter((f) => AVOIDED.test(readFileSync(f, 'utf8')))
check('the desk screens and lib/duration.ts say past due, missed or late, never the avoided word' + (saidAt.length ? ' (in: ' + saidAt.join(', ') + ')' : ''), saidAt.length === 0)

// --- the live demo lab (/demo) -------------------------------------------------------------------------------
// Temporary, Devnet only: both sides sign in the browser with keys loaded at runtime. Its own cases run in the
// SMOKE_CASES loop below; these check what one render cannot. The route, xrpl reached through import() from
// lib/demoKeys.ts only (so no other page carries it), no way out for a seed, and a loaded seed never rendered.
// Offline: nothing here reads the API. The seed is a throwaway wallet generated now, never a role seed.
console.log(NL + '  demo lab')
const routeSrc = readFileSync('src/lib/useRoute.ts', 'utf8')
check('/demo is a route of useRoute.ts and not a section of DESKS', /const ROUTES: RoutePath\[\] = \[[^\]]*'\/demo'/.test(routeSrc) && !/\['\/demo',/.test(routeSrc))
check('App.tsx draws DemoLab on /demo, loaded lazily', appSrc.includes("path === '/demo'") && /lazy\(\(\) => import\('\.\/screens\/DemoLab'\)/.test(appSrc))
const STATIC_XRPL = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]xrpl['"]|require\(\s*['"]xrpl['"]\s*\)/m
const DYNAMIC_XRPL = /import\(\s*['"]xrpl['"]\s*\)/
check('xrpl self-test: a static import is caught; a type import and import() are not',
  STATIC_XRPL.test("import { Wallet } from 'xrpl'") && STATIC_XRPL.test("import * as x from \"xrpl\"") && !STATIC_XRPL.test("import type { Wallet } from 'xrpl'")
  && !STATIC_XRPL.test("const m = await import('xrpl')") && DYNAMIC_XRPL.test("xrplModule ??= import('xrpl')"))
const xrplStatic = srcFiles.filter((f) => STATIC_XRPL.test(readFileSync(f, 'utf8')))
const xrplDynamic = srcFiles.filter((f) => DYNAMIC_XRPL.test(readFileSync(f, 'utf8')))
check('no file of app/src imports xrpl statically' + (xrplStatic.length ? ' (' + xrplStatic.join(', ') + ')' : ''), xrplStatic.length === 0)
check('only src/lib/demoKeys.ts loads xrpl, through import()' + ' (' + xrplDynamic.join(', ') + ')', JSON.stringify(xrplDynamic) === JSON.stringify(['src/lib/demoKeys.ts']))
const labSrc = readFileSync('src/screens/DemoLab.tsx', 'utf8')
const keysSrc = readFileSync('src/lib/demoKeys.ts', 'utf8')
const NO_WAY_OUT = /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|console\./
const NO_DIALOG = /window\.(confirm|alert|prompt)|\b(alert|prompt)\(/
check('self-test: fetch, localStorage, console. and window.confirm are caught', NO_WAY_OUT.test('await fetch(url)') && NO_WAY_OUT.test('localStorage.setItem') && NO_WAY_OUT.test('console.log(seed)') && NO_DIALOG.test('window.confirm("x")') && !NO_WAY_OUT.test('sessionStorage.setItem'))
check('lib/demoKeys.ts: no fetch, socket, beacon, localStorage or console, so a seed has no way out', !NO_WAY_OUT.test(keysSrc))
check('DemoLab.tsx: no localStorage or console, no browser dialog (the default asks in the page)', !/localStorage|console\./.test(labSrc) && !NO_DIALOG.test(labSrc))
{
  const keys = await import('../src/lib/demoKeys.ts')
  const xrplMod = await import('xrpl')
  const throwaway = (xrplMod.Wallet ?? xrplMod.default.Wallet).generate()
  const { KeysPanel, DemoLab } = await import('../src/screens/DemoLab.tsx')
  await keys.loadSeeds({ borrower: throwaway.seed })
  const keysHtml = plain(renderToString(createElement(KeysPanel, { keys: keys.keyStore.get() })))
  check('keys panel: the address derived in the browser from a loaded seed is shown', keysHtml.includes(throwaway.classicAddress))
  check('keys panel: the seed itself is never rendered', !keysHtml.includes(throwaway.seed))
  keys.forgetKeys()
  check('Forget keys: no key left', keys.keyStore.get().length === 0)
  accessible('demo lab without a run', plain(renderToString(createElement(DemoLab))))
}

// Each screen that declares SMOKE_CASES renders them, and each must show its strings.
for (const n of readdirSync('src/screens').filter((x) => x.endsWith('.tsx'))) {
  if (!readFileSync('src/screens/' + n, 'utf8').includes('export const SMOKE_CASES')) continue
  const { SMOKE_CASES } = await import('../src/screens/' + n)
  for (const c of SMOKE_CASES) {
    const html = plain(renderToString(c.element))
    const name = n + ' / ' + c.name
    for (const s of c.mustContain ?? []) check(name + ': ' + s, html.includes(s))
    // Each string present, and the first occurrence of each before the first of the next.
    if (c.before) {
      const at = c.before.map((s) => html.indexOf(s))
      check(name + ': in order ' + c.before.join(' < '), at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])))
    }
    if (c.enabledButton) {
      const b = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find((m) => m[2] === c.enabledButton)
      check(name + ': "' + c.enabledButton + '" is not disabled', Boolean(b) && !/\bdisabled\b/.test(b[1]))
    }
    for (const s of c.mustNotContain ?? []) check(name + ': no ' + s, !html.includes(s))
    // Step 21: on the desk, no dollar amount without its label, in any case.
    if (n.startsWith('Desk')) {
      const bare = unlabelled(html)
      if (bare.length) check(name + ': a dollar amount without the label (' + bare.slice(0, 3).join(' | ') + ')', false)
    }
  }
}

console.log(NL + '  ' + bad + ' problem(s)')
process.exitCode = bad ? 1 : 0
