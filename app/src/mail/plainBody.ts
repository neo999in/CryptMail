/**
 * The readable text of an inbound message.
 *
 * Separate from `core/mime.ts` on purpose: that module implements
 * `docs/message-format.md` — the envelope CryptMail *writes* — and is meant to
 * stay a 1:1 mirror of it. This one reads whatever the rest of the world sends,
 * which is a different and much messier problem.
 *
 * It only needs to be good enough to render a body a human can read, and to
 * find the files hanging off it. It is not a general MIME parser: no charset
 * conversion beyond UTF-8 and no RFC 2047 word decoding.
 *
 * Written after the first real Gmail message opened in the app showed the
 * multipart boundary, the part headers and raw `=E2=80=87` escapes to the user
 * (2026-08-08). The demo fixtures are single-part US-ASCII, so nothing here was
 * reachable until real mail arrived.
 */
import { Attachment, decodedSize, newAttachmentId } from './attachment';
import { decodeTransfer } from './transferEncoding';

type Part = { headers: Record<string, string>; body: string };

/** Split a message or part into headers plus its raw body. */
function split(section: string): Part {
  const normalized = section.replace(/\r\n/g, '\n');
  const at = normalized.indexOf('\n\n');
  const headerBlock = at === -1 ? '' : normalized.slice(0, at);
  const body = at === -1 ? normalized : normalized.slice(at + 2);

  const headers: Record<string, string> = {};
  // Unfold continuation lines first: a long Content-Type is routinely wrapped.
  for (const line of headerBlock.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { headers, body };
}

function decodeBody(part: Part): string {
  // The charset is the part's own, and it has to travel with the bytes: a
  // Windows-1252 part read as UTF-8 loses a character *and* the one after it.
  return decodeTransfer(
    part.headers['content-transfer-encoding'],
    part.body,
    parameterOf(part.headers['content-type'] ?? '', 'charset'),
  );
}

/** Crude tag strip, used only when a message offers no text/plain alternative. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Last, so an escaped entity like &amp;lt; does not become a tag bracket.
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}

function boundaryOf(contentType: string): string | null {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * The sub-parts of a multipart, split on its boundary.
 *
 * Empty when the `Content-Type` declares no boundary — a malformed multipart has
 * no children to find, which is not an error worth raising to a reader.
 */
function childrenOf(part: Part): Part[] {
  const boundary = boundaryOf(part.headers['content-type'] ?? '');
  if (!boundary) return [];

  return part.body
    .replace(/\r\n/g, '\n')
    .split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \t]*$`, 'm'))
    .slice(1, -1)
    .filter((section) => section != null && section.trim() !== '' && section !== '--')
    .map((section) => split(section.replace(/^\n/, '')));
}

/**
 * The best readable text in a part, descending through nested multiparts.
 *
 * Returns null when a branch holds nothing renderable — an attachment-only
 * subtree, say — so the caller can keep looking at its siblings.
 */
function readable(part: Part): string | null {
  const contentType = part.headers['content-type'] ?? 'text/plain';

  if (/^multipart\//i.test(contentType)) {
    const parts = childrenOf(part);
    if (parts.length === 0) return null;

    // text/plain wins over text/html wherever both exist, which is the whole
    // point of multipart/alternative.
    const plain = parts.find((p) => /^text\/plain/i.test(p.headers['content-type'] ?? 'text/plain'));
    if (plain) return decodeBody(plain).trim();

    for (const child of parts) {
      const found = readable(child);
      if (found !== null && found !== '') return found;
    }
    return null;
  }

  if (/^text\/html/i.test(contentType)) return htmlToText(decodeBody(part)).trim();
  if (/^text\//i.test(contentType)) return decodeBody(part).trim();

  return null;
}

/**
 * The readable text of a raw RFC 5322 message.
 *
 * Never throws and never returns the raw MIME source when it can help it: a
 * message it cannot parse falls back to the undecoded body, which is still
 * closer to readable than an error screen.
 */
export function plainBodyOf(raw: string): string {
  const message = split(raw);
  const found = readable(message);
  return found ?? message.body.trim();
}

/**
 * Every attached file in a raw, *unencrypted* message.
 *
 * Encrypted mail does not come through here — its files are inside the
 * ciphertext and `parseProtectedInner` reads them. This exists so an ordinary
 * email with a PDF on it looks the same in the reader as an encrypted one,
 * minus the lock.
 *
 * Only base64 parts are returned. A part in some other transfer encoding is
 * skipped rather than handed over half-decoded: the reader would then offer to
 * open bytes that are not the file.
 */
export function attachmentsOf(raw: string): Attachment[] {
  const out: Attachment[] = [];

  const walk = (part: Part) => {
    const contentType = part.headers['content-type'] ?? 'text/plain';
    if (/^multipart\//i.test(contentType)) {
      const boundary = boundaryOf(contentType);
      if (!boundary) return;
      for (const child of sectionsOf(part.body, boundary)) walk(child);
      return;
    }

    const disposition = part.headers['content-disposition'] ?? '';
    const filename = parameterOf(disposition, 'filename') ?? parameterOf(contentType, 'name');
    if (!filename) return;
    if ((part.headers['content-transfer-encoding'] ?? '').toLowerCase().trim() !== 'base64') return;

    const data = part.body.replace(/\s+/g, '');
    const contentId = part.headers['content-id']?.replace(/^</, '').replace(/>$/, '');
    out.push({
      id: contentId ?? newAttachmentId(),
      name: filename,
      mimeType: contentType.split(';')[0].trim() || 'application/octet-stream',
      size: decodedSize(data),
      data,
      inline: /inline/i.test(disposition) || undefined,
      contentId,
    });
  };

  walk(split(raw));
  return out;
}

/** The parts of a multipart body, split the way `readable` splits them. */
function sectionsOf(body: string, boundary: string): Part[] {
  return body
    .replace(/\r\n/g, '\n')
    .split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \t]*$`, 'm'))
    .slice(1, -1)
    .filter((section) => section != null && section.trim() !== '' && section !== '--')
    .map((section) => split(section.replace(/^\n/, '')));
}

/** A quoted or bare parameter off a header value. */
function parameterOf(header: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header);
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * The decoded `text/html` part of a message, or `''` when it has none.
 *
 * `plainBodyOf` deliberately flattens HTML to text, which destroys the one thing
 * an anchor is: a pairing of visible label and destination. That pairing is the
 * evidence behind the strongest phishing signal the spam engine has, so it is
 * exposed here as markup and read — never rendered, never executed — by
 * `spam/urls.ts`'s bounded `extractLinks` scan.
 *
 * Decoding happens through the same `decodeBody` path as the text branch, which
 * matters: quoted-printable soft breaks and `=3D` escapes would otherwise split
 * `href` attributes in half and hide exactly the links worth reading.
 */
export function htmlOf(raw: string): string {
  const found = firstHtml(split(raw));
  return found ?? '';
}

/** The first `text/html` part in a tree, descending through multiparts. */
function firstHtml(part: Part): string | null {
  const contentType = part.headers['content-type'] ?? 'text/plain';

  if (/^text\/html/i.test(contentType)) return decodeBody(part);
  if (!/^multipart\//i.test(contentType)) return null;

  for (const child of childrenOf(part)) {
    const found = firstHtml(child);
    if (found !== null && found !== '') return found;
  }
  return null;
}
