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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonical, sha256Hex } from '../nyc/contracts.mjs'

const GENESIS = '0'.repeat(64)

/**
 * @param {string} [path]
 * @returns {{ append(entry: object): object, entries(): object[], verifyChain(): { ok: true } | { ok: false, firstBadSeq: number } }}
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

  return { append, entries: () => lines(), verifyChain }
}
