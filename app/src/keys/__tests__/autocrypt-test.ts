/**
 * Harvesting keys from `Autocrypt` headers.
 *
 * Two properties carry weight here. A header that is malformed, truncated or
 * lying about whose key it carries must leave the keyring exactly as it was —
 * this runs during inbox sync, and one bad message cannot be allowed to break
 * it. And a header bearing a *different* key for an address already on file has
 * to reach `changed`, because that is the rule-1 signal that stops a send.
 */
import { fakePublicKey } from '../../core/demoCore';
import { encodeUtf8Base64 } from '../../lib/base64';
import { ADA_ARMORED, ADA_EMAIL, ADA_FINGERPRINT } from '../../pgp/__tests__/fixtures';
import { Keyring, upsertKey } from '../../store/keyring';
import { autocryptKeyFrom, harvestAutocrypt } from '../autocrypt';

const BOB = 'bob@example.com';
const BOB_FP = '11112222333344445555666677778888AAAABBBB';
const BOB_ROTATED_FP = '99998888777766665555444433332222CCCCDDDD';

const bobKey = fakePublicKey(BOB, BOB_FP);
const bobRotatedKey = fakePublicKey(BOB, BOB_ROTATED_FP);

/** The header CryptMail itself emits: base64 of the *armored* key. */
const header = (addr: string, armored: string) =>
  `addr=${addr}; prefer-encrypt=mutual; keydata=${encodeUtf8Base64(armored)}`;

describe('autocryptKeyFrom', () => {
  it('reads back a header CryptMail emitted', () => {
    expect(autocryptKeyFrom(header(BOB, bobKey), BOB)).toBe(bobKey);
  });

  it('accepts an already-armored block, which is what parseEncrypted hands over', () => {
    expect(autocryptKeyFrom(bobKey, BOB)).toBe(bobKey);
  });

  it('armors raw key packets, the shape the Autocrypt spec actually specifies', () => {
    // Base64 of the binary key, not of the armored text — every other client.
    const raw = ADA_ARMORED.split('\n')
      .filter((l) => !l.startsWith('-----') && !l.startsWith('=') && l.trim() !== '')
      .join('');
    const armored = autocryptKeyFrom(`addr=${ADA_EMAIL}; keydata=${raw}`, ADA_EMAIL);
    expect(armored).toContain('BEGIN PGP PUBLIC KEY BLOCK');
  });

  it('ignores a header whose addr is not the sender — anyone could claim any address', () => {
    expect(autocryptKeyFrom(header(BOB, bobKey), 'someone-else@example.com')).toBeUndefined();
  });

  it('returns nothing for a header with no keydata, and for junk', () => {
    expect(autocryptKeyFrom(`addr=${BOB}; prefer-encrypt=mutual`, BOB)).toBeUndefined();
    expect(autocryptKeyFrom('', BOB)).toBeUndefined();
    expect(autocryptKeyFrom('addr=b; keydata=%%%not base64%%%', 'b')).toBeUndefined();
  });
});

describe('harvestAutocrypt', () => {
  it('adds a key from a valid header, marked as coming from Autocrypt', async () => {
    const keyring = await harvestAutocrypt({}, BOB, header(BOB, bobKey), 'Bob');
    expect(keyring[BOB].fingerprint).toBe(BOB_FP);
    expect(keyring[BOB].source).toBe('autocrypt');
    expect(keyring[BOB].trust).toBe('seen');
    expect(keyring[BOB].name).toBe('Bob');
  });

  it('reads a real OpenPGP key out of a header', async () => {
    const keyring = await harvestAutocrypt({}, ADA_EMAIL, header(ADA_EMAIL, ADA_ARMORED));
    expect(keyring[ADA_EMAIL].fingerprint).toBe(ADA_FINGERPRINT);
  });

  it('leaves the keyring untouched for a malformed header, and does not throw', async () => {
    const before: Keyring = upsertKey({}, { email: BOB, fingerprint: BOB_FP, armored: bobKey }, 'manual');
    for (const bad of ['', 'addr=bob@example.com; keydata=zzzz', 'not a header at all']) {
      await expect(harvestAutocrypt(before, BOB, bad)).resolves.toBe(before);
    }
  });

  it('does nothing when there is no header at all', async () => {
    const before: Keyring = {};
    await expect(harvestAutocrypt(before, BOB, undefined)).resolves.toBe(before);
  });

  it('marks a known address changed when the fingerprint differs', async () => {
    const before = await harvestAutocrypt({}, BOB, header(BOB, bobKey));
    const after = await harvestAutocrypt(before, BOB, header(BOB, bobRotatedKey));
    expect(after[BOB].trust).toBe('changed');
    expect(after[BOB].fingerprint).toBe(BOB_ROTATED_FP);
  });
});
