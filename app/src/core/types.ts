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

import { Attachment } from '../mail/attachment';

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

/**
 * A device transfer: this phone's identity, its per-email-key conversations and
 * its archive of forward-secret mail, sealed for a replacement phone.
 *
 * The same two halves as a recovery backup — a code shown once and a file —
 * and the same rule: the code is never stored. Unlike a backup, making one
 * **hands this phone's conversations over**: from then on it sends with
 * long-term keys, because two phones writing into one conversation would break
 * it for the contact.
 */
export type DeviceTransfer = {
  /** Shown once, as a recovery code is. Never persisted. */
  code: string;
  /** The sealed file. Opaque; useless without the code. */
  blob: string;
};

/** What arrives on the new phone. `archive` is whatever `exportTransfer` was given. */
export type ImportedTransfer = {
  identity: Identity;
  archive: string;
};

export type BuildRequest = {
  from: string;
  to: string[];
  subject: string;
  body: string;
  /**
   * The message as HTML, when it was written with formatting. `body` is then
   * its text alternative; both go inside the ciphertext.
   */
  html?: string;
  /** Armored public keys for every recipient — and for the sender, so Sent is readable. */
  recipientKeys: string[];
  /** Sender's public key, emitted as an Autocrypt header. */
  autocryptKey?: string;
  /** Threading headers, emitted in the clear on the outer envelope (message-format.md). */
  inReplyTo?: string;
  references?: string[];
  /**
   * Files to seal into the inner tree alongside the body.
   *
   * Base64 strings, so nothing but strings crosses the core boundary (rule 3);
   * `mail/attachment.ts` caps their size for the same reason.
   */
  attachments?: Attachment[];
  /**
   * The answer to a handshake. Marks the outer subject so the other side's
   * sync finds it; the caller supplies the fixed text from `core/handshake.ts`.
   */
  handshake?: boolean;
  /**
   * Which security level seals it (`core/qkd.ts`). Defaults to 4, per-email
   * keys. 1 is OpenPGP to long-term keys — only ever the user's explicit
   * choice. 2 and 3 take keys from the Key Manager and need no recipient keys.
   */
  level?: SecurityLevel;
};

/**
 * The security levels the user can choose between, in the problem statement's
 * numbering: 1 no quantum security (OpenPGP), 2 quantum-aided AES, 3 quantum
 * one-time pad, 4 post-quantum per-email keys (the default).
 */
export type SecurityLevel = 1 | 2 | 3 | 4;

/**
 * The simulated QKD Key Manager, as the app may see it — never a key.
 * `account` is the signed-in mailbox: the KM login is the mail login.
 */
export type KmStatus = {
  account: string;
  saeId: string;
  peerSaeId: string | null;
  role: 'Solo' | 'Master' | 'Slave';
  /** Keys this end can still encrypt with. */
  available: number;
  /** Keys still in the bank, either end's, not yet consumed. */
  remaining: number;
  bankSize: number;
  keyBits: number;
};

/** The simulated QKD link: this bank sealed for the other phone, under a code shown once. */
export type KmLink = { code: string; blob: string };

/** A first-contact handshake: one recipient, fixed content, see `core/handshake.ts`. */
export type HandshakeRequest = {
  from: string;
  to: string;
  /** The recipient's armored public key. */
  recipientKey: string;
  autocryptKey?: string;
};

/**
 * Where a recipient stands with per-email keys: our own key, a conversation
 * that exists, an offer we can open one with, or nothing yet — a handshake first.
 */
export type SessionStatus = 'self' | 'session' | 'offer' | 'none';

/** The result of decrypting a PGP/MIME message: protected headers restored. */
export type DecryptedMessage = {
  subject: string;
  body: string;
  /**
   * The sender's `text/html`, when the sealed tree carried one.
   *
   * Attacker-controlled markup that happens to have been encrypted — being
   * inside the ciphertext says who sent it, not that it is safe — so it is
   * carried raw and sanitised at the point of render (`html/sanitize.ts`),
   * exactly like the HTML of an unencrypted message — including CryptMail's
   * own, which a rich-text message carries: the reader cannot tell a message
   * this app wrote from one crafted to look like it.
   */
  html?: string;
  signature: SignatureStatus;
  /** Fingerprint the signature verified against, when known. */
  signerFingerprint?: string;
  /** Public key harvested from the Autocrypt header, if the message carried one. */
  autocryptKey?: string;
  /** Files found in the decrypted tree. Empty for a message that carried none. */
  attachments: Attachment[];
  /**
   * True when the message was sealed with a per-email key that is now
   * destroyed. It opens **once**: the caller must archive what was decrypted
   * (`store/archiveStore.ts`), because no key anywhere can open it again.
   */
  forwardSecret?: boolean;
  /** The level it was sealed at. 2 and 3 open once, like per-email keys. */
  securityLevel?: SecurityLevel;
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

  /**
   * Seal this phone's identity, conversations and `archive` for a new phone,
   * and hand the conversations over. `archive` is opaque to the core.
   */
  exportTransfer(email: string, archive: string): Promise<DeviceTransfer>;

  /**
   * Adopt a transfer, replacing this phone's identity and conversations.
   * `expectedEmail` is the mailbox signed in here; a transfer for any other
   * address is refused (`malformed`) before anything changes. A wrong code is
   * `decrypt-failed`.
   */
  importTransfer(blob: string, code: string, expectedEmail: string): Promise<ImportedTransfer>;

  /** When this phone handed its conversations to another, or null. */
  transferStatus(): Promise<{ handedOverAt: Date | null }>;

  /**
   * Take the conversations back. Only safe if the other phone never sent a
   * message with per-email keys — the caller must say so before calling.
   */
  resumeSessions(): Promise<void>;

  /**
   * M5: sign + encrypt, then assemble the full RFC 5322 / PGP-MIME message.
   *
   * **Per-email keys only.** Refuses (`no-key`) unless every recipient other
   * than the sender has a session or an offer — check `sessionStatus` first and
   * hold the message instead. Never falls back to long-term keys.
   */
  buildEncrypted(request: BuildRequest): Promise<string>;

  /**
   * A contentless first-contact message carrying this device's offer — the one
   * thing still sealed to a long-term key. Its text is fixed
   * (`core/handshake.ts`); nothing the user wrote is an argument.
   */
  buildHandshake(request: HandshakeRequest): Promise<string>;

  /** Per recipient key, in order: see `SessionStatus`. */
  sessionStatus(email: string, recipientKeys: string[]): Promise<SessionStatus[]>;

  /**
   * M5 inverse: detect, decrypt, verify, restore the protected subject.
   * `mailbox` is the signed-in address, whose Key Manager opens Level 2/3 mail.
   */
  parseEncrypted(rfc822: string, mailbox?: string): Promise<DecryptedMessage>;

  /** The Key Manager for the signed-in `mailbox` — the one login. Created on first use. */
  kmStatus(mailbox: string): Promise<KmStatus>;
  /** A fresh bank of 100 × 1 Kb keys. A linked bank must be linked again. */
  kmRegenerate(mailbox: string): Promise<KmStatus>;
  /** Seal this bank for the other phone; this end becomes master. */
  kmExportLink(mailbox: string): Promise<KmLink>;
  /** Adopt the other phone's link. */
  kmImportLink(mailbox: string, blob: string, code: string): Promise<KmStatus>;

  /** Cheap structural check used to decide whether to call `parseEncrypted`. */
  looksEncrypted(rfc822: string): boolean;
}

export class CoreError extends Error {
  constructor(
    message: string,
    readonly code: 'no-key' | 'malformed' | 'decrypt-failed' | 'unavailable',
    /** The core's own wording, for logs. `message` is what a person reads. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}
