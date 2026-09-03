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

  it('records no key change, because there is no key it replaced', () => {
    const keyring = upsertKey({}, ANYA, 'autocrypt');
    expect(keyring[ANYA.email].changedAt).toBeUndefined();
    expect(keyring[ANYA.email].previousFingerprint).toBeUndefined();
  });

  it('records a keyserver key as trusted on first use and nothing more', () => {
    // A keyserver is a party that can hand out the wrong key. Nothing it says
    // can amount to verification; only comparing a safety number does.
    const keyring = upsertKey({}, ANYA, 'directory');
    expect(keyring[ANYA.email].source).toBe('directory');
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

  it('records when it changed, and what it replaced', () => {
    // The trust mark is the *current* state and moves on the moment the new key
    // is verified. This is the history behind it, and the contacts dashboard is
    // what reads it (`contacts/contacts.ts`).
    const after = upsertKey(verified, ANYA_ROTATED, 'autocrypt')[ANYA.email];
    expect(after.previousFingerprint).toBe(ANYA.fingerprint);
    expect(Date.parse(after.changedAt ?? '')).not.toBeNaN();
  });

  it('keeps that record when the new key is later verified and seen again', () => {
    const changed = upsertKey(verified, ANYA_ROTATED, 'autocrypt');
    const nowVerified: Keyring = {
      [ANYA.email]: { ...changed[ANYA.email], trust: 'verified', verifiedAt: '2026-03-03T00:00:00.000Z' },
    };
    const after = upsertKey(nowVerified, ANYA_ROTATED, 'autocrypt')[ANYA.email];
    expect(after.trust).toBe('verified');
    expect(after.changedAt).toBe(changed[ANYA.email].changedAt);
    expect(after.previousFingerprint).toBe(ANYA.fingerprint);
  });

  it('blocks the same way whether the key arrived by header or by keyserver', () => {
    // Discovery makes this the common path: once every client fetches every
    // key, a keyserver quietly swapping one is the attack that matters.
    expect(upsertKey(verified, ANYA_ROTATED, 'directory')[ANYA.email].trust).toBe('changed');
  });
});

/**
 * Self-authenticated rotation (docs/key-management.md, "Key rotation").
 *
 * A key change signed by the key it replaces is something only its holder could
 * produce, so it is a rotation and not a substitution. Without that signature
 * the two are indistinguishable and rule 1 applies.
 *
 * Producing the evidence is a core operation and needs the Rust core; the trust
 * transition it drives is here, tested, and every caller passes `none` today.
 */
describe('a key change that proves it is a rotation', () => {
  const seen: Keyring = upsertKey({}, ANYA, 'autocrypt');

  it('is accepted, and lands at trust-on-first-use', () => {
    const after = upsertKey(seen, ANYA_ROTATED, 'autocrypt', undefined, { rotation: 'self-signed' });
    expect(after[ANYA.email].trust).toBe('seen');
    expect(after[ANYA.email].fingerprint).toBe(ANYA_ROTATED.fingerprint);
  });

  it('is still recorded as a key change, because that is what it is', () => {
    // The evidence decides whether the change *blocks*, not whether it happened.
    const after = upsertKey(seen, ANYA_ROTATED, 'manual', undefined, { rotation: 'self-signed' })[ANYA.email];
    expect(after.previousFingerprint).toBe(ANYA.fingerprint);
    expect(after.changedAt).toBeTruthy();
  });

  it('is not treated as verified — nobody compared the new safety number', () => {
    const wasVerified: Keyring = {
      [ANYA.email]: { ...seen[ANYA.email], trust: 'verified', verifiedAt: '2026-01-02T00:00:00.000Z' },
    };
    const after = upsertKey(wasVerified, ANYA_ROTATED, 'manual', undefined, { rotation: 'self-signed' });
    expect(after[ANYA.email].trust).toBe('seen');
    expect(after[ANYA.email].verifiedAt).toBeUndefined();
  });

  it('blocks when the evidence is absent, which is today’s behaviour', () => {
    expect(upsertKey(seen, ANYA_ROTATED, 'autocrypt', undefined, { rotation: 'none' })[ANYA.email].trust).toBe(
      'changed',
    );
    expect(upsertKey(seen, ANYA_ROTATED, 'autocrypt')[ANYA.email].trust).toBe('changed');
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
