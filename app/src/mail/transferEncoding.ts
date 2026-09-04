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
 * Quoted-printable, decoded through bytes rather than characters.
 *
 * `=E2=80=87` is one character in three escapes, so the escapes have to be
 * decoded to bytes and the bytes read as UTF-8 together. Decoding each escape
 * to its own character produces mojibake instead.
 */
export function decodeQuotedPrintable(input: string): string {
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

/**
 * Decode one part's body against its `Content-Transfer-Encoding`.
 *
 * A malformed part returns its raw text rather than throwing: a message that
 * arrives slightly wrong should still be readable, and an exception here would
 * take the whole message down with it.
 */
export function decodeTransfer(encoding: string | undefined, body: string): string {
  const scheme = (encoding ?? '').toLowerCase().trim();
  try {
    if (scheme === 'quoted-printable') return decodeQuotedPrintable(body);
    if (scheme === 'base64') return bytesToUtf8(base64ToBytes(body.replace(/\s+/g, '')));
  } catch {
    // Fall through to the raw text.
  }
  return body;
}
