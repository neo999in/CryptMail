/**
 * ⚠️  NOT CRYPTOGRAPHY.
 *
 * A stand-in for `ciphermail-core` (Rust/rPGP) so the frontend can be built,
 * demoed and reviewed before M1/M2 land. It produces byte-correct PGP/MIME
 * envelopes (docs/message-format.md) whose "ciphertext" is *encoded*, not
 * encrypted — anyone can read it.
 *
 * `kind === 'demo'` and every real send path checks that, so this can never be
 * used to send something the user believes is encrypted. See config.ts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { decodeUtf8Base64, encodeUtf8Base64 } from '../lib/base64';
import {
  armor,
  buildEncryptedEnvelope,
  buildProtectedInner,
  dearmor,
  extractArmor,
  isPgpMime,
  parseProtectedInner,
  parseRfc822,
} from './mime';
import { parseArmoredPublicKey } from '../pgp/parseArmoredKey';
import { BuildRequest, CipherCore, CoreError, DecryptedMessage, Identity, PublicKeyInfo } from './types';

const IDENTITY_KEY = 'ciphermail.demo.identity';
const DEMO_ARMOR_TAG = 'CIPHERMAIL-DEMO-V1:';

export const demoCore: CipherCore = {
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
    const stored = await AsyncStorage.getItem(`${IDENTITY_KEY}.${email}`);
    return stored ? (JSON.parse(stored) as Identity) : null;
  },

  async importPublicKey(armored: string): Promise<PublicKeyInfo> {
    const trimmed = armored.trim();
    if (!trimmed.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
      throw new CoreError('That does not look like an armored public key block.', 'malformed');
    }
    // Fast path for CipherMail's own demo keys, which put the address and
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

  async buildEncrypted(request: BuildRequest): Promise<string> {
    if (request.recipientKeys.length === 0) {
      throw new CoreError('Refusing to build a message with no recipient keys.', 'no-key');
    }
    const inner = buildProtectedInner({
      from: request.from,
      to: request.to,
      subject: request.subject,
      body: request.body,
    });
    const signer = fingerprintOf(request.autocryptKey ?? '') ?? 'UNKNOWN';
    const payload = encodeUtf8Base64(`${DEMO_ARMOR_TAG}${signer}:${encodeUtf8Base64(inner)}`);
    return buildEncryptedEnvelope({
      from: request.from,
      to: request.to,
      armored: armor(payload),
      autocryptKeydata: request.autocryptKey ? encodeUtf8Base64(request.autocryptKey) : undefined,
    });
  },

  async parseEncrypted(rfc822: string): Promise<DecryptedMessage> {
    const block = extractArmor(rfc822);
    if (!block) throw new CoreError('No PGP message block found.', 'malformed');

    const decoded = decodeUtf8Base64(dearmor(block));
    if (!decoded.startsWith(DEMO_ARMOR_TAG)) {
      // Real OpenPGP ciphertext: only the native core can open this.
      throw new CoreError(
        'This message needs the real crypto core to decrypt (demo mode is running).',
        'decrypt-failed',
      );
    }
    const rest = decoded.slice(DEMO_ARMOR_TAG.length);
    const sep = rest.indexOf(':');
    const signerFingerprint = rest.slice(0, sep);
    const { subject, body } = parseProtectedInner(decodeUtf8Base64(rest.slice(sep + 1)));

    const autocrypt = parseRfc822(rfc822).headers['autocrypt'];
    return {
      subject,
      body,
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

function randomFingerprint(): string {
  const bytes = Crypto.getRandomBytes(20);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Armor-shaped, with the metadata the demo importer reads back. */
export function fakePublicKey(email: string, fingerprint: string): string {
  const filler = encodeUtf8Base64(`ciphermail-demo-key:${email}:${fingerprint}`).repeat(6);
  const lines = (filler.match(/.{1,64}/g) ?? []).slice(0, 8);
  return [
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    `Comment: CipherMail demo key <${email}>`,
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
