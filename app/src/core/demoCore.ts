/**
 * ⚠️  NOT CRYPTOGRAPHY.
 *
 * A stand-in for `cryptmail-core` (Rust/rPGP) so the frontend can be built,
 * demoed and reviewed before M1/M2 land. It produces byte-correct PGP/MIME
 * envelopes (docs/message-format.md) whose "ciphertext" is *encoded*, not
 * encrypted — anyone can read it.
 *
 * `kind === 'demo'` and every real send path checks that, so this can never be
 * used to send something the user believes is encrypted. See config.ts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';

import { decodeUtf8Base64, encodeUtf8Base64, utf8ToBytes } from '../lib/base64';
import { generateRecoveryCode, normaliseRecoveryCode } from './recoveryCode';
import {
  armor,
  autocryptKeydata,
  buildEncryptedEnvelope,
  buildProtectedInner,
  dearmor,
  extractArmor,
  isPgpMime,
  parseProtectedInner,
  parseRfc822,
} from './mime';
import { getAsyncItemMigrating } from '../lib/legacyStorageKey';
import { parseArmoredPublicKey } from '../pgp/parseArmoredKey';
import {
  BuildRequest,
  CryptCore,
  CoreError,
  DecryptedMessage,
  DeviceTransfer,
  HandshakeRequest,
  Identity,
  ImportedTransfer,
  PublicKeyInfo,
  RecoveryBackup,
  SessionStatus,
} from './types';
import { helloContent } from './handshake';

const IDENTITY_KEY = 'cryptmail.demo.identity';
const DEMO_ARMOR_TAG = 'CRYPTMAIL-DEMO-V1:';
/** Demo messages built before the rename; read-only, never emitted. */
const LEGACY_ARMOR_TAG = 'CIPHERMAIL-DEMO-V1:';

const RECOVERY_HEADER = '-----BEGIN CRYPTMAIL RECOVERY BACKUP-----';
const RECOVERY_FOOTER = '-----END CRYPTMAIL RECOVERY BACKUP-----';
const DEMO_RECOVERY_TAG = 'CRYPTMAIL-DEMO-RECOVERY-V1:';

const TRANSFER_HEADER = '-----BEGIN CRYPTMAIL TRANSFER-----';
const TRANSFER_FOOTER = '-----END CRYPTMAIL TRANSFER-----';
const DEMO_TRANSFER_TAG = 'CRYPTMAIL-DEMO-TRANSFER-V1:';

export const demoCore: CryptCore = {
  kind: 'demo',

  async generateIdentity(email: string): Promise<Identity> {
    const fingerprint = randomFingerprint();
    const identity: Identity = {
      email,
      fingerprint,
      publicKeyArmored: fakePublicKey(email, fingerprint),
      createdAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(`${IDENTITY_KEY}.${email}`, JSON.stringify(identity));
    return identity;
  },

  async loadIdentity(email: string): Promise<Identity | null> {
    const stored = await getAsyncItemMigrating(`${IDENTITY_KEY}.${email}`);
    return stored ? (JSON.parse(stored) as Identity) : null;
  },

  async importPublicKey(armored: string): Promise<PublicKeyInfo> {
    const trimmed = armored.trim();
    if (!trimmed.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
      throw new CoreError('That does not look like an armored public key block.', 'malformed');
    }
    // Fast path for CryptMail's own demo keys, which put the address and
    // fingerprint in armor headers. Real OpenPGP keys don't — they keep them in
    // the binary packets, so those fall through to the packet reader below.
    const comment = trimmed.match(/^Comment:\s*(.+)$/m)?.[1] ?? '';
    const headerEmail = comment.match(/[^\s<>]+@[^\s<>]+/)?.[0]?.toLowerCase();
    const headerFingerprint = trimmed.match(/^Fingerprint:\s*([0-9A-F ]+)$/m)?.[1]?.replace(/\s+/g, '');
    if (headerEmail && headerFingerprint) {
      return { email: headerEmail, fingerprint: headerFingerprint, armored: trimmed, userId: comment };
    }
    // A real armored public key (GnuPG, Proton Mail, any OpenPGP tool): read the
    // primary-key fingerprint and User ID out of the packet stream. Throws
    // CoreError('malformed') if it isn't a usable v4 key.
    const parsed = parseArmoredPublicKey(trimmed);
    return { email: parsed.email, fingerprint: parsed.fingerprint, armored: trimmed, userId: parsed.userId };
  },

  /**
   * ⚠️  Encodes; does not wrap. The real core stretches the code with Argon2id
   * and re-wraps the OpenPGP secret key — there is no secret key here to wrap.
   *
   * The verifier below is a plain SHA-256 of the code, **not** a KDF: it exists
   * so the wrong-code path is a real path the UI and its tests exercise, rather
   * than something that only appears once the Rust lands. A demo blob is
   * readable by anyone who has it, exactly like a demo message.
   */
  async exportRecoveryBackup(email: string): Promise<RecoveryBackup> {
    const identity = await demoCore.loadIdentity(email);
    if (!identity) {
      throw new CoreError('This device has no identity key to back up.', 'no-key');
    }

    const code = generateRecoveryCode();
    const payload = `${DEMO_RECOVERY_TAG}${verifierFor(code)}:${encodeUtf8Base64(JSON.stringify(identity))}`;
    return { code, blob: armorRecovery(encodeUtf8Base64(payload)) };
  },

  async importRecoveryBackup(blob: string, code: string): Promise<Identity> {
    const body = dearmorRecovery(blob);
    if (!body) {
      throw new CoreError('That is not a CryptMail recovery backup.', 'malformed');
    }

    let decoded: string;
    try {
      decoded = decodeUtf8Base64(body);
    } catch {
      throw new CoreError('This recovery backup is damaged and cannot be read.', 'malformed');
    }

    if (!decoded.startsWith(DEMO_RECOVERY_TAG)) {
      // A backup the real core produced. Only the real core can unwrap it.
      throw new CoreError(
        'This backup needs the real crypto core to restore (demo mode is running).',
        'decrypt-failed',
      );
    }

    const rest = decoded.slice(DEMO_RECOVERY_TAG.length);
    const sep = rest.indexOf(':');
    if (sep < 0) {
      throw new CoreError('This recovery backup is damaged and cannot be read.', 'malformed');
    }

    if (rest.slice(0, sep) !== verifierFor(code)) {
      throw new CoreError('That recovery code does not match this backup.', 'decrypt-failed');
    }

    let identity: Identity;
    try {
      identity = JSON.parse(decodeUtf8Base64(rest.slice(sep + 1))) as Identity;
    } catch {
      throw new CoreError('This recovery backup is damaged and cannot be read.', 'malformed');
    }

    // Adopt it as this device's identity, which is what restoring means.
    await AsyncStorage.setItem(`${IDENTITY_KEY}.${identity.email}`, JSON.stringify(identity));
    return identity;
  },

  /**
   * ⚠️  Encodes; does not seal. A demo recovery backup plus the archive, in a
   * transfer's armor. The demo core has no per-email keys, so there are no
   * conversations to hand over and its archive is always empty.
   */
  async exportTransfer(email: string, archive: string): Promise<DeviceTransfer> {
    const backup = await demoCore.exportRecoveryBackup(email);
    const payload = encodeUtf8Base64(`${DEMO_TRANSFER_TAG}${JSON.stringify({ email, backup: backup.blob, archive })}`);
    const lines = [TRANSFER_HEADER, '', ...(payload.match(/.{1,64}/g) ?? []), TRANSFER_FOOTER];
    return { code: backup.code, blob: lines.join('\n') };
  },

  async importTransfer(blob: string, code: string, expectedEmail: string): Promise<ImportedTransfer> {
    const start = blob.indexOf(TRANSFER_HEADER);
    const end = blob.indexOf(TRANSFER_FOOTER);
    if (start < 0 || end < start) throw new CoreError('That is not a CryptMail transfer.', 'malformed');
    let inner: { email: string; backup: string; archive: string };
    try {
      const decoded = decodeUtf8Base64(blob.slice(start + TRANSFER_HEADER.length, end).replace(/\s+/g, ''));
      if (!decoded.startsWith(DEMO_TRANSFER_TAG)) throw new Error('not a demo transfer');
      inner = JSON.parse(decoded.slice(DEMO_TRANSFER_TAG.length));
    } catch {
      throw new CoreError('This transfer needs the real crypto core, or it is damaged.', 'malformed');
    }
    if (expectedEmail && inner.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new CoreError(`This transfer holds the key for ${inner.email}.`, 'malformed');
    }
    const identity = await demoCore.importRecoveryBackup(inner.backup, code);
    return { identity, archive: inner.archive };
  },

  /**
   * ⚠️  The demo core has no sessions — it encodes, it does not encrypt — so
   * everyone but ourselves reads as `session` and nothing is ever held for a
   * handshake. Per-email keys only exist in the real core.
   */
  async sessionStatus(email: string, recipientKeys: string[]): Promise<SessionStatus[]> {
    const own = (await demoCore.loadIdentity(email))?.publicKeyArmored;
    return recipientKeys.map((key) => (key === own ? 'self' : 'session'));
  },

  /** Encoded like every demo message, with the handshake's fixed text. */
  async buildHandshake(request: HandshakeRequest): Promise<string> {
    const rfc822 = await demoCore.buildEncrypted({
      from: request.from,
      to: [request.to],
      ...helloContent(request.from),
      recipientKeys: [request.recipientKey],
      autocryptKey: request.autocryptKey,
      handshake: true,
    });
    return rfc822;
  },

  /** The Key Manager lives in the real core: its keys never exist in JavaScript. */
  async kmStatus() {
    throw noKm();
  },
  async kmRegenerate() {
    throw noKm();
  },
  async kmExportLink() {
    throw noKm();
  },
  async kmImportLink() {
    throw noKm();
  },

  /** Nor does the protocol that fills it: `core/src/bb84.rs` is the real core. */
  async bb84Begin() {
    throw noKm();
  },
  async bb84Measure() {
    throw noKm();
  },
  async bb84Judge() {
    throw noKm();
  },
  async bb84Accept() {
    throw noKm();
  },
  async bb84Leg() {
    return null;
  },
  async bb84Eavesdrop() {
    throw noKm();
  },

  /** Nothing to hand over: the demo core has no conversations. */
  async transferStatus() {
    return { handedOverAt: null };
  },

  async resumeSessions() {},

  async buildEncrypted(request: BuildRequest): Promise<string> {
    if (request.level === 2 || request.level === 3) throw noKm();
    if (request.recipientKeys.length === 0) {
      throw new CoreError('Refusing to build a message with no recipient keys.', 'no-key');
    }
    const inner = buildProtectedInner({
      from: request.from,
      to: request.to,
      subject: request.subject,
      body: request.body,
      html: request.html,
      attachments: request.attachments,
    });
    const signer = fingerprintOf(request.autocryptKey ?? '') ?? 'UNKNOWN';
    const payload = encodeUtf8Base64(`${DEMO_ARMOR_TAG}${signer}:${encodeUtf8Base64(inner)}`);
    return buildEncryptedEnvelope({
      from: request.from,
      to: request.to,
      armored: armor(payload),
      autocryptKeydata: request.autocryptKey ? autocryptKeydata(request.autocryptKey) : undefined,
      inReplyTo: request.inReplyTo,
      references: request.references,
      handshake: request.handshake,
    });
  },

  async parseEncrypted(rfc822: string): Promise<DecryptedMessage> {
    const block = extractArmor(rfc822);
    if (!block) throw new CoreError('No PGP message block found.', 'malformed');

    const decoded = decodeUtf8Base64(dearmor(block));
    const tag = [DEMO_ARMOR_TAG, LEGACY_ARMOR_TAG].find((t) => decoded.startsWith(t));
    if (!tag) {
      // Real OpenPGP ciphertext: only the native core can open this.
      throw new CoreError(
        'This message needs the real crypto core to decrypt (demo mode is running).',
        'decrypt-failed',
      );
    }
    const rest = decoded.slice(tag.length);
    const sep = rest.indexOf(':');
    const signerFingerprint = rest.slice(0, sep);
    const { subject, body, html, attachments } = parseProtectedInner(
      decodeUtf8Base64(rest.slice(sep + 1)),
    );

    const autocrypt = parseRfc822(rfc822).headers['autocrypt'];
    return {
      subject,
      body,
      html,
      attachments,
      signature: 'valid',
      signerFingerprint: signerFingerprint === 'UNKNOWN' ? undefined : signerFingerprint,
      autocryptKey: autocrypt ? unflattenAutocrypt(autocrypt) : undefined,
    };
  },

  looksEncrypted(rfc822: string): boolean {
    return isPgpMime(rfc822);
  },
};

/* ------------------------------------------------------------- helpers ---- */

/**
 * Binds a blob to the code that produced it, so a wrong code is *detected*.
 *
 * Not a key-derivation function and not slow on purpose — a demo blob carries
 * no secret, so there is nothing here to brute-force. The real core stretches
 * the code with Argon2id and derives an actual wrapping key from it.
 */
function verifierFor(code: string): string {
  const digest = sha256(utf8ToBytes(`cryptmail-demo-recovery-v1:${normaliseRecoveryCode(code)}`));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same 64-column armor the message path uses, under its own label. */
function armorRecovery(payload: string): string {
  return [
    RECOVERY_HEADER,
    'Comment: CryptMail identity backup — useless without the recovery code',
    '',
    ...(payload.match(/.{1,64}/g) ?? []),
    RECOVERY_FOOTER,
  ].join('\n');
}

/** The armored body, or null if this is not a recovery backup at all. */
function dearmorRecovery(blob: string): string | null {
  const start = blob.indexOf(RECOVERY_HEADER);
  const end = blob.indexOf(RECOVERY_FOOTER);
  if (start < 0 || end < 0 || end < start) return null;

  return blob
    .slice(start + RECOVERY_HEADER.length, end)
    .split('\n')
    // Drop armor headers (`Comment:`) and blank lines, keeping only the payload.
    .filter((line) => line.trim() !== '' && !line.includes(':'))
    .join('')
    .trim();
}

function noKm(): CoreError {
  return new CoreError('The quantum Key Manager needs the real crypto core (demo mode is running).', 'unavailable');
}

function randomFingerprint(): string {
  const bytes = Crypto.getRandomBytes(20);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Armor-shaped, with the metadata the demo importer reads back. */
export function fakePublicKey(email: string, fingerprint: string): string {
  const filler = encodeUtf8Base64(`cryptmail-demo-key:${email}:${fingerprint}`).repeat(6);
  const lines = (filler.match(/.{1,64}/g) ?? []).slice(0, 8);
  return [
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    `Comment: CryptMail demo key <${email}>`,
    `Fingerprint: ${fingerprint}`,
    '',
    ...lines,
    '=dEm0',
    '-----END PGP PUBLIC KEY BLOCK-----',
  ].join('\n');
}

function fingerprintOf(armored: string): string | undefined {
  return armored.match(/^Fingerprint:\s*([0-9A-F ]+)$/m)?.[1]?.replace(/\s+/g, '');
}

function unflattenAutocrypt(header: string): string | undefined {
  const keydata = header.match(/keydata=([^;]+)/)?.[1]?.trim();
  if (!keydata) return undefined;
  try {
    const decoded = decodeUtf8Base64(keydata);
    return decoded.includes('BEGIN PGP PUBLIC KEY BLOCK') ? decoded : undefined;
  } catch {
    return undefined;
  }
}
