// Offline check of the credit-event feed: derive() on composed snapshot pairs of each type, createFeed on
// a fake Reader and a fake ledger client, /api/feed and /api/feed/stream on an in-memory API, the
// amendment votes on a fake fetch and an injected clock, and a static read of DeskFeed.tsx. No Devnet.
// With --live (under with-api.mjs): a heartbeat on /api/feed/stream within 15 s.
//   node src/dev/check-feed.mjs
//   node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-feed.mjs --live
import { get } from 'node:http'
import { readFileSync } from 'node:fs'
import { num } from '../num.mjs'
import { createApi } from '../api.mjs'
import { createNyc, readAmendments, createAmendmentsCache } from '../nyc/index.mjs'
import { derive, createFeed } from '../feed/derive.mjs'
import { SCHEMAS, encodeStatement } from '../nyc/contracts.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}

const VAULT = 'AB'.repeat(32)
const OWNER = 'rKS7Q49nLj8QzSBzXwiwUUehZbcuCHfEXT'
const SHARE = 'CD'.repeat(24)
const LOAN = 'EF'.repeat(32)
const TX = (n) => String(n).padStart(64, '0')
const BORROWER = JSON.parse(readFileSync('demo/desk.json', 'utf8')).collateral.borrower
const loan = (o = {}) => ({ loanId: LOAN, previousTxnId: TX(1), status: 'current', flags: 0, principalOutstanding: num('5000000'), nextPaymentDueAt: '2026-10-25T12:00:00Z', label: 'L1', ...o })
const snap = (L, o = {}) => ({
  vaultId: VAULT, ledgerIndex: L, ledgerHash: 'A'.repeat(64),
  vault: { owner: OWNER, shareMptId: SHARE, lossUnrealized: num(o.loss ?? '0'), assetsTotal: num(o.assets ?? '50000000'), assetsAvailable: num(o.available ?? '35000000'), lastChangeLedger: o.changed ?? 90 },
  brokers: [{ loanBrokerId: 'BB'.repeat(32), coverAvailable: num(o.cover ?? '3000000') }],
  loans: o.loans ?? [loan()],
  escrows: o.escrows ?? [],
  vaultData: o.data ?? null, statementTxHash: o.data ? TX(9) : undefined,
})
const escrow = (index, o = {}) => ({ index, Account: BORROWER, Destination: 'rCollateral', Amount: { mpt_issuance_id: SHARE, value: '5000000' }, PreviousTxnID: TX(7), LedgerEntryType: 'Escrow', ...o })
const types = (evs) => evs.map((e) => e.type)
const valid = (evs) => evs.every((e) => SCHEMAS.feedEvent(e).length === 0) || evs.map((e) => SCHEMAS.feedEvent(e))
const statement = (kind, text) => encodeStatement({ s: 'orma.stmt/1', loan: LOAN, kind, text, at: 846180562 })

// --- derive ------------------------------------------------------------------------------------------
{
  const late = derive(snap(100), snap(101, { loans: [loan({ status: 'overdue' })] }))
  eq('LOAN_LATE: a loan that turns overdue', [types(late), late[0]?.loanId, valid(late)], [['LOAN_LATE'], LOAN, true])
  const imp = derive(snap(100), snap(101, { loss: '10000000', loans: [loan({ status: 'impaired', flags: 0x20000, previousTxnId: TX(2) })] }))
  eq('IMPAIRMENT: its flag appears, the LoanManage as txHash, the recognised loss as effect',
    [types(imp), imp[0]?.txHash, imp[0]?.moneyEffect, valid(imp)], [['IMPAIRMENT'], TX(2), { value: '10000000', unit: 'drops' }, true])
  const def = derive(snap(100), snap(101, { assets: '45150000', cover: '2850000', loans: [loan({ status: 'defaulted', flags: 0x10000, previousTxnId: TX(3) })] }))
  eq('DEFAULT and COVER_DRAWN: the cover drawn carries the defaulted loan',
    [types(def), def[1]?.loanId, def[1]?.moneyEffect, def.map((e) => e.id), valid(def)],
    [['DEFAULT', 'COVER_DRAWN'], LOAN, { value: '-150000', unit: 'drops' }, ['0000000000000000101-0', '0000000000000000101-1'], true])
  const orig = derive(snap(100, { loans: [] }), snap(101))
  eq('LOAN_ORIGINATED: a new loan', [types(orig), orig[0]?.moneyEffect, valid(orig)], [['LOAN_ORIGINATED'], { value: '5000000', unit: 'drops' }, true])
  const pledged = derive(snap(100), snap(101, { escrows: [escrow('E1'.repeat(32))] }))
  eq('SHARES_PLEDGED: an escrow of shares that appears, its EscrowCreate as txHash',
    [types(pledged), pledged[0]?.txHash, pledged[0]?.moneyEffect, pledged[0]?.receipts, valid(pledged)],
    [['SHARES_PLEDGED'], TX(7), { value: '5000000', unit: 'share-units' }, [{ object: 'Escrow', field: 'Amount', before: null, after: { mpt_issuance_id: SHARE, value: '5000000' } }], true])

  const said = statement('impaired', 'L1 marked impaired')
  const ok = derive(snap(100), snap(101, { data: said, loans: [loan({ flags: 0x20000, status: 'impaired' })] }))
  const no = derive(snap(100), snap(101, { data: said }))
  eq('STATEMENT: a Data that changes, CONSISTENT then INCONSISTENT, DECLARED with no moneyEffect (I6)',
    [types(ok), ok[0]?.statement.consistency.status, no[0]?.statement.consistency.status, [...ok, ...no].map((e) => [e.provenance, e.moneyEffect]), valid([...ok, ...no])],
    [['STATEMENT', 'IMPAIRMENT'], 'CONSISTENT', 'INCONSISTENT', [['DECLARED', null], ['REAL', { value: '0', unit: 'drops' }], ['DECLARED', null]], true])
  eq('STATEMENT: a first snapshot that carries a Data yields one STATEMENT and nothing else', types(derive(null, snap(100, { data: said, escrows: [escrow('E1'.repeat(32))] }))), ['STATEMENT'])
  eq('STATEMENT: an unreadable Data is UNPARSEABLE', derive(snap(100), snap(101, { data: 'ABCD' }))[0]?.statement.consistency.status, 'UNPARSEABLE')
  eq('a first snapshot without Data yields nothing', derive(null, snap(100)), [])
  eq('a transition outside the seven types yields nothing', derive(snap(100), snap(101, { available: '30000000', loans: [loan({ status: 'due_soon' })] })), [])
  const trapped = snap(101)
  trapped.loans[0].PreviousFields = { Flags: 0x10000, PrincipalOutstanding: '1' }
  trapped.PreviousFields = { LossUnrealized: '99999999' }
  eq('a PreviousFields planted with false values is never read', derive(snap(100), trapped), [])
}

// --- createFeed on a fake Reader and a fake ledger client -------------------------------------------
function fakeLedger() {
  const calls = []
  const w = { calls, escrowsAt: {}, data: null, dataTx: TX(9) }
  w.xrpl = {
    req: async (p) => {
      calls.push(p)
      if (p.command === 'account_objects') {
        const at = w.escrowsAt[p.ledger_index] ?? []
        if (at === 'fail') throw new Error('timeout')
        if (at === 'marker') return { result: { account_objects: [], marker: 'x' } }
        return { result: { account_objects: at } }
      }
      if (p.command === 'ledger_entry') return { result: { node: { Data: w.data ?? undefined, PreviousTxnID: w.dataTx, Owner: OWNER } } }
      if (p.command === 'tx') return { result: { hash: w.dataTx, tx_json: { TransactionType: 'VaultSet', Account: OWNER, Data: w.data } } }
      throw new Error(`unexpected ${p.command}`)
    },
  }
  return w
}
function fakeReader(xrpl) {
  const subs = []
  return { xrpl, subscribe: (fn) => (subs.push(fn), () => {}), emit: async (s) => { for (const fn of subs) await fn(s) }, serverTime: '2026-10-25T00:00:00Z', ledgerIndex: 0, snapshots: new Map(), vaultIds: [], missing: new Set(), all: () => [] }
}
const readerSnap = (L, o = {}) => {
  const s = snap(L, o)
  delete s.escrows
  delete s.vaultData
  delete s.statementTxHash
  return s
}
{
  const w = fakeLedger()
  const reader = fakeReader(w.xrpl)
  const feed = createFeed(reader, { escrowAccounts: [BORROWER] })
  const e1 = escrow('E1'.repeat(32))
  const second = { ...readerSnap(101), vaultId: 'AC'.repeat(32) }
  w.escrowsAt = { 100: [], 101: [e1], 102: 'fail', 103: [e1], 104: 'marker', 105: [e1, escrow('E2'.repeat(32), { Account: 'rThird', Destination: BORROWER })] }
  await reader.emit(readerSnap(100))
  await reader.emit(readerSnap(101))
  await reader.emit(second)
  const reads101 = w.calls.filter((c) => c.command === 'account_objects' && c.ledger_index === 101)
  eq('one escrow read per account and per ledger, at the snapshot ledger, shared by its vaults', [reads101.length, reads101[0]?.account, reads101[0]?.type], [1, BORROWER, 'escrow'])
  for (const L of [102, 103, 104, 105]) await reader.emit(readerSnap(L))
  eq('an escrow missed on a failed read then found again, a marker page, a third party\'s escrow to the borrower: one SHARES_PLEDGED only',
    types(feed.after(null)), ['SHARES_PLEDGED'])
  eq('the vault is re-read only when lastChangeLedger changes', w.calls.filter((c) => c.command === 'ledger_entry').length, 2)
  w.data = statement('impaired', 'L1 marked impaired')
  await reader.emit(readerSnap(106, { changed: 106 }))
  const st = feed.after(null).at(-1)
  eq('a Data that changes with lastChangeLedger: a STATEMENT, its VaultSet as txHash', [st?.type, st?.txHash], ['STATEMENT', TX(9)])
  const all = feed.after(null)
  eq('after(cursor): the events after it, in order', feed.after(all[0].id).map((e) => e.id), all.slice(1).map((e) => e.id))
}

// --- the routes, on an in-memory API ------------------------------------------------------------------
const failing = async () => { throw new Error('offline') }
{
  const w = fakeLedger()
  const reader = fakeReader(w.xrpl)
  const nyc = createNyc({ reader, env: {}, fetchImpl: failing })
  const api = createApi(reader, { port: 0, nyc })
  await api.listen()
  const base = `http://127.0.0.1:${api.server.address().port}`
  w.escrowsAt = { 200: [], 201: [escrow('E1'.repeat(32))], 202: [escrow('E1'.repeat(32)), escrow('E3'.repeat(32))] }
  await reader.emit(readerSnap(200))
  await reader.emit(readerSnap(201))
  const all = await (await fetch(`${base}/api/feed`)).json()
  eq('GET /api/feed: events, nextCursor, and amendments unavailable with a 200 when xrpscan fails',
    [all.events.length, all.nextCursor === all.events.at(-1)?.id, all.amendments.status, all.amendments.items], [1, true, 'unavailable', []])
  const badCursor = await fetch(`${base}/api/feed?after=nope`)
  eq('an invalid cursor is 400 BAD_CURSOR', [badCursor.status, (await badCursor.json()).error.code], [400, 'BAD_CURSOR'])

  const open = (path = '/api/feed/stream') => new Promise((resolve) => {
    const req = get(`${base}${path}`, { agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      resolve({ status: res.statusCode, type: res.headers['content-type'], req, res, body: () => body })
    })
    req.on('error', () => resolve({ status: 0 }))
  })
  // Three waves of 100 at once, every stream kept open: a Windows listener refuses connections past its
  // backlog (ECONNREFUSED on 68 of 300 opened together), which the cap never gets to answer.
  const streams = []
  for (let wave = 0; wave < 3; wave++) streams.push(...await Promise.all(Array.from({ length: 100 }, () => open())))
  eq('300 streams: the first 100 served, the others 503 BUSY', [streams.filter((s) => s.status === 200).length, streams.filter((s) => s.status === 503).length, streams.find((s) => s.status === 200)?.type],
    [100, 200, 'text/event-stream'])
  await reader.emit(readerSnap(202))
  await new Promise((r) => setTimeout(r, 100))
  const live = streams.find((s) => s.status === 200)
  eq('a credit event reaches an open stream as event: credit', live.body().includes('event: credit') && live.body().includes('"type":"SHARES_PLEDGED"'), true)
  live.req.destroy()
  await new Promise((r) => setTimeout(r, 100))
  const again = await open()
  eq('a closed stream gives its place back', again.status, 200)
  const after = await (await fetch(`${base}/api/feed?after=${all.nextCursor}`)).json()
  eq('GET /api/feed?after=<cursor>: only the later events', after.events.map((e) => e.type), ['SHARES_PLEDGED'])
  for (const s of [...streams, again]) s.req?.destroy()
  await nyc.close()
  await api.close()
}
{
  const reader = { serverTime: 'x', ledgerIndex: 0, snapshots: new Map(), vaultIds: [], missing: new Set(), all: () => [] }
  const api = createApi(reader, { port: 0, nyc: createNyc({ reader, env: {}, fetchImpl: failing }) })
  await api.listen()
  const r = await fetch(`http://127.0.0.1:${api.server.address().port}/api/feed`)
  eq('a reader without subscribe: an empty feed, 200', [r.status, (await r.json()).events], [200, []])
  await api.close()
}

// --- the amendment votes ------------------------------------------------------------------------------
{
  const at = () => new Date('2026-10-25T12:00:00Z')
  const rejected = await readAmendments({ fetchImpl: failing, now: at })
  const http500 = await readAmendments({ fetchImpl: async () => ({ status: 500, json: async () => [] }), now: at })
  const fine = await readAmendments({ fetchImpl: async () => ({ status: 200, json: async () => [{ name: 'LendingProtocol', enabled: false }] }), now: at })
  eq('readAmendments: a rejected fetch and a 500 are unavailable, an array is ok, never an exception',
    [rejected.status, rejected.items, http500.status, fine.status, fine.items.length, fine.fetchedAt], ['unavailable', [], 'unavailable', 'ok', 1, '2026-10-25T12:00:00.000Z'])
  let clock = 0
  let reads = 0
  const cache = createAmendmentsCache({ read: async () => (reads++, { status: 'ok' }), now: () => clock })
  await Promise.all([cache.get(), cache.get()])
  clock = 59_000
  await cache.get()
  const within = reads
  clock = 61_000
  await cache.get()
  eq('the cache: two concurrent gets and one at +59 s make one read, one at +61 s a second', [within, reads], [1, 2])
}

// --- the screen ---------------------------------------------------------------------------------------
{
  const src = readFileSync('app/src/screens/DeskFeed.tsx', 'utf8')
  eq('DeskFeed.tsx: FEED_POLL_MS = 3000, EventSource guarded, no /api/universe',
    [src.includes('FEED_POLL_MS = 3000'), src.includes("typeof EventSource !== 'undefined'"), src.includes('/api/universe')], [true, true, false])
}

// --- live ---------------------------------------------------------------------------------------------
if (process.argv.includes('--live')) {
  const base = process.env.API_BASE ?? 'http://127.0.0.1:8788'
  const t0 = Date.now()
  const beat = await new Promise((resolve) => {
    const req = get(`${base}/api/feed/stream`, { agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => {
        body += c
        if (body.includes('event: heartbeat')) { req.destroy(); resolve(Date.now() - t0) }
      })
    })
    req.on('error', () => resolve(null))
    setTimeout(() => { req.destroy(); resolve(null) }, 15_000)
  })
  eq('live: a heartbeat on /api/feed/stream within 15 s', beat !== null && beat < 15_000, true)
}

console.log(bad ? `\n  ${bad} FAILED` : '\n  all ok')
process.exitCode = bad ? 1 : 0
