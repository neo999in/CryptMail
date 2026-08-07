/**
 * Encryption at rest for everything this app keeps locally.
 *
 * `docs/security.md` says local data is encrypted at rest. It was not: the
 * keyring, drafts, outbox and — worst of all — the search index of *decrypted*
 * subjects and bodies were plain JSON in AsyncStorage, readable by anything
 * with filesystem access to the app's sandbox. That is the one place where the
 * product's central promise leaked, since the search index is by construction a
 * plaintext copy of exactly the mail the user encrypted.
 *
 * ## Shape
 *
 * A single 32-byte data-encryption key (the DEK) lives in `expo-secure-store`,
 * which is Keystore-backed on Android and Keychain-backed on iOS. Values are
 * sealed with XChaCha20-Poly1305 under a fresh random 24-byte nonce per write.
 *
 * XChaCha20-Poly1305 rather than AES-256-GCM because the nonce is random on
 * every write: GCM's 96-bit nonce makes random selection uncomfortable at
 * volume, while XChaCha's 192-bit nonce makes a collision negligible. The
 * implementation is `@noble/ciphers` — audited, dependency-free, and pure
 * TypeScript, so it behaves identically on Android and on web rather than
 * needing a native module the web build cannot load.
 *
 * ## What this does and does not defend against
 *
 * It defends against offline inspection of the app's storage — another app
 * exploiting a path traversal, an ADB backup, someone reading the disk. It does
 * **not** defend against a compromised, running app: the DEK is in memory
 * whenever CryptMail is open. Nor does it protect metadata; see security.md.
 *
 * On web there is no Keychain, so `expo-secure-store` is unavailable and the
 * DEK falls back to AsyncStorage — sitting beside the data it protects, which
 * is not real protection. That is reported by `protectionLevel()` and surfaced
 * to the user rather than hidden, exactly as `demoReason()` does for crypto.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import * as Crypto from 'expo-crypto';

import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../lib/base64';

/** Marks a stored value as sealed. Absent ⇒ a pre-encryption plaintext value. */
const ENVELOPE_PREFIX = 'CMSEAL1.';
const DEK_STORE_KEY = 'cryptmail.dek.v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export type ProtectionLevel =
  /** DEK held by the platform keystore — the intended configuration. */
  | 'keystore'
  /** No keystore on this platform; the DEK sits beside the data it protects. */
  | 'weak'
  /** Not yet determined — `initLocalCrypto` has not run. */
  | 'unknown';

/**
 * The secure-store surface this module needs, narrowed to three methods.
 *
 * Injectable so tests can run without a native keystore, and so the web
 * fallback is an explicit substitution rather than a silent import failure.
 */
export type SecretStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

let dek: Uint8Array | null = null;
let protection: ProtectionLevel = 'unknown';

/** Where the DEK is kept, for the UI to report honestly. */
export function protectionLevel(): ProtectionLevel {
  return protection;
}

/**
 * Load the DEK, creating one on first run. Idempotent.
 *
 * Must complete before any `seal`/`unseal` call; `AppState` awaits it during
 * boot, before it touches a single store.
 */
export async function initLocalCrypto(store: SecretStore, level: ProtectionLevel): Promise<void> {
  if (dek) return;

  const existing = await store.getItem(DEK_STORE_KEY);
  if (existing) {
    const bytes = base64ToBytes(existing);
    // A truncated or corrupt DEK must fail loudly. Silently generating a
    // replacement would decrypt nothing and quietly discard the user's keyring.
    if (bytes.length !== KEY_BYTES) {
      throw new Error('The local encryption key is corrupt; local data cannot be read.');
    }
    dek = bytes;
  } else {
    dek = Crypto.getRandomBytes(KEY_BYTES);
    await store.setItem(DEK_STORE_KEY, bytesToBase64(dek));
  }
  protection = level;
}

/** Test seam: forget the DEK so a fresh `initLocalCrypto` runs. */
export function resetLocalCryptoForTests(): void {
  dek = null;
  protection = 'unknown';
}

function key(): Uint8Array {
  if (!dek) {
    throw new Error('Local storage encryption is not initialised — call initLocalCrypto first.');
  }
  return dek;
}

/** `plaintext` → `CMSEAL1.<nonce>.<ciphertext>`, both base64. */
export function seal(plaintext: string): string {
  const nonce = Crypto.getRandomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(key(), nonce).encrypt(utf8ToBytes(plaintext));
  return `${ENVELOPE_PREFIX}${bytesToBase64(nonce)}.${bytesToBase64(sealed)}`;
}

export function isSealed(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Inverse of `seal`. A value written before this module existed is returned
 * unchanged, so an existing install keeps its keyring and drafts; the caller
 * re-seals it on the next write.
 *
 * Throws if a *sealed* value fails to authenticate — that means the DEK is
 * wrong or the data was tampered with, and returning anything at all would turn
 * a detected attack into a silent one.
 */
export function unseal(stored: string): string {
  if (!isSealed(stored)) return stored;

  const [nonceB64, cipherB64] = stored.slice(ENVELOPE_PREFIX.length).split('.');
  if (!nonceB64 || !cipherB64) {
    throw new Error('Stored value is not a well-formed sealed envelope.');
  }
  const opened = xchacha20poly1305(key(), base64ToBytes(nonceB64)).decrypt(base64ToBytes(cipherB64));
  return bytesToUtf8(opened);
}
