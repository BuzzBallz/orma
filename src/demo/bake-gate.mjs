/**
 * The grade with teeth. Demo 3, proven on Devnet.
 *
 * Two limited partners, identical in every way that matters to the ledger: same balance,
 * same transaction, same vault, submitted in the same wave. One holds a credential we
 * issued. The other does not. The ledger admits one and refuses the other, and we are
 * not in the loop at the moment it happens.
 *
 * WHAT THE SEQUENCE PROVES, step by step:
 *
 *   1. we issue a credential to LP_GOOD              CredentialCreate
 *   2. LP_GOOD opts in                               CredentialAccept
 *      Issuance alone grants nothing. Without this the deposit is still tecNO_AUTH, so a
 *      credential cannot be done TO someone.
 *   3. an INDEPENDENT vault owner names our issuer   PermissionedDomainSet
 *      We sign nothing. We are not asked. We cannot refuse. That is the correct shape
 *      for a rating: being cited without consent is how every rating agency works.
 *   4. that owner creates a private, gated vault     VaultCreate + tfVaultPrivate + DomainID
 *   5. both LPs deposit in the same wave             tesSUCCESS / tecNO_AUTH
 *   6. we revoke                                     CredentialDelete
 *   7. LP_GOOD's next deposit bounces                tecNO_AUTH
 *   8. but their existing position still withdraws   tesSUCCESS
 *      The gate controls who may ENTER, never who may leave. A rater who could trap
 *      capital would be a worse problem than the one this solves.
 *
 * Every result is read from the VALIDATED metadata, never from engine_result: we have
 * observed an engine result of tecNO_AUTH go on to validate as tesSUCCESS, and on this
 * feature that is the difference between "refused" and "admitted".
 *
 * Run: node src/demo/bake-gate.mjs [--window 3600]
 * Out: demo/gate-vault.json  (TRACKED)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Client } from 'xrpl'
import { Xrpl } from '../xrpl.mjs'
import {
  BARS, TF_VAULT_PRIVATE, hexType,
  issueCredential, acceptCredential, revokeCredential, createDomain,
  submitValidated, gateStatus, isNamedIn,
} from '../credentials.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = 'demo/gate-vault.json'
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d }
const WINDOW = Number(arg('window', 3600))
const LABEL = arg('label', 'Thorne Senior Secured I')
const BAR = BARS.IG

const steps = []
const rec = (name, r, note) => {
  steps.push({ step: name, code: r.code, ok: r.ok, hash: r.hash ?? null, note: note ?? null })
  const mark = r.ok ? 'ok  ' : (String(r.code).startsWith('tec') ? 'REJ ' : 'FAIL')
  console.log(`    ${mark} ${name.padEnd(34)} ${r.code}${r.hash ? '  ' + r.hash.slice(0, 16) + '…' : ''}`)
  return r
}
const must = (r, what) => {
  if (!r.ok) { console.error(`\n  ABORT ${what} -> ${r.code} ${r.error ?? ''}`); process.exit(1) }
  return r
}

const c = new Client(WS, { connectionTimeout: 20000 })
await c.connect()
const closeTime = async () => Number((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)
const buildVersion = (await c.request({ command: 'server_info' })).result.info.build_version
console.log(`\n  rippled ${buildVersion}`)
console.log(`  credential ${BAR.name} — ${BAR.says}\n`)

console.log('  funding four accounts')
// RATER is us. VAULTOWNER is an independent party who will cite us without asking.
const { wallet: rater } = await c.fundWallet()
const { wallet: vaultOwner } = await c.fundWallet()
const { wallet: lpGood } = await c.fundWallet()
const { wallet: lpBad } = await c.fundWallet()
console.log(`    rater       ${rater.address}`)
console.log(`    vault owner ${vaultOwner.address}   (independent: never signs anything of ours)`)
console.log(`    LP graded   ${lpGood.address}`)
console.log(`    LP ungraded ${lpBad.address}`)

console.log('\n  1-2. issue, then the LP opts in')
must(rec('CredentialCreate', await issueCredential(c, rater, lpGood.address, BAR.name)), 'issue')
must(rec('CredentialAccept (by the LP)', await acceptCredential(c, lpGood, rater.address, BAR.name)), 'accept')

console.log('\n  3. the vault owner names our issuer. We sign nothing.')
const dom = must(await createDomain(c, vaultOwner, [{ issuer: rater.address, type: BAR.name }]), 'domain')
rec('PermissionedDomainSet', dom, 'signed by the vault owner alone')
console.log(`         domain ${dom.domainId}`)

console.log('\n  4. a private, gated vault')
const now = await closeTime()
// The whole sequence must finish INSIDE the Subscription phase, and that is not a
// convenience. Deposits are only legal in Subscription, so once it closes a refused
// deposit returns tecEXPIRED for the phase and the credential is never consulted; and
// withdrawals are refused for the entire Investment phase with tecTOO_SOON, so the
// revocation asymmetry -- entry closed, exit open -- becomes unobservable.
//
// A first run with a 25 second window proved exactly that: the deposit came back
// tecEXPIRED and the withdrawal tecTOO_SOON, neither of which says anything about the
// gate. The two phase rules mask the credential rule rather than compose with it.
// 900s is the floor the sequence needs; a presentation wants far more, so the
// orchestrator raises it. Either way the whole test runs inside Subscription.
const SUB = now + Math.max(900, Number(process.env.GATE_SUBSCRIPTION_SECONDS ?? 900))
const RED = SUB + WINDOW
const vc = must(await submitValidated(c, vaultOwner, {
  TransactionType: 'VaultCreate', Asset: { currency: 'XRP' },
  VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: RED, WithdrawalPolicy: 1,
  // tfVaultPrivate is REQUIRED alongside DomainID. Without it the domain is inert.
  Flags: TF_VAULT_PRIVATE,
  DomainID: dom.domainId,
}), 'VaultCreate')
rec('VaultCreate (private + domain)', vc)
const vaultId = vc.meta.AffectedNodes.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === 'Vault').LedgerIndex
console.log(`         vault ${vaultId}`)

console.log('\n  5. both LPs deposit, same wave, same amount')
const [good, bad] = await Promise.all([
  submitValidated(c, lpGood, { TransactionType: 'VaultDeposit', VaultID: vaultId, Amount: '20000000' }),
  submitValidated(c, lpBad, { TransactionType: 'VaultDeposit', VaultID: vaultId, Amount: '20000000' }),
])
rec('VaultDeposit — graded LP', good)
rec('VaultDeposit — ungraded LP', bad, 'refused by the ledger, not by us')

console.log('\n  6-8. revoke, and see what it does and does not do')
must(rec('CredentialDelete (revoke)', await revokeCredential(c, rater, lpGood.address, BAR.name)), 'revoke')
const bounced = rec('VaultDeposit after revocation', await submitValidated(c, lpGood, { TransactionType: 'VaultDeposit', VaultID: vaultId, Amount: '3000000' }), 'entry is closed')
const exit = rec('VaultWithdraw after revocation', await submitValidated(c, lpGood, { TransactionType: 'VaultWithdraw', VaultID: vaultId, Amount: '5000000' }), 'the exit stays open')

// --- read the gate back the way the product does -----------------------------
const x = new Xrpl(WS)
await x.connect()
const raw = await x.vaultInfo(vaultId)
const status = await gateStatus(x, {
  isPrivate: Boolean(Number(raw.Flags ?? 0) & TF_VAULT_PRIVATE),
  shareMptId: raw.shares?.mpt_issuance_id ?? null,
})
console.log('\n  GATE, read back from the ledger')
console.log(`    gated              ${status.gated}`)
console.log(`    domain             ${status.domainId}`)
console.log(`    accepted issuers   ${status.acceptedCredentials.map((a) => `${a.type} by ${a.issuer.slice(0, 10)}…`).join(', ')}`)
console.log(`    we are named in it ${isNamedIn(status, rater.address)}`)

const out = {
  bakedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  bakedDuring: 'XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026',
  network: 'devnet', buildVersion,
  label: LABEL,
  vaultId,
  domainId: dom.domainId,
  credentialType: BAR.name,
  credentialTypeHex: hexType(BAR.name),
  accounts: { rater: rater.address, vaultOwner: vaultOwner.address, lpGraded: lpGood.address, lpUngraded: lpBad.address },
  steps,
  gate: status,
  verdict: {
    gradedAdmitted: good.ok,
    ungradedRefused: !bad.ok && bad.code === 'tecNO_AUTH',
    entryClosedAfterRevocation: !bounced.ok && bounced.code === 'tecNO_AUTH',
    exitStayedOpen: exit.ok,
  },
}
mkdirSync('demo', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(`\n  -> ${OUT}\n`)

await x.disconnect()
await c.disconnect()

const v = out.verdict
const allHeld = v.gradedAdmitted && v.ungradedRefused && v.entryClosedAfterRevocation && v.exitStayedOpen
if (!allHeld) {
  console.error('  THE GATE DID NOT BEHAVE AS CLAIMED:', JSON.stringify(v))
  process.exit(1)
}
console.log('  All four claims held. The grade has teeth.\n')
