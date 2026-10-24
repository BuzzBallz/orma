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
const { DeskScreen, DESK_TABS, OPERATOR_ACTIONS, rememberOperator } = await import('../src/screens/Desk.tsx')
const { Figure, Recompute } = await import('../src/components/Ledger.tsx')
const api = await import('../src/lib/api.ts')
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
  }
}

console.log(NL + '  ' + bad + ' problem(s)')
process.exitCode = bad ? 1 : 0
