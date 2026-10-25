// Offline check of edge cases in the Feed, the Universe and the share metadata reader, each on a fake
// ledger client: a statement transaction that cannot be found, a pass read at an older ledger, escrows
// over two pages, a vault seen live whose owner's brokers run past MAX_PAGES, metadata that is not hex.
// No Devnet.
//   node src/dev/check-core-edges.mjs
import { num } from '../num.mjs'
import { createFeed } from '../feed/derive.mjs'
import { readUniverse } from '../universe/scan.mjs'
import { parseShareMetadata } from '../metadata.mjs'
import { encodeStatement } from '../nyc/contracts.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const VAULT = 'AB'.repeat(32)
const OWNER = 'rKS7Q49nLj8QzSBzXwiwUUehZbcuCHfEXT'
const BORROWER = 'rBorrower'
const SHARE = 'CD'.repeat(24)
const LOAN = 'EF'.repeat(32)
const TX = (n) => String(n).padStart(64, '0')
const types = (evs) => evs.map((e) => e.type)

const snap = (L, changed = 90) => ({
  vaultId: VAULT, ledgerIndex: L, ledgerHash: 'A'.repeat(64),
  vault: { owner: OWNER, shareMptId: SHARE, lossUnrealized: num('0'), assetsTotal: num('50000000'), assetsAvailable: num('35000000'), lastChangeLedger: changed },
  brokers: [{ loanBrokerId: 'BB'.repeat(32), coverAvailable: num('3000000') }],
  loans: [{ loanId: LOAN, previousTxnId: TX(1), status: 'current', flags: 0, principalOutstanding: num('5000000'), nextPaymentDueAt: '2026-10-25T12:00:00Z', label: 'L1' }],
})
const escrow = (index) => ({ index, Account: BORROWER, Destination: 'rCollateral', Amount: { mpt_issuance_id: SHARE, value: '5000000' }, PreviousTxnID: TX(7), LedgerEntryType: 'Escrow' })

/** A fake ledger: `pages[L]` is the list of escrow pages at L; `data` the Vault's Data; `txFails` makes `tx` throw. */
function fakeLedger({ pages = {}, data = null, txFails = false } = {}) {
  const calls = []
  return {
    calls,
    xrpl: {
      req: async (p) => {
        calls.push(p)
        if (p.command === 'account_objects') {
          const list = pages[p.ledger_index] ?? [[]]
          const i = p.marker === undefined ? 0 : Number(p.marker)
          return { result: { account_objects: list[i] ?? [], ...(i + 1 < list.length && { marker: String(i + 1) }) } }
        }
        if (p.command === 'ledger_entry') return { result: { node: { Data: data ?? undefined, PreviousTxnID: TX(9), Owner: OWNER } } }
        if (p.command === 'tx') {
          if (txFails) throw Object.assign(new Error('txnNotFound'), { data: { error: 'txnNotFound' } })
          return { result: { hash: TX(9), tx_json: { TransactionType: 'VaultSet', Account: OWNER, Data: data } } }
        }
        throw new Error(`unexpected ${p.command}`)
      },
    },
  }
}
function fakeReader(xrpl) {
  const subs = []
  return { xrpl, subscribe: (fn) => (subs.push(fn), () => {}), emit: async (s) => { for (const fn of subs) await fn(s) } }
}

// --- the Feed -----------------------------------------------------------------------------------------
{
  const said = encodeStatement({ s: 'orma.stmt/1', loan: LOAN, kind: 'impaired', text: 'L1 marked impaired', at: 846180562 })
  const w = fakeLedger({ data: said, txFails: true, pages: { 101: [[escrow('E1'.repeat(32))]] } })
  const reader = fakeReader(w.xrpl)
  const feed = createFeed(reader, { escrowAccounts: [BORROWER] })
  await reader.emit(snap(100))
  await reader.emit(snap(101))
  const all = feed.after(null)
  eq('a statement transaction that cannot be found: the baseline is composed, its STATEMENT without txHash, later events still come',
    [types(all), 'txHash' in (all[0] ?? {})], [['STATEMENT', 'SHARES_PLEDGED'], false])
}
{
  const e1 = escrow('E1'.repeat(32))
  const w = fakeLedger({ pages: { 100: [[]], 102: [[e1]], 101: [[]], 103: [[e1]] } })
  const reader = fakeReader(w.xrpl)
  const feed = createFeed(reader, { escrowAccounts: [BORROWER] })
  for (const L of [100, 102, 101, 103]) await reader.emit(snap(L))
  eq('a pass read at an older ledger is skipped: one SHARES_PLEDGED, never replayed', types(feed.after(null)), ['SHARES_PLEDGED'])
  eq('the older ledger is never read for escrows', w.calls.some((c) => c.command === 'account_objects' && c.ledger_index === 101), false)
}
{
  const w = fakeLedger({ pages: { 100: [[]], 101: [[], [escrow('E1'.repeat(32))]] } })
  const reader = fakeReader(w.xrpl)
  const feed = createFeed(reader, { escrowAccounts: [BORROWER] })
  await reader.emit(snap(100))
  await reader.emit(snap(101))
  const reads = w.calls.filter((c) => c.command === 'account_objects' && c.ledger_index === 101)
  eq('escrows over two pages: marker followed at the same ledger, the pledge on page 2 found',
    [types(feed.after(null)), reads.length, reads[1]?.marker, reads.every((c) => c.ledger_index === 101)], [['SHARES_PLEDGED'], 2, '1', true])
}

// --- the Universe -------------------------------------------------------------------------------------
{
  const LIVE = 'C1'.repeat(32)
  const xrpl = {
    lastLedger: 1000, lastLedgerHash: 'D'.repeat(64), lastCloseTime: 846200000,
    async req(p) {
      if (p.command === 'vault_info') return { result: { vault: { index: LIVE, Owner: 'rStranger', Asset: { currency: 'XRP' } }, ledger_index: 1000 } }
      if (p.command === 'account_objects') return { result: { account_objects: [], marker: 'again', ledger_index: 1000 } }
      throw new Error(`unexpected ${p.command}`)
    },
  }
  const got = await readUniverse({ xrpl, known: [], live: { ids: () => [LIVE], liveSinceLedger: () => 900 } })
    .then((u) => [u.count, u.coverage.live], (e) => `rejected: ${e?.name}`)
  eq('a vault seen only live whose owner\'s brokers run past MAX_PAGES is omitted, the document still served', got, [0, 1])
}

// --- share metadata -----------------------------------------------------------------------------------
{
  const json = Buffer.from(JSON.stringify({ t: 'X' }), 'utf8').toString('hex').toUpperCase()
  eq('metadata that is not hex says so; valid hex, with or without 0x, still parses',
    [parseShareMetadata('ZZ12').reason, parseShareMetadata('ABC').reason, parseShareMetadata(json).meta, parseShareMetadata(`0x${json}`).meta],
    ['metadata is not valid hex', 'metadata is not valid hex', { t: 'X' }, { t: 'X' }])
}

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
