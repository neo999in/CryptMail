import { MailSummary } from '../../mail/types';
import { ContactKey, Keyring, upsertKey } from '../../store/keyring';
import { buildContacts, searchContacts, trustSummary } from '../contacts';

const ME = 'me@gmail.com';

/** `from` is a bare address here — every case that cares about the display name passes `fromName`. */
function msg(
  over: Omit<Partial<MailSummary>, 'from'> & { from?: string; fromName?: string } = {},
): MailSummary {
  const { from, fromName, ...rest } = over;
  return {
    id: 'm1',
    from: { address: from ?? 'ada@example.com', name: fromName ?? 'Ada Lovelace' },
    to: [ME],
    date: '2026-08-01T10:00:00Z',
    subject: 'Hello',
    snippet: '',
    unread: false,
    starred: false,
    ...rest,
  };
}

function key(over: Partial<ContactKey> & { email: string }): ContactKey {
  return {
    fingerprint: 'AAAA1111BBBB2222',
    armored: '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    trust: 'seen',
    source: 'autocrypt',
    firstSeen: '2026-07-01T00:00:00Z',
    lastSeen: '2026-07-01T00:00:00Z',
    ...over,
  } as ContactKey;
}

const ring = (...keys: ContactKey[]): Keyring =>
  Object.fromEntries(keys.map((k) => [k.email, k])) as Keyring;

describe('buildContacts', () => {
  test('lists an address seen only in the mail, with no key', () => {
    const contacts = buildContacts({ keyring: {}, messages: [msg()], self: ME });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ email: 'ada@example.com', trust: 'none', received: 1 });
    expect(contacts[0].key).toBeUndefined();
  });

  test('lists a key with no mail behind it', () => {
    const contacts = buildContacts({
      keyring: ring(key({ email: 'grace@example.com', trust: 'verified' })),
      messages: [],
      self: ME,
    });
    expect(contacts.map((c) => c.email)).toEqual(['grace@example.com']);
    expect(contacts[0].trust).toBe('verified');
    expect(contacts[0].received).toBe(0);
  });

  test('one contact when an address is in both halves', () => {
    const contacts = buildContacts({
      keyring: ring(key({ email: 'ada@example.com' })),
      messages: [msg(), msg({ id: 'm2' })],
      self: ME,
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ trust: 'seen', received: 2 });
  });

  test('carries the trust state through for every kind of key', () => {
    const contacts = buildContacts({
      keyring: ring(
        key({ email: 'v@example.com', trust: 'verified' }),
        key({ email: 's@example.com', trust: 'seen' }),
        key({ email: 'c@example.com', trust: 'changed' }),
      ),
      messages: [msg({ from: 'n@example.com' })],
      self: ME,
    });
    expect(Object.fromEntries(contacts.map((c) => [c.email, c.trust]))).toEqual({
      'v@example.com': 'verified',
      's@example.com': 'seen',
      'c@example.com': 'changed',
      'n@example.com': 'none',
    });
  });

  test('never lists the signed-in address', () => {
    const contacts = buildContacts({ keyring: {}, messages: [msg({ to: [ME, 'x@e.com'] })], self: ME });
    expect(contacts.map((c) => c.email)).toEqual(['ada@example.com', 'x@e.com']);
  });

  test('excludes every address the account owns when several are connected', () => {
    const contacts = buildContacts({
      keyring: {},
      messages: [msg({ from: 'other@gmail.com', to: [ME] })],
      self: [ME, 'other@gmail.com'],
    });
    expect(contacts).toHaveLength(0);
  });

  test('counts received and addressed apart', () => {
    const contacts = buildContacts({
      keyring: {},
      messages: [
        msg({ id: 'a', from: 'ada@example.com', to: [ME, 'bob@example.com'] }),
        msg({ id: 'b', from: ME, to: ['ada@example.com'] }),
      ],
      self: ME,
    });
    const ada = contacts.find((c) => c.email === 'ada@example.com')!;
    const bob = contacts.find((c) => c.email === 'bob@example.com')!;
    expect(ada).toMatchObject({ received: 1, addressed: 1 });
    expect(bob).toMatchObject({ received: 0, addressed: 1 });
  });

  test('reads the address out of a full `Name <addr>` recipient header', () => {
    const contacts = buildContacts({
      keyring: {},
      messages: [msg({ from: ME, to: ['Ada Lovelace <Ada@Example.com>'] })],
      self: ME,
    });
    expect(contacts.map((c) => c.email)).toEqual(['ada@example.com']);
  });

  test('lastMessageAt is the newest message either way', () => {
    const contacts = buildContacts({
      keyring: {},
      messages: [
        msg({ id: 'old', date: '2026-01-01T00:00:00Z' }),
        msg({ id: 'new', date: '2026-08-09T00:00:00Z' }),
        msg({ id: 'mid', date: '2026-05-01T00:00:00Z' }),
      ],
      self: ME,
    });
    expect(contacts[0].lastMessageAt).toBe('2026-08-09T00:00:00Z');
  });

  test('the keyring name beats the display name on a From header', () => {
    const contacts = buildContacts({
      keyring: ring(key({ email: 'ada@example.com', name: 'A. Lovelace' })),
      messages: [msg()],
      self: ME,
    });
    expect(contacts[0].name).toBe('A. Lovelace');
  });

  test('falls back to the From display name when the key has none', () => {
    const contacts = buildContacts({ keyring: {}, messages: [msg()], self: ME });
    expect(contacts[0].name).toBe('Ada Lovelace');
  });

  test('junk senders are left out, but a junk sender that has a key is not', () => {
    const contacts = buildContacts({
      keyring: ring(key({ email: 'known@example.com' })),
      messages: [
        msg({ id: 'j1', from: 'spammer@example.com', labels: ['SPAM'] }),
        msg({ id: 'j2', from: 'known@example.com', labels: ['SPAM'] }),
      ],
      self: ME,
      isJunk: (m) => (m.labels ?? []).includes('SPAM'),
    });
    expect(contacts.map((c) => c.email)).toEqual(['known@example.com']);
    // Filed as junk, so it is not counted as correspondence either.
    expect(contacts[0].received).toBe(0);
  });

  test('sorted alphabetically by display name, not by trust', () => {
    const contacts = buildContacts({
      keyring: ring(key({ email: 'zoe@example.com', trust: 'changed' })),
      messages: [msg({ from: 'ada@example.com' })],
      self: ME,
    });
    expect(contacts.map((c) => c.email)).toEqual(['ada@example.com', 'zoe@example.com']);
  });

  test('surfaces when the key was first seen and when it changed', () => {
    const contacts = buildContacts({
      keyring: ring(
        key({
          email: 'ada@example.com',
          firstSeen: '2026-02-02T00:00:00Z',
          changedAt: '2026-06-06T00:00:00Z',
          previousFingerprint: 'OLD00000',
          trust: 'changed',
        }),
      ),
      messages: [],
      self: ME,
    });
    expect(contacts[0]).toMatchObject({
      keyFirstSeen: '2026-02-02T00:00:00Z',
      keyChangedAt: '2026-06-06T00:00:00Z',
      previousFingerprint: 'OLD00000',
    });
  });

  test('a key that changed keeps saying so after it is verified again', () => {
    // The whole point of `changedAt`: `trust` moves back off `changed`, and the
    // fact that this address once swapped fingerprints must survive it.
    let keyring = upsertKey({}, { email: 'ada@example.com', fingerprint: 'AAA', armored: 'a' }, 'autocrypt');
    keyring = upsertKey(keyring, { email: 'ada@example.com', fingerprint: 'BBB', armored: 'b' }, 'autocrypt');
    keyring = {
      ...keyring,
      'ada@example.com': { ...keyring['ada@example.com'], trust: 'verified' },
    };

    const contacts = buildContacts({ keyring, messages: [], self: ME });
    expect(contacts[0].trust).toBe('verified');
    expect(contacts[0].keyChangedAt).toBeTruthy();
    expect(contacts[0].previousFingerprint).toBe('AAA');
  });

  test('a key seen again unchanged reports no change at all', () => {
    let keyring = upsertKey({}, { email: 'ada@example.com', fingerprint: 'AAA', armored: 'a' }, 'autocrypt');
    keyring = upsertKey(keyring, { email: 'ada@example.com', fingerprint: 'AAA', armored: 'a' }, 'autocrypt');
    expect(buildContacts({ keyring, messages: [], self: ME })[0].keyChangedAt).toBeUndefined();
  });
});

describe('trustSummary', () => {
  test('counts each state and the total', () => {
    const contacts = buildContacts({
      keyring: ring(
        key({ email: 'v@e.com', trust: 'verified' }),
        key({ email: 's@e.com', trust: 'seen' }),
        key({ email: 's2@e.com', trust: 'seen' }),
        key({ email: 'c@e.com', trust: 'changed' }),
      ),
      messages: [msg({ from: 'n@e.com' })],
      self: ME,
    });
    expect(trustSummary(contacts)).toEqual({ total: 5, verified: 1, seen: 2, changed: 1, none: 1 });
  });

  test('an empty book is all zeroes', () => {
    expect(trustSummary([])).toEqual({ total: 0, verified: 0, seen: 0, changed: 0, none: 0 });
  });
});

describe('searchContacts', () => {
  const contacts = buildContacts({
    keyring: ring(key({ email: 'ada@example.com', name: 'Ada Lovelace' })),
    messages: [
      msg({ id: '1', from: 'grace@navy.mil', fromName: 'Grace Hopper', date: '2026-08-08T00:00:00Z' }),
      msg({ id: '2', from: 'katherine@nasa.gov', fromName: 'Katherine Johnson', date: '2026-08-09T00:00:00Z' }),
      msg({ id: '3', from: 'adalovelace@old.example', fromName: 'A. L.', date: '2026-01-01T00:00:00Z' }),
    ],
    self: ME,
  });

  test('an empty query suggests nothing', () => {
    expect(searchContacts(contacts, '   ')).toEqual([]);
  });

  test('matches on the address', () => {
    expect(searchContacts(contacts, 'grace').map((c) => c.email)).toEqual(['grace@navy.mil']);
  });

  test('matches on the name', () => {
    expect(searchContacts(contacts, 'lovelace').map((c) => c.email)).toContain('ada@example.com');
  });

  test('is case-insensitive', () => {
    expect(searchContacts(contacts, 'GRACE').map((c) => c.email)).toEqual(['grace@navy.mil']);
  });

  test('a prefix match outranks a substring match, even a more recent one', () => {
    const both = buildContacts({
      keyring: {},
      messages: [
        // Contains "nasa", and is the newer of the two — rank still decides.
        msg({ id: 'a', from: 'katherine@nasa.gov', fromName: 'K. J.', date: '2026-08-09T00:00:00Z' }),
        msg({ id: 'b', from: 'nasa-press@example.com', fromName: 'Press', date: '2026-01-01T00:00:00Z' }),
      ],
      self: ME,
    });
    expect(searchContacts(both, 'nasa').map((c) => c.email)).toEqual([
      'nasa-press@example.com',
      'katherine@nasa.gov',
    ]);
  });

  test('among equal ranks, the most recent correspondent comes first', () => {
    const recent = buildContacts({
      keyring: {},
      messages: [
        msg({ id: 'a', from: 'sam.old@example.com', date: '2026-01-01T00:00:00Z' }),
        msg({ id: 'b', from: 'sam.new@example.com', date: '2026-08-01T00:00:00Z' }),
      ],
      self: ME,
    });
    expect(searchContacts(recent, 'sam').map((c) => c.email)).toEqual([
      'sam.new@example.com',
      'sam.old@example.com',
    ]);
  });

  test('respects the limit', () => {
    expect(searchContacts(contacts, 'a', 1)).toHaveLength(1);
  });

  test('contacts with no key are suggested alongside the ones that have one', () => {
    // Ranking must not bury them: an invite is what they exist for.
    expect(searchContacts(contacts, 'katherine').map((c) => c.trust)).toEqual(['none']);
  });
});
