/**
 * Re-resolve a baked facility's valuation pointer and repair its committed artefact.
 *
 * WHY THIS IS NEEDED. bake-metadata.mjs closes the ledger half of the loop and then tries
 * the service half, but the service reads the facilities in demo/ at startup and the
 * facility it has just created is seconds old. So a fresh bake records a failing fifth
 * step and a null pledge, which is honest at the moment it is written and wrong an hour
 * later once the service has been restarted.
 *
 * Leaving it that way matters: the artefact is committed, a reader takes it as evidence,
 * and it shows the loop failing when the loop works.
 *
 * Run this after restarting the API on a fresh bake:
 *   node src/demo/repair-resolution.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const FILE = 'demo/metadata-vault.json'
const BASE = process.env.API_BASE ?? 'http://localhost:8787'

if (!existsSync(FILE)) {
  console.error(`  ${FILE} not found. Bake it first: node src/demo/bake-metadata.mjs`)
  process.exit(1)
}
const j = JSON.parse(readFileSync(FILE, 'utf8'))

let r
try {
  const res = await fetch(`${BASE}/api/mpt/${j.shareMptId}/resolve?units=1000000`)
  r = await res.json()
} catch (e) {
  console.error(`  ${BASE} did not answer: ${String(e).slice(0, 90)}`)
  console.error('  Start the reader first:  node src/index.mjs')
  process.exit(1)
}

if (!r.resolved || !r.nav) {
  console.error('  the pointer still does not resolve to a valuation')
  for (const s of r.steps ?? []) console.error(`    ${s.ok ? 'ok  ' : 'FAIL'} ${s.step}  ${String(s.detail ?? '').slice(0, 70)}`)
  console.error('\n  If the last step failed, the service is running but does not serve this')
  console.error('  facility yet. Restart it so it picks up demo/, then run this again.')
  process.exit(1)
}

j.resolution = {
  verifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  steps: r.steps,
  resolved: r.resolved,
  navUrl: r.navUrl ?? null,
  xls89: r.metadata?.conformance ?? null,
}
j.pledgeExample = r.pledge ?? null
j.unitValue = r.nav.unitValue
writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n')

console.log(`  ${r.steps.filter((s) => s.ok).length}/${r.steps.length} steps green`)
console.log(`  unit value  reported ${r.nav.unitValue.reported}  held ${r.nav.unitValue.held}  ${r.nav.unitValue.divergenceBps} bp`)
if (r.pledge) console.log(`  pledge of ${r.pledge.units} units  overstatement avoided ${r.pledge.overstatement} drops`)
console.log(`  -> ${FILE}`)
