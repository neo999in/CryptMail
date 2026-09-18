/**
 * App lock: the rules, with no React and no platform in them.
 *
 * What the lock is, said once so nothing above this oversells it: a gate in
 * front of the UI. It does **not** encrypt anything with the PIN — local data
 * is sealed under the keystore's device key whether the lock is on or not
 * (`store/localCrypto.ts`), and the running app still holds that key while the
 * lock screen is up. What it stops is someone holding an unlocked phone from
 * reading mail in CryptMail. `docs/app-lock.md` is the longer version.
 *
 * The PIN itself is never stored. What is kept is a PBKDF2-SHA256 verifier with
 * a random salt, inside the sealed store — so reading it back needs the device
 * key first, and then a guess per PIN at the cost of the KDF. A 4-digit PIN is
 * ten thousand guesses however slow the hash, so the real defence against
 * guessing is the cooldown below, which survives a restart because it is stored.
 */
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64ToBytes, bytesToBase64 } from '../lib/base64';

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

/**
 * PBKDF2 rounds for a new verifier — deliberately few.
 *
 * The check runs in pure JavaScript on Hermes, between the last digit and the
 * lock lifting, and 30 000 rounds held the pad for one to two seconds on every
 * unlock. They bought almost nothing: the verifier is inside the sealed store,
 * so attacking it at all needs the device key first, and then a 4-digit PIN is
 * ten thousand guesses — seconds on a PC at 30 000 rounds or at 1 000. The
 * defence against guessing is the stored cooldown, not the hash.
 *
 * Stored on the verifier, and a verifier made with any other count is re-made
 * on its next successful unlock (`needsRehash`), so changing this migrates.
 */
export const PIN_ITERATIONS = 1_000;
export const PIN_SALT_BYTES = 16;

export type PinVerifier = {
  v: 1;
  /** Base64. */
  salt: string;
  /** Base64 of the 32-byte derived key. */
  hash: string;
  iterations: number;
  /**
   * How many digits the PIN has, so the unlock pad can check as soon as that
   * many are typed instead of asking for an OK tap. It narrows a guess from
   * "4 to 8 digits" to one length — a small leak every phone lock screen makes.
   */
  length: number;
};

export type LockTimeout = 'immediately' | '1m' | '5m' | '15m' | '1h';

export const LOCK_TIMEOUTS: LockTimeout[] = ['immediately', '1m', '5m', '15m', '1h'];

export const LOCK_TIMEOUT_MS: Record<LockTimeout, number> = {
  immediately: 0,
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
};

export const LOCK_TIMEOUT_LABEL: Record<LockTimeout, string> = {
  immediately: 'Immediately',
  '1m': 'After 1 minute',
  '5m': 'After 5 minutes',
  '15m': 'After 15 minutes',
  '1h': 'After 1 hour',
};

export type AppLockPrefs = {
  /** A verifier present *is* the lock being on — there is no separate flag to disagree with it. */
  pin: PinVerifier | null;
  /** Offer the fingerprint (or face) before the PIN. Meaningless without a PIN. */
  biometrics: boolean;
  /** How long CryptMail may sit in the background before it asks again. */
  timeout: LockTimeout;
  /** Wrong PINs in a row. Reset by any successful unlock. */
  failures: number;
  /** Epoch ms before which no PIN is checked at all. 0 when not cooling down. */
  lockedUntil: number;
};

export const DEFAULT_APP_LOCK: AppLockPrefs = {
  pin: null,
  biometrics: false,
  timeout: 'immediately',
  failures: 0,
  lockedUntil: 0,
};

export function isLockEnabled(prefs: AppLockPrefs): boolean {
  return prefs.pin !== null;
}

/** 4 to 8 ASCII digits, and nothing else — not a space, not a full-width digit. */
export function isValidPin(pin: string): boolean {
  return new RegExp(`^[0-9]{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

/** The salt is a parameter so tests are deterministic; callers pass fresh random bytes. */
export async function makePinVerifier(
  pin: string,
  salt: Uint8Array,
  iterations: number = PIN_ITERATIONS,
): Promise<PinVerifier> {
  if (!isValidPin(pin)) throw new Error(`A PIN is ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`);
  const hash = await derive(pin, salt, iterations);
  return { v: 1, salt: bytesToBase64(salt), hash: bytesToBase64(hash), iterations, length: pin.length };
}

/** Made with a round count other than today's, so re-hash it once the PIN is known to be right. */
export function needsRehash(verifier: PinVerifier): boolean {
  return verifier.iterations !== PIN_ITERATIONS;
}

export async function checkPin(pin: string, verifier: PinVerifier): Promise<boolean> {
  // Checked before the KDF, not instead of comparing: a wrong length is a wrong
  // PIN, and there is nothing to learn from timing that `length` doesn't say.
  if (!isValidPin(pin) || pin.length !== verifier.length) return false;
  const hash = await derive(pin, base64ToBytes(verifier.salt), verifier.iterations);
  return constantTimeEqual(hash, base64ToBytes(verifier.hash));
}

function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  return pbkdf2Async(sha256, pin, salt, { c: iterations, dkLen: 32 });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Free guesses before the first cooldown. */
export const FREE_ATTEMPTS = 5;
const FIRST_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

/**
 * How long to refuse PINs after this many wrong ones in a row: nothing for the
 * first five, then 30 s, doubling per further miss, capped at an hour. Ten
 * thousand 4-digit PINs at that rate is not an afternoon's work.
 */
export function cooldownAfter(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  const doublings = Math.min(failures - FREE_ATTEMPTS, 20);
  return Math.min(FIRST_COOLDOWN_MS * 2 ** doublings, MAX_COOLDOWN_MS);
}

export function afterFailure(prefs: AppLockPrefs, now: number): AppLockPrefs {
  const failures = prefs.failures + 1;
  const wait = cooldownAfter(failures);
  return { ...prefs, failures, lockedUntil: wait > 0 ? now + wait : 0 };
}

export function afterSuccess(prefs: AppLockPrefs): AppLockPrefs {
  return { ...prefs, failures: 0, lockedUntil: 0 };
}

/** Milliseconds left before a PIN will be checked again; 0 when it will be now. */
export function cooldownRemaining(prefs: AppLockPrefs, now: number): number {
  return Math.max(0, prefs.lockedUntil - now);
}

/**
 * Whether coming back to the foreground must show the lock.
 *
 * `awayAt` is when the app went to the background, or null when there is
 * nothing to judge — it never left, or it left for something CryptMail itself
 * opened (`lib/lockExemption.ts`) and came back in good time.
 */
export function shouldLockOnReturn(prefs: AppLockPrefs, awayAt: number | null, now: number): boolean {
  if (!isLockEnabled(prefs) || awayAt === null) return false;
  // A clock that went backwards is not a reason to skip the lock.
  const away = now - awayAt;
  return away < 0 || away >= LOCK_TIMEOUT_MS[prefs.timeout];
}

/**
 * Coerce whatever was read off disk into valid prefs.
 *
 * A malformed verifier means the lock is **on with a PIN nobody can enter**
 * only if we keep it, and off if we drop it. Neither is good, but dropping it
 * would let a corrupted store turn the lock off, so a verifier that is present
 * but unreadable is kept — the way out of a lock you cannot open is the same as
 * for a forgotten PIN, and is said on the lock screen.
 */
export function normaliseAppLock(value: Partial<AppLockPrefs> | null | undefined): AppLockPrefs {
  const pin = value?.pin ?? null;
  return {
    pin: pin && typeof pin === 'object' ? pin : null,
    biometrics: value?.biometrics === true && !!pin,
    timeout: value?.timeout && LOCK_TIMEOUTS.includes(value.timeout) ? value.timeout : DEFAULT_APP_LOCK.timeout,
    failures: nonNegative(value?.failures),
    lockedUntil: nonNegative(value?.lockedUntil),
  };
}

const nonNegative = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** "30 seconds", "2 minutes", "1 hour" — for the cooldown line on the pad. */
export function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
