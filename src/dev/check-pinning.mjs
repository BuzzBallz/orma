// Offline check that every state read is pinned to one numeric validated ledger L: a Reader pass, and
// the reads made outside it (a broker, a share issuance, a gate, an escrow scan), all go out at L; a
// fresh connection discovers L before its first read instead of sending ledger_index null; only
// closeTime() asks for 'validated', and only account_tx (history) is not pinned. Each snapshot carries
// L and its hash, and reaches both kinds of subscriber. A fake client records every request; no network.
//   node src/dev/check-pinning.mjs
import { readFileSync } from 'node:fs'
import { Xrpl, normaliseVault } from '../xrpl.mjs'
import { Reader } from '../poll.mjs'
import { gateStatus } from '../credentials.mjs'
import { findShareEscrows } from '../collateral.mjs'
import { num } from '../num.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const VAULT = 'AB'.repeat(32)
const BROKER = 'B'.repeat(64)
const SHARE = 'CD'.repeat(24)
const DOMAIN = 'D'.repeat(64)
const OWNER = 'rOwnerXXXXXXXXXXXXXXXXXXXXXXX'
const PSEUDO = 'rVaultPseudoXXXXXXXXXXXXXXXXX'
const HOLDER = 'rHolderXXXXXXXXXXXXXXXXXXXXXX'
const hashOf = (L) => L.toString(16).toUpperCase().padStart(64, '0')

/**
 * A fake rippled behind a real Xrpl: every request recorded, minimal answers (one vault, one broker,
 * two loans, one issuance, a domain, an escrow), the validated ledger moved by hand.
 */
function fakeXrpl({ ledger = 1000, withHash = true } = {}) {
  const x = new Xrpl('wss://fake.invalid')
  const state = { ledger, requests: [] }
  const node = (n) => ({ result: { node: n, ledger_index: state.ledger } })
  x.client = {
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    on: () => {},
    async request(p) {
      state.requests.push(structuredClone(p))
      switch (p.command) {
        case 'ledger':
          return { result: { ledger_index: state.ledger, ...(withHash && { ledger_hash: hashOf(state.ledger) }), ledger: { ledger_index: String(state.ledger), close_time: 800000000 + state.ledger, ...(withHash && { ledger_hash: hashOf(state.ledger) }) } } }
        case 'vault_info':
          return { result: { vault: { index: VAULT, Owner: OWNER, Account: PSEUDO, ShareMPTID: SHARE, AssetsTotal: '51000000', AssetsAvailable: '41000000', LossUnrealized: '10000000', Scale: 0, Flags: 0x00010000, shares: { mpt_issuance_id: SHARE, OutstandingAmount: '51000000', LockedAmount: '2000000' } } } }
        case 'account_objects':
          if (p.type === 'loan_broker') return { result: { account_objects: [{ index: BROKER, VaultID: VAULT, LoanSequence: 3, Owner: OWNER, Account: 'rBrokerXXXXXXXXXXXXXXXXXXXXXX', DebtTotal: '15000000', CoverAvailable: '2000000' }] } }
          if (p.type === 'escrow') return { result: { account_objects: [{ index: 'E'.repeat(64), Account: HOLDER, Destination: OWNER, Amount: { mpt_issuance_id: SHARE, value: '5' } }] } }
          return { result: { account_objects: [] } }
        case 'ledger_entry':
          if (p.loan) return node({ index: `${p.loan.loan_seq}`.repeat(64).slice(0, 64), LoanBrokerID: BROKER, Borrower: HOLDER, PrincipalOutstanding: '5000000', PaymentRemaining: 2, Flags: p.loan.loan_seq === 1 ? 0x00020000 : 0 })
          if (p.mpt_issuance) return node({ index: SHARE, DomainID: DOMAIN, Flags: 0x38, OutstandingAmount: '51000000' })
          if (p.index === DOMAIN) return node({ index: DOMAIN, Owner: OWNER, AcceptedCredentials: [] })
          if (p.index === BROKER) return node({ index: BROKER, VaultID: VAULT })
          throw Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
        case 'account_tx':
          return { result: { transactions: [], ledger_index_min: 1, ledger_index_max: state.ledger } }
        default:
          throw new Error(`unexpected command ${p.command}`)
      }
    },
  }
  return { x, state }
}

const STATE_READS = new Set(['vault_info', 'ledger_entry', 'account_objects'])
/** State reads not sent at exactly ledger L: 'validated', 'current', absent, or another ledger. */
const unpinned = (requests, L) => requests.filter((p) => STATE_READS.has(p.command) && p.ledger_index !== L)

console.log('a Reader pass')
{
  const L = 1000
  const { x, state } = fakeXrpl({ ledger: L })
  const reader = new Reader([VAULT], x)
  const viaSetter = []
  const viaSubscribe = []
  reader.onSnapshot = (snap) => viaSetter.push(snap)
  reader.subscribe((snap) => viaSubscribe.push(snap))
  reader.subscribe(() => { throw new Error('a consumer that throws') })
  reader.subscribe(async () => { throw new Error('a consumer that rejects') })
  const later = []
  const off = reader.subscribe((snap) => later.push(snap))
  off()
  await reader.tick()
  const snap = reader.get(VAULT)

  eq('the pass read the vault, its broker and both loans', state.requests.map((p) => p.command), ['ledger', 'vault_info', 'account_objects', 'ledger_entry', 'ledger_entry'])
  eq("zero vault_info, ledger_entry or account_objects not at L ('validated', 'current', absent or another)", unpinned(state.requests, L), [])
  eq("only closeTime() asks for 'validated'", state.requests.filter((p) => p.ledger_index === 'validated').map((p) => p.command), ['ledger'])
  eq('the snapshot is stamped with L and its hash', [snap.ledgerIndex, snap.ledgerHash, /^[0-9A-F]{64}$/.test(snap.ledgerHash)], [L, hashOf(L), true])
  eq('the Reader keeps L and its hash', [reader.ledgerIndex, reader.ledgerHash], [L, hashOf(L)])
  eq('the subscriber set by reader.onSnapshot = fn got it', viaSetter.map((s) => [s.ledgerIndex, s.ledgerHash]), [[L, hashOf(L)]])
  eq('the subscriber of reader.subscribe(fn) got it', viaSubscribe.map((s) => [s.ledgerIndex, s.ledgerHash]), [[L, hashOf(L)]])
  eq('a consumer that throws or rejects does not break the pass', [reader.degraded, reader.passes], [false, 1])
  eq('an unsubscribed consumer gets nothing', later.length, 0)
  eq('the getter returns the hook it was set to', typeof reader.onSnapshot, 'function')
  reader.onSnapshot = (s) => viaSetter.push(s)
  reader.onSnapshot = null
  state.ledger = L + 1
  await reader.tick()
  eq('setting the hook replaces the previous one, null removes it; subscribe() stays', [viaSetter.length, viaSubscribe.length], [1, 2])
  eq('the next pass is pinned to the next ledger', [unpinned(state.requests.slice(5), L + 1), reader.get(VAULT).ledgerIndex], [[], L + 1])
  eq('the vault keeps its shares in escrow (lockedAmount)', reader.get(VAULT).vault.lockedAmount.toFixed(), '2000000')

  console.log('reads outside a pass, with no ledger given')
  const Lr = reader.ledgerIndex
  const before = state.requests.length
  state.ledger = Lr + 7 // the ledger moved on; an off-cycle read stays at the Reader's last L
  await x.loanBroker(BROKER)
  await x.mptIssuance(SHARE.toLowerCase())
  const gate = await gateStatus(x, reader.get(VAULT).vault)
  const escrows = await findShareEscrows(x, SHARE, [HOLDER, OWNER])
  const off1 = state.requests.slice(before)
  eq('Xrpl.loanBroker, Xrpl.mptIssuance, gateStatus and findShareEscrows', off1.map((p) => p.command), ['ledger_entry', 'ledger_entry', 'ledger_entry', 'ledger_entry', 'account_objects', 'account_objects'])
  eq("each goes out at the Reader's last validated L", unpinned(off1, Lr), [])
  eq('none of them reads a ledger first', off1.filter((p) => p.command === 'ledger').length, 0)
  eq('and they still answer', [gate.domainId, gate.domainOwner, escrows.length], [DOMAIN, OWNER, 1])
  const at = Lr + 3
  const before2 = state.requests.length
  await gateStatus(x, reader.get(VAULT).vault, at)
  await findShareEscrows(x, SHARE, [HOLDER], at)
  await x.vaultInfo(VAULT, at)
  await x.accountObjects(OWNER, 'loan_broker', at)
  await x.loan(BROKER, at)
  eq('a ledger given is the ledger used', unpinned(state.requests.slice(before2), at), [])
  let refused = null
  try { await x.vaultInfo(VAULT, 'validated') } catch (e) { refused = e.constructor.name }
  eq("a state read never sends 'validated', even when asked to", refused, 'TypeError')

  console.log('account_tx, the one documented exception')
  const before3 = state.requests.length
  await x.accountTx(HOLDER)
  const tx = state.requests.slice(before3)
  eq('account_tx goes out over a window, without a numeric ledger_index', tx.map((p) => [p.command, typeof p.ledger_index, p.ledger_index_min, p.ledger_index_max]), [['account_tx', 'undefined', -1, -1]])
  const all = state.requests.filter((p) => !Number.isSafeInteger(p.ledger_index))
  eq("every request without a numeric ledger_index is closeTime()'s 'ledger' or account_tx", [...new Set(all.map((p) => p.command))].sort(), ['account_tx', 'ledger'])
  const src = readFileSync(new URL('../xrpl.mjs', import.meta.url), 'utf8')
  const head = src.slice(0, src.indexOf('import '))
  eq('the head of src/xrpl.mjs documents account_tx as the exception', /account_tx[^]*not pinned/.test(head), true)
}

console.log('a fresh Xrpl that has read no ledger yet')
{
  const { x, state } = fakeXrpl({ ledger: 2000 })
  eq('it has no ledger', x.lastLedger, null)
  await x.mptIssuance(SHARE)
  eq('mptIssuance() reads the validated ledger first, then the issuance at that number', state.requests, [
    { command: 'ledger', ledger_index: 'validated' },
    { command: 'ledger_entry', mpt_issuance: SHARE, ledger_index: 2000 },
  ])
  for (const [name, call] of [
    ['vaultInfo', (y) => y.vaultInfo(VAULT)], ['loanBroker', (y) => y.loanBroker(BROKER)], ['loan', (y) => y.loan({ loan_broker_id: BROKER, loan_seq: 1 })],
    ['accountObjects', (y) => y.accountObjects(OWNER, 'loan_broker')], ['gateStatus', (y) => gateStatus(y, { shareMptId: SHARE, isPrivate: true })],
    ['findShareEscrows', (y) => findShareEscrows(y, SHARE, [HOLDER, OWNER])],
  ]) {
    const fresh = fakeXrpl({ ledger: 3000 })
    await call(fresh.x)
    const [first, ...rest] = fresh.state.requests
    eq(`${name}() on a fresh Xrpl: one 'ledger' read, then every read at 3000`, [first, rest.length > 0 && unpinned(rest, 3000).length === 0, rest.filter((p) => p.command === 'ledger').length], [{ command: 'ledger', ledger_index: 'validated' }, true, 0])
  }
}

console.log('a server that gives no ledger hash')
{
  const { x } = fakeXrpl({ ledger: 4000, withHash: false })
  const reader = new Reader([VAULT], x)
  await reader.tick()
  eq('the snapshot carries ledgerHash null, not an error', [reader.get(VAULT).ledgerIndex, reader.get(VAULT).ledgerHash, reader.degraded], [4000, null, false])
}

console.log('normaliseVault')
eq('lockedAmount read on the vault, absent meaning zero', [normaliseVault({ LockedAmount: '7' }, 0).lockedAmount.toFixed(), normaliseVault({}, 0).lockedAmount.toFixed()], [num('7').toFixed(), '0'])

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
