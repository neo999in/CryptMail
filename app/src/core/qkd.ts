/**
 * The four security levels, and the email that carries a Level 2 or 3 message.
 *
 * | Level | What seals the message | Keys from |
 * |---|---|---|
 * | 1 — No quantum security | OpenPGP to the recipient's long-term key | their public key |
 * | 2 — Quantum | AES-256-GCM, key from HKDF over one 1 Kb quantum key | the Key Manager |
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
import { decodeTransfer } from '../mail/transferEncoding';
import { autocryptHeaderLine, PLACEHOLDER_SUBJECT } from './mime';
import type { SecurityLevel } from './types';

export type { SecurityLevel };

/** Level 4 — what this build sends when nothing else is chosen. */
export const DEFAULT_LEVEL: SecurityLevel = 4;

/**
 * How compose groups the levels, and the order it offers them in.
 *
 * Numbered 1–4 they read as a ladder, which is wrong twice over: Level 4 is
 * both the default and the strongest thing here, and Level 3's guarantee
 * depends on a key source this build simulates. They are two pairs — what
 * protects your mail, and what demonstrates the Key Manager — so the row says
 * so, and leads with the default.
 */
/**
 * Levels that cannot be chosen or sent in this build. Level 3 is switched off:
 * a one-time pad is only as good as its key source, which here is simulated,
 * and it drains the bank a key per 128 bytes. Mail already received at Level 3
 * still opens — only sending is off. Remove it from here to bring it back.
 */
export const DISABLED_LEVELS: readonly SecurityLevel[] = [3];

export const isLevelEnabled = (level: SecurityLevel): boolean => !DISABLED_LEVELS.includes(level);

export const LEVEL_GROUPS: { label: string; hint: string; levels: SecurityLevel[] }[] = [
  {
    label: 'Everyday',
    hint: 'Works with anyone who uses CryptMail. No setup, no key bank, signed so they know it is you.',
    levels: [4, 1],
  },
  {
    label: 'Quantum keys',
    hint: 'Needs a key bank shared with them (Settings → Quantum Key Manager). Demonstrates the QKD integration.',
    levels: ([2, 3] as SecurityLevel[]).filter(isLevelEnabled),
  },
];

/** Which group a level belongs to. */
export function groupOf(level: SecurityLevel): (typeof LEVEL_GROUPS)[number] {
  return LEVEL_GROUPS.find((g) => g.levels.includes(level)) ?? LEVEL_GROUPS[0];
}

export const LEVELS: Record<SecurityLevel, { short: string; name: string; detail: string }> = {
  1: {
    short: 'L1 · PGP',
    name: 'Level 1 — No quantum security',
    detail: 'Standard OpenPGP to their long-term key. No quantum keys are used.',
  },
  2: {
    short: 'L2 · Quantum',
    name: 'Level 2 — Quantum',
    detail:
      'A quantum key from the shared key bank, used once, seeds AES-256-GCM. The bank is linked over ' +
      'ML-KEM-768 + X25519. One key per message; attachments fit.',
  },
  3: {
    short: 'L3 · OTP',
    name: 'Level 3 — Quantum secure (one-time pad)',
    detail: 'Quantum keys used directly as a one-time pad. One 1 Kb key per 128 bytes — short text only.',
  },
  4: {
    short: 'L4 · PQC',
    name: 'Level 4 — Post-quantum per-email keys',
    detail: 'A new key for every email over ML-KEM-768 + X25519, destroyed once read. The default.',
  },
};

export const QKD_BEGIN = '-----BEGIN CRYPTMAIL QKD MESSAGE-----';
export const QKD_END = '-----END CRYPTMAIL QKD MESSAGE-----';

/** Bytes of one quantum key: 1 Kb. */
export const QKD_KEY_BYTES = 128;

/** The armored block as it sits in some text, or null. */
function sliceArmor(text: string): string | null {
  const start = text.indexOf(QKD_BEGIN);
  const end = text.indexOf(QKD_END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + QKD_END.length);
}

/**
 * The top-level part's transfer encoding and body, for a single-part message.
 *
 * `buildQkdEnvelope` sends exactly that shape, so there is no tree to walk —
 * and deliberately no MIME parser here, since the one that reads inbound mail
 * lives in `mail/plainBody.ts` and flattens HTML, which would destroy an armor
 * block rather than decode it.
 */
function topLevelPart(raw: string): { encoding?: string; charset?: string; body: string } | null {
  const blank = raw.search(/\r?\n\r?\n/);
  if (blank === -1) return null;
  const headers = raw.slice(0, blank);
  const body = raw.slice(blank).replace(/^\r?\n\r?\n/, '');
  // Unfolds a continued header before reading it: a long Content-Type is often
  // wrapped onto a second line, and `charset` is what tends to sit on it.
  const header = (name: string): string | undefined =>
    headers
      .match(new RegExp(`^${name}:[ \t]*(.*(?:\r?\n[ \t].*)*)$`, 'im'))?.[1]
      .replace(/\r?\n[ \t]+/g, ' ')
      .trim();
  return {
    encoding: header('content-transfer-encoding'),
    charset: header('content-type')?.match(/charset="?([^";]+)"?/i)?.[1],
    body,
  };
}

/**
 * The armored QKD block in a raw message, or null.
 *
 * **The body is transfer-decoded first.** `buildQkdEnvelope` declares `7bit`,
 * but that is a statement about what we send, not a promise about what arrives:
 * a provider may re-encode the body on delivery, and Gmail does. Quoted-printable
 * is the case that matters, and it is quietly destructive here — `BEGIN` and
 * `END` contain no character QP escapes, so the markers survive intact while the
 * base64 between them is rewritten (`=` padding becomes `=3D`, long lines gain
 * soft breaks). The block is then found, looks entirely well-formed, and fails
 * to parse, which surfaces as "damaged or incomplete" on a message that is
 * perfectly fine at rest on the server.
 *
 * Decoding cannot be guessed after the fact: a base64 line ending in `=` and a
 * QP soft break are the same two bytes. So the part's declared encoding decides,
 * and the undecoded text is the fallback for anything this does not recognise.
 */
export function extractQkdArmor(raw: string): string | null {
  const decoded = transferDecodedBody(raw);
  return (decoded !== null ? sliceArmor(decoded) : null) ?? sliceArmor(raw);
}

/**
 * The body of a single-part message with a quoted-printable or base64
 * transfer encoding undone, or null when it declares neither. Any armored block
 * we send as `7bit` needs this on the way back in — see `extractQkdArmor`; the
 * quantum-link legs (`state/bb84.ts`) are the other case.
 */
export function transferDecodedBody(raw: string): string | null {
  const part = topLevelPart(raw);
  const scheme = (part?.encoding ?? '').toLowerCase().trim();
  if (!part || (scheme !== 'quoted-printable' && scheme !== 'base64')) return null;
  return decodeTransfer(part.encoding, part.body, part.charset);
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
