/**
 * The recovery code: 160 bits a human has to write down and type back.
 *
 * This is the only secret in CryptMail that lives on paper, which drives every
 * decision here. The alphabet is **Crockford base32** — the digits plus the
 * uppercase letters minus `I`, `L`, `O` and `U`. The first three are dropped
 * because they are indistinguishable from `1` and `0` in most handwriting and
 * many fonts; `U` is dropped so a random code cannot spell something the user
 * would rather not read out over the phone.
 *
 * Confusables are *accepted* on input rather than rejected: someone who writes
 * `O` and types `0` has not made a mistake worth punishing with "wrong recovery
 * code", which is an alarming message when the key really is correct.
 *
 * 20 bytes encodes to exactly 32 characters with no padding, shown as eight
 * groups of four. The code is generated, never chosen, so there is no
 * weak-passphrase failure mode — which is why `key-management.md` option B
 * (user-chosen passphrase) is deliberately not implemented.
 */
import * as Crypto from 'expo-crypto';

/** Crockford base32. Deliberately not RFC 4648 — see the note above. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ENTROPY_BYTES = 20;
/** 20 bytes × 8 bits ÷ 5 bits per character. Exact, so nothing is padded. */
export const CODE_LENGTH = (ENTROPY_BYTES * 8) / 5;
const GROUP_SIZE = 4;

/** A fresh code, already grouped for display. */
export function generateRecoveryCode(): string {
  return formatRecoveryCode(encodeBase32(Crypto.getRandomBytes(ENTROPY_BYTES)));
}

/** `K7M2NQ8Z…` → `K7M2-NQ8Z-…`. Idempotent: re-formatting a grouped code is safe. */
export function formatRecoveryCode(code: string): string {
  const bare = normaliseRecoveryCode(code);
  return (bare.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g')) ?? []).join('-');
}

/**
 * Strip everything a human might add and fold the confusable characters in.
 *
 * Tolerates any spacing, casing and separator, so a code read back off paper
 * with the wrong grouping still works.
 */
export function normaliseRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(new RegExp(`[^${ALPHABET}]`, 'g'), '');
}

/** Whether `input` could be a recovery code at all. Does not prove it is *the* code. */
export function isValidRecoveryCode(input: string): boolean {
  return normaliseRecoveryCode(input).length === CODE_LENGTH;
}

function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >> bits) & 31];
    }
  }
  // 20 bytes divides evenly into 5-bit groups, so no remainder can be left. A
  // different ENTROPY_BYTES would need padding handled here.
  return out;
}
