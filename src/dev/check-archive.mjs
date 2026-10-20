// Offline check of the archive fallback, on the real archive in evidence/devnet-tx: what the two
// history routes serve as Devnet's floor rises past the event's ledgers. The live reads are
// simulated from the archive itself, as a server with that floor would return them. No network.
//   node src/dev/check-archive.mjs
import { readFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadArchive, mergeHistory, historyWindow, creates, ARCHIVE_DIR } from '../archive.mjs'
import { fetchNavHistory } from '../navhistory.mjs'
import { readBrokerHistory, fetchBrokerHistory, analyseOrdering, reputation } from '../history.mjs'
import { createApi } from '../api.mjs'
import { extendDeclaration } from './capture-history.mjs'

const COVERAGE = JSON.parse(readFileSync(join(ARCHIVE_DIR, '_manifest.json'), 'utf8')).coverage
const MERIDIAN = '864C5A2DDCED78C6198B0703169D533B747A56E5F9398D832033F79E37E8C835'
const KESTREL = '24EAA01AD4CE70D8ABB4ACB4255DC4C216B8AF3B9E7315DB8052BFC1E5810089'
// PreviousTxnLgrSeq of each object, read from Devnet on 2026-10-13: where each history has to reach.
const LAST_CHANGE = { [MERIDIAN]: 5262028, [KESTREL]: 5262083, meridianBroker: 5261989, kestrelBroker: 5262083 }
const BEFORE_EVENT = 5193077   // the public server's floor on 2026-10-13
const PRUNED = 6200000         // a floor above every event ledger
const arc = loadArchive()

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

// What account_tx returns on a server whose floor is `floor`: the account's transactions at or above
// it, newest first, with the range it searched.
const devnet = (floor) => ({
  accountTxWindow: async (account) => ({
    transactions: (arc.accounts.get(account)?.entries ?? [])
      .filter((e) => e.ledger_index >= floor)
      .map(({ source, ...e }) => e)
      .sort((a, b) => b.ledger_index - a.ledger_index || b.meta.TransactionIndex - a.meta.TransactionIndex),
    ledgerMin: floor, ledgerMax: floor + 900000, truncated: false,
  }),
})

const vault = (id) => ({ vaultId: id, pseudoAccount: COVERAGE.vaults[id].pseudoAccount.account, lastChangeLedger: LAST_CHANGE[id] })
const nav = (h) => h.points.map((p) => `${p.kind} ${p.navNaive} ${p.navCorrect}`)
const sources = (xs) => xs.map((x) => x.source)

// A broker exactly as the ledger created it, from its LoanBrokerSet in the archive.
const brokerOf = (vaultId, lastChangeLedger) => {
  const { owner } = COVERAGE.vaults[vaultId]
  const id = owner.loanBrokerIds[0]
  for (const e of arc.accounts.get(owner.account).entries) {
    const n = e.meta.AffectedNodes.find((a) => a.CreatedNode?.LedgerEntryType === 'LoanBroker' && a.CreatedNode.LedgerIndex === id)
    if (n) {
      const f = n.CreatedNode.NewFields
      return { loanBrokerId: id, owner: owner.account, coverRateMinimum: f.CoverRateMinimum, coverRateLiquidation: f.CoverRateLiquidation, lastChangeLedger, createdIn: e.ledger_index }
    }
  }
  throw new Error(`no LoanBrokerSet for the broker of ${vaultId.slice(0, 8)} in the archive`)
}
const kestrel = brokerOf(KESTREL, LAST_CHANGE.kestrelBroker)
const meridian = brokerOf(MERIDIAN, LAST_CHANGE.meridianBroker)
const conduct = async (xrpl, opts = {}, broker = kestrel, vaultId = KESTREL) => {
  const { events, window } = await readBrokerHistory(xrpl, broker, vault(vaultId), opts)
  const ordering = analyseOrdering(events, broker, window)
  const rep = reputation(events, ordering, broker, window)
  return { events, window, ordering, rep, grade: `${rep.grade} ${rep.score}` }
}

console.log('\n  the archive')
eq('every declared transaction loads, for all ten accounts', [arc.accounts.size, [...arc.accounts.values()].every((c) => c.intact)], [10, true])
eq('its capture time is the one the manifest declares', arc.capturedAt, COVERAGE.capturedAt)

console.log('\n  merge')
const [newer, older] = [...arc.accounts.get(vault(MERIDIAN).pseudoAccount).entries].sort((a, b) => b.ledger_index - a.ledger_index)
const liveCopy = { ...newer, meta: { ...newer.meta, marker: 'live' } }
const merged = mergeHistory([liveCopy], [newer, older])
eq('a hash in both keeps the live copy', [merged.length, merged[0].source, merged[0].meta.marker], [2, 'live', 'live'])
eq('one only in the archive is marked so', merged[1].source, 'archive')
const sameLedger = (i, h) => ({ hash: h, ledger_index: 7, meta: { TransactionIndex: i } })
eq('newest first, by ledger then by position in it', mergeHistory([sameLedger(1, 'A'), sameLedger(3, 'B')], [sameLedger(2, 'C'), { hash: 'D', ledger_index: 8, meta: { TransactionIndex: 0 } }]).map((e) => e.hash), ['D', 'B', 'C', 'A'])

console.log('\n  the window')
const made = { hash: 'C', ledger_index: 150, meta: { TransactionIndex: 0, AffectedNodes: [{ CreatedNode: { LedgerEntryType: 'Vault', LedgerIndex: 'V' } }] } }
const span = (live, coverage, lastChange = 250) => historyWindow({
  live: { transactions: [], truncated: false, ...live }, coverage, capturedAt: null, merged: [made], origin: creates('Vault', 'V'), lastChange,
})
const kept100to200 = { ledgerMin: 100, ledgerMax: 200, entries: [made], intact: true }
eq('archive and live windows that touch: complete', span({ ledgerMin: 201, ledgerMax: 300 }, kept100to200).complete, true)
const holed = span({ ledgerMin: 202, ledgerMax: 300 }, kept100to200)
eq('a single ledger between them: incomplete, and that ledger named', [holed.complete, holed.reason], [false, 'ledger 201 is in neither the live window (202-300) nor the archive'])
eq('an archive with a transaction that did not load covers nothing', span({ ledgerMin: 201, ledgerMax: 300 }, { ...kept100to200, intact: false }).complete, false)
const reached = { transactions: [made, { hash: 'N', ledger_index: 260, meta: { TransactionIndex: 0, AffectedNodes: [] } }], ledgerMin: 100, ledgerMax: 300 }
eq('a live read that reached the creation: complete', span(reached, null).complete, true)
eq('the same read stopped by its page limit at the creation ledger: incomplete', span({ ...reached, truncated: true }, null).complete, false)
const blind = span({ ledgerMin: null, ledgerMax: null }, kept100to200, null)
eq('no stated range, no last change, nothing returned: incomplete', [blind.complete, blind.reason], [false, 'its last change is unknown, and the live read stated no range'])

console.log('\n  nav-history, Meridian')
const whole = await fetchNavHistory(devnet(BEFORE_EVENT), vault(MERIDIAN), { archive: arc })
eq('nothing pruned: the three points, all live, complete', [nav(whole), sources(whole.points), whole.window.complete, whole.window.archive.added],
  [['deposit 1.000000 1.000000', 'loan 1.000000 1.000000', 'impair 1.000000 0.803922'], ['live', 'live', 'live'], true, 0])
const pruned = await fetchNavHistory(devnet(PRUNED), vault(MERIDIAN), { archive: arc })
eq('all pruned: the same points, from the archive, complete', [nav(pruned), sources(pruned.points), pruned.window.complete], [nav(whole), ['archive', 'archive', 'archive'], true])
const cut = whole.points[1].hash && arc.accounts.get(vault(MERIDIAN).pseudoAccount).entries.find((e) => e.hash === whole.points[1].hash).ledger_index
const partial = await fetchNavHistory(devnet(cut), vault(MERIDIAN), { archive: arc })
eq('partly pruned (the live read is not empty): merged anyway, sources mixed', [nav(partial), sources(partial.points), partial.window.complete], [nav(whole), ['archive', 'live', 'live'], true])
const bare = await fetchNavHistory(devnet(PRUNED), vault(MERIDIAN), { archive: null })
eq('all pruned, no archive: no points, and it says the series is incomplete', [bare.points.length, bare.window.complete, /created/.test(bare.window.reason)], [0, false, true])
const later = await fetchNavHistory(devnet(7000000), vault(MERIDIAN), { archive: arc })
eq('floor past the archive\'s top, vault unchanged since: still complete', later.window.complete, true)
const unknown = await fetchNavHistory(devnet(7000000), { ...vault(MERIDIAN), lastChangeLedger: null }, { archive: arc })
eq('the same with its last change unknown: incomplete, the gap named', [unknown.window.complete, /^ledger \d+ is in neither/.test(unknown.window.reason)], [false, true])

console.log('\n  broker-history, Kestrel')
const live = await conduct(devnet(BEFORE_EVENT), { archive: null })
eq('nothing pruned: E 25, sequence score 0, from the live record alone', [live.grade, live.ordering.fairness, live.window.complete], ['E 25', '0.0000', true])
const kept = await conduct(devnet(PRUNED), { archive: arc })
eq('all pruned, with the archive: the same E 25, every event from the archive', [kept.grade, kept.ordering.fairness, sources(kept.events), kept.window.complete],
  ['E 25', '0.0000', ['archive', 'archive', 'archive'], true])
const lost = await conduct(devnet(PRUNED), { archive: null })
eq('all pruned, no archive: no grade at all, not A', [lost.rep.grade, lost.rep.score, lost.rep.withheld, lost.rep.findings[0].code, lost.ordering.applicable], [null, null, true, 'HISTORY_INCOMPLETE', false])
const firstDefault = live.events.find((e) => e.kind === 'default').ledgerIndex
const half = await conduct(devnet(firstDefault + 1), { archive: null })
eq('first default pruned, second still live, no archive: withheld', [half.events.filter((e) => e.kind === 'default').length, half.rep.grade], [1, null])
const orphaned = await conduct(devnet(kestrel.createdIn + 1), { archive: null })
eq('creation pruned, both defaults still live, no archive: no ordering either', [orphaned.events.filter((e) => e.kind === 'default').length, orphaned.ordering.applicable, orphaned.rep.grade], [2, false, null])
// An archive captured before Meridian's impairment, the impairment since pruned: the broker itself
// last changed before it, so only the vault's last change shows the record ends too early.
const early = { ...arc, accounts: new Map(arc.accounts) }
const impairAt = LAST_CHANGE[MERIDIAN]
const ownerCov = arc.accounts.get(meridian.owner)
early.accounts.set(meridian.owner, { ...ownerCov, ledgerMax: impairAt - 1, entries: ownerCov.entries.filter((e) => e.ledger_index < impairAt) })
const beforeImpair = await conduct(devnet(PRUNED), { archive: early }, meridian, MERIDIAN)
eq('archive ends before the last impairment: incomplete, though the broker had not changed since',
  [beforeImpair.events.some((e) => e.kind === 'impair'), beforeImpair.window.complete, beforeImpair.rep.grade], [false, false, null])
// What the build deployed on 13 September serves once the defaults are pruned: the case this fixes.
const old = await fetchBrokerHistory({ accountTx: async (a) => (await devnet(PRUNED).accountTxWindow(a)).transactions }, kestrel.owner, kestrel.loanBrokerId)
const oldRep = reputation(old, analyseOrdering(old, kestrel), kestrel)
eq('CONTROL: graded without a window, the pruned record scores A 100', `${oldRep.grade} ${oldRep.score}`, 'A 100')

console.log('\n  a damaged archive')
const dir = mkdtempSync(join(tmpdir(), 'orma-archive-'))
try {
  cpSync(ARCHIVE_DIR, dir, { recursive: true })
  const victim = whole.points[0].hash
  const t = JSON.parse(readFileSync(join(dir, `${victim}.json`), 'utf8'))
  t.Sequence += 1
  writeFileSync(join(dir, `${victim}.json`), JSON.stringify(t, null, 2))
  const damaged = loadArchive(dir)
  const c = damaged.accounts.get(vault(MERIDIAN).pseudoAccount)
  eq('a transaction that no longer hashes to its id is not served', c.entries.some((e) => e.hash === victim), false)
  eq('and its account no longer counts as covered', c.intact, false)
  const h = await fetchNavHistory(devnet(PRUNED), vault(MERIDIAN), { archive: damaged })
  eq('so the pruned series says it is incomplete', h.window.complete, false)
  eq('a missing directory is no archive', loadArchive(join(dir, 'absent')), null)
  // One owner declared under two facilities: the archive vouches for the range both declarations cover.
  const m = JSON.parse(readFileSync(join(dir, '_manifest.json'), 'utf8'))
  const again = m.coverage.vaults[MERIDIAN].owner
  m.coverage.vaults.extra = { label: 'same owner, captured earlier', pseudoAccount: null, owner: { ...again, ledgerMax: again.ledgerMax - 10 } }
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify(m, null, 2))
  eq('an account declared twice keeps the range both cover', loadArchive(dir).accounts.get(again.account).ledgerMax, again.ledgerMax - 10)
} finally { rmSync(dir, { recursive: true, force: true }) }

console.log('\n  a later capture')
const at = { A: [100, 0], B: [150, 0], C: [190, 0], D: [250, 1] }
const declaredABC = { account: 'r1', ledgerMin: 50, ledgerMax: 200, transactions: ['A', 'B', 'C'] }
const refusal = (fn) => { try { fn(); return 'accepted' } catch (e) { return e.message.slice(e.message.indexOf(': ') + 2).split(' ').slice(0, 4).join(' ') } }
eq('after pruning, it extends the declaration and keeps what the earlier one held',
  extendDeclaration(declaredABC, { account: 'r1', ledgerMin: 180, ledgerMax: 300, transactions: ['C', 'D'] }, (h) => at[h], 'x'),
  { account: 'r1', ledgerMin: 50, ledgerMax: 300, transactions: ['A', 'B', 'C', 'D'] })
eq('a listing that starts after the declared range ends is refused, not written over it',
  refusal(() => extendDeclaration(declaredABC, { account: 'r1', ledgerMin: 400, ledgerMax: 500, transactions: [] }, (h) => at[h], 'x')), 'the new listing starts')
eq('a listing missing a declared transaction inside its own range is refused',
  refusal(() => extendDeclaration(declaredABC, { account: 'r1', ledgerMin: 120, ledgerMax: 300, transactions: ['C'] }, (h) => at[h], 'x')), 'the new listing misses')

console.log('\n  the routes')
const snap = (id, brokers) => ({ vaultId: id, vault: vault(id), brokers, loans: [] })
const snaps = new Map([[MERIDIAN, snap(MERIDIAN, [])], [KESTREL, snap(KESTREL, [kestrel])]])
const reader = { snapshots: snaps, get: (id) => snaps.get(id) ?? null, all: () => [...snaps.values()], getByShareMpt: () => null, serverTime: '2026-10-16T00:00:00Z', ledgerIndex: PRUNED, xrpl: devnet(PRUNED) }
const api = createApi(reader, { port: 0 })
await api.listen()
const base = `http://127.0.0.1:${api.server.address().port}`
const get = async (path) => (await fetch(base + path)).json()
const bh = await get(`/api/vaults/${KESTREL}/broker-history`)
eq('broker-history once pruned: E 25 and the window it rests on', [bh.reputation.grade, bh.reputation.score, bh.window.complete, sources(bh.events)], ['E', 25, true, ['archive', 'archive', 'archive']])
const nh = await get(`/api/vaults/${MERIDIAN}/nav-history`)
eq('nav-history once pruned: three archived points, complete', [nh.points.length, sources(nh.points), nh.window.complete, nh.window.archive.capturedAt], [3, ['archive', 'archive', 'archive'], true, COVERAGE.capturedAt])
await api.close()

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0  // not process.exit(): on Windows it aborts while the closed sockets are still closing
