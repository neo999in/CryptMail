/**
 * `utf8ByteLength` measures stores and bounds the search index, so it has to
 * agree with the bytes `utf8ToBytes` actually produces — including for the
 * characters where a character count and a byte count part ways.
 */
import { utf8ByteLength, utf8ToBytes } from '../base64';

describe('utf8ByteLength', () => {
  it.each([
    ['ascii', 'hello'],
    ['two-byte', 'café'],
    ['three-byte', '€ and 漢字'],
    ['surrogate pair', 'mail 📬 sealed 🔒'],
    ['empty', ''],
  ])('agrees with the encoder for %s text', (_label, text) => {
    expect(utf8ByteLength(text)).toBe(utf8ToBytes(text).length);
  });

  it('counts a lone surrogate the way the encoder writes it', () => {
    const lone = String.fromCharCode(0xd83d);
    expect(utf8ByteLength(lone)).toBe(utf8ToBytes(lone).length);
  });
});
