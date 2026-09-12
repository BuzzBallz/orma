/**
 * Render the verification screen to a string against the REAL captured payload.
 *
 * Typechecking proves the shapes line up. This proves the component does not throw on
 * the actual bytes the API serves, and that the three figures the pitch depends on are
 * genuinely in the output rather than merely in the props. Cheap, and it catches the
 * class of mistake that only shows up in front of a room.
 *
 *   pnpm smoke                          (needs the API on :8787)
 *
 * tsx is invoked through npx rather than added to devDependencies: re-resolving this
 * lockfile mid-event to gain one dev tool is a poor trade, and the binary is cached.
 *
 * The --tsconfig flag in that script is load-bearing: without it tsx falls back to the
 * classic JSX runtime, the component throws "React is not defined", and the failure
 * looks like a bug in the screen rather than in the harness.
 */
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const race = await (await fetch(BASE + '/api/indexer-race')).json()

const { Evidence } = await import('../src/screens/Evidence.tsx')
const html = renderToString(createElement(Evidence, { d: race }))

const must = [
  race.readings.naive.value,
  race.readings.correct.value,
  String(race.readings.divergenceBps),
]
let bad = 0
for (const m of must) {
  const ok = html.includes(m)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'MISS'} ${m}`)
}
// The empty object is the whole point: if it is not rendered, the screen is decoration.
const emptyRendered = html.includes('{}')
console.log(`  ${emptyRendered ? 'ok  ' : 'MISS'} empty PreviousFields object is on screen`)
if (!emptyRendered) bad++

console.log(`\n  ${html.length} bytes rendered, ${bad} problem(s)`)
process.exit(bad ? 1 : 0)
