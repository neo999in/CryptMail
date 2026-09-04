/**
 * RFC 5322 / PGP-MIME assembly and parsing, exactly as specified in
 * docs/message-format.md.
 *
 * In the shipped prototype this work happens in Rust (M5) — the Rust side owns
 * every byte of MIME. This module exists so the demo core can produce and read
 * byte-identical envelopes, and so the app has one place that knows the shape
 * of a message when it needs to render raw headers.
 */
import { encodeUtf8Base64 } from '../lib/base64';
import {
  Attachment,
  contentIdFor,
  decodedSize,
  newAttachmentId,
} from '../mail/attachment';
import { decodeTransfer } from '../mail/transferEncoding';

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
 * Flatten an armored public key into an `Autocrypt` header's `keydata` value.
 *
 * One place, because two message shapes now carry the header — the encrypted
 * envelope below and `buildPlaintext` (which the invite goes out as) — and a
 * second copy of this would be a second thing to get wrong.
 */
export function autocryptKeydata(armoredPublicKey: string): string {
  return encodeUtf8Base64(armoredPublicKey);
}

/** The one `Autocrypt:` header line both message shapes emit. */
export function autocryptHeaderLine(addr: string, keydata: string): string {
  return `Autocrypt: addr=${addr}; prefer-encrypt=mutual; keydata=${keydata}`;
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
  /** Threading, in the clear — provider metadata, see message-format.md. */
  inReplyTo?: string;
  references?: string[];
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
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references?.length) headers.push(`References: ${args.references.join(' ')}`);
  if (args.autocryptKeydata) {
    headers.push(autocryptHeaderLine(args.from, args.autocryptKeydata));
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

/**
 * One MIME part: its unfolded headers and its raw, still-encoded body.
 *
 * The envelope this module writes is `multipart/mixed` with one `text/plain`
 * part and one part per attachment, so `splitMultipart` is flat. Reading is not
 * symmetrical with writing: a decrypted tree can come from any PGP client, and
 * those nest a `multipart/alternative` inside the mixed part — hence
 * `flattenParts`. Inbound *unencrypted* mail stays `mail/plainBody.ts`'s
 * problem; this module only ever sees what was sealed.
 */
export type MimePart = { headers: Headers; body: string };

/** The boundary declared by a `Content-Type`, or null. */
export function boundaryOf(contentType: string): string | null {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** Split a multipart body into its parts, dropping the preamble and epilogue. */
export function splitMultipart(body: string, boundary: string): MimePart[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body
    .replace(/\r\n/g, '\n')
    .split(new RegExp(`^--${escaped}(--)?[ \t]*$`, 'm'))
    .slice(1, -1)
    .filter((section) => section != null && section.trim() !== '' && section !== '--')
    .map((section) => parseRfc822(section.replace(/^\n/, '')));
}

/** A quoted parameter off a header value: `name="x"` -> `x`. */
function param(header: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header);
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * Encode one attachment as a MIME part.
 *
 * Base64 wrapped at 76 columns, per RFC 2045 — some providers reject or rewrite
 * a part with longer lines, and a rewritten part inside a signed tree would
 * break the signature.
 */
export function attachmentPart(a: Attachment): string {
  const disposition = a.inline ? 'inline' : 'attachment';
  const headers = [
    `Content-Type: ${a.mimeType}; name="${a.name}"`,
    `Content-Disposition: ${disposition}; filename="${a.name}"`,
    'Content-Transfer-Encoding: base64',
  ];
  // Only an inline part needs an identity: it is the `cid:` the body refers to.
  if (a.inline) headers.push(`Content-ID: <${a.contentId ?? contentIdFor(a.id)}>`);

  return [...headers, '', ...(a.data.replace(/\s+/g, '').match(/.{1,76}/g) ?? [])].join('\n');
}

/** Read the attachment parts back out of a parsed multipart tree. */
export function attachmentsFromParts(parts: MimePart[]): Attachment[] {
  const out: Attachment[] = [];
  for (const part of parts) {
    const contentType = part.headers['content-type'] ?? 'text/plain';
    const disposition = part.headers['content-disposition'] ?? '';
    const filename = param(disposition, 'filename') ?? param(contentType, 'name');
    // A part is a file if it says so, or if it carries a filename. A bare
    // `text/plain` with neither is the body.
    if (!/attachment|inline/i.test(disposition) && !filename) continue;
    if (/^text\/plain/i.test(contentType) && !filename) continue;

    const data = part.body.replace(/\s+/g, '');
    const contentId = part.headers['content-id']?.replace(/^</, '').replace(/>$/, '');
    out.push({
      id: contentId ?? newAttachmentId(),
      name: filename ?? 'attachment',
      mimeType: contentType.split(';')[0].trim() || 'application/octet-stream',
      size: decodedSize(data),
      data,
      inline: /inline/i.test(disposition) || undefined,
      contentId,
    });
  }
  return out;
}

/**
 * The inner, protected-headers MIME tree that gets encrypted.
 *
 * `multipart/mixed` with the body first and every attachment after it, so a
 * filename and its bytes both sit inside the ciphertext — which is the whole
 * reason attachments are worth doing here at all (message-format.md:
 * "Attachment filenames and types live *inside* the encrypted tree").
 */
export function buildProtectedInner(args: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  attachments?: Attachment[];
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
    ...(args.attachments ?? []).flatMap((a) => [`--${boundary}`, attachmentPart(a), '']),
    `--${boundary}--`,
    '',
  ].join('\n');
}

/**
 * Every part of a tree, flattened — descending into nested multiparts.
 *
 * `buildProtectedInner` writes one flat `multipart/mixed`, so for a message
 * CryptMail sent this returns the same list `splitMultipart` does. It matters
 * for mail *other* PGP clients sealed: Thunderbird and ProtonMail put a
 * `multipart/alternative` inside the mixed part, and a flat split sees that
 * wrapper as one opaque part — which is how the bodies inside it went missing.
 */
function flattenParts(parts: MimePart[]): MimePart[] {
  const out: MimePart[] = [];
  for (const part of parts) {
    const contentType = part.headers['content-type'] ?? 'text/plain';
    const boundary = /^multipart\//i.test(contentType) ? boundaryOf(contentType) : null;
    if (boundary) out.push(...flattenParts(splitMultipart(part.body, boundary)));
    else out.push(part);
  }
  return out;
}

/** A body part — text the reader shows, as opposed to a file hanging off it. */
function bodyPart(parts: MimePart[], mimeType: RegExp): MimePart | undefined {
  return parts.find(
    (p) =>
      mimeType.test(p.headers['content-type'] ?? 'text/plain') &&
      !/attachment|inline/i.test(p.headers['content-disposition'] ?? ''),
  );
}

/** The newline(s) before a boundary belong to the delimiter, not the part. */
const TRAILING_NEWLINES = /\n+$/;

/** Decode one part's body against its own transfer encoding. */
function partText(part: MimePart): string {
  return decodeTransfer(part.headers['content-transfer-encoding'], part.body);
}

/**
 * Read back the protected subject, bodies and files from a decrypted tree.
 *
 * Both bodies come back when the sender wrote both, and the caller chooses:
 * `html` is what the reader renders, `body` is its fallback and what the search
 * index stores. They are not alternatives *here* because they are not
 * alternatives to every consumer — indexing markup would put tag names in the
 * search index, and rendering the flattened text would throw the message away.
 *
 * Transfer-decoded, which a foreign client's tree needs and our own does not:
 * `buildProtectedInner` writes 7-bit text, but everyone else sends
 * quoted-printable — and an HTML part read undecoded has `=3D` where every one
 * of its `href=` should be.
 */
export function parseProtectedInner(inner: string): {
  subject: string;
  body: string;
  /** The sender's `text/html`, when they wrote one. Never sanitised here. */
  html?: string;
  attachments: Attachment[];
} {
  const { headers, body } = parseRfc822(inner);
  const subject = headers['subject'] ?? PLACEHOLDER_SUBJECT;
  const boundary = boundaryOf(headers['content-type'] ?? '');
  if (!boundary) {
    // A single-part tree. It is still allowed to be HTML — some clients seal
    // one — in which case that markup is both the body and the html.
    const single = decodeTransfer(headers['content-transfer-encoding'], body).trim();
    const isHtml = /^text\/html/i.test(headers['content-type'] ?? '');
    return { subject, body: single, html: isHtml ? single : undefined, attachments: [] };
  }

  const parts = flattenParts(splitMultipart(body, boundary));
  const text = bodyPart(parts, /^text\/plain/i);
  const html = bodyPart(parts, /^text\/html/i);

  return {
    subject,
    body: text ? partText(text).replace(/\n+$/, '') : body.trim(),
    // Trailing newlines belong to the boundary that follows the part, not to
    // the part — same trim the text body gets.
    html: html ? partText(html).replace(TRAILING_NEWLINES, '') : undefined,
    attachments: attachmentsFromParts(parts),
  };
}

/**
 * A plain, unencrypted RFC 5322 message — used for M4's plaintext-send check.
 *
 * `autocryptKey` is the sender's *public* key, armored. Carrying it costs
 * nothing and is what lets a recipient's fresh install answer encrypted without
 * a setup step: the invite in `AppState` is a plaintext message whose only real
 * payload is this header.
 */
export function buildPlaintext(args: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  autocryptKey?: string;
  /** Threading, so an unencrypted reply still lands in its conversation. */
  inReplyTo?: string;
  references?: string[];
  /**
   * Files, in the clear like everything else here.
   *
   * A plaintext message with an attachment is `multipart/mixed`, so the
   * filename, type and bytes are all visible to every hop — which is exactly
   * what this mode means and what the compose screen says before it is chosen.
   * The invite never passes any: it carries no content by design.
   */
  attachments?: Attachment[];
}): string {
  const headers = [
    `From: ${args.from}`,
    `To: ${args.to.join(', ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${args.subject}`,
  ];
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references?.length) headers.push(`References: ${args.references.join(' ')}`);
  if (args.autocryptKey) {
    headers.push(autocryptHeaderLine(args.from, autocryptKeydata(args.autocryptKey)));
  }

  const attachments = args.attachments ?? [];
  if (attachments.length === 0) {
    headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8');
    return [...headers, '', args.body, ''].join('\n');
  }

  const boundary = `plain-${Math.random().toString(36).slice(2, 10)}`;
  headers.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`);
  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    args.body,
    '',
    ...attachments.flatMap((a) => [`--${boundary}`, attachmentPart(a), '']),
    `--${boundary}--`,
    '',
  ].join('\n');
}
