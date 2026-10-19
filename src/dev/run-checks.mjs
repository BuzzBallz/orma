// npm test: every check in src/dev that needs neither Devnet nor the gitignored fixtures/ and .demo/,
// one after the other. A new check-*.mjs is picked up without touching package.json; one that needs
// the network goes in NEEDS_DEVNET.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NEEDS_DEVNET = new Set([
  'check-reader.mjs', 'check-score.mjs', 'check-contract.mjs', 'check-oracle.mjs',
  'check-collateral.mjs', 'check-history.mjs', 'check-loanset-overload.mjs', 'check-demo-ready.mjs',
])
const dir = fileURLToPath(new URL('.', import.meta.url))
const runs = readdirSync(dir)
  .filter((f) => /^check-.+\.mjs$/.test(f) && !NEEDS_DEVNET.has(f))
  .sort()
  .flatMap((f) => (f === 'check-evidence.mjs' ? [[f], [f, '--self-test']] : [[f]]))

const failed = []
for (const [file, ...args] of runs) {
  console.log(`\n# ${file} ${args.join(' ')}`)
  if (spawnSync(process.execPath, [dir + file, ...args], { stdio: 'inherit' }).status !== 0) failed.push([file, ...args].join(' '))
}
console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')}` : `\nall ${runs.length} passed`)
process.exitCode = failed.length ? 1 : 0
