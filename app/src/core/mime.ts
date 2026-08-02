/**
 * RFC 5322 / PGP-MIME assembly and parsing, exactly as specified in
 * docs/message-format.md.
 *
 * In the shipped prototype this work happens in Rust (M5) — the Rust side owns
 * every byte of MIME. This module exists so the demo core can produce and read
 * byte-identical envelopes, and so the app has one place that knows the shape
 * of a message when it needs to render raw headers.
 */

export const PLACEHOLDER_SUBJECT = '[Encrypted message]';
export const ARMOR_BEGIN = '-----BEGIN PGP MESSAGE-----';
export const ARMOR_END = '-----END PGP MESSAGE-----';

export type Headers = Record<string, string>;

export type RawMessage = {
  headers: Headers;
  body: string;
};

export function parseRfc822(raw: string): RawMessage {
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? '' : normalized.slice(split + 2);

  const headers: Headers = {};
  // Unfold continuation lines before splitting on ':'.
  for (const line of headerBlock.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { headers, body };
}

export function isPgpMime(raw: string): boolean {
  const { headers, body } = parseRfc822(raw);
  const ct = headers['content-type'] ?? '';
  const structural = /multipart\/encrypted/i.test(ct) && /application\/pgp-encrypted/i.test(ct);
  return structural || body.includes(ARMOR_BEGIN);
}

/** Pull the armored block out of a `multipart/encrypted` body. */
export function extractArmor(raw: string): string | null {
  const start = raw.indexOf(ARMOR_BEGIN);
  const end = raw.indexOf(ARMOR_END);
  if (start === -1 || end === -1) return null;
  return raw.slice(start, end + ARMOR_END.length);
}

/** Wrap ciphertext base64 in an OpenPGP ASCII-armor block, 64 cols wide. */
export function armor(payloadBase64: string): string {
  const lines = payloadBase64.match(/.{1,64}/g) ?? [];
  return [ARMOR_BEGIN, '', ...lines, '=Ab3D', ARMOR_END].join('\n');
}

export function dearmor(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.startsWith('-----') && !l.startsWith('=') && l.trim() !== '')
    .join('');
}

/**
 * The outer envelope from message-format.md: placeholder subject, Autocrypt
 * header, `multipart/encrypted` with the fixed `Version: 1` part.
 */
export function buildEncryptedEnvelope(args: {
  from: string;
  to: string[];
  date?: Date;
  armored: string;
  /** Base64 `keydata` value for the Autocrypt header (the sender's public key). */
  autocryptKeydata?: string;
  messageId?: string;
}): string {
  const boundary = `=-=-=cryptmail-${Math.random().toString(36).slice(2, 10)}=-=-=`;
  const date = (args.date ?? new Date()).toUTCString();
  const messageId = args.messageId ?? `<${Math.random().toString(36).slice(2)}@cryptmail>`;

  const headers = [
    `From: ${args.from}`,
    `To: ${args.to.join(', ')}`,
    `Date: ${date}`,
    `Subject: ${PLACEHOLDER_SUBJECT}`,
    `Message-ID: ${messageId}`,
  ];
  if (args.autocryptKeydata) {
    headers.push(
      `Autocrypt: addr=${args.from}; prefer-encrypt=mutual; keydata=${args.autocryptKeydata}`,
    );
  }
  headers.push(
    'MIME-Version: 1.0',
    `Content-Type: multipart/encrypted;`,
    ` protocol="application/pgp-encrypted";`,
    ` boundary="${boundary}"`,
  );

  return [
    headers.join('\n'),
    '',
    `--${boundary}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '',
    'Version: 1',
    '',
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '',
    args.armored,
    '',
    `--${boundary}--`,
    '',
  ].join('\n');
}

/** The inner, protected-headers MIME tree that gets encrypted. */
export function buildProtectedInner(args: {
  from: string;
  to: string[];
  subject: string;
  body: string;
}): string {
  const boundary = `inner-${Math.random().toString(36).slice(2, 10)}`;
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"; protected-headers="v1"`,
    `Subject: ${args.subject}`,
    `From: ${args.from}`,
    `To: ${args.to.join(', ')}`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    args.body,
    '',
    `--${boundary}--`,
    '',
  ].join('\n');
}

/** Read back the protected subject + text body from a decrypted inner tree. */
export function parseProtectedInner(inner: string): { subject: string; body: string } {
  const { headers, body } = parseRfc822(inner);
  const subject = headers['subject'] ?? PLACEHOLDER_SUBJECT;
  const boundaryMatch = (headers['content-type'] ?? '').match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) return { subject, body: body.trim() };

  const parts = body.split(`--${boundaryMatch[1]}`);
  for (const part of parts) {
    if (!/text\/plain/i.test(part)) continue;
    const sep = part.indexOf('\n\n');
    if (sep !== -1) return { subject, body: part.slice(sep + 2).replace(/\n+$/, '') };
  }
  return { subject, body: body.trim() };
}

/** A plain, unencrypted RFC 5322 message — used for M4's plaintext-send check. */
export function buildPlaintext(args: {
  from: string;
  to: string[];
  subject: string;
  body: string;
}): string {
  return [
    `From: ${args.from}`,
    `To: ${args.to.join(', ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    args.body,
    '',
  ].join('\n');
}
