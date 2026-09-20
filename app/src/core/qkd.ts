/**
 * The four security levels, and the email that carries a Level 2 or 3 message.
 *
 * | Level | What seals the message | Keys from |
 * |---|---|---|
 * | 1 — No quantum security | OpenPGP to the recipient's long-term key | their public key |
 * | 2 — Quantum-aided AES | AES-256-GCM, key from HKDF over one 1 Kb quantum key | the Key Manager |
 * | 3 — Quantum secure (OTP) | one-time pad: XOR with quantum keys, HMAC with one more | the Key Manager |
 * | 4 — Post-quantum (default) | a per-email key over ML-KEM-768 + X25519 | the session with them |
 *
 * The Key Manager is simulated inside the core (`core/src/km.rs`) — the keys
 * are random, not quantum — and never leave it: this file only ever sees the
 * armored ciphertext and the IDs of the keys that sealed it.
 *
 * ## On the wire
 *
 * A Level 2 or 3 email is an ordinary `text/plain` message: a sentence saying
 * what it is, then the armored block. Any mail system carries it and any client
 * displays it — interoperable with the traditional network by construction. Its
 * subject is the same placeholder as every encrypted message, so the inbox,
 * rules and notifications already treat it as encrypted without being told.
 */
import { autocryptHeaderLine, PLACEHOLDER_SUBJECT } from './mime';
import type { SecurityLevel } from './types';

export type { SecurityLevel };

/** Level 4 — what this build sends when nothing else is chosen. */
export const DEFAULT_LEVEL: SecurityLevel = 4;

export const LEVELS: Record<SecurityLevel, { short: string; name: string; detail: string }> = {
  1: {
    short: 'L1 · PGP',
    name: 'Level 1 — No quantum security',
    detail: 'Standard OpenPGP to their long-term key. No quantum keys are used.',
  },
  2: {
    short: 'L2 · Q-AES',
    name: 'Level 2 — Quantum-aided AES',
    detail: 'A quantum key from the Key Manager seeds AES-256-GCM. One key per message; attachments fit.',
  },
  3: {
    short: 'L3 · OTP',
    name: 'Level 3 — Quantum secure (one-time pad)',
    detail: 'Quantum keys used directly as a one-time pad. One 1 Kb key per 128 bytes — short text only.',
  },
  4: {
    short: 'L4 · PQC',
    name: 'Level 4 — Post-quantum per-email keys',
    detail: 'A new key for every email over ML-KEM-768 + X25519, destroyed once read.',
  },
};

export const QKD_BEGIN = '-----BEGIN CRYPTMAIL QKD MESSAGE-----';
export const QKD_END = '-----END CRYPTMAIL QKD MESSAGE-----';

/** Bytes of one quantum key: 1 Kb. */
export const QKD_KEY_BYTES = 128;

/** The armored QKD block in a raw message, or null. */
export function extractQkdArmor(raw: string): string | null {
  const start = raw.indexOf(QKD_BEGIN);
  const end = raw.indexOf(QKD_END);
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + QKD_END.length);
}

export const isQkdMessage = (raw: string): boolean => extractQkdArmor(raw) !== null;

/** The level a QKD block declares, from its armor header. */
export function qkdLevelOf(raw: string): 2 | 3 | null {
  const level = extractQkdArmor(raw)?.match(/^Level:\s*([23])\s*$/m)?.[1];
  return level === '2' ? 2 : level === '3' ? 3 : null;
}

/** Quantum keys a Level 3 message of `bytes` needs: one per 128 bytes, plus the MAC key. */
export const otpKeysNeeded = (bytes: number): number => Math.max(1, Math.ceil(bytes / QKD_KEY_BYTES)) + 1;

/** Build the email around a QKD block. */
export function buildQkdEnvelope(args: {
  from: string;
  to: string[];
  armored: string;
  level: 2 | 3;
  autocryptKeydata?: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
}): string {
  const headers = [
    `From: ${args.from}`,
    `To: ${args.to.join(', ')}`,
    `Date: ${(args.date ?? new Date()).toUTCString()}`,
    `Subject: ${PLACEHOLDER_SUBJECT}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@cryptmail>`,
  ];
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references?.length) headers.push(`References: ${args.references.join(' ')}`);
  if (args.autocryptKeydata) headers.push(autocryptHeaderLine(args.from, args.autocryptKeydata));
  headers.push(
    `X-CryptMail-Security: ${LEVELS[args.level].name}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
  );
  return [
    headers.join('\n'),
    '',
    `This message is encrypted with quantum keys (${LEVELS[args.level].name}).`,
    'Open it in CryptMail on a device whose Key Manager holds the matching keys.',
    '',
    args.armored.trim(),
    '',
  ].join('\n');
}
