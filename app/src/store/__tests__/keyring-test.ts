/**
 * Keyring trust transitions (docs/key-management.md, "Trust levels").
 *
 * The rule that carries weight: a key that arrives with a *different*
 * fingerprint for a known address is `changed`, never silently accepted — and
 * it must not inherit the verification of the key it replaced.
 */
import { PublicKeyInfo } from '../../core';
import { findKey, Keyring, removeKey, upsertKey } from '../keyring';

const ANYA: PublicKeyInfo = {
  email: 'anya@partner.com',
  fingerprint: '4F2A9C71E3081BD577A03E6CB2940F8AD5C36A1982EF4471',
  armored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nanya\n-----END PGP PUBLIC KEY BLOCK-----',
};

/** Same address, different key — a new device, or an attacker. */
const ANYA_ROTATED: PublicKeyInfo = { ...ANYA, fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666' };

describe('adding a key', () => {
  it('starts at trust-on-first-use', () => {
    const keyring = upsertKey({}, ANYA, 'autocrypt');
    expect(keyring[ANYA.email].trust).toBe('seen');
    expect(keyring[ANYA.email].verifiedAt).toBeUndefined();
  });

  it('keeps the first-seen time when the same key is seen again', () => {
    const first = upsertKey({}, ANYA, 'autocrypt');
    const again = upsertKey(first, ANYA, 'autocrypt');
    expect(again[ANYA.email].firstSeen).toBe(first[ANYA.email].firstSeen);
  });

  it('does not downgrade a verified key that has not changed', () => {
    const verified: Keyring = {
      [ANYA.email]: {
        ...ANYA,
        trust: 'verified',
        source: 'manual',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
        verifiedAt: '2026-01-02T00:00:00.000Z',
      },
    };
    const after = upsertKey(verified, ANYA, 'autocrypt');
    expect(after[ANYA.email].trust).toBe('verified');
    expect(after[ANYA.email].verifiedAt).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('when the fingerprint changes', () => {
  const verified: Keyring = {
    [ANYA.email]: {
      ...ANYA,
      trust: 'verified',
      source: 'manual',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      verifiedAt: '2026-01-02T00:00:00.000Z',
    },
  };

  it('marks the key changed rather than accepting it', () => {
    expect(upsertKey(verified, ANYA_ROTATED, 'autocrypt')[ANYA.email].trust).toBe('changed');
  });

  it('drops the old verification, which attested to the old key', () => {
    // Otherwise the UI shows "compared 2 January" beside a key nobody checked.
    expect(upsertKey(verified, ANYA_ROTATED, 'autocrypt')[ANYA.email].verifiedAt).toBeUndefined();
  });

  it('stores the new key material, so the change is visible', () => {
    expect(upsertKey(verified, ANYA_ROTATED, 'autocrypt')[ANYA.email].fingerprint).toBe(
      ANYA_ROTATED.fingerprint,
    );
  });
});

describe('lookup', () => {
  const keyring = upsertKey({}, ANYA, 'manual');

  it('is case-insensitive and ignores surrounding space', () => {
    expect(findKey(keyring, '  Anya@Partner.com ')).toBeDefined();
  });

  it('returns nothing for an address with no key', () => {
    expect(findKey(keyring, 'nobody@example.com')).toBeUndefined();
  });

  it('forgets a key completely', () => {
    expect(findKey(removeKey(keyring, ANYA.email), ANYA.email)).toBeUndefined();
  });
});
