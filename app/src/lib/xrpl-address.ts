/**
 * Classic-address validation, done properly and without a library.
 *
 * The read-only path lets a judge paste an address when no extension is installed. An
 * address is the one thing on this screen a human types, so it gets checked the way the
 * ledger checks it — base58 over the XRPL alphabet, 25 bytes, version 0x00, and the real
 * double-SHA-256 checksum. A typo must be refused, not displayed as an account.
 */
const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'

function decodeBase58(s: string): Uint8Array | null {
  const out = [0]
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return null
    let carry = v
    for (let i = 0; i < out.length; i++) {
      carry += out[i] * 58
      out[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) { out.push(carry & 0xff); carry >>= 8 }
  }
  // every leading 'r' is a leading zero byte, exactly as in bitcoin's base58
  for (const ch of s) { if (ch !== ALPHABET[0]) break; out.push(0) }
  return new Uint8Array(out.reverse())
}

export type AddressCheck =
  | { ok: true; address: string }
  | { ok: false; reason: string }

export async function validateClassicAddress(raw: string): Promise<AddressCheck> {
  const address = raw.trim()
  if (!address) return { ok: false, reason: 'paste an address first' }
  if (!address.startsWith('r')) return { ok: false, reason: 'a classic address starts with r' }
  if (address.length < 25 || address.length > 35) return { ok: false, reason: 'a classic address is 25 to 35 characters' }

  const bytes = decodeBase58(address)
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x00) {
    return { ok: false, reason: 'not a valid XRPL base58 address' }
  }
  const body = bytes.slice(0, 21)
  const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
  const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1))
  for (let i = 0; i < 4; i++) {
    if (h2[i] !== bytes[21 + i]) return { ok: false, reason: 'checksum does not match — check for a typo' }
  }
  return { ok: true, address }
}

/** rXXXX…YYYY, the way a desk writes an account. */
export function shortAddress(a: string, head = 6, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`
}
