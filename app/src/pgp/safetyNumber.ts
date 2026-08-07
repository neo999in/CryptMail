/**
 * Safety numbers: the out-of-band comparison that turns "seen" into "verified".
 *
 * `docs/key-management.md` defines **verified** as "the user compared the key
 * fingerprint out-of-band". The app previously had a one-tap "mark verified"
 * button with nothing to compare — which recorded the *claim* of verification
 * without the act, and a trust mark that can be granted without evidence is
 * worse than none: it makes an unverified key look checked.
 *
 * ## Why a safety number rather than two fingerprints
 *
 * Comparing raw fingerprints means each side reads out a different string and
 * has to know which is whose. A safety number is derived from **both** keys in
 * a fixed order, so both people see the *same* digits and either side can read
 * while the other checks. This is the Signal model, and it is easier to do
 * correctly over a phone call.
 *
 * Order-independence is the point: `safetyNumber(a, b)` and `safetyNumber(b,
 * a)` must agree, or the two people compare different numbers and conclude they
 * are under attack. Hence the sort.
 *
 * The derivation is a plain SHA-256 over both fingerprints. It is not a
 * password hash and does not need to be slow — fingerprints are already
 * high-entropy public data, and the only thing being resisted is accidental
 * collision, not guessing.
 *
 * SHA-256 comes from `@noble/hashes` rather than `expo-crypto` deliberately.
 * `expo-crypto`'s digest is native, and jest-expo stubs it to return an empty
 * string — under which every safety number compares equal to every other, so
 * the tests would pass while certifying nothing. A pure-JS hash runs the same
 * code in tests, on device and on web, and is the one place that matters.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { utf8ToBytes } from '../lib/base64';

const DOMAIN = 'cryptmail-safety-number-v1';

/** Digits per group, and groups shown. 30 digits ≈ 99.6 bits. */
const GROUP_SIZE = 5;
const GROUPS = 6;

/**
 * Shortest input accepted as a fingerprint, in hex characters.
 *
 * Real ones are 40 (v4) or 64 (v6). Without a floor, `normaliseFingerprint`
 * strips a garbage string like `"not-hex"` down to its one hex character and
 * derives a perfectly plausible-looking safety number from it — a check that
 * displays six confident groups of digits while attesting to nothing. 32 is
 * below every real fingerprint length and far above any accident.
 */
const MIN_FINGERPRINT_HEX = 32;

/** Uppercase hex, no spaces or `0x` — the form `gpg --fingerprint` compares. */
export function normaliseFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/**
 * Group a fingerprint for reading aloud: four hex characters at a time.
 *
 * Unrelated to the safety number — this is for displaying a single key, e.g.
 * when showing the user their own.
 */
export function formatFingerprint(fingerprint: string): string {
  return (normaliseFingerprint(fingerprint).match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * The number both parties compare. Identical whichever side computes it.
 *
 * Throws on anything that is not a plausible fingerprint rather than returning
 * digits: a safety number derived from junk still looks like a safety number,
 * and the user would compare it, match it, and verify a key nobody checked.
 */
export async function safetyNumber(ours: string, theirs: string): Promise<string> {
  const a = normaliseFingerprint(ours);
  const b = normaliseFingerprint(theirs);
  if (a.length < MIN_FINGERPRINT_HEX || b.length < MIN_FINGERPRINT_HEX) {
    throw new Error('A safety number needs two complete fingerprints.');
  }

  // Sorted so both devices derive the same value regardless of who is "ours".
  const [first, second] = [a, b].sort();
  const digest = toHex(sha256(utf8ToBytes(`${DOMAIN}:${first}:${second}`)));
  return groupDigits(digitsFrom(digest, GROUP_SIZE * GROUPS));
}

/**
 * Turn hex into decimal digits, five hex characters at a time.
 *
 * Taking hex nibbles modulo 10 would bias toward 0–5; reading a wider chunk and
 * reducing it makes the bias negligible (0xFFFFF is 1,048,575, so each decimal
 * digit is within ~0.001% of uniform).
 */
function digitsFrom(hex: string, count: number): string {
  let out = '';
  for (let i = 0; out.length < count; i += 5) {
    const chunk = hex.slice(i, i + 5);
    if (chunk.length < 5) break;
    out += String(parseInt(chunk, 16) % 100000).padStart(5, '0');
  }
  return out.slice(0, count);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function groupDigits(digits: string): string {
  return (digits.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g')) ?? []).join(' ');
}

/**
 * Whether what the user typed or scanned matches the expected safety number.
 *
 * Whitespace-insensitive, because a user reading digits back will not reproduce
 * the grouping, and rejecting a correct number over a space would train people
 * to ignore the check.
 */
export function safetyNumberMatches(expected: string, entered: string): boolean {
  const strip = (s: string) => s.replace(/\s+/g, '');
  return strip(expected).length > 0 && strip(expected) === strip(entered);
}
