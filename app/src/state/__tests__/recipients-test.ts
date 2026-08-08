import { Identity } from '../../core';
import { ContactKey, Keyring } from '../../store/keyring';
import { resolveRecipientStates } from '../recipients';

const identity: Identity = {
  email: 'me@example.com',
  fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555',
  publicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmine\n-----END PGP PUBLIC KEY BLOCK-----',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const contact = (over: Partial<ContactKey> = {}): ContactKey => ({
  email: 'ada@example.com',
  fingerprint: '9999888877776666555544443333222211110000',
  armored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nada\n-----END PGP PUBLIC KEY BLOCK-----',
  trust: 'seen',
  source: 'manual',
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-01T00:00:00.000Z',
  ...over,
});

const keyring: Keyring = { 'ada@example.com': contact() };

describe('resolveRecipientStates', () => {
  it('reports an address with no key as missing', () => {
    expect(resolveRecipientStates(keyring, identity, ['nobody@example.com'])).toEqual([
      { email: 'nobody@example.com', status: 'missing' },
    ]);
  });

  it('reports a keyring contact as ok, carrying its key', () => {
    const [state] = resolveRecipientStates(keyring, identity, ['ada@example.com']);
    expect(state.status).toBe('ok');
    expect(state.key?.armored).toContain('ada');
  });

  it('reports a verified contact as verified', () => {
    const ring: Keyring = { 'ada@example.com': contact({ trust: 'verified' }) };
    expect(resolveRecipientStates(ring, identity, ['ada@example.com'])[0].status).toBe('verified');
  });

  it('reports a contact whose key changed as changed', () => {
    const ring: Keyring = { 'ada@example.com': contact({ trust: 'changed' }) };
    expect(resolveRecipientStates(ring, identity, ['ada@example.com'])[0].status).toBe('changed');
  });

  // The first-run wall: the identity is never written to the keyring, so
  // without this the very first thing a new user tries — mailing themselves —
  // is blocked by rule 1 as "no key".
  it('resolves this device s own address from the identity, not the keyring', () => {
    const [state] = resolveRecipientStates({}, identity, ['me@example.com']);
    expect(state.status).toBe('verified');
    expect(state.key?.armored).toBe(identity.publicKeyArmored);
    expect(state.key?.fingerprint).toBe(identity.fingerprint);
  });

  it('matches its own address regardless of case or surrounding space', () => {
    expect(resolveRecipientStates({}, identity, ['  ME@Example.com '])[0].status).toBe('verified');
  });

  it('prefers the identity over a stale keyring entry for its own address', () => {
    const stale: Keyring = { 'me@example.com': contact({ email: 'me@example.com', trust: 'changed' }) };
    const [state] = resolveRecipientStates(stale, identity, ['me@example.com']);
    expect(state.status).toBe('verified');
    expect(state.key?.fingerprint).toBe(identity.fingerprint);
  });

  it('reports every address as missing when there is no identity yet', () => {
    expect(resolveRecipientStates({}, null, ['me@example.com'])[0].status).toBe('missing');
  });
});
