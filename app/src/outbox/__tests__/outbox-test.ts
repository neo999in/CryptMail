import { Identity, PublicKeyInfo } from '../../core';
import { Keyring, upsertKey } from '../../store/keyring';
import {
  dueScheduled,
  Held,
  listScheduled,
  removeScheduled,
  resolvableHeld,
  ScheduledOutbox,
  stillPending,
  upsertScheduled,
} from '../outbox';

function item(id: string, sendAt: string, over: Partial<Held> = {}): Held {
  return { id, to: ['a@b.com'], subject: 's', body: 'b', sendAt, ...over };
}

describe('listScheduled', () => {
  test('orders by sendAt, soonest first', () => {
    const o: ScheduledOutbox = {
      a: item('a', '2026-07-23T12:00:00Z'),
      b: item('b', '2026-07-23T09:00:00Z'),
      c: item('c', '2026-07-23T10:00:00Z'),
    };
    expect(listScheduled(o).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  test('is empty for an empty outbox', () => {
    expect(listScheduled({})).toEqual([]);
  });
});

describe('dueScheduled', () => {
  const o: ScheduledOutbox = {
    past: item('past', '2026-07-23T08:00:00Z'),
    now: item('now', '2026-07-23T10:00:00Z'),
    future: item('future', '2026-07-23T12:00:00Z'),
  };

  test('returns items at or before now, soonest first', () => {
    expect(dueScheduled(o, '2026-07-23T10:00:00Z').map((s) => s.id)).toEqual(['past', 'now']);
  });

  test('excludes future items', () => {
    expect(dueScheduled(o, '2026-07-23T09:00:00Z').map((s) => s.id)).toEqual(['past']);
  });

  test('is empty when nothing is due yet', () => {
    expect(dueScheduled(o, '2026-07-23T07:00:00Z')).toEqual([]);
  });
});

describe('upsertScheduled / removeScheduled', () => {
  test('upsert adds an item without mutating the input', () => {
    const before: ScheduledOutbox = {};
    const next = upsertScheduled(before, item('a', '2026-07-23T10:00:00Z'));
    expect(next.a.id).toBe('a');
    expect(before).toEqual({});
  });

  test('remove deletes an item without mutating the input', () => {
    const before: ScheduledOutbox = { a: item('a', '2026-07-23T10:00:00Z') };
    const next = removeScheduled(before, 'a');
    expect(next.a).toBeUndefined();
    expect(before.a).toBeDefined();
  });

  test('remove is a no-op for an unknown id', () => {
    const before: ScheduledOutbox = { a: item('a', '2026-07-23T10:00:00Z') };
    expect(Object.keys(removeScheduled(before, 'x'))).toEqual(['a']);
  });
});

/* ------------------------------------------------- messages held for a key -- */

const keyFor = (email: string, fingerprint: string): PublicKeyInfo => ({
  email,
  fingerprint,
  armored: `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${email}\n-----END PGP PUBLIC KEY BLOCK-----`,
});

const ring = (...emails: string[]): Keyring =>
  emails.reduce<Keyring>((k, e, i) => upsertKey(k, keyFor(e, `FFFF000${i}`), 'directory'), {});

/** Same address, second key, no proof of rotation — the `changed` state. */
const withChanged = (email: string): Keyring =>
  upsertKey(ring(email), keyFor(email, 'DDDD9999'), 'directory');

const held = (id: string, to: string[]): Held => ({
  id,
  to,
  subject: 's',
  body: 'b',
  sendAt: '2026-07-23T10:00:00Z',
  reason: 'awaiting-key',
  pending: to,
});

describe('holding a message for a key', () => {
  test('the clock never releases an awaiting-key message', () => {
    // Its sendAt is when it was written, which is always in the past. Releasing
    // on time would send it to someone who still cannot read it.
    const outbox: ScheduledOutbox = { a: held('a', ['nokey@x.com']) };
    expect(dueScheduled(outbox, '2030-01-01T00:00:00Z')).toEqual([]);
  });

  test('a time-scheduled message with no reason field still behaves as before', () => {
    const outbox: ScheduledOutbox = { a: item('a', '2026-07-23T08:00:00Z') };
    expect(dueScheduled(outbox, '2026-07-23T10:00:00Z').map((s) => s.id)).toEqual(['a']);
  });
});

describe('resolvableHeld', () => {
  test('releases a message once every recipient has a key', () => {
    const outbox: ScheduledOutbox = { a: held('a', ['one@x.com', 'two@x.com']) };
    expect(resolvableHeld(outbox, ring('one@x.com', 'two@x.com')).map((h) => h.id)).toEqual(['a']);
  });

  test('holds a message where one recipient of three is still missing', () => {
    const outbox: ScheduledOutbox = { a: held('a', ['one@x.com', 'two@x.com', 'three@x.com']) };
    expect(resolvableHeld(outbox, ring('one@x.com', 'two@x.com'))).toEqual([]);
  });

  test('never releases a message to a key that changed fingerprint', () => {
    // Rule 1: a possible key substitution is not something waiting can fix, so
    // this message stays put until a person re-verifies the key.
    const outbox: ScheduledOutbox = { a: held('a', ['mitm@x.com']) };
    expect(resolvableHeld(outbox, withChanged('mitm@x.com'))).toEqual([]);
  });

  test('ignores time-scheduled messages — they are not its business', () => {
    const outbox: ScheduledOutbox = { a: item('a', '2026-07-23T08:00:00Z', { reason: 'time' }) };
    expect(resolvableHeld(outbox, ring('a@b.com'))).toEqual([]);
  });

  test('resolves the sender’s own address from the identity, not the keyring', () => {
    // Mailing yourself is the first thing anyone tries. The identity is never
    // written to the keyring, so without this the message would wait forever.
    const identity: Identity = {
      email: 'me@x.com',
      fingerprint: 'AAAA1111',
      publicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nme\n-----END PGP PUBLIC KEY BLOCK-----',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const outbox: ScheduledOutbox = { a: held('a', ['me@x.com', 'one@x.com']) };
    expect(resolvableHeld(outbox, ring('one@x.com'), identity).map((h) => h.id)).toEqual(['a']);
    expect(resolvableHeld(outbox, ring('one@x.com'))).toEqual([]);
  });
});

describe('stillPending', () => {
  test('names only the addresses that cannot be encrypted to yet', () => {
    expect(stillPending(held('a', ['one@x.com', 'gone@x.com']), ring('one@x.com'))).toEqual(['gone@x.com']);
  });

  test('counts a changed key as pending — it is not usable', () => {
    expect(stillPending(held('a', ['mitm@x.com']), withChanged('mitm@x.com'))).toEqual(['mitm@x.com']);
  });
});
