/**
 * Can a third party edit the PermissionedDomain that cites it? Probed on Devnet, live.
 *
 * WHY THIS MATTERS. The gate beat claims the facility named our issuer unilaterally, and
 * that we cannot decline being cited and cannot alter the arrangement. The first half is
 * visible in the domain object. The second half was, until this probe, asserted. A jury
 * that asks for the hash of "we tried to edit their domain" has to be handed one.
 *
 * WHAT IS PROBED. A funded account that is NOT the domain owner submits
 * PermissionedDomainSet against the existing DomainID, which is the only way to modify a
 * domain in place. Whatever the ledger returns is what this writes down.
 *
 * Run: node src/demo/probe-domain-edit.mjs
 * Out: demo/domain-authority.json  (TRACKED)
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { Client } from 'xrpl'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = 'demo/domain-authority.json'

const gate = JSON.parse(readFileSync('demo/gate-vault.json', 'utf8'))
const domainId = gate.gate?.domainId ?? gate.domainId
const domainOwner = gate.gate?.domainOwner ?? gate.accounts?.owner
const credType = gate.credentialTypeHex ?? gate.gate?.acceptedCredentials?.[0]?.typeHex
if (!domainId || !credType) throw new Error('demo/gate-vault.json carries no domain to probe')

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const buildVersion = (await c.request({ command: 'server_info' })).result.info.build_version
console.log(`\n  rippled ${buildVersion}`)
console.log(`  can an outsider edit the domain that cites them?\n`)
console.log(`    domain   ${domainId}`)
console.log(`    owner    ${domainOwner}`)

const { wallet: outsider } = await c.fundWallet()
console.log(`    outsider ${outsider.address}\n`)

// The domain must still exist, or the probe proves nothing about authority.
let domainLive = false
try {
  const e = await c.request({ command: 'ledger_entry', index: domainId })
  domainLive = e.result.node?.LedgerEntryType === 'PermissionedDomain'
} catch { /* reported below */ }

let code, hash = null, onLedger = false
try {
  const r = await c.submitAndWait(
    {
      TransactionType: 'PermissionedDomainSet',
      Account: outsider.address,
      DomainID: domainId,
      AcceptedCredentials: [{ Credential: { Issuer: outsider.address, CredentialType: credType } }],
    },
    { wallet: outsider, autofill: true },
  )
  code = r.result.meta.TransactionResult
  hash = r.result.hash
  onLedger = true
} catch (e) {
  const raw = e?.data?.error_exception ?? e?.data?.error ?? String(e)
  code = String(raw).match(/(tem|tec|tef|ter)[A-Z_]+/)?.[0] ?? String(raw).slice(0, 80)
}

const refused = /^(tec|tem|tef|ter)/.test(code) && code !== 'tesSUCCESS'
const out = {
  probedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  probedDuring: 'XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026',
  network: 'devnet',
  buildVersion,
  question: 'Can an account that is not the domain owner modify a PermissionedDomain that names it?',
  domainId,
  domainOwner,
  domainLive,
  attemptedBy: outsider.address,
  attempt: { transactionType: 'PermissionedDomainSet', code, hash, onLedger },
  answer: refused
    ? `No. The ledger returned ${code}. Being cited in a domain confers no authority over it.`
    : `INCONCLUSIVE: the ledger returned ${code}. Do not cite this.`,
  whyItMatters:
    'The facility names an issuer unilaterally and the issuer cannot decline. This probe is the other half: the issuer also cannot alter the arrangement it was named in.',
}
mkdirSync('demo', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(`    ${refused ? 'REFUSED' : 'XX     '} PermissionedDomainSet  ${code}${hash ? '  ' + hash : '  (no ledger slot)'}`)
console.log(`\n  ${out.answer}`)
console.log(`  domain still on ledger: ${domainLive}`)
console.log(`  -> ${OUT}\n`)
await c.disconnect()
if (!refused) process.exit(1)
