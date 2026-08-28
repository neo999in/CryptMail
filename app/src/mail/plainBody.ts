/**
 * The readable text of an inbound message.
 *
 * Separate from `core/mime.ts` on purpose: that module implements
 * `docs/message-format.md` — the envelope CryptMail *writes* — and is meant to
 * stay a 1:1 mirror of it. This one reads whatever the rest of the world sends,
 * which is a different and much messier problem.
 *
 * It only needs to be good enough to render a body a human can read. It is not
 * a general MIME parser: no charset conversion beyond UTF-8, no RFC 2047
 * word decoding, no attachment extraction.
 *
 * Written after the first real Gmail message opened in the app showed the
 * multipart boundary, the part headers and raw `=E2=80=87` escapes to the user
 * (2026-08-08). The demo fixtures are single-part US-ASCII, so nothing here was
 * reachable until real mail arrived.
 */
import { base64ToBytes, bytesToUtf8 } from '../lib/base64';

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

/**
 * `=E2=80=87` is one character in three escapes, so the escapes have to be
 * decoded to bytes and the bytes read as UTF-8 together. Decoding each escape
 * to its own character produces mojibake instead.
 */
function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
    const char = withoutSoftBreaks[i];
    const hex = withoutSoftBreaks.slice(i + 1, i + 3);
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      // Already-literal text. Anything non-ASCII here is malformed QP, but
      // passing its UTF-8 bytes through renders better than dropping it.
      for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
    }
  }
  return bytesToUtf8(Uint8Array.from(bytes));
}

function decodeBody(part: Part): string {
  const encoding = (part.headers['content-transfer-encoding'] ?? '').toLowerCase().trim();
  try {
    if (encoding === 'quoted-printable') return decodeQuotedPrintable(part.body);
    if (encoding === 'base64') return bytesToUtf8(base64ToBytes(part.body.replace(/\s+/g, '')));
  } catch {
    // A malformed part must still show its raw text rather than an error.
  }
  return part.body;
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
