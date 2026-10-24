/**
 * Bake the desk's dollar lending (step 21, addendum A11): a Devnet test dollar that stands in for RLUSD,
 * issued by a test account of ours (Ripple publishes no RLUSD issuer on Devnet, and the lending amendments
 * are off on Testnet), and a closed-ended USD vault of the desk with its LoanBroker and first-loss cover.
 * Only the loan's currency changes: the collateral stays shares of XRP vaults (I4). The risk officer's terms,
 * which name the XRP/USD oracle documents the desk reads, are anchored apart, once the Devnet relay publishes
 * (src/demo/fx-relay.mjs, then src/demo/anchor-usd-terms.mjs).
 *
 *   1. a usdIssuer account from the faucet; asfAllowTrustLineClawback before any trust line, as RLUSD's
 *      issuer has it, then asfDefaultRipple (VaultCreate refuses an issued asset whose issuer lacks it);
 *   2. trust lines for deskOwner and borrower, then USD issued to deskOwner;
 *   3. the desk's USD vault (XLS-65, owner deskOwner, VaultKind 1, the desk's RedemptionDate), its
 *      LoanBroker, the desk's deposit during the subscription and the cover; the Investment phase waited for;
 *   4. every object re-read at one validated ledger, a USD LoanSet simulated (a fact for the receipt, never a
 *      gate: without the desk's countersignature it answers temBAD_SIGNER), then demo/desk-usd.json written,
 *      last.
 *
 * ONCE: an existing demo/desk-usd.json is never overwritten (exit 2), as for bake-nyc. The seeds of
 * deskOwner and borrower are read in this process from .demo/roles.json
 * and never printed; .demo/roles.json and ROLES_FILE do not change, so the VPS needs no new secret. The
 * issuer's seed goes to .demo/usd-issuer.json (gitignored, never on the VPS, never printed) before it is
 * funded.
 *
 * The vault id is kept as usdVaultId, not vaultId: demo/*.json files with a vaultId are the information
 * layer's served facilities, and the dollar vault is a lending pool of the desk, read by the desk's own code.
 *
 * Run:  node --env-file-if-exists=.env src/demo/bake-usd.mjs [--dry-run]
 * Exit: 0 baked (or, with --dry-run, preflight passed and nothing sent), 2 refused, 64 bad usage, 1 any other
 *       failure. A script that opened a socket sets process.exitCode and lets the process end.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Wallet, decode, hashes } from 'xrpl'
import { Xrpl } from '../xrpl.mjs'
import { num, Decimal } from '../num.mjs'
import { mandateHash, usdAmount, USD_LABEL } from '../nyc/contracts.mjs'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const OUT = { desk: 'demo/desk-usd.json' }
const ROLES_FILE = '.demo/roles.json'
const ISSUER_FILE = '.demo/usd-issuer.json'
const RECEIPT = '.demo/bake-usd-receipt.json'

// --- dates, in Ripple seconds, as bake-nyc has them ------------------------------------------------------
/** Tue 27 Oct 2026 00:00 ET: the desk's vaults outlive the last demo loan by a day. */
const DESK_REDEMPTION = 846388800
/** Sun 25 Oct 17:00 ET, the latest a desk LoanSet may be validated. */
const LATEST_DESK_LOANSET = 846277200
const LOAN_REDEMPTION_BUFFER = 60
const DESK_LOAN = { paymentInterval: 86400, gracePeriod: 3600 }
const SUBSCRIPTION_SECONDS = 240 // four deposits land well inside it

// --- the dollar plan (addendum A11, E4-T3) ------------------------------------------------------------------
/** XRP/USD on 24 Oct 20:19 UTC (CoinGecko 1.29, Kraken last trade 1.29262): fixes the planned principal only. */
const PLAN_PRICE = '1.29'
const FX_HAIRCUT_BPS = 1000 // the terms' haircut
const MAX_SINGLE_LOAN_USD = '10' // the terms' cap

// --- amounts, in dollars ------------------------------------------------------------------------------------
const RATE = 10000 // CoverRateMinimum and CoverRateLiquidation, in 1e-5 units: 10 %, as the XRP desk
const DEPOSIT = num(MAX_SINGLE_LOAN_USD).times(3) // three loans at the terms' cap
const COVER = DEPOSIT.times(RATE).div(1e5).ceil().times(2) // covered twice over, as the XRP desk
const ISSUED_TO_DESK = DEPOSIT.plus(COVER).plus(64) // the deposit, the cover, and room for fees of nothing
const TRUST_LIMIT = '1000000'
/** XRP the desk owner needs free for the reserves of a trust line, a vault, its shares, a broker, and fees. */
const DESK_XRP_FREE = 10

const LSF_DEFAULT_RIPPLE = 0x00800000
const LSF_ALLOW_TRUSTLINE_CLAWBACK = 0x80000000
const ASF_DEFAULT_RIPPLE = 8
const ASF_ALLOW_TRUSTLINE_CLAWBACK = 16

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const created = (meta, type) => (meta?.AffectedNodes ?? []).map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === type)
const flagOn = (flags, bit) => (BigInt(num(flags).toFixed(0)) & BigInt(bit)) !== 0n
const usd = (d) => new Decimal(d).toFixed()

class BakeError extends Error {}
class UsageError extends Error {}
class Refused extends Error {}

const argv = process.argv.slice(2)
const opts = { dryRun: false }

let c = null
let x = null
let started = false
let lastSubmitted = 0
const receipt = { bakedAt: null, network: 'devnet', ws: WS, buildVersion: null, usdIssuer: null, steps: [], reads: {}, loanSetSimulated: null }

process.exitCode = await main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(`  usage: node src/demo/bake-usd.mjs [--dry-run]\n  ${e.message}`)
    return 64
  }
  if (e instanceof Refused) {
    console.error(`  REFUSED  ${e.message}`)
    return 2
  }
  console.error(`\n  ABORT  ${e instanceof BakeError ? e.message : String(e?.stack ?? e).slice(0, 600)}`)
  saveReceipt()
  return 1
}).finally(async () => {
  try { await x?.disconnect() } catch { /* already gone */ }
})

async function main() {
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`)
  }

  // --- preflight: nothing on disk is overwritten, every key the bake signs with is the one demo/ names ------
  console.log('\n  preflight')
  for (const f of Object.values(OUT)) if (existsSync(f)) throw new Refused(`${f} already exists: the USD bake runs once, and its outputs are never overwritten`)
  let desk, mandate, roles
  try {
    desk = JSON.parse(readFileSync('demo/desk.json', 'utf8'))
    mandate = JSON.parse(readFileSync('demo/mandate-desk-1.json', 'utf8'))
  } catch (e) {
    throw new Refused(`the XRP desk is not baked here (demo/desk.json or demo/mandate-desk-1.json: ${e.code ?? e.name})`)
  }
  if (mandateHash(mandate) !== mandate.hash) throw new Refused('demo/mandate-desk-1.json does not hash to its own hash')
  if (!desk.plannedLoan?.units || !desk.plannedLoan?.principalDrops) throw new Refused('demo/desk.json carries no plannedLoan')
  try {
    roles = JSON.parse(readFileSync(ROLES_FILE, 'utf8')).accounts ?? {}
  } catch (e) {
    throw new Refused(`${ROLES_FILE} could not be read (${e.code ?? e.name})`)
  }
  const wallet = (role, want) => {
    const seed = roles[role]?.seed
    if (typeof seed !== 'string') throw new Refused(`${ROLES_FILE} carries no ${role} key`)
    const w = Wallet.fromSeed(seed)
    if (w.address !== want) throw new Refused(`the ${role} key of ${ROLES_FILE} is not the ${role} demo/ names (${want})`)
    return w
  }
  const w = {
    deskOwner: wallet('deskOwner', desk.owner),
    borrower: wallet('borrower', desk.collateral?.borrower),
  }
  console.log(`    ok    keys of deskOwner ${w.deskOwner.address} and borrower ${w.borrower.address}`)
  if (DESK_REDEMPTION < LATEST_DESK_LOANSET + DESK_LOAN.paymentInterval + LOAN_REDEMPTION_BUFFER) {
    throw new Refused(`RedemptionDate ${DESK_REDEMPTION} is under ${LATEST_DESK_LOANSET} + ${DESK_LOAN.paymentInterval} + ${LOAN_REDEMPTION_BUFFER}: the last demo LoanSet would be refused`)
  }
  // The dollar loan is the XRP plan's dollar equivalent at 1.29, less the haircut: while XRP trades near 1.29
  // it sits at the XRP plan's LTV at withdrawal value and crosses the mandate's limit on the same default.
  const principalUsd = new Decimal(desk.plannedLoan.principalDrops).div(1e6).times(PLAN_PRICE).times(new Decimal(1).minus(new Decimal(FX_HAIRCUT_BPS).div(10000))).toFixed(6, Decimal.ROUND_DOWN)
  const principal = new Decimal(principalUsd).toFixed()
  if (new Decimal(principal).gt(MAX_SINGLE_LOAN_USD)) throw new Refused(`the planned dollar loan ${principal} is above the terms' maxSingleLoanUsd ${MAX_SINGLE_LOAN_USD}`)
  console.log(`    ok    planned loan ${desk.plannedLoan.units} share units against ${principal} USD (${desk.plannedLoan.principalDrops} drops × ${PLAN_PRICE} × (1 − ${FX_HAIRCUT_BPS}/10000) / 10^6)`)

  x = new Xrpl(WS)
  await x.connect()
  c = x.client
  const pinnedReq = x.req.bind(x)
  x.req = async (payload) => {
    for (let i = 0; ; i++) {
      try {
        return await pinnedReq(payload)
      } catch (e) {
        const code = e?.data?.error
        if (['entryNotFound', 'objectNotFound', 'actNotFound', 'txnNotFound'].includes(code) || i >= 7) throw e
        await pause(e, payload.command, i)
      }
    }
  }
  receipt.buildVersion = x.buildVersion
  console.log(`    ok    rippled ${x.buildVersion} on ${WS}`)
  await x.closeTime()
  const L0 = x.lastLedger
  const info = (await x.req({ command: 'server_state', ledger_index: 'validated' })).result.state.validated_ledger
  const reserve = (n) => new Decimal(info.reserve_base).plus(new Decimal(info.reserve_inc).times(n))
  /** XRP an account holds above its reserve at L0, and its balance */
  const free = async (address) => {
    const a = (await x.req({ command: 'account_info', account: address, ledger_index: L0 })).result.account_data
    return { free: num(a.Balance).minus(reserve(a.OwnerCount ?? 0)).div(1e6), balance: num(a.Balance).div(1e6) }
  }
  const deskAccount = await free(w.deskOwner.address)
  const deskFree = deskAccount.free
  const borrowerFree = (await free(w.borrower.address)).free
  console.log(`    ok    at ledger ${L0}: deskOwner ${deskFree.toFixed(2)} XRP free, borrower ${borrowerFree.toFixed(2)} XRP free (reserve ${new Decimal(info.reserve_base).div(1e6).toFixed()} + ${new Decimal(info.reserve_inc).div(1e6).toFixed()} per object)`)
  const plan = [
    `fund a new usdIssuer at the faucet; AccountSet asfAllowTrustLineClawback (${ASF_ALLOW_TRUSTLINE_CLAWBACK}), then asfDefaultRipple (${ASF_DEFAULT_RIPPLE})`,
    `TrustSet USD ${TRUST_LIMIT} for deskOwner and for borrower; Payment ${usd(ISSUED_TO_DESK)} USD to deskOwner`,
    `VaultCreate USD of usdIssuer, owner deskOwner, VaultKind 1, SubscriptionDate close_time + ${SUBSCRIPTION_SECONDS}, RedemptionDate ${DESK_REDEMPTION}`,
    `LoanBrokerSet DebtMaximum ${usd(DEPOSIT)}, CoverRateMinimum and CoverRateLiquidation ${RATE}; VaultDeposit ${usd(DEPOSIT)} USD; LoanBrokerCoverDeposit ${usd(COVER)} USD`,
    'wait for the Investment phase; re-read every object at one ledger; simulate a USD LoanSet',
    `write ${OUT.desk}; then src/demo/fx-relay.mjs --init and src/demo/anchor-usd-terms.mjs for the terms`,
  ]
  console.log(`\n  plan\n${plan.map((p, i) => `    ${i + 1}. ${p}`).join('\n')}`)
  if (opts.dryRun) {
    console.log(`\n  dry run: ${deskFree.lt(DESK_XRP_FREE) ? `deskOwner would first be topped up at the faucet (needs ${DESK_XRP_FREE} XRP free)` : 'deskOwner has the XRP it needs'}; nothing sent, nothing written`)
    return 0
  }

  // --- 1. the issuer ----------------------------------------------------------------------------------------
  mkdirSync('.demo', { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const f of [ISSUER_FILE, RECEIPT]) {
    if (existsSync(f)) {
      renameSync(f, `${f}.${stamp}.bak`)
      console.log(`  kept the previous run's ${f} as ${f}.${stamp}.bak`)
    }
  }
  started = true
  receipt.bakedAt = new Date().toISOString()
  console.log('\n  1. the issuer')
  const issuer = Wallet.generate()
  // The seed first, before any funding: a bake that dies later must not lose the account it paid for.
  writeFileSync(ISSUER_FILE, JSON.stringify({ usdIssuer: { address: issuer.address, seed: issuer.seed } }, null, 2) + '\n')
  receipt.usdIssuer = issuer.address
  await fundTo(issuer, 20, 'usdIssuer')
  if (deskFree.lt(DESK_XRP_FREE)) await fundTo(w.deskOwner, deskAccount.balance.plus(new Decimal(DESK_XRP_FREE).minus(deskFree)).ceil().toFixed(0), 'deskOwner')
  const clawback = await submit({ TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_ALLOW_TRUSTLINE_CLAWBACK }, issuer, 'AccountSet asfAllowTrustLineClawback, before any trust line')
  const ripple = await submit({ TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }, issuer, 'AccountSet asfDefaultRipple')
  saveReceipt()

  // --- 2. trust lines and the desk's dollars ------------------------------------------------------------------
  console.log('\n  2. trust lines')
  const lineDesk = await submit({ TransactionType: 'TrustSet', Account: w.deskOwner.address, LimitAmount: usdAmount(TRUST_LIMIT, issuer.address) }, w.deskOwner, 'TrustSet USD of deskOwner')
  const lineBorrower = await submit({ TransactionType: 'TrustSet', Account: w.borrower.address, LimitAmount: usdAmount(TRUST_LIMIT, issuer.address) }, w.borrower, 'TrustSet USD of borrower')
  const issue = await submit({ TransactionType: 'Payment', Account: issuer.address, Destination: w.deskOwner.address, Amount: usdAmount(usd(ISSUED_TO_DESK), issuer.address) }, issuer, `Payment ${usd(ISSUED_TO_DESK)} USD to deskOwner`)
  saveReceipt()

  // --- 3. the USD vault, its broker, the deposit and the cover -----------------------------------------------
  console.log('\n  3. the USD vault')
  const t0 = await x.closeTime()
  const SUB = t0 + SUBSCRIPTION_SECONDS
  const asset = { currency: 'USD', issuer: issuer.address }
  const vc = await submit({
    TransactionType: 'VaultCreate', Account: w.deskOwner.address, Asset: asset,
    VaultKind: 1, SubscriptionDate: SUB, RedemptionDate: DESK_REDEMPTION, WithdrawalPolicy: 1,
  }, w.deskOwner, 'VaultCreate USD, owner deskOwner')
  const vaultId = created(vc.result.meta, 'Vault')?.LedgerIndex
  if (!vaultId) throw new BakeError('VaultCreate created no Vault')
  const lb = await submit({
    TransactionType: 'LoanBrokerSet', Account: w.deskOwner.address, VaultID: vaultId,
    ManagementFeeRate: 1000, DebtMaximum: usd(DEPOSIT), CoverRateMinimum: RATE, CoverRateLiquidation: RATE,
  }, w.deskOwner, 'LoanBrokerSet on the USD vault')
  const loanBrokerId = created(lb.result.meta, 'LoanBroker')?.LedgerIndex
  if (!loanBrokerId) throw new BakeError('LoanBrokerSet created no LoanBroker')
  const dep = await submit({ TransactionType: 'VaultDeposit', Account: w.deskOwner.address, VaultID: vaultId, Amount: usdAmount(usd(DEPOSIT), issuer.address) }, w.deskOwner, `VaultDeposit ${usd(DEPOSIT)} USD by deskOwner`)
  const cov = await submit({ TransactionType: 'LoanBrokerCoverDeposit', Account: w.deskOwner.address, LoanBrokerID: loanBrokerId, Amount: usdAmount(usd(COVER), issuer.address) }, w.deskOwner, `LoanBrokerCoverDeposit ${usd(COVER)} USD`)
  saveReceipt()
  await waitTo(SUB + 5, 'the subscription closes, Investment opens')

  // --- 4. everything read again at one ledger -------------------------------------------------------------------
  console.log('\n  4. re-read at one ledger')
  const L = await fresh()
  const vault = (await x.req({ command: 'vault_info', vault_id: vaultId, ledger_index: L })).result.vault
  const shareMptId = String(vault.ShareMPTID ?? vault.shares?.mpt_issuance_id ?? '').toUpperCase()
  const broker = (await x.req({ command: 'ledger_entry', index: loanBrokerId, ledger_index: L })).result.node
  const issuerRoot = (await x.req({ command: 'account_info', account: issuer.address, ledger_index: L })).result.account_data
  const lineOf = async (account) => (await x.req({ command: 'account_lines', account, peer: issuer.address, ledger_index: L })).result.lines.find((l) => l.currency === 'USD') ?? null
  const deskLine = await lineOf(w.deskOwner.address)
  const borrowerLine = await lineOf(w.borrower.address)
  const problems = []
  if (vault.Asset?.currency !== 'USD' || vault.Asset?.issuer !== issuer.address) problems.push(`the vault's asset is ${JSON.stringify(vault.Asset)}, not USD of ${issuer.address}`)
  if (vault.Owner !== w.deskOwner.address) problems.push(`the vault's owner is ${vault.Owner}`)
  if (vault.VaultKind !== 1) problems.push('the vault is not closed-ended')
  if (vault.RedemptionDate !== DESK_REDEMPTION) problems.push(`the vault's RedemptionDate is ${vault.RedemptionDate}`)
  if (!num(vault.AssetsTotal).eq(DEPOSIT)) problems.push(`the vault holds ${vault.AssetsTotal} USD, not ${usd(DEPOSIT)}`)
  if (!/^[0-9A-F]{48}$/.test(shareMptId)) problems.push('the vault names no share')
  if (broker.VaultID !== vaultId || !num(broker.CoverAvailable).eq(COVER)) problems.push(`the broker's cover is ${broker.CoverAvailable}, not ${usd(COVER)}`)
  if (!flagOn(issuerRoot.Flags, LSF_ALLOW_TRUSTLINE_CLAWBACK)) problems.push('the issuer does not carry lsfAllowTrustLineClawback')
  if (!flagOn(issuerRoot.Flags, LSF_DEFAULT_RIPPLE)) problems.push('the issuer does not carry lsfDefaultRipple')
  if (!borrowerLine) problems.push("the borrower's USD trust line is not on the ledger")
  if (!deskLine) problems.push("the desk owner's USD trust line is not on the ledger")
  if (problems.length) throw new BakeError(`at ledger ${L}: ${problems.join('; ')}`)
  const ledgerHash = (await x.req({ command: 'ledger', ledger_index: L })).result.ledger_hash
  receipt.reads = { ledgerIndex: L, ledgerHash, vault, broker, issuerFlags: issuerRoot.Flags, deskLine, borrowerLine }
  console.log(`    ok    at ledger ${L}: vault ${vaultId.slice(0, 12)}… holds ${vault.AssetsTotal} USD, share ${shareMptId}, cover ${broker.CoverAvailable} USD; the issuer carries clawback and default ripple; both trust lines exist`)

  // A USD LoanSet as the desk's would be, simulated: what the ledger says of it today, kept as a fact.
  try {
    const loanTx = await c.autofill({
      TransactionType: 'LoanSet', Account: w.borrower.address, LoanBrokerID: loanBrokerId, Counterparty: w.deskOwner.address,
      PrincipalRequested: principal, PaymentInterval: DESK_LOAN.paymentInterval, GracePeriod: DESK_LOAN.gracePeriod, PaymentTotal: 1,
    })
    delete loanTx.TxnSignature
    const s = await x.req({ command: 'simulate', tx_json: loanTx })
    receipt.loanSetSimulated = { engineResult: s.result.engine_result ?? s.result.meta?.TransactionResult ?? null, ledgerIndex: s.result.ledger_index ?? null }
  } catch (e) {
    receipt.loanSetSimulated = { error: String(e?.data?.error_message ?? e?.data?.error ?? e?.message ?? e).slice(0, 160) }
  }
  console.log(`    info  a USD LoanSet of ${principal}, simulated: ${JSON.stringify(receipt.loanSetSimulated)}`)
  saveReceipt()

  const tx = (r) => ({ txHash: r.result.hash, ledgerIndex: r.result.ledger_index })
  const record = {
    label: 'desk-usd',
    note: "The desk's dollar lending pool (step 21, addendum A11). Its id is usdVaultId, not vaultId: it is read by the desk's code, not served by the information layer.",
    asset: { currency: 'USD', issuer: issuer.address, label: USD_LABEL },
    usdIssuer: issuer.address,
    owner: w.deskOwner.address,
    usdVaultId: vaultId,
    shareMptId,
    loanBrokerId,
    subscriptionDate: SUB,
    redemptionDate: DESK_REDEMPTION,
    plannedLoan: {
      units: desk.plannedLoan.units, principalUsd: principal,
      paymentInterval: DESK_LOAN.paymentInterval, gracePeriod: DESK_LOAN.gracePeriod,
      rule: 'principalUsd = plannedLoan.principalDrops of demo/desk.json / 10^6 × 1.29 (XRP/USD on 24 Oct 20:19 UTC) × (1 − fxHaircutBps / 10000), toFixed(6) ROUND_DOWN: the XRP plan in dollars, at its LTV while XRP trades near 1.29',
    },
    amounts: { issuedToDesk: usd(ISSUED_TO_DESK), deposit: usd(DEPOSIT), cover: usd(COVER), debtMaximum: usd(DEPOSIT), trustLimit: TRUST_LIMIT },
    txs: {
      clawback: tx(clawback), defaultRipple: tx(ripple), trustDesk: tx(lineDesk), trustBorrower: tx(lineBorrower), issue: tx(issue),
      vaultCreate: tx(vc), loanBrokerSet: tx(lb), deposit: tx(dep), cover: tx(cov),
    },
    readAt: { ledgerIndex: L, ledgerHash },
    loanSetSimulated: receipt.loanSetSimulated,
    bakedAt: receipt.bakedAt,
  }
  writeFileSync(OUT.desk, JSON.stringify(record, null, 2) + '\n')
  saveReceipt()
  console.log(`    ok    wrote ${OUT.desk}\n\n  baked: USD vault ${vaultId}, broker ${loanBrokerId}, issuer ${issuer.address}`)
  return 0
}

// --- submission, as bake-nyc does it ------------------------------------------------------------------------

async function submit(tx, wallet, what, expect = 'tesSUCCESS') {
  return send(async () => wallet.sign(await c.autofill({ ...tx })).tx_blob, what, expect)
}

async function send(build, what, expect = 'tesSUCCESS') {
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    let blob
    try {
      blob = await build()
    } catch (e) {
      lastError = e
      await pause(e, `${what}: signing`, attempt)
      continue
    }
    const hash = hashes.hashSignedTx(blob)
    const last = decode(blob).LastLedgerSequence
    try {
      const r = await c.request({ command: 'submit', tx_blob: blob })
      if (/^tem/.test(r.result.engine_result)) throw new BakeError(`${what}: ${r.result.engine_result} (${r.result.engine_result_message})`)
    } catch (e) {
      if (e instanceof BakeError) throw e
      lastError = e // it may have gone out before the socket dropped: its hash tells
    }
    const validated = await outcome(hash, last)
    if (validated) return settle({ result: validated }, what, expect)
    console.log(`    retry  ${what}: not validated by ledger ${last}, signing again`)
  }
  throw new BakeError(`${what}: not validated after 5 attempts (${String(lastError?.message ?? lastError).slice(0, 100)})`)
}

/** The validated transaction with this hash, or null once the ledger is past its LastLedgerSequence. */
async function outcome(hash, last) {
  for (let i = 0; ; i++) {
    try {
      const r = await c.request({ command: 'tx', transaction: hash })
      if (r.result.validated) return r.result
    } catch (e) {
      if (e?.data?.error !== 'txnNotFound') await pause(e, 'tx lookup', Math.min(i, 3))
    }
    await x.closeTime()
    if (x.lastLedger > last) {
      try {
        const r = await c.request({ command: 'tx', transaction: hash })
        if (r.result.validated) return r.result
      } catch { /* not found: it never applied */ }
      return null
    }
    await sleep(1500)
  }
}

/** A dropped socket or a transient error: wait, then reconnect if the socket is gone. */
async function pause(e, what, i = 0) {
  const ms = Math.min(8000, 1000 * 2 ** i)
  console.log(`    wait   ${what}: ${String(e?.data?.error ?? e?.message ?? e).slice(0, 70)}; again in ${ms / 1000}s`)
  await sleep(ms)
  try {
    if (!c.isConnected()) await c.connect()
  } catch { /* the next request tries again */ }
}

function settle(r, what, expect = 'tesSUCCESS') {
  const code = r.result.meta?.TransactionResult
  const want = Array.isArray(expect) ? expect : [expect]
  const ok = want.includes(code)
  receipt.steps.push({ what, result: code, txHash: r.result.hash, ledgerIndex: r.result.ledger_index })
  lastSubmitted = Math.max(lastSubmitted, r.result.ledger_index ?? 0)
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${what.padEnd(58)} ${String(code).padEnd(17)} ${String(r.result.hash).slice(0, 16)}…`)
  if (!ok) throw new BakeError(`${what}: ${code}, expected ${want.join(' or ')}`)
  return r
}

/** Faucet until the account holds at least `xrp`, read at the validated ledger. */
async function fundTo(wallet, xrp, role) {
  for (let i = 0; i < 8; i++) {
    const L = await fresh()
    let balance = new Decimal(0)
    try {
      balance = num((await x.req({ command: 'account_info', account: wallet.address, ledger_index: L })).result.account_data.Balance)
    } catch (e) {
      if (e?.data?.error !== 'actNotFound') throw e
    }
    if (balance.gte(new Decimal(xrp).times(1e6))) return
    try {
      await c.fundWallet(wallet)
      console.log(`    faucet  ${role.padEnd(12)} ${wallet.address}`)
    } catch (e) {
      await pause(e, `faucet for ${role}`, Math.min(i, 3))
    }
  }
  throw new BakeError(`the faucet did not bring ${role} to ${xrp} XRP after 8 requests`)
}

async function waitTo(t, why) {
  const now = await x.closeTime()
  if (t > now) console.log(`  waiting ${t - now}s — ${why}`)
  const deadline = Date.now() + (Math.max(0, t - now) + 600) * 1000
  while ((await x.closeTime()) < t) {
    if (Date.now() > deadline) throw new BakeError(`gave up waiting for close_time ${t} (${why}): the ledger is at ${x.lastCloseTime}`)
    await sleep(3000)
  }
}

async function atLedger(n) {
  const deadline = Date.now() + 120000
  while ((await x.closeTime(), x.lastLedger) < n) {
    if (Date.now() > deadline) throw new BakeError(`the node never validated ledger ${n}`)
    await sleep(1000)
  }
  return n
}

/** The validated ledger, never below the last transaction this run saw validated. */
async function fresh() {
  await atLedger(lastSubmitted)
  return x.lastLedger
}

function saveReceipt() {
  if (!started) return
  try {
    mkdirSync('.demo', { recursive: true })
    writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n')
  } catch (e) {
    console.error(`  could not write ${RECEIPT}: ${String(e).slice(0, 120)}`)
  }
}

