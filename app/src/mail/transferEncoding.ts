/**
 * Content-Transfer-Encoding, decoded.
 *
 * A codec, not a policy — which is why it sits apart from both readers rather
 * than inside either. `mail/plainBody.ts` reads what the world sends in the
 * clear and `core/mime.ts` reads the protected tree a *foreign* PGP client
 * sealed; both meet the same quoted-printable and base64 parts, and neither
 * should own the other's copy of this.
 *
 * Nothing here decides what a part means. It turns the bytes on the wire back
 * into the text they encode, and nothing else.
 */
import { base64ToBytes, bytesToUtf8 } from '../lib/base64';

/**
 * The bytes 0x80-0x9F in Windows-1252, which ISO-8859-1 leaves as controls.
 *
 * Mail labelled `iso-8859-1` is decoded as Windows-1252 on purpose, and every
 * browser does the same: the label is wrong far more often than it is right,
 * because the templates that emit it come from Windows editors that put curly
 * quotes, dashes and bullets in exactly this range. Reading it as strict
 * Latin-1 would turn each of those into a control character instead.
 *
 * Above 0x9F the two encodings agree with Unicode's own first 256 code points,
 * so the byte *is* the code point and no table is needed.
 */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** The charsets that are one byte per character, by every spelling mail uses. */
const SINGLE_BYTE = /^(?:iso[-_]?8859[-_]?1|latin[-_]?1|l1|cp[-_]?1252|windows[-_]?1252)$/;

/**
 * Bytes to text, in the character set the part declared.
 *
 * Not a detail: a part is a sequence of *bytes*, and which characters they
 * spell is a decision the sender made and wrote down. Reading a Windows-1252
 * part as UTF-8 does not merely mistranslate the odd character — the decoder
 * takes one byte for the start of a multi-byte sequence and eats the next one
 * too. A footer reading `Help · Privacy` came back with a Hebrew letter where
 * the dot was and no space after it, because the dot's byte swallowed it.
 *
 * Anything not named here is read as UTF-8, which is what the rest of the world
 * sends and what an unlabelled part almost always is.
 */
export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const name = (charset ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!SINGLE_BYTE.test(name)) return bytesToUtf8(bytes);

  let out = '';
  for (const byte of bytes) {
    out += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte);
  }
  return out;
}

/**
 * Quoted-printable, decoded through bytes rather than characters.
 *
 * `=E2=80=87` is one character in three escapes, so the escapes have to be
 * decoded to bytes and the bytes read together, in the part's own character
 * set. Decoding each escape to its own character produces mojibake instead.
 */
export function decodeQuotedPrintable(input: string, charset?: string): string {
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
  return decodeBytes(Uint8Array.from(bytes), charset);
}

/**
 * Decode one part's body against its `Content-Transfer-Encoding` and charset.
 *
 * A malformed part returns its raw text rather than throwing: a message that
 * arrives slightly wrong should still be readable, and an exception here would
 * take the whole message down with it.
 *
 * `charset` is the parameter off the part's own `Content-Type`. It is only
 * consultable for the two encodings that carry bytes — a part sent as 8-bit
 * text arrived as text, and whatever its label says, it was decoded before this
 * module ever saw it.
 */
export function decodeTransfer(
  encoding: string | undefined,
  body: string,
  charset?: string,
): string {
  const scheme = (encoding ?? '').toLowerCase().trim();
  try {
    if (scheme === 'quoted-printable') return decodeQuotedPrintable(body, charset);
    if (scheme === 'base64') {
      return decodeBytes(base64ToBytes(body.replace(/\s+/g, '')), charset);
    }
  } catch {
    // Fall through to the raw text.
  }
  return body;
}
