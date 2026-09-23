/**
 * The two security levels, and the email that carries a Level 2 message.
 *
 * | Level | What seals the message | Keys from |
 * |---|---|---|
 * | 1 — No quantum security (default) | OpenPGP to the recipient's long-term key | their public key |
 * | 2 — Quantum | AES-256-GCM, key from HKDF over one 1 Kb quantum key and the sender's SAE ID | the Key Manager |
 *
 * Level 3, the one-time pad, was removed: it was the only reason the bank had
 * halves, since a pad cannot be bound to its sender and two ends picking one
 * key would reuse it. Archived Level 3 mail still opens (`levelName` names it);
 * the core refuses any other, and nothing sends it.
 *
 * The Key Manager is simulated inside the core (`core/src/km.rs`) — the keys
 * are random, not quantum — and never leave it: this file only ever sees the
 * armored ciphertext and the IDs of the keys that sealed it.
 *
 * ## On the wire
 *
 * A Level 2 email is an ordinary `text/plain` message: a sentence saying
 * what it is, then the armored block. Any mail system carries it and any client
 * displays it — interoperable with the traditional network by construction. Its
 * subject is the same placeholder as every encrypted message, so the inbox,
 * rules and notifications already treat it as encrypted without being told.
 */
import { decodeTransfer } from '../mail/transferEncoding';
import { autocryptHeaderLine, PLACEHOLDER_SUBJECT } from './mime';
import type { OpenedLevel, SecurityLevel } from './types';

export type { OpenedLevel, SecurityLevel };

/** Level 1 — what this build sends when nothing else is chosen. */
export const DEFAULT_LEVEL: SecurityLevel = 1;

/**
 * How compose groups the levels, and the order it offers them in.
 *
 * Numbered in a row they read as a ladder, which is wrong: Level 2's guarantee
 * depends on a key source this build simulates. They are two groups — what
 * works with anyone, and what demonstrates the Key Manager — so the row says
 * so, and leads with the default.
 */
export const LEVEL_GROUPS: { label: string; hint: string; levels: SecurityLevel[] }[] = [
  {
    label: 'Everyday',
    hint: 'Works with anyone who uses CryptMail. No setup, no key bank, signed so they know it is you.',
    levels: [1],
  },
  {
    label: 'Quantum keys',
    hint: 'Needs a key bank shared with them (Settings → Quantum Key Manager). Demonstrates the QKD integration.',
    levels: [2],
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
};

/** The name of any level a message may carry, including the removed Level 3. */
export function levelName(level: OpenedLevel): string {
  return level === 3 ? 'Level 3 — one-time pad (removed)' : LEVELS[level].name;
}

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

/** Build the email around a QKD block. */
export function buildQkdEnvelope(args: {
  from: string;
  to: string[];
  armored: string;
  level: 2;
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
