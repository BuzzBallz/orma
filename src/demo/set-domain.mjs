/**
 * Makes the Oracle publisher identifiable: a fresh Devnet account, a Domain on it, and the
 * xrp-ledger.toml on that domain that lists it.
 *
 *   --new-publisher  fund a new account, write its seed to .demo/publisher.json (gitignored) and
 *                    print only the address. The operator copies the seed into PUBLISH_SEED.
 *   (no flag)        AccountSet: Domain = hex("ormaprotocol.com") on the account of PUBLISH_SEED
 *   --check          exit 0 if that account's Domain is ormaprotocol.com and the account is listed
 *                    in app/public/.well-known/xrp-ledger.toml; 3 if not; 2 if PUBLISH_SEED is missing
 *
 * The account is always new: rippled 3.4.1 refuses an OracleSet that changes the Provider of an
 * existing Oracle (OracleSet.cpp:135, temMALFORMED), so the previous publisher cannot become "Orma".
 *
 * Run: node --env-file-if-exists=.env src/demo/set-domain.mjs [--new-publisher | --check]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Client, Wallet } from 'xrpl'

const WS = process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233'
const DOMAIN = 'ormaprotocol.com'
const TOML = 'app/public/.well-known/xrp-ledger.toml'
const flag = process.argv[2]

if (flag !== undefined && flag !== '--new-publisher' && flag !== '--check') {
  console.error('usage: set-domain.mjs [--new-publisher | --check]')
  process.exitCode = 64
} else if (flag !== '--new-publisher' && !process.env.PUBLISH_SEED) {
  console.error('PUBLISH_SEED is not set')
  process.exitCode = 2
} else {
  const c = new Client(WS, { connectionTimeout: 20000 })
  await c.connect()
  try {
    if (flag === '--new-publisher') {
      const { wallet } = await c.fundWallet()
      mkdirSync('.demo', { recursive: true })
      writeFileSync('.demo/publisher.json', JSON.stringify({ address: wallet.address, seed: wallet.seed }, null, 2))
      console.log(wallet.address)
    } else if (flag === '--check') {
      const wallet = Wallet.fromSeed(process.env.PUBLISH_SEED)
      const L = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
      const root = (await c.request({ command: 'account_info', account: wallet.address, ledger_index: L })).result.account_data
      const domain = root.Domain ? Buffer.from(root.Domain, 'hex').toString('utf8') : null
      const listed = new RegExp(`address\\s*=\\s*"${wallet.address}"`).test(readFileSync(TOML, 'utf8'))
      console.log(`${wallet.address} at ledger ${L}: Domain ${domain ?? 'absent'}, ${listed ? 'listed' : 'not listed'} in the toml`)
      process.exitCode = domain === DOMAIN && listed ? 0 : 3
    } else {
      const wallet = Wallet.fromSeed(process.env.PUBLISH_SEED)
      const tx = { TransactionType: 'AccountSet', Account: wallet.address, Domain: Buffer.from(DOMAIN, 'utf8').toString('hex').toUpperCase() }
      const r = await c.submitAndWait(tx, { wallet, autofill: true })
      const result = r.result.meta.TransactionResult
      console.log(`${wallet.address} Domain ${DOMAIN}: ${result} ${r.result.hash}`)
      process.exitCode = result === 'tesSUCCESS' ? 0 : 1
    }
  } finally {
    await c.disconnect()
  }
}
