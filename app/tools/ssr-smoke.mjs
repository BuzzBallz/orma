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

const grab = async (path) => {
  try {
    const r = await fetch(BASE + path)
    return r.ok ? await r.json() : null
  } catch {
    return null
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
const plain = (h) => h.replaceAll('<!-- -->', '')
const check = (what, ok) => {
  if (!ok) bad++
  console.log('  ' + (ok ? 'ok  ' : 'MISS') + ' ' + what)
}
const { DeskScreen, DESK_TABS } = await import('../src/screens/Desk.tsx')
const { Figure, Recompute } = await import('../src/components/Ledger.tsx')

const harbor = JSON.parse(readFileSync('../demo/harbor-1.json', 'utf8'))
const desk = JSON.parse(readFileSync('../demo/desk.json', 'utf8'))
const ticket = await grab('/api/tickets?share=' + harbor.shareMptId + '&op=pledge&units=' + desk.plannedLoan.units + '&mandate=desk-1')
console.log(NL + '  desk')
if (!ticket) {
  check('/api/tickets returned a Harbor-1 ticket', false)
} else {
  for (const tab of DESK_TABS) {
    const html = plain(renderToString(createElement(DeskScreen, { ticket, mark: null, tab: tab.id })))
    for (const s of tab.mustContain) check('tab ' + tab.id + ': ' + s, html.includes(s))
  }
  const html = plain(renderToString(createElement(DeskScreen, { ticket, mark: null, tab: 'ticket' })))
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
}

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
  let src = readFileSync(file, 'utf8')
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
    for (const s of c.mustContain ?? []) check(n + ' / ' + c.name + ': ' + s, html.includes(s))
  }
}

console.log(NL + '  ' + bad + ' problem(s)')
process.exitCode = bad ? 1 : 0
