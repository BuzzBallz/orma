/**
 * Can the impairment authority be delegated? Re-proven on Devnet, during the event.
 *
 * WHY THIS MATTERS. The whole asymmetry argument rests on the vault owner and the
 * LoanBroker owner being the same account with no way out. If XLS-75 PermissionDelegation
 * let that owner hand impairment authority to an independent third party, the conflict
 * would be voluntary rather than structural, and the paper's central claim would be much
 * weaker. So it has to be tested rather than asserted.
 *
 * WHY THERE IS NO HASH FOR THE FAILURES, AND WHY THAT IS CORRECT. A `tem` result is
 * rejected at submission: it never reaches a ledger and is never assigned a slot, so it
 * has no transaction hash to cite. Asking for one is asking for something the result class
 * cannot produce. The evidence shape that IS available, and that this probe captures, is
 * a positive control: the same transaction type, from the same account, on the same
 * network, delegating a permission that is allowed. If that succeeds with a hash while the
 * lending permissions are refused, delegation demonstrably works here and the lending
 * suite is specifically excluded.
 *
 * Run: node src/demo/probe-delegation.mjs
 * Out: demo/delegation.json  (TRACKED)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client } from 'xrpl'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = 'demo/delegation.json'

// PermissionValue is the transaction type NAME as a string. xrpl 5.2.0's client-side
// validator refuses the numeric type outright, which is worth knowing: the wire format
// carries a number, the library does not accept one.
//
// Payment is the control. The rest are the lending suite: if any one of them were
// delegable the asymmetry argument would not hold.
const PERMISSIONS = [
  { value: 'Payment', control: true },
  { value: 'LoanManage' },
  { value: 'VaultCreate' },
  { value: 'VaultDeposit' },
  { value: 'LoanBrokerSet' },
  { value: 'LoanSet' },
  { value: 'VaultWithdraw' },
].map((p) => ({ ...p, name: p.value }))

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const buildVersion = (await c.request({ command: 'server_info' })).result.info.build_version
console.log(`\n  rippled ${buildVersion}`)
console.log('  can impairment authority be delegated?\n')

const { wallet: owner } = await c.fundWallet()
const { wallet: delegate } = await c.fundWallet()
console.log(`    owner    ${owner.address}`)
console.log(`    delegate ${delegate.address}\n`)

const results = []
for (const p of PERMISSIONS) {
  let code, hash = null, onLedger = false
  try {
    const r = await c.submitAndWait(
      {
        TransactionType: 'DelegateSet',
        Account: owner.address,
        Authorize: delegate.address,
        Permissions: [{ Permission: { PermissionValue: p.value } }],
      },
      { wallet: owner, autofill: true },
    )
    code = r.result.meta.TransactionResult
    hash = r.result.hash
    onLedger = true
  } catch (e) {
    // A tem* is thrown by the local check layer rather than returned, and never lands.
    code = e?.data?.error_exception ?? e?.data?.error ?? String(e)
    code = String(code).match(/tem[A-Z_]+/)?.[0] ?? String(code).slice(0, 60)
  }
  results.push({ permission: p.name, control: Boolean(p.control), code, hash, onLedger })
  const mark = p.control ? (code === 'tesSUCCESS' ? 'ok  ' : 'XX  ') : (code.startsWith('tem') ? 'REJ ' : 'XX  ')
  console.log(`    ${mark} ${String(p.name).padEnd(15)}  ${code}${hash ? '  ' + hash.slice(0, 20) + '…' : '  (no ledger slot)'}`)
}

const control = results.find((r) => r.control)
const lending = results.filter((r) => !r.control)
const allRefused = lending.every((r) => String(r.code).startsWith('tem'))

const out = {
  probedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  probedDuring: 'XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026',
  network: 'devnet',
  buildVersion,
  question: 'Can a vault owner delegate LoanManage authority to an independent third party under XLS-75?',
  answer: allRefused && control?.code === 'tesSUCCESS'
    ? 'No. Delegation works on this network, and the lending suite is specifically not delegable.'
    : 'INCONCLUSIVE, see results.',
  control: control
    ? { permission: control.permission, code: control.code, hash: control.hash,
        note: 'Positive control. Delegation demonstrably works on this network.' }
    : null,
  lendingSuite: lending.map((r) => ({ permission: r.permission, code: r.code, onLedger: r.onLedger })),
  whyNoHashes: 'A tem result is rejected at submission. It never reaches a ledger and is never assigned a slot, so it has no transaction hash. The positive control carries one because it succeeded.',
  accounts: { owner: owner.address, delegate: delegate.address },
}
mkdirSync('demo', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')

console.log(`\n  ${out.answer}`)
console.log(`  -> ${OUT}\n`)
await c.disconnect()
if (!allRefused || control?.code !== 'tesSUCCESS') {
  console.error('  THE RESULT DOES NOT SUPPORT THE CLAIM. Do not cite it.')
  process.exit(1)
}
