// Offline check of the archive fallback, on the real archive in evidence/devnet-tx: what the two
// history routes serve as Devnet's floor rises past the event's ledgers. The live reads are
// simulated from the archive itself, as a server with that floor would return them. No network.
//   node src/dev/check-archive.mjs
import { readFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadArchive, mergeHistory, ARCHIVE_DIR } from '../archive.mjs'
import { fetchNavHistory } from '../navhistory.mjs'
import { readBrokerHistory, fetchBrokerHistory, analyseOrdering, reputation } from '../history.mjs'
import { createApi } from '../api.mjs'

const COVERAGE = JSON.parse(readFileSync(join(ARCHIVE_DIR, '_manifest.json'), 'utf8')).coverage
const MERIDIAN = '864C5A2DDCED78C6198B0703169D533B747A56E5F9398D832033F79E37E8C835'
const KESTREL = '24EAA01AD4CE70D8ABB4ACB4255DC4C216B8AF3B9E7315DB8052BFC1E5810089'
// PreviousTxnLgrSeq of each object, read from Devnet on 2026-10-13: where each history has to reach.
const LAST_CHANGE = { [MERIDIAN]: 5262028, [KESTREL]: 5262083, kestrelBroker: 5262083 }
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

// The broker exactly as the ledger created it, from its LoanBrokerSet in the archive.
const kestrel = (() => {
  const { owner } = COVERAGE.vaults[KESTREL]
  const id = owner.loanBrokerIds[0]
  for (const e of arc.accounts.get(owner.account).entries) {
    const n = e.meta.AffectedNodes.find((a) => a.CreatedNode?.LedgerEntryType === 'LoanBroker' && a.CreatedNode.LedgerIndex === id)
    if (n) {
      const f = n.CreatedNode.NewFields
      return { loanBrokerId: id, owner: owner.account, coverRateMinimum: f.CoverRateMinimum, coverRateLiquidation: f.CoverRateLiquidation, lastChangeLedger: LAST_CHANGE.kestrelBroker }
    }
  }
  throw new Error('no LoanBrokerSet for the Kestrel broker in the archive')
})()
const conduct = async (xrpl, opts = {}) => {
  const { events, window } = await readBrokerHistory(xrpl, kestrel, vault(KESTREL), opts)
  const ordering = analyseOrdering(events, kestrel, window)
  const rep = reputation(events, ordering, kestrel, window)
  return { events, window, ordering, rep, grade: `${rep.grade} ${rep.score}` }
}

console.log('\n  the archive')
eq('every declared transaction loads, for all eight accounts', [arc.accounts.size, [...arc.accounts.values()].every((c) => c.intact)], [8, true])
eq('its capture time is the one the manifest declares', arc.capturedAt, COVERAGE.capturedAt)

console.log('\n  merge')
const [newer, older] = [...arc.accounts.get(vault(MERIDIAN).pseudoAccount).entries].sort((a, b) => b.ledger_index - a.ledger_index)
const liveCopy = { ...newer, meta: { ...newer.meta, marker: 'live' } }
const merged = mergeHistory([liveCopy], [newer, older])
eq('a hash in both keeps the live copy', [merged.length, merged[0].source, merged[0].meta.marker], [2, 'live', 'live'])
eq('one only in the archive is marked so', merged[1].source, 'archive')
const sameLedger = (i, h) => ({ hash: h, ledger_index: 7, meta: { TransactionIndex: i } })
eq('newest first, by ledger then by position in it', mergeHistory([sameLedger(1, 'A'), sameLedger(3, 'B')], [sameLedger(2, 'C'), { hash: 'D', ledger_index: 8, meta: { TransactionIndex: 0 } }]).map((e) => e.hash), ['D', 'B', 'C', 'A'])

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
} finally { rmSync(dir, { recursive: true, force: true }) }

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
