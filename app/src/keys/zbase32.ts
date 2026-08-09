/**
 * The address hash Web Key Directory lookups are keyed by.
 *
 * WKD asks for `…/hu/<z-base-32 of SHA-1 of the lower-cased local part>`. The
 * hash is not there for security — SHA-1's collision weakness is irrelevant to a
 * lookup key — it is there so a domain serving keys does not also receive a
 * plaintext list of the addresses being asked about.
 *
 * z-base-32 is Zooko's human-oriented alphabet: no `0`/`l`/`v`/`2`, and the bit
 * order runs least-significant-first within each byte, which is why this cannot
 * borrow a normal base32 implementation.
 */
import { sha1 } from '@noble/hashes/legacy.js';

import { utf8ToBytes } from '../lib/base64';

const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

export function zBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
  }
  // A trailing partial group is padded with zero bits, never dropped: 160 bits
  // is 32 whole characters, but the function has to stay correct for any input.
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** The 32-character WKD hash of a mailbox local part. */
export function zBase32Sha1(localPart: string): string {
  return zBase32(sha1(utf8ToBytes(localPart.toLowerCase())));
}
