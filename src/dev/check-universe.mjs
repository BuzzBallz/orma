// Check of the Universe (step 13). Offline by default, no network:
//   node src/dev/check-universe.mjs        (a) readUniverse on a fake xrpl that records every request: one
//                                          ledger_index, no ledger_data, I7 before any figure, priced and
//                                          not priced, omissions; (b) watchVaults on a fake client: ids
//                                          from LedgerEntryType and LedgerIndex alone, the 200 cap,
//                                          resubscribe on connected, no unhandled rejection; (c) the 60 s
//                                          cache, 4 reads in flight at most, marker pages, createNyc with
//                                          and without demo/
//   node src/dev/check-universe.mjs --live GET /api/universe against API_BASE (run under with-api.mjs)
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'xrpl'
import { Decimal, num } from '../num.mjs'
import { Reader } from '../poll.mjs'
import { normaliseVault } from '../xrpl.mjs'
import { createApi } from '../api.mjs'
import { createNyc } from '../nyc/index.mjs'
import { SCHEMAS } from '../nyc/contracts.mjs'
import { issuanceIdOf } from '../ticket/inputs.mjs'
import { watchVaults, readUniverse, createUniverseCache, demoVaultIds } from '../universe/scan.mjs'

let bad = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const hex64 = (c) => c.repeat(64).slice(0, 64)
const L = 1000
const H = hex64('AB')
const tick = () => new Promise((r) => setImmediate(r))

/** Every log line written while fn runs, parsed. */
async function logsOf(fn) {
  const lines = []
  const write = process.stderr.write
  process.stderr.write = (chunk) => {
    for (const s of String(chunk).split('\n').filter(Boolean)) {
      try {
        lines.push(JSON.parse(s))
      } catch {
        lines.push({ msg: s })
      }
    }
    return true
  }
  try {
    const value = await fn()
    return { value, lines }
  } finally {
    process.stderr.write = write
  }
}
const hasGrade = (v) => (Array.isArray(v) ? v.some(hasGrade) : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => k === 'grade' || hasGrade(x)) : false)

// --- the fake ledger ---------------------------------------------------------------------------------------

const OWNER = Wallet.generate().address
const OTHER = Wallet.generate().address

/** A vault as vault_info serves it, with its share issuance in `shares`. */
function vault(id, { asset = { currency: 'XRP' }, at, aa, lu, shares, owner = OWNER } = {}) {
  const pseudo = Wallet.generate().address
  const share = issuanceIdOf({ Issuer: pseudo, Sequence: 1 })
  return {
    index: id, LedgerEntryType: 'Vault', Account: pseudo, Owner: owner, Asset: asset, ShareMPTID: share, Scale: 0,
    ...(at !== undefined && { AssetsTotal: at }), ...(aa !== undefined && { AssetsAvailable: aa }), ...(lu !== undefined && { LossUnrealized: lu }),
    shares: { LedgerEntryType: 'MPTokenIssuance', Issuer: pseudo, Sequence: 1, mpt_issuance_id: share, ...(shares !== undefined && { OutstandingAmount: shares }) },
  }
}

const ID = {
  priced: hex64('1'), noShares: hex64('2'), lossGap: hex64('3'), iou: hex64('4'), zero: hex64('5'), zeroShares: hex64('6'),
  mpt: hex64('7'), objectNotFound: hex64('8'), entryNotFound: hex64('9'), liveFails: hex64('A'), liveOk: hex64('C'),
}
const VAULTS = {
  [ID.priced]: vault(ID.priced, { at: '51000000', aa: '41000000', lu: '10000000', shares: '51000000' }),
  [ID.noShares]: vault(ID.noShares, {}),
  [ID.lossGap]: vault(ID.lossGap, { at: '51000000', aa: '41000000', lu: '10000001', shares: '51000000' }),
  [ID.iou]: vault(ID.iou, { asset: { currency: 'USD', issuer: OTHER }, at: '100', aa: '100', shares: '100' }),
  [ID.zero]: vault(ID.zero, { at: '1000', aa: '0', lu: '990', shares: '51000000' }),
  [ID.zeroShares]: vault(ID.zeroShares, { at: '5000000', aa: '5000000' }),
  [ID.mpt]: vault(ID.mpt, { asset: { mpt_issuance_id: '00'.repeat(4) + '11'.repeat(20) }, at: '10', aa: '10', shares: '10' }),
  [ID.liveOk]: vault(ID.liveOk, { at: '2000000', aa: '2000000', shares: '2000000', owner: OTHER }),
}
const broker = (i, vaultId) => ({ index: hex64(String.fromCharCode(48 + i)).replace(/^./, 'B'), LedgerEntryType: 'LoanBroker', VaultID: vaultId })
const BROKERS = {
  [OWNER]: [broker(1, ID.priced), broker(2, ID.lossGap), broker(3, ID.priced), broker(4, ID.noShares)],
  [OTHER]: [],
}

/**
 * A fake xrpl at L 1000: every request recorded; `pageSize` pages account_objects by marker; `slow`
 * delays vault_info of the ids it names; `fail` makes vault_info of an id throw a non-notFound error.
 */
function fakeXrpl({ vaults = VAULTS, brokers = BROKERS, pageSize = 10, slow = new Map(), fail = new Set(), client } = {}) {
  const requests = []
  let inFlight = 0
  let peak = 0
  const err = (code) => Object.assign(new Error(code), { data: { error: code } })
  return {
    lastLedger: L, lastLedgerHash: H, lastCloseTime: 846200000, requests, client,
    get peak() { return peak },
    async closeTime() { throw new Error('readUniverse must never call closeTime()') },
    async req(p) {
      requests.push(structuredClone(p))
      if (p.command === 'vault_info') {
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          if (slow.has(p.vault_id)) await slow.get(p.vault_id)
          else await tick()
          if (p.vault_id === ID.objectNotFound) throw err('objectNotFound')
          if (p.vault_id === ID.entryNotFound) throw err('entryNotFound')
          if (fail.has(p.vault_id)) throw err('noNetwork')
          const v = vaults[p.vault_id]
          if (!v) throw err('entryNotFound')
          return { result: { vault: structuredClone(v), ledger_index: L } }
        } finally {
          inFlight--
        }
      }
      if (p.command === 'account_objects') {
        const all = brokers[p.account] ?? []
        const start = p.marker ? Number.parseInt(p.marker, 10) : 0
        const items = all.slice(start, start + pageSize)
        return { result: { account_objects: items, ledger_index: L, ...(start + pageSize < all.length && { marker: String(start + pageSize) }) } }
      }
      throw new Error(`fake xrpl: no ${p.command}`)
    },
  }
}

const liveOf = (ids, since = null) => ({ ids: () => ids, liveSinceLedger: () => since })

// --- (a) readUniverse ----------------------------------------------------------------------------------------

async function universeCases() {
  console.log('(a) readUniverse at one ledger')
  const x = fakeXrpl({ fail: new Set([ID.liveFails]) })
  const known = [ID.priced, ID.noShares, ID.lossGap, ID.iou, ID.zero, ID.zeroShares, ID.mpt, ID.objectNotFound, ID.entryNotFound, ID.priced.toLowerCase()]
  const { value: u, lines } = await logsOf(() => readUniverse({ xrpl: x, known, live: liveOf([ID.liveFails, ID.liveOk], 900) }))
  const by = Object.fromEntries(u.vaults.map((v) => [v.vaultId, v]))
  eq('no ledger_data request, and every request at ledger_index 1000', [x.requests.some((p) => p.command === 'ledger_data'), x.requests.every((p) => p.ledger_index === L)], [false, true])
  eq('count = vaults.length; the absent ids and the live one that fails are omitted', [u.count, u.vaults.length, Object.keys(by).sort()],
    [8, 8, [ID.priced, ID.noShares, ID.lossGap, ID.iou, ID.zero, ID.zeroShares, ID.mpt, ID.liveOk].sort()])
  eq('each vault once, Meridian-like ids deduplicated whatever their case', u.vaults.filter((v) => v.vaultId === ID.priced).length, 1)
  eq('the brokers grouped by VaultID, the other vaults\' left out', [by[ID.priced].brokers, by[ID.lossGap].brokers, by[ID.liveOk].brokers], [[broker(1, '').index, broker(3, '').index], [broker(2, '').index], []])
  const nav = Reader.nav(normaliseVault(VAULTS[ID.priced], 0))
  eq('the XRP vault with shares (OutstandingAmount 51000000) is priced by Reader.nav, neither figure 0.000000',
    [by[ID.priced].priced, by[ID.priced].perUnitHeld, by[ID.priced].perUnitNaive, by[ID.priced].perUnitHeld !== '0.000000'], [true, nav.navCorrect, nav.navNaive, true])
  eq('0.803922 and 1.000000', [by[ID.priced].perUnitHeld, by[ID.priced].perUnitNaive], ['0.803922', '1.000000'])
  eq('the XRP vault without shares and the IOU vault: priced false, reason not priced, no figure',
    [[by[ID.noShares].priced, by[ID.noShares].reason, 'perUnitHeld' in by[ID.noShares]], [by[ID.iou].priced, by[ID.iou].reason, 'perUnitHeld' in by[ID.iou]]],
    [[false, 'not priced', false], [false, 'not priced', false]])
  eq('LossUnrealized one drop above AssetsTotal − AssetsAvailable: inconsistent snapshot, no figure (I7)',
    [by[ID.lossGap].priced, by[ID.lossGap].reason, 'perUnitHeld' in by[ID.lossGap], 'perUnitNaive' in by[ID.lossGap]], [false, 'inconsistent snapshot', false, false])
  eq('no OutstandingAmount and AssetsTotal not zero: inconsistent snapshot, I7 before not priced', [by[ID.zeroShares].priced, by[ID.zeroShares].reason], [false, 'inconsistent snapshot'])
  const errors = lines.filter((l) => l.level === 'error' && l.module === 'universe')
  eq('an error line per inconsistent vault, naming its rule (lossGap, zeroShares)',
    [errors.find((l) => l.vaultId === ID.lossGap)?.rules, errors.find((l) => l.vaultId === ID.zeroShares)?.rules?.includes('zeroShares')], ['lossGap', true])
  eq('an XRP vault whose withdrawal value rounds to zero: priced, perUnitHeld 0.000000', [by[ID.zero].priced, by[ID.zero].perUnitHeld], [true, '0.000000'])
  eq('the MPT vault: not priced', [by[ID.mpt].priced, by[ID.mpt].reason, by[ID.mpt].asset], [false, 'not priced', VAULTS[ID.mpt].Asset])
  const warns = lines.filter((l) => l.level === 'warn' && l.module === 'universe')
  eq('the objectNotFound id, the entryNotFound id and the live id that fails each leave a warn line',
    [ID.objectNotFound, ID.entryNotFound, ID.liveFails].map((id) => warns.some((l) => l.vaultId === id)), [true, true, true])
  eq('the live failure names its code', warns.find((l) => l.vaultId === ID.liveFails)?.code, 'noNetwork')
  eq('seen: known for a known id, live for one seen only live', [by[ID.priced].seen, by[ID.liveOk].seen], ['known', 'live'])
  eq('coverage counts each source before omission, liveSinceLedger from the stream', u.coverage, { known: 9, live: 2, liveSinceLedger: 900 })
  eq('ledgerIndex and ledgerHash are the Reader\'s last validated ledger, the banner set', [u.ledgerIndex, u.ledgerHash, u.banner], [L, H, 'not live on mainnet'])
  eq('no grade key anywhere', hasGrade(u), false)
  eq('the document passes SCHEMAS.universe', SCHEMAS.universe(u), [])

  const known2 = await readUniverse({ xrpl: fakeXrpl({ fail: new Set([ID.priced]) }), known: [ID.priced], live: liveOf([]) }).then(() => 'resolved', (e) => `rejected: ${e.message}`)
  eq('a read error on a known vault other than entryNotFound or objectNotFound rejects the document', known2, 'rejected: noNetwork')
  const noLedger = await readUniverse({ xrpl: { ...fakeXrpl(), lastLedger: null }, known: [ID.priced] }).then(() => 'resolved', () => 'rejected')
  const noHash = await readUniverse({ xrpl: { ...fakeXrpl(), lastLedgerHash: 'XYZ' }, known: [ID.priced] }).then(() => 'resolved', () => 'rejected')
  eq('an L that is not an integer, or a hash that is not 64 hex, rejects the document', [noLedger, noHash], ['rejected', 'rejected'])
  const twoPages = fakeXrpl({ pageSize: 1 })
  const tp = await readUniverse({ xrpl: twoPages, known: [ID.priced] })
  eq('an owner with several pages of account_objects: every broker, marker followed at the same L',
    [tp.vaults[0].brokers.length, twoPages.requests.filter((p) => p.command === 'account_objects').length, twoPages.requests.filter((p) => p.marker).every((p) => p.ledger_index === L)], [2, 4, true])
  const capped = { ...fakeXrpl({ pageSize: 1, brokers: { [OWNER]: Array.from({ length: 60 }, (_, i) => broker(1, ID.zero)) } }) }
  eq('past 50 pages the document is rejected', await readUniverse({ xrpl: capped, known: [ID.priced] }).then(() => 'resolved', (e) => (e instanceof RangeError ? 'rejected' : e.message)), 'rejected')
}

// --- (b) watchVaults -----------------------------------------------------------------------------------------

function fakeClient({ connected = true, rejectSubscribe = false } = {}) {
  const c = new EventEmitter()
  c.requests = []
  c.isConnected = () => connected
  c.request = async (p) => {
    c.requests.push(p)
    if (rejectSubscribe) throw new Error('subscribe refused')
    return { result: {} }
  }
  return c
}
const txMessage = ({ validated = true, ledger = 500, nodes }) => ({ type: 'transaction', validated, ledger_index: ledger, meta: { AffectedNodes: nodes, TransactionResult: 'tesSUCCESS' } })
const node = (kind, type, index, extra = {}) => ({ [kind]: { LedgerEntryType: type, LedgerIndex: index, ...extra } })

async function watchCases() {
  console.log('(b) watchVaults, the transactions stream')
  const c = fakeClient()
  const w = watchVaults(c)
  await tick()
  eq('a subscribe to transactions at creation, the client being connected', c.requests.map((p) => [p.command, p.streams]), [['subscribe', ['transactions']]])
  c.emit('connected')
  await tick()
  eq('one more on each connected (a reconnection loses the subscription)', c.requests.length, 2)
  c.emit('transaction', txMessage({ validated: false, ledger: 480, nodes: [node('CreatedNode', 'Vault', hex64('D'))] }))
  eq('a message not validated adds nothing, and fixes liveSinceLedger', [w.ids(), w.liveSinceLedger()], [[], 480])
  let trapped = 0
  const trap = {}
  for (const k of ['PreviousFields', 'FinalFields', 'NewFields']) Object.defineProperty(trap, k, { enumerable: true, get() { trapped++; return { AssetsTotal: '999' } } })
  const X = hex64('E')
  const Y = hex64('F')
  c.emit('transaction', txMessage({ nodes: [node('CreatedNode', 'Vault', X), { ModifiedNode: Object.assign(trap, { LedgerEntryType: 'Vault', LedgerIndex: Y.toLowerCase() }) }, node('ModifiedNode', 'LoanBroker', hex64('1'))] }))
  eq('a validated message that creates Vault X and modifies Y adds both, a LoanBroker node nothing', w.ids(), [X, Y])
  eq('the trapped PreviousFields, FinalFields and NewFields are never read', trapped, 0)
  c.emit('transaction', txMessage({ nodes: [node('DeletedNode', 'Vault', X)] }))
  eq('a DeletedNode of X removes it', w.ids(), [Y])
  c.emit('transaction', { type: 'transaction', validated: true, ledger_index: 501, meta: null })
  c.emit('transaction', 'not an object')
  eq('a malformed message is ignored', w.ids(), [Y])
  const u = await readUniverse({ xrpl: fakeXrpl({ vaults: { ...VAULTS, [Y]: vault(Y, { at: '10', aa: '10', shares: '10' }) } }), known: [ID.priced], live: w })
  eq('readUniverse with the vaults seen: seen live on Y, coverage.live 1, liveSinceLedger 480',
    [u.vaults.find((v) => v.vaultId === Y)?.seen, u.coverage.live, u.coverage.liveSinceLedger], ['live', 1, 480])
  w.stop()

  const c2 = fakeClient()
  const w2 = watchVaults(c2)
  const ids = Array.from({ length: 201 }, (_, i) => i.toString(16).toUpperCase().padStart(64, '0'))
  c2.emit('transaction', txMessage({ ledger: 700, nodes: ids.slice(0, 100).map((id) => node('ModifiedNode', 'Vault', id)) }))
  c2.emit('transaction', txMessage({ nodes: [node('ModifiedNode', 'Vault', ids[1])] })) // seen again before the 201st
  c2.emit('transaction', txMessage({ nodes: ids.slice(100).map((id) => node('CreatedNode', 'Vault', id)) }))
  eq('201 distinct vaults: 200 stay, the first seen leaves, the one seen again stays',
    [w2.ids().length, w2.ids().includes(ids[0]), w2.ids().includes(ids[1]), w2.ids().includes(ids[200]), w2.liveSinceLedger()], [200, false, true, true, 700])
  w2.stop()

  let unhandled = 0
  const count = () => { unhandled++ }
  process.on('unhandledRejection', count)
  const { lines } = await logsOf(async () => {
    const w3 = watchVaults(fakeClient({ rejectSubscribe: true }))
    for (let i = 0; i < 5; i++) await tick()
    w3.stop()
  })
  await new Promise((r) => setTimeout(r, 20))
  const before = unhandled
  Promise.reject(new Error('witness, left without a handler on purpose'))
  await new Promise((r) => setTimeout(r, 20))
  process.off('unhandledRejection', count)
  eq('a client that rejects subscribe: a warn line, no unhandled rejection (and the witness counts one)',
    [lines.some((l) => l.level === 'warn' && l.msg === 'transactions stream not subscribed'), before, unhandled], [true, 0, 1])
}

// --- (c) the cache, the bound, createNyc --------------------------------------------------------------------

async function cacheCases() {
  console.log('(c) the cache, at most 4 reads in flight, createNyc')
  let t = 0
  let reads = 0
  let mode = 'ok'
  const cache = createUniverseCache({ now: () => t, read: async () => { reads++; await tick(); if (mode === 'fail') throw new Error('down'); return { n: reads } } })
  await Promise.all([cache.get(), cache.get()])
  t = 59_000
  await cache.get()
  eq('two concurrent get() then a third at +59 s: one read', reads, 1)
  t = 61_000
  await cache.get()
  eq('a get() at +61 s: a second read', reads, 2)
  t = 200_000
  mode = 'fail'
  const r1 = await cache.get().then(() => 'ok', () => 'rejected')
  mode = 'ok'
  const r2 = await cache.get().then((d) => d.n)
  eq('a rejected read is not kept: the next get() reads again', [r1, r2, reads], ['rejected', 4, 4])

  // one read fails fast while three are slow: the rejection waits for the three, never more than 4 in flight
  const gates = new Map()
  const opened = []
  const slowIds = [hex64('1'), hex64('5'), hex64('7')]
  for (const id of slowIds) gates.set(id, new Promise((r) => opened.push(r)))
  const x = fakeXrpl({ slow: gates, fail: new Set([hex64('2')]) })
  const many = [hex64('1'), hex64('5'), hex64('7'), hex64('2'), hex64('3'), hex64('4'), hex64('6')]
  const c2 = createUniverseCache({ read: () => readUniverse({ xrpl: x, known: many, live: liveOf([]) }) })
  let settled = false
  const p = c2.get().then(() => 'resolved', () => 'rejected').finally(() => { settled = true })
  for (let i = 0; i < 10; i++) await tick()
  const settledEarly = settled
  const startedBefore = x.requests.filter((q) => q.command === 'vault_info').length
  for (const open of opened) open()
  const outcome = await p
  eq('a read fails fast while three are slow: the rejection only after the three, and no read started after the failure',
    [settledEarly, outcome, startedBefore, x.requests.filter((q) => q.command === 'vault_info').length], [false, 'rejected', 4, 4])
  const again = await c2.get().then(() => 'resolved', () => 'rejected')
  eq('never more than 4 vault reads in flight, even at the next get()', [x.peak <= 4, again], [true, 'rejected'])

  // createNyc offline, in a directory of its own
  const home = process.cwd()
  const dirA = mkdtempSync(join(tmpdir(), 'orma-universe-'))
  mkdirSync(join(dirA, 'demo'))
  writeFileSync(join(dirA, 'demo', 'good.json'), JSON.stringify({ vaultId: ID.priced }))
  writeFileSync(join(dirA, 'demo', 'broken.json'), '{ not json')
  const { value: ids, lines } = await logsOf(() => demoVaultIds(join(dirA, 'demo')))
  eq('a demo/ with one valid and one invalid file keeps the valid one\'s id, a warn naming the invalid',
    [ids, lines.some((l) => l.level === 'warn' && String(l.file).endsWith('broken.json'))], [[ID.priced], true])
  const dirB = mkdtempSync(join(tmpdir(), 'orma-universe-'))
  const client = fakeClient()
  const xr = fakeXrpl({ client })
  const reader = { xrpl: xr, vaultIds: [], serverTime: '2026-10-25T12:00:00Z', ledgerIndex: L, snapshots: new Map(), missing: new Set(), all: () => [], get: () => null, getByShareMpt: () => null }
  process.chdir(dirB)
  let nyc
  let warnNoDemo
  try {
    const r = await logsOf(() => createNyc({ reader, env: {} }))
    nyc = r.value
    warnNoDemo = r.lines.some((l) => l.level === 'warn' && l.module === 'universe' && /no demo directory/.test(l.msg))
  } finally {
    process.chdir(home)
  }
  await tick()
  eq('createNyc on a reader with a client and no demo/: exactly one subscribe, a warn line, no exception',
    [client.requests.filter((q) => q.command === 'subscribe').length, warnNoDemo], [1, true])
  client.emit('transaction', txMessage({ nodes: [node('ModifiedNode', 'Vault', ID.liveOk)] }))
  const api = createApi(reader, { port: 0, nyc })
  await api.listen()
  const res = await fetch(`http://127.0.0.1:${api.server.address().port}/api/universe`)
  const body = await res.json()
  await api.close()
  eq('a vault given to watchVaults is served by /api/universe with seen live', [res.status, body.vaults?.find((v) => v.vaultId === ID.liveOk)?.seen, SCHEMAS.universe(body)], [200, 'live', []])
  const quiet = await logsOf(() => createNyc({ reader: { ...reader, xrpl: null, vaultIds: undefined }, env: {} }))
  eq('createNyc on a fake reader without xrpl.client nor vaultIds: no exception', Boolean(quiet.value?.handle), true)
}

// --- --live --------------------------------------------------------------------------------------------------

async function live() {
  const base = process.env.API_BASE
  if (!base) {
    console.log('  API_BASE is not set: run under src/dev/with-api.mjs')
    process.exitCode = 2
    return
  }
  console.log(`--live against ${base}`)
  const res = await fetch(`${base}/api/universe`)
  const u = await res.json()
  eq('GET /api/universe: 200 with a numeric ledgerIndex', [res.status, Number.isSafeInteger(u.ledgerIndex)], [200, true])
  eq('count = vaults.length', u.count, u.vaults?.length)
  const { readFileSync } = await import('node:fs')
  for (const label of ['harbor-1', 'harbor-2', 'harbor-3', 'desk', 'spare']) {
    const id = JSON.parse(readFileSync(`demo/${label}.json`, 'utf8')).vaultId.toUpperCase()
    eq(`${label} is in the universe, seen known`, u.vaults?.find((v) => v.vaultId === id)?.seen, 'known')
  }
  const h1 = u.vaults?.find((v) => v.vaultId === JSON.parse(readFileSync('demo/harbor-1.json', 'utf8')).vaultId.toUpperCase())
  const held = num(h1?.perUnitHeld ?? 0)
  const naive = num(h1?.perUnitNaive ?? 0)
  eq('Harbor-1 (L1 impaired since the bake): priced, withdrawal value below the value read by all, neither zero',
    [h1?.priced, held.lt(naive), !held.isZero(), !naive.isZero()], [true, true, true, true])
  eq('the document served passes SCHEMAS.universe', SCHEMAS.universe(u), [])
  void Decimal
}

// --- dispatch (last) -----------------------------------------------------------------------------------------

if (process.argv.includes('--live')) {
  await live()
} else {
  await universeCases()
  await watchCases()
  await cacheCases()
}
console.log(bad ? `\n  ${bad} failed` : '\n  all ok')
if (bad) process.exitCode = 1
