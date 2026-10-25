/**
 * The desk's decision log: one JSON line per decision, append-only, each chained to the one before by
 * its hash, so that an altered entry breaks the chain from that entry on. It continues the same file
 * from one process to the next (a restart neither empties nor rotates it): `append` reads the file for
 * `seq` and `prevHash`, and `verifyChain` reads the whole file on every call. The file is the export.
 *
 * Entry: { seq, prevHash, ticketId, mandateHash, decision, code?, txHash?, ledgerIndex, ledgerHash, hash },
 * ledgerIndex and ledgerHash being the validated ledger the decision read (I2), and
 * hash = sha256Hex(canonical(entry without hash)).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonical, sha256Hex } from '../nyc/contracts.mjs'
import { logger } from '../log.mjs'

const log = logger('desk:decision-log')
const GENESIS = '0'.repeat(64)

/**
 * @param {string} [path]
 * @returns {{ append(entry: object): object, appendMarginCall(entry: object): object, entries(): object[], verifyChain(): { ok: true } | { ok: false, firstBadSeq: number } }}
 */
export function openLog(path = process.env.DESK_LOG_PATH ?? '.demo/decisions.jsonl') {
  mkdirSync(dirname(path), { recursive: true })

  /** Every line of the file, parsed; a line that is not JSON reads as null and breaks the chain there. */
  function lines() {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  }

  /**
   * A last line without its newline is an append cut short (a crash, a full disk): it was never acknowledged,
   * so it is cut off before the next append, which would otherwise fuse with it and break the chain for good.
   */
  function cutTornTail() {
    if (!existsSync(path)) return
    const buf = readFileSync(path)
    if (!buf.length || buf[buf.length - 1] === 0x0a) return
    const keep = buf.lastIndexOf(0x0a) + 1
    log.warn('torn last line of the decision log cut before the append', { path, bytesCut: buf.length - keep })
    truncateSync(path, keep)
  }

  function verifyChain() {
    let prev = GENESIS
    const all = lines()
    for (let i = 0; i < all.length; i++) {
      const e = all[i]
      if (!e || e.seq !== i + 1 || e.prevHash !== prev) return { ok: false, firstBadSeq: i + 1 }
      const { hash, ...rest } = e
      if (hash !== sha256Hex(canonical(rest))) return { ok: false, firstBadSeq: i + 1 }
      prev = hash
    }
    return { ok: true }
  }

  /**
   * Append one decision, chained to the last line of the file.
   * @param {{ ticketId: string, mandateHash: string, decision: 'approved'|'refused'|'declined', code?: string, txHash?: string|null, ledgerIndex: number, ledgerHash: string }} entry
   */
  function append({ ticketId, mandateHash, decision, code, txHash, ledgerIndex, ledgerHash }) {
    cutTornTail()
    const all = lines()
    const last = all.at(-1)
    const body = {
      seq: all.length + 1,
      prevHash: last?.hash ?? GENESIS,
      ticketId, mandateHash, decision,
      ...(code && { code }),
      ...(txHash && { txHash }),
      ledgerIndex, ledgerHash,
    }
    const entry = { ...body, hash: sha256Hex(canonical(body)) }
    appendFileSync(path, JSON.stringify(entry) + '\n')
    return entry
  }

  /**
   * Append one margin-call transition (step 20, addendum A11): the second kind of entry of the same log,
   * chained by the same rule, the desk's decision and the ledger it was read at. The shortfall the call
   * demands goes with an ISSUED or EXPIRED entry, so that a restart that cannot judge again at once (no
   * usable price, an inconsistent snapshot) still serves the call whole.
   * @param {{ status: 'ISSUED'|'CURED'|'EXPIRED', loanId: string, mandateHash: string, policyHash: string, issuedLedger: number, issuedAt: string, cureBy: string, ltvHeldBps: number|null, maxLtvBps: number, ledgerIndex: number, ledgerHash: string, shortfall?: object|null }} entry
   */
  function appendMarginCall({ status, loanId, mandateHash, policyHash, issuedLedger, issuedAt, cureBy, ltvHeldBps, maxLtvBps, ledgerIndex, ledgerHash, shortfall = null }) {
    cutTornTail()
    const all = lines()
    const last = all.at(-1)
    const body = {
      seq: all.length + 1,
      prevHash: last?.hash ?? GENESIS,
      kind: 'margin-call', status, loanId, mandateHash, policyHash, issuedLedger, issuedAt, cureBy, ltvHeldBps, maxLtvBps,
      ledgerIndex, ledgerHash, ...(shortfall && { shortfall }),
    }
    const entry = { ...body, hash: sha256Hex(canonical(body)) }
    appendFileSync(path, JSON.stringify(entry) + '\n')
    return entry
  }

  return { append, appendMarginCall, entries: () => lines(), verifyChain }
}
