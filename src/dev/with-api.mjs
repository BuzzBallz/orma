/**
 * Runs a command against a local API on :8788 that never publishes. The API signs role actions only
 * when DESK_SEED and ROLES_FILE are set (the live desk checks need that); the command itself gets no seed.
 *
 *   node --env-file-if-exists=.env src/dev/with-api.mjs -- <cmd> [args...]
 *   node --env-file-if-exists=.env src/dev/with-api.mjs --self-test
 *
 * Exit: the command's own code; 64 invalid usage; 70 API not ready within 90 s.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const PORT = 8788
const BASE = `http://127.0.0.1:${PORT}`
const INDEX = fileURLToPath(new URL('../index.mjs', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const RECEIPTS = join('.demo', 'receipts')
const ROLES_POST = '/api/roles/r1/holder/simulateWithdraw'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (a) => (/[\s'()?:=&|<>^%]/.test(a) ? `"${a}"` : a)

async function call(path, method = 'GET') {
  const res = await fetch(BASE + path, { method, signal: AbortSignal.timeout(5000) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * PUBLISH_SEED and PUBLISH are blanked, never removed: the .env loader of src/index.mjs only
 * writes a key that is undefined, so a removed key would be read back from the root .env and
 * two processes would publish from one account.
 */
export function startApi({ env = {}, cwd = process.cwd() } = {}) {
  const child = spawn(process.execPath, [INDEX], {
    cwd,
    env: { ...process.env, ...env, PORT: String(PORT), PUBLISH_SEED: '', PUBLISH: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((r) => child.once('exit', r))
  return { child, exited, stderrLines: () => err.split('\n').filter(Boolean) }
}

async function stopApi(api) {
  api.child.kill()
  await api.exited
}

/** Ready is "the reader finished its first pass", not "the port is open". */
async function waitReady(api, ms = 90_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms && api.child.exitCode === null) {
    try {
      const h = await call('/api/health')
      if (h.status === 200 && h.body?.ok === true && (await call(`/api/mpt/${'0'.repeat(48)}/nav`)).status === 404) return true
    } catch { /* not listening yet */ }
    await sleep(500)
  }
  return false
}

/**
 * The wrapped command talks to the API and needs no key: every seed and the roles file are blanked, so a
 * tool it downloads (npx) never sees them. Blanked, not removed, for the reason given above startApi.
 */
export function commandEnv(env = process.env) {
  return { ...env, API_BASE: BASE, PUBLISH_SEED: '', PUBLISH: '', DESK_SEED: '', ROLES_FILE: '', OWNER_SEED: '', FX_RELAY_SEED: '' }
}

function runCommand(cmd, args) {
  const env = commandEnv()
  // Windows refuses a bare .cmd without a shell, and a shell splits a quoted path at its spaces.
  const useShell = process.platform === 'win32' && !isAbsolute(cmd) && !/\.exe$/i.test(cmd)
  const child = useShell
    ? spawn([cmd, ...args].map(q).join(' '), { stdio: 'inherit', shell: true, env })
    : spawn(cmd, args, { stdio: 'inherit', env })
  return new Promise((resolve) => {
    child.once('error', () => resolve(127))
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

async function runWith(argv) {
  const [cmd, ...args] = argv
  if (!cmd) {
    console.error('usage: with-api.mjs -- <cmd> [args...] | --self-test')
    return 64
  }
  if (process.platform === 'win32' && !isAbsolute(cmd) && !/\.exe$/i.test(cmd) && args.some((a) => a.includes('"'))) {
    console.error('with-api: an argument containing a double quote cannot be passed through a Windows shell')
    return 64
  }
  const api = startApi()
  if (!(await waitReady(api))) {
    console.error(api.stderrLines().slice(-20).join('\n'))
    console.error('with-api: the API was not ready after 90 s')
    await stopApi(api)
    return 70
  }
  const startedAt = new Date().toISOString()
  const exitCode = await runCommand(cmd, args)
  const finishedAt = new Date().toISOString()
  await stopApi(api)
  const joined = argv.join(' ')
  mkdirSync(RECEIPTS, { recursive: true })
  const name = joined.replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 80)
  const stamp = finishedAt.replace(/[:.]/g, '-')
  writeFileSync(join(RECEIPTS, `${name}-${stamp}.json`), JSON.stringify({ cmd: joined, exitCode, startedAt, finishedAt, apiBase: BASE }, null, 2))
  return exitCode
}

// --- self-test --------------------------------------------------------------

function firstServedVault() {
  for (const f of readdirSync('demo').filter((n) => n.endsWith('.json')).sort()) {
    try {
      const j = JSON.parse(readFileSync(join('demo', f), 'utf8'))
      if (/^[A-Fa-f0-9]{64}$/.test(j.vaultId ?? '') && !j.retired) return j.vaultId.toUpperCase()
    } catch { /* a malformed capture is skipped, as the API does */ }
  }
  throw new Error('demo/ holds no served vault')
}

const parsed = (api) => api.stderrLines().map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const configError = (api) => parsed(api).find((l) => l.level === 'error' && Array.isArray(l.missing))

async function notConfigured() {
  const r = await call(ROLES_POST, 'POST')
  assert.equal(r.status, 503)
  assert.equal(r.body?.error?.code, 'NOT_CONFIGURED')
}

async function probeHealthAndGuards(vaultId) {
  const api = startApi({ env: { ROLES_FILE: '', DESK_SEED: '', LOG_PRETTY: '0' } })
  try {
    assert.ok(await waitReady(api), 'probe 1: API not ready')
    assert.notEqual((await call(`/api/vaults/${vaultId}`)).status, 503, 'probe 1: still WARMING_UP after the wait')
    assert.equal((await call('/api/health')).status, 200)
    assert.equal((await call('/api/vaults')).status, 200)
    const nf = await call('/api/no-such-route')
    assert.equal(nf.status, 404)
    assert.equal(nf.body?.error?.code, 'NOT_FOUND')
    await notConfigured()
    const e = configError(api)
    assert.ok(e && e.missing.includes('ROLES_FILE') && e.missing.includes('DESK_SEED'), 'probe 1: missing does not name ROLES_FILE and DESK_SEED')
  } finally {
    await stopApi(api)
  }
  console.log('ok 1: health, vaults, 404 envelope, 503 NOT_CONFIGURED, missing')
}

function probeProcessGuards() {
  const script = "import { installProcessGuards } from './src/log.mjs'; installProcessGuards(); Promise.reject(new Error('probe'))"
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, LOG_PRETTY: '0' },
  })
  assert.equal(r.status, 1, `probe 2: exit ${r.status}`)
  const lines = r.stderr.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } })
  assert.ok(lines.some((l) => l?.level === 'error'), 'probe 2: no JSON error line on stderr')
  console.log('ok 2: unhandled rejection exits 1 with a JSON error line')
}

function probeReceipt() {
  const script = "process.exit(process.env.API_BASE === 'http://127.0.0.1:8788' && !process.env.PUBLISH_SEED && !process.env.OWNER_SEED ? 3 : 9)"
  const argv = [process.execPath, '-e', script]
  const t0 = new Date().toISOString()
  // The API never reads either key (startApi blanks PUBLISH_SEED), so only the command's env is under test.
  const env = { ...process.env, PUBLISH_SEED: 'sProbeNotARealSeed', OWNER_SEED: 'sProbeNotARealSeed' }
  const r = spawnSync(process.execPath, [SELF, '--', ...argv], { stdio: 'inherit', timeout: 150_000, env })
  assert.equal(r.status, 3, `probe 3: exit ${r.status}`)
  const receipt = readdirSync(RECEIPTS)
    .map((f) => JSON.parse(readFileSync(join(RECEIPTS, f), 'utf8')))
    .find((x) => x.cmd === argv.join(' ') && x.startedAt >= t0)
  assert.ok(receipt, 'probe 3: no receipt for this run')
  assert.equal(receipt.exitCode, 3)
  assert.equal(receipt.apiBase, BASE)
  assert.ok(Number.isFinite(Date.parse(receipt.finishedAt)))
  assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt))
  console.log('ok 3: -- mode returns the exit code, leaves a receipt and hands the command no seed')
}

async function probePopulatedEnv(vaultId) {
  const dir = mkdtempSync(join(tmpdir(), 'orma-with-api-'))
  writeFileSync(join(dir, '.env'), 'DESK_SEED=sProbeNotARealSeed\nROLES_FILE=.env\nPUBLISH_SEED=sProbeNotARealSeed\n')
  const api = startApi({ cwd: dir, env: { VAULTS: vaultId, ROLES_FILE: '', DESK_SEED: '', LOG_PRETTY: '0' } })
  try {
    assert.ok(await waitReady(api), 'probe 4: API not ready')
    const e = configError(api)
    for (const k of ['ROLES_FILE', 'DESK_SEED', 'PUBLISH_SEED']) assert.ok(e?.missing.includes(k), `probe 4: missing does not name ${k}`)
    const publishing = parsed(api).find((l) => l.msg === 'publishing enabled' || l.msg === 'publishing disabled, reader continues')
    assert.equal(publishing, undefined, 'probe 4: the publish branch was taken')
    await notConfigured()
  } finally {
    await stopApi(api)
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('ok 4: a populated .env does not publish (roles blanked here, so writes answer 503)')
}

async function selfTest() {
  if (!existsSync('demo')) throw new Error('run from the repository root')
  const vaultId = firstServedVault()
  await probeHealthAndGuards(vaultId)
  probeProcessGuards()
  probeReceipt()
  await probePopulatedEnv(vaultId)
}

const argv = process.argv.slice(2)
if (argv[0] === '--self-test') {
  try {
    await selfTest()
    console.log('with-api self-test passed')
  } catch (e) {
    console.error(`with-api self-test failed: ${e.message}`)
    process.exitCode = 1
  }
} else if (argv[0] === '--') {
  process.exitCode = await runWith(argv.slice(1))
} else {
  console.error('usage: with-api.mjs -- <cmd> [args...] | --self-test')
  process.exitCode = 64
}
