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

  for (const m of [race.readings.naive.value, race.readings.correct.value, String(race.readings.divergenceBps)]) {
    const ok = html.includes(m)
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

  const { Facility } = await import('../src/screens/Facility.tsx')
  const page = renderToString(createElement(Facility, { d: detail, history, collateral }))

  const hasConduct = page.includes('Exhibit 3')
  const hasPledges = page.includes('Exhibit 4')
  console.log(NL + '  facility ' + id.slice(0, 10) + ' renders, ' + page.length + ' bytes')
  console.log('  ' + (hasConduct ? 'ok  ' : '--  ') + ' Exhibit 3 manager conduct '
    + (hasConduct ? 'present' : 'omitted, no manager on file'))
  console.log('  ' + (hasPledges ? 'ok  ' : '--  ') + ' Exhibit 4 pledged units   '
    + (hasPledges ? 'present' : 'omitted, nothing pledged'))

  // The whole reason the API reports null rather than 0: an unstated book must never
  // print as a figure. If an event says the book is unknown, an em-dash reaches the page.
  if (history?.events?.some((e) => e.debtBefore === null)) {
    const dashed = page.includes(String.fromCharCode(8212))
    if (!dashed) bad++
    console.log('  ' + (dashed ? 'ok  ' : 'MISS') + ' unstated book renders as an em-dash, not 0.00')
  }
}

console.log(NL + '  ' + bad + ' problem(s)')
process.exit(bad ? 1 : 0)
