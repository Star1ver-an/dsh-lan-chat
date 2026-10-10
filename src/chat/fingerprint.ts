/**
 * The pairing fingerprint both sides of one pairing derive independently.
 * @module @deepseek-ai/dsh-chat/src/fingerprint
 */

import { createHash } from 'node:crypto'

/**
 * Derive the short verification fingerprint of one peer pair: the first 8 hex
 * characters of the SHA-256 digest over the lexically sorted peer ids joined
 * with a newline. Both sides derive the same value for the same pair and a
 * different value for any other pair, so users can compare it out-of-band
 * ("does your screen also show `1a2b3c4d`?") to confirm they paired with the
 * person they meant to. v1 has no key exchange, so this human check is the
 * only mispairing defense — it is a sanity aid, not an authenticity proof.
 * @param a - one peer id.
 * @param b - the other peer id.
 * @returns the 8-character lowercase hex fingerprint.
 */
export function pairingFingerprint(a: string, b: string): string {
  const pair = [a, b].sort()
  return createHash('sha256').update(pair.join('\n'), 'utf8').digest('hex').slice(0, 8)
}
