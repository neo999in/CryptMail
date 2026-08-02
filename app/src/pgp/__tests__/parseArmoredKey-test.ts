import { bytesToBase64, utf8ToBytes } from '../../lib/base64';
import { parseArmoredPublicKey, sha1Hex, userIdDisplayName } from '../parseArmoredKey';
import { ADA_ARMORED, ADA_EMAIL, ADA_FINGERPRINT, ADA_USERID } from './fixtures';

/**
 * The fixture is a real key exported from GnuPG 2.4 (`gpg --armor --export`),
 * so `fingerprint` is a known-answer: it must equal what `gpg --fingerprint`
 * prints. The SHA-1 the fingerprint is built on is pinned to NIST vectors, so
 * the whole chain is independently verifiable — not circular.
 */
describe('sha1Hex', () => {
  it('matches NIST FIPS-180 known-answer vectors', () => {
    expect(sha1Hex(utf8ToBytes(''))).toBe('DA39A3EE5E6B4B0D3255BFEF95601890AFD80709');
    expect(sha1Hex(utf8ToBytes('abc'))).toBe('A9993E364706816ABA3E25717850C26C9CD0D89D');
    expect(sha1Hex(utf8ToBytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '84983E441C3BD26EBAAE4AA1F95129E5E54670F1',
    );
  });

  it('handles input that spans multiple 64-byte blocks', () => {
    // 1,000,000 'a' → the classic long FIPS-180 vector.
    expect(sha1Hex(utf8ToBytes('a'.repeat(1_000_000)))).toBe('34AA973CD4C4DAA4F61EEB2BDBAD27316534016F');
  });
});

describe('parseArmoredPublicKey', () => {
  it('reads fingerprint, email, and user id from a real GnuPG v4 key', () => {
    const key = parseArmoredPublicKey(ADA_ARMORED);
    expect(key.fingerprint).toBe(ADA_FINGERPRINT);
    expect(key.email).toBe(ADA_EMAIL);
    expect(key.userId).toBe(ADA_USERID);
    expect(key.version).toBe(4);
  });

  it('tolerates surrounding prose and whitespace around the block', () => {
    const messy = `Hi! here is my key, please add it:\n\n   ${ADA_ARMORED}   \n\ncheers`;
    expect(parseArmoredPublicKey(messy).fingerprint).toBe(ADA_FINGERPRINT);
  });

  it('lower-cases the email but preserves user-id case', () => {
    const key = parseArmoredPublicKey(ADA_ARMORED);
    expect(key.email).toBe(key.email.toLowerCase());
    expect(key.userId).toContain('Ada Lovelace');
  });

  it('rejects text that is not an armored key block', () => {
    expect(() => parseArmoredPublicKey('just some words')).toThrow(/armored public key/i);
  });

  it('rejects a block that carries no public-key packet', () => {
    // A single 0x00 byte is not a valid packet header, so no key packet is found.
    const noKey = [
      '-----BEGIN PGP PUBLIC KEY BLOCK-----',
      '',
      bytesToBase64(Uint8Array.from([0])),
      '=AAAA',
      '-----END PGP PUBLIC KEY BLOCK-----',
    ].join('\n');
    expect(() => parseArmoredPublicKey(noKey)).toThrow(/public-key packet/i);
  });

  it('rejects an unsupported key version rather than inventing a fingerprint', () => {
    // Old-format public-key packet (tag 6), length 5, version byte = 99.
    const body = Uint8Array.from([99, 0, 0, 0, 0]);
    const packet = Uint8Array.from([0x98, body.length, ...body]); // 0x98 = old fmt, tag 6, 1-octet len
    const block = [
      '-----BEGIN PGP PUBLIC KEY BLOCK-----',
      '',
      bytesToBase64(packet),
      '=AAAA',
      '-----END PGP PUBLIC KEY BLOCK-----',
    ].join('\n');
    expect(() => parseArmoredPublicKey(block)).toThrow(/version/i);
  });
});

describe('userIdDisplayName', () => {
  it('extracts the name portion before the angle-bracketed address', () => {
    expect(userIdDisplayName('Ada Lovelace <ada@example.com>')).toBe('Ada Lovelace');
  });

  it('returns undefined for a bare address', () => {
    expect(userIdDisplayName('ada@example.com')).toBeUndefined();
  });

  it('ignores the CryptMail demo comment so demo keys are not misnamed', () => {
    expect(userIdDisplayName('CryptMail demo key <ada@example.com>')).toBeUndefined();
  });
});
