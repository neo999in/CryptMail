/**
 * The crypto core contract.
 *
 * This is the exact surface the Rust `cryptmail-core` library will expose
 * through UniFFI → Kotlin → turbo module (prototype-plan.md, M2/M5). Nothing
 * but strings crosses this boundary, and a private key never appears in any
 * return value.
 *
 * Two implementations exist:
 *   · `nativeCore` — the real one, present once M2 lands.
 *   · `demoCore`   — a *non-cryptographic* stand-in so the UI can be built and
 *                    demoed before the core exists. It refuses to be used for
 *                    real sends; see `CoreKind`.
 */

export type CoreKind = 'native' | 'demo';

export type Trust = 'seen' | 'verified' | 'changed';

/** This device's keypair. The private half never leaves the core. */
export type Identity = {
  email: string;
  fingerprint: string;
  publicKeyArmored: string;
  createdAt: string;
};

/** A contact's public key, as held in the local keyring. */
export type PublicKeyInfo = {
  email: string;
  fingerprint: string;
  armored: string;
  userId?: string;
};

export type SignatureStatus = 'valid' | 'invalid' | 'unknown' | 'none';

/**
 * A backup of this device's identity, wrapped under a generated recovery code.
 *
 * The secret key is protected by a passphrase the Android Keystore holds, and
 * that Keystore key has no backup path — so a wiped device means a permanently
 * lost identity and every message ever sent to it becomes unreadable.
 * `key-management.md` §Recovery option A closes that: the same secret key is
 * re-wrapped under a high-entropy code the user writes down.
 *
 * Both halves are strings and `blob` is ciphertext the core produced and only
 * the core reopens, so the "no private key leaves the core" rule is intact.
 */
export type RecoveryBackup = {
  /** Shown to the user exactly once. Never persisted — persisting it defeats the point. */
  code: string;
  /** The secret key wrapped under the code. Opaque; safe to store anywhere. */
  blob: string;
};

export type BuildRequest = {
  from: string;
  to: string[];
  subject: string;
  body: string;
  /** Armored public keys for every recipient — and for the sender, so Sent is readable. */
  recipientKeys: string[];
  /** Sender's public key, emitted as an Autocrypt header. */
  autocryptKey?: string;
  /** Threading headers, emitted in the clear on the outer envelope (message-format.md). */
  inReplyTo?: string;
  references?: string[];
};

/** The result of decrypting a PGP/MIME message: protected headers restored. */
export type DecryptedMessage = {
  subject: string;
  body: string;
  signature: SignatureStatus;
  /** Fingerprint the signature verified against, when known. */
  signerFingerprint?: string;
  /** Public key harvested from the Autocrypt header, if the message carried one. */
  autocryptKey?: string;
};

export interface CryptCore {
  readonly kind: CoreKind;

  /** M2: generate an identity keypair; private half is stored Keystore-wrapped. */
  generateIdentity(email: string): Promise<Identity>;
  /** Load the identity created on a previous run, or null on a fresh install. */
  loadIdentity(email: string): Promise<Identity | null>;

  /** Parse + validate an armored public key someone pasted in. Throws if malformed. */
  importPublicKey(armored: string): Promise<PublicKeyInfo>;

  /**
   * Wrap this device's secret key under a freshly generated recovery code.
   *
   * The code is returned once for the user to write down and is not stored. The
   * identity is unchanged — recovery restores the same key and fingerprint, so
   * senders never have to do anything.
   */
  exportRecoveryBackup(email: string): Promise<RecoveryBackup>;

  /**
   * Restore an identity from a backup, adopting it as this device's key.
   *
   * Throws `decrypt-failed` if the code is wrong and `malformed` if the blob is
   * not a backup at all — the two are distinguished so the UI can tell the user
   * which of the two things they got wrong.
   */
  importRecoveryBackup(blob: string, code: string): Promise<Identity>;

  /** M5: sign + encrypt, then assemble the full RFC 5322 / PGP-MIME message. */
  buildEncrypted(request: BuildRequest): Promise<string>;

  /** M5 inverse: detect, decrypt, verify, restore the protected subject. */
  parseEncrypted(rfc822: string): Promise<DecryptedMessage>;

  /** Cheap structural check used to decide whether to call `parseEncrypted`. */
  looksEncrypted(rfc822: string): boolean;
}

export class CoreError extends Error {
  constructor(message: string, readonly code: 'no-key' | 'malformed' | 'decrypt-failed' | 'unavailable') {
    super(message);
    this.name = 'CoreError';
  }
}
