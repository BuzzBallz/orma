// Offline check of the loan status a performing loan gets as its payment date nears: due soon is
// the end of the interval, not all of it. No network, no ledger.
//   node src/dev/check-figures.mjs
import { normaliseLoan } from '../xrpl.mjs'
import { Reader } from '../poll.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const DAY = 86400
const NOW = 800000000
const status = (dueInSeconds, interval, grace = 0) =>
  normaliseLoan({ Flags: 0, NextPaymentDueDate: NOW + dueInSeconds, PaymentInterval: interval, GracePeriod: grace }, NOW).status

eq('due in 30 days of a 30-day interval', status(30 * DAY, 30 * DAY), 'current')
eq('due in 28 days of a 30-day interval', status(28 * DAY, 30 * DAY), 'current')
eq('due in 3 days of a 30-day interval', status(3 * DAY, 30 * DAY), 'due_soon')
eq('due in 4 days of a 30-day interval', status(4 * DAY, 30 * DAY), 'current')
eq('due in 3 days of a 365-day interval: capped at three days', status(3 * DAY, 365 * DAY), 'due_soon')
eq('due in 4 days of a 365-day interval', status(4 * DAY, 365 * DAY), 'current')
eq('due in 50 seconds of a 600-second interval', status(50, 600), 'due_soon')
eq('due in 100 seconds of a 600-second interval', status(100, 600), 'current')
eq('a day late, within its grace', status(-DAY, 30 * DAY, 2 * DAY), 'overdue')

// One pass reads one ledger: the one it took its close time from, for the vault, its brokers and its loans.
const asked = []
const at = (cmd) => (req) => { asked.push(cmd + '@' + req); }
const fake = {
  lastLedger: null,
  async closeTime() { this.lastLedger = 101; return NOW },
  async vaultInfo(id, ledger) { at('vault_info')(ledger); return { index: id, Owner: 'rOwner', Account: 'rPseudo', AssetsTotal: '1', AssetsAvailable: '1', shares: { OutstandingAmount: '1' } } },
  async accountObjects(account, type, ledger) { at('account_objects')(ledger); return [{ index: 'B'.repeat(64), VaultID: 'AB'.repeat(32), LoanSequence: 2 }] },
  async loan(ref, ledger) { at('loan')(ledger); return { index: 'C'.repeat(64), Flags: 0, NextPaymentDueDate: NOW + DAY, PaymentInterval: 30 * DAY } },
}
await new Reader(['AB'.repeat(32)], fake).tick()
eq('a pass reads the vault, its brokers and its loans at one ledger', asked, ['vault_info@101', 'account_objects@101', 'loan@101'])

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
