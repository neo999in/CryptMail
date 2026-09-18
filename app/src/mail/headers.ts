/**
 * Reading raw RFC 5322 headers the way a provider API would have handed them over.
 *
 * Gmail's `format=metadata` and Graph's JSON both return headers already
 * decoded. IMAP returns the bytes on the wire, so a subject arrives as
 * `=?UTF-8?B?w5xiZXI=?=` and an address list as one string with commas inside
 * quoted names. Pure module — no storage, no network.
 */
import { base64ToBytes, bytesToUtf8 } from '../lib/base64';
import { parseAddress } from '../lib/format';

/** Unfold, then split into a lowercased-name map. A repeated header keeps its first value. */
export function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!(name in headers)) headers[name] = line.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * Decode RFC 2047 encoded-words (`=?charset?B|Q?text?=`).
 *
 * Whitespace *between* two encoded-words is dropped, as the RFC requires — that
 * is how a long subject is split across folded lines without gaining spaces. A
 * word in a charset this platform cannot decode is left as it arrived rather
 * than guessed at.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1')
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (word, charset: string, encoding: string, text: string) => {
      try {
        const bytes = encoding.toUpperCase() === 'B' ? base64ToBytes(text) : qBytes(text);
        return decodeCharset(bytes, charset.split('*')[0]) ?? word;
      } catch {
        return word;
      }
    });
}

function qBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '_') out.push(0x20);
    else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Bytes in a named charset, or null when this platform cannot say what they mean. */
export function decodeCharset(bytes: Uint8Array, charset: string): string | null {
  const name = charset.trim().toLowerCase();
  if (name === 'utf-8' || name === 'utf8' || name === 'us-ascii' || name === 'ascii') return bytesToUtf8(bytes);
  if (name === 'iso-8859-1' || name === 'latin1' || name === 'latin-1') {
    return String.fromCharCode(...Array.from(bytes));
  }
  // Everything else — windows-1252, iso-2022-jp, koi8-r — only if this
  // runtime's TextDecoder knows it. Hermes' may know none of them.
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    // windows-1252 is a superset of latin-1 over the printable range, and it is
    // what most mislabelled mail actually is.
    if (name === 'windows-1252' || name === 'cp1252') return String.fromCharCode(...Array.from(bytes));
    return null;
  }
}

/**
 * Split an address-list header on the commas that separate addresses — not the
 * ones inside a quoted display name (`"Doe, Jane" <jane@example.com>`), a
 * comment, or angle brackets.
 */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      current += c;
      if (c === '\\' && i + 1 < value.length) current += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '(') comment++;
    else if (c === ')' && comment > 0) comment--;
    else if (c === '<') angle++;
    else if (c === '>' && angle > 0) angle--;
    else if (c === ',' && angle === 0 && comment === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** One address, with its display name decoded. */
export function decodeAddress(value: string): { address: string; name?: string } {
  // A group (`team: a@x.org, b@y.org;`) lists its members after a colon; the
  // group's name is not anyone's address.
  const bare = value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^[^"<>@]*:\s*/, '')
    .replace(/;\s*$/, '')
    .trim();
  const parsed = parseAddress(bare);
  const name = parsed.name ? decodeEncodedWords(parsed.name).replace(/\\(.)/g, '$1').trim() : undefined;
  return name ? { address: parsed.address, name } : { address: parsed.address };
}

/** The bare addresses in an address-list header. */
export function addressesIn(value: string | undefined): string[] {
  if (!value) return [];
  return splitAddressList(value)
    .map((a) => decodeAddress(a).address)
    .filter((a) => a.includes('@'));
}
