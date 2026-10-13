// Offline check of evidence/devnet-tx. No network access.
//
// For every capture: tx_blob hashes back to the file name; the JSON transaction (less the
// envelope fields the server adds) re-encodes to exactly tx_blob; the JSON meta re-encodes to
// exactly meta_blob; and both blobs decode to the same fields as the JSON, key for key, so a
// field the codec would skip cannot hide in the JSON. Then every devnet.xrpl.org/transactions
// link in README.md must have a capture.
//
// What this does not prove: only tx_blob is bound to its id. meta_blob and the validated flag
// are the server's copy as served; binding them offline would need the ledger header and its
// transaction tree. A forgery written consistently into both meta_blob and the JSON passes,
// and --self-test shows that case passing on purpose.
//
//   node src/dev/check-evidence.mjs [captureDir] [readme]
//   node src/dev/check-evidence.mjs --self-test
import { readFileSync, readdirSync, writeFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashes, decode, encode } from 'xrpl'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const HEX64 = /^[0-9A-F]{64}$/
const DEVNET_NETWORK_ID = 2
// Fields of a `tx` response that the server adds around the signed transaction; none is in tx_blob.
const ENVELOPE = ['ctid', 'date', 'hash', 'inLedger', 'ledger_index', 'status', 'validated', 'meta']

// Two leaf values are equal when they are identical or when the codec serialises them identically
// for that field (UInt64 comes back from decode zero-padded and upper-case, the JSON API omits both).
function sameLeaf(field, a, b) {
  if (a === b) return true
  if (typeof field !== 'string') return false
  try { return encode({ [field]: a }) === encode({ [field]: b }) } catch { return false }
}

// Key-for-key comparison of a decoded blob with its JSON copy. Returns the first difference as a path.
function deepDiff(a, b, path, field) {
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  if (kind(a) !== kind(b)) return `${path}: blob ${JSON.stringify(a)} vs JSON ${JSON.stringify(b)}`
  if (kind(a) === 'array') {
    if (a.length !== b.length) return `${path}: ${a.length} entries in the blob vs ${b.length} in the JSON`
    for (let i = 0; i < a.length; i++) {
      const d = deepDiff(a[i], b[i], `${path}[${i}]`, null)
      if (d) return d
    }
    return null
  }
  if (kind(a) === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) return `${path}.${k}: in the JSON, not in the blob`
      if (!(k in b)) return `${path}.${k}: in the blob, not in the JSON`
      const d = deepDiff(a[k], b[k], `${path}.${k}`, k)
      if (d) return d
    }
    return null
  }
  return sameLeaf(field, a, b) ? null : `${path}: blob ${JSON.stringify(a)} vs JSON ${JSON.stringify(b)}`
}

// CTID: 0xC, 28-bit ledger index, 16-bit transaction index, 16-bit network id.
function parseCtid(ctid) {
  if (typeof ctid !== 'string' || !/^C[0-9A-F]{15}$/.test(ctid)) return null
  const n = BigInt(`0x${ctid}`)
  return {
    ledger: Number((n >> 32n) & 0xfffffffn),
    index: Number((n >> 16n) & 0xffffn),
    network: Number(n & 0xffffn),
  }
}

function checkOne(dir, id, fail) {
  let bin, tx
  try {
    bin = JSON.parse(readFileSync(join(dir, `${id}.bin.json`), 'utf8'))
    tx = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
  } catch (e) { fail(id, `unreadable: ${e.message}`); return }

  // The one binding that needs no trust in the server: the id is the hash of the signed blob.
  let computed
  try { computed = hashes.hashSignedTx(bin.tx_blob) } catch (e) { fail(id, `tx_blob does not hash: ${e.message}`); return }
  if (computed !== id) fail(id, `tx_blob hashes to ${computed}, not the file name`)
  if (bin.hash !== id) fail(id, `stored hash ${bin.hash} differs from the file name`)
  if (tx.hash !== id) fail(id, `JSON capture hash ${tx.hash} differs from the file name`)

  // Envelope fields: the two server responses must agree with each other.
  if (bin.ledger_index !== tx.ledger_index) fail(id, `ledger_index ${bin.ledger_index} (binary) vs ${tx.ledger_index} (JSON)`)
  if (tx.inLedger !== tx.ledger_index) fail(id, `inLedger ${tx.inLedger} vs ledger_index ${tx.ledger_index}`)
  if (bin.date !== tx.date) fail(id, `date ${bin.date} (binary) vs ${tx.date} (JSON)`)
  if (bin.validated !== true || tx.validated !== true) fail(id, 'capture is not marked validated by the server')
  const ctid = parseCtid(tx.ctid)
  if (!ctid) fail(id, `ctid ${tx.ctid} is not a CTID`)
  else {
    if (ctid.ledger !== tx.ledger_index) fail(id, `ctid ledger ${ctid.ledger} vs ledger_index ${tx.ledger_index}`)
    if (ctid.index !== tx.meta?.TransactionIndex) fail(id, `ctid index ${ctid.index} vs meta TransactionIndex ${tx.meta?.TransactionIndex}`)
    if (ctid.network !== DEVNET_NETWORK_ID) fail(id, `ctid network ${ctid.network}, Devnet is ${DEVNET_NETWORK_ID}`)
  }

  // Transaction: JSON less the envelope must be tx_blob, byte for byte and key for key.
  const txJson = { ...tx }
  for (const k of ENVELOPE) delete txJson[k]
  try {
    if (encode(txJson) !== bin.tx_blob) fail(id, 'JSON transaction does not re-encode to tx_blob')
  } catch (e) { fail(id, `JSON transaction does not encode: ${e.message}`) }
  try {
    const d = deepDiff(decode(bin.tx_blob), txJson, 'tx', null)
    if (d) fail(id, d)
  } catch (e) { fail(id, `tx_blob does not decode: ${e.message}`) }

  // Metadata: JSON meta must be meta_blob, byte for byte and key for key. delivered_amount is
  // computed by the API, not stored, so it is compared with what it is derived from instead.
  if (!tx.meta || typeof tx.meta !== 'object') { fail(id, 'JSON capture has no meta'); return }
  const metaJson = { ...tx.meta }
  if ('delivered_amount' in metaJson) {
    const from = metaJson.DeliveredAmount ?? tx.Amount
    if (metaJson.delivered_amount !== 'unavailable' && deepDiff(from, metaJson.delivered_amount, 'meta.delivered_amount', 'Amount')) {
      fail(id, 'meta.delivered_amount differs from DeliveredAmount / Amount')
    }
    delete metaJson.delivered_amount
  }
  try {
    if (encode(metaJson) !== bin.meta_blob) fail(id, 'JSON meta does not re-encode to meta_blob')
  } catch (e) { fail(id, `JSON meta does not encode: ${e.message}`) }
  try {
    const d = deepDiff(decode(bin.meta_blob), metaJson, 'meta', null)
    if (d) fail(id, d)
  } catch (e) { fail(id, `meta_blob does not decode: ${e.message}`) }
}

export function check(dir, readme) {
  const failures = []
  const fail = (h, msg) => failures.push(`${h.slice(0, 16)}...  ${msg}`)

  let files = []
  try { files = readdirSync(dir) } catch (e) { fail('evidence        ', `cannot read ${dir}: ${e.message}`) }
  const binIds = files.filter((f) => f.endsWith('.bin.json')).map((f) => f.slice(0, -'.bin.json'.length))
  const jsonIds = files.filter((f) => /^[0-9A-Fa-f]{64}\.json$/.test(f)).map((f) => f.slice(0, 64))

  for (const id of jsonIds) if (!binIds.includes(id)) fail(id, 'JSON capture has no .bin.json')
  for (const id of binIds) {
    if (!HEX64.test(id)) { fail(id, 'file name is not a 64-hex upper-case hash'); continue }
    if (!jsonIds.includes(id)) { fail(id, '.bin.json has no JSON capture'); continue }
    checkOne(dir, id, fail)
  }

  const linked = [...new Set([...readFileSync(readme, 'utf8').matchAll(/devnet\.xrpl\.org\/transactions\/([0-9A-Fa-f]{64})/g)].map((m) => m[1].toUpperCase()))]
  if (linked.length === 0) fail('README.md       ', 'no devnet.xrpl.org/transactions links found; the scan would prove nothing')
  if (binIds.length === 0) fail('evidence        ', `no captures found in ${dir}`)
  for (const h of linked) if (!binIds.includes(h)) fail(h, 'linked from README.md but not captured')

  return { failures, captures: binIds.length, linked: linked.length }
}

// Planted defects on a temporary copy. Each case states whether the checker must fail it.
function selfTest() {
  const SRC = `${ROOT}/evidence/devnet-tx`
  const README = `${ROOT}/README.md`
  const IMPAIR = '075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3'
  const ORACLE = (() => {
    for (const f of readdirSync(SRC).filter((x) => x.endsWith('.bin.json'))) {
      const t = JSON.parse(readFileSync(join(SRC, f.replace('.bin.json', '.json')), 'utf8'))
      if (t.PriceDataSeries) return f.slice(0, 64)
    }
    throw new Error('no OracleSet capture to tamper with')
  })()
  const rw = (dir, file, fn) => {
    const p = join(dir, file)
    const v = JSON.parse(readFileSync(p, 'utf8'))
    fn(v)
    writeFileSync(p, JSON.stringify(v, null, 2))
  }
  const vaultNode = (meta) => {
    const n = meta.AffectedNodes.find((a) => a.ModifiedNode?.LedgerEntryType === 'Vault')
    if (!n) throw new Error('no Vault ModifiedNode in the impairment capture')
    return n.ModifiedNode
  }
  const forgeVault = (meta) => { vaultNode(meta).PreviousFields = { LossUnrealized: '0' } }

  const cases = [
    { name: 'clean copy', expectFail: false, plant() {} },
    { name: 'last tx_blob nibble flipped (inside the signature, still decodes)', expectFail: true, plant(d) {
      rw(d, `${IMPAIR}.bin.json`, (b) => { const i = b.tx_blob.length - 1; b.tx_blob = b.tx_blob.slice(0, i) + (b.tx_blob[i] === '0' ? '1' : '0') + b.tx_blob.slice(i + 1) })
    } },
    { name: 'Vault PreviousFields forged to {LossUnrealized:"0"} in the JSON only', expectFail: true, plant(d) {
      rw(d, `${IMPAIR}.json`, (t) => forgeVault(t.meta))
    } },
    { name: 'Vault PreviousFields forged in meta_blob only', expectFail: true, plant(d) {
      rw(d, `${IMPAIR}.bin.json`, (b) => { const m = decode(b.meta_blob); forgeVault(m); b.meta_blob = encode(m) })
    } },
    { name: 'unknown key added inside a JSON AffectedNode (the codec would skip it)', expectFail: true, plant(d) {
      rw(d, `${IMPAIR}.json`, (t) => { vaultNode(t.meta).note = 'x' })
    } },
    { name: 'OracleSet AssetPrice changed in the JSON', expectFail: true, plant(d) {
      rw(d, `${ORACLE}.json`, (t) => { const p = t.PriceDataSeries[0].PriceData; p.AssetPrice = (BigInt(`0x${p.AssetPrice}`) + 1n).toString(16) })
    } },
    { name: 'ledger_index changed in the JSON envelope', expectFail: true, plant(d) {
      rw(d, `${IMPAIR}.json`, (t) => { t.ledger_index += 1 })
    } },
    { name: 'capture linked from README removed', expectFail: true, plant(d) {
      rmSync(join(d, `${IMPAIR}.json`)); rmSync(join(d, `${IMPAIR}.bin.json`))
    } },
    // Known limit, kept as a control so the README's wording has a receipt: the metadata is not
    // hash-bound offline, so a forgery written consistently into both copies passes.
    { name: 'KNOWN LIMIT: same Vault forgery in both meta_blob and JSON', expectFail: false, plant(d) {
      rw(d, `${IMPAIR}.json`, (t) => forgeVault(t.meta))
      rw(d, `${IMPAIR}.bin.json`, (b) => { const m = decode(b.meta_blob); forgeVault(m); b.meta_blob = encode(m) })
    } },
  ]

  let wrong = 0
  for (const c of cases) {
    const d = mkdtempSync(join(tmpdir(), 'orma-evidence-'))
    try {
      cpSync(SRC, d, { recursive: true })
      c.plant(d)
      const r = check(d, README)
      const failed = r.failures.length > 0
      const ok = failed === c.expectFail
      if (!ok) wrong++
      console.log(`  ${ok ? 'ok  ' : 'BAD '} ${c.name}: ${failed ? `fails (${r.failures[0]})` : 'passes'}`)
    } finally { rmSync(d, { recursive: true, force: true }) }
  }
  if (wrong) { console.error(`\n  FAIL: ${wrong} of ${cases.length} self-test case(s) behaved unexpectedly`); process.exit(1) }
  console.log(`\n  PASS: ${cases.length} self-test cases behaved as expected`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv[2] === '--self-test') selfTest()
  else {
    const dir = resolve(process.argv[2] ?? `${ROOT}/evidence/devnet-tx`)
    const readme = resolve(process.argv[3] ?? `${ROOT}/README.md`)
    const { failures, captures, linked } = check(dir, readme)
    if (failures.length) {
      for (const f of failures) console.error(`  FAIL ${f}`)
      console.error(`\n  FAIL: ${failures.length} problem(s) across ${captures} captures`)
      process.exit(1)
    }
    console.log(`  PASS: ${captures} captures; each tx_blob hashes to its id; JSON transaction and meta re-encode to tx_blob and meta_blob and match them key for key; all ${linked} README transaction links captured. meta_blob is the server's copy, not hash-bound.`)
  }
}
