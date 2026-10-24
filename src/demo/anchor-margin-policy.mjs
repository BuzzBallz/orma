/**
 * Writes the risk officer's margin policy once (step 20, addendum A11): demo/margin-policy-desk-1.json,
 * orma.marginpolicy/1, DECLARED, hashed like the mandate (over its own keys, without hash and anchorTx) and
 * anchored by an AccountSet of the risk officer whose Memo is orma.marginpolicy/1:<hash>, as the bake
 * anchored the mandate. The mandate file and its hash are read, never touched.
 *
 * Refuses (exit 2, nothing written or submitted) when the file already carries an anchorTx, when the
 * mandate does not hash to its own hash, or without the risk officer's key in .demo/roles.json. The key is
 * read in this process only, never printed.
 *
 *   node --env-file-if-exists=.env src/demo/anchor-margin-policy.mjs --dry-run   the document and its Memo, nothing read or sent
 *   node --env-file-if-exists=.env src/demo/anchor-margin-policy.mjs             anchor on Devnet, then write the file
 * Exit: 0 written (or the dry run printed), 1 the anchor failed, 2 refused.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Client, Wallet } from 'xrpl'
import { mandateHash, marginPolicyHash, SCHEMAS } from '../nyc/contracts.mjs'

const OUT = 'demo/margin-policy-desk-1.json'
const MANDATE = 'demo/mandate-desk-1.json'
const ROLES = '.demo/roles.json'
const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const dry = process.argv.includes('--dry-run')

function refuse(sentence) {
  console.log(`  refused: ${sentence}`)
  process.exitCode = 2
}

async function main() {
  if (existsSync(OUT)) {
    let anchored = false
    try {
      anchored = typeof JSON.parse(readFileSync(OUT, 'utf8')).anchorTx === 'string'
    } catch { /* an unreadable file is refused below, never overwritten blindly */ }
    return refuse(anchored ? `${OUT} already carries an anchorTx; a declared policy is never rewritten.` : `${OUT} exists but is unreadable; remove it by hand after checking it.`)
  }
  const mandate = JSON.parse(readFileSync(MANDATE, 'utf8'))
  if (mandateHash(mandate) !== mandate.hash) return refuse(`${MANDATE} does not hash to its own hash.`)

  const body = {
    schema: 'orma.marginpolicy/1', id: mandate.id, mandateHash: mandate.hash, trigger: 'maxLtvBps', cureSeconds: 600,
    realWorldNote: 'Institutional desks usually give 12 to 24 hours; 600 seconds on Devnet so a full cycle can be shown.',
    cureAction: 'pledgeEscrow',
    afterExpiry: 'The desk may act under its escrow policy (finish only after a default). No automatic seizure.',
    issuedAt: new Date().toISOString(),
  }
  const hash = marginPolicyHash(body)
  const tx = {
    TransactionType: 'AccountSet', Account: mandate.riskOfficer,
    Memos: [{ Memo: { MemoType: hex('orma.marginpolicy/1'), MemoData: hex(`orma.marginpolicy/1:${hash}`) } }],
  }
  console.log(`  margin policy ${body.id}: cure ${body.cureSeconds} s, trigger ${body.trigger}, mandate ${mandate.hash.slice(0, 12)}…, hash ${hash}`)
  if (dry) {
    console.log(`  dry run: the AccountSet of the risk officer ${mandate.riskOfficer} would carry orma.marginpolicy/1:${hash}; nothing read or sent`)
    return
  }

  let wallet
  try {
    const seed = JSON.parse(readFileSync(ROLES, 'utf8')).accounts?.riskOfficer?.seed
    if (!seed) return refuse(`${ROLES} carries no riskOfficer key.`)
    wallet = Wallet.fromSeed(seed)
  } catch (e) {
    return refuse(`${ROLES} could not be read (${e.code ?? e.name}).`)
  }
  if (wallet.address !== mandate.riskOfficer) return refuse('the riskOfficer key of the roles file is not the risk officer the mandate names.')

  const client = new Client(WS, { connectionTimeout: 20000, timeout: 20000 })
  try {
    await client.connect()
    const r = await client.submitAndWait(tx, { wallet, autofill: true })
    const result = r.result.meta?.TransactionResult
    if (result !== 'tesSUCCESS') {
      console.log(`  the anchor ended ${result}; nothing written`)
      process.exitCode = 1
      return
    }
    const doc = { ...body, hash, anchorTx: r.result.hash }
    const problems = SCHEMAS.marginPolicy(doc)
    if (problems.length) {
      console.log(`  the anchored document does not pass SCHEMAS.marginPolicy: ${problems.join('; ')}`)
      process.exitCode = 1
      return
    }
    writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
    console.log(`  anchored by ${r.result.hash} at ledger ${r.result.ledger_index}; wrote ${OUT}`)
  } catch (e) {
    console.log(`  the anchor failed: ${String(e?.message ?? e).slice(0, 160)}; nothing written`)
    process.exitCode = 1
  } finally {
    await client.disconnect().catch(() => {})
  }
}

await main()
