/**
 * The send path — rule 1.
 *
 * `deliver` has exactly three outcomes and plaintext is not one of them, so this
 * tests all three against the real service graph: a fake `MailClient` collects
 * whatever would go on the wire, and every assertion about "not sent in the
 * clear" is made against those bytes rather than against an intermediate value.
 *
 * The stores are stubbed because they seal their contents with a device key that
 * only exists after `initStorage`; the logic under test is indifferent to where
 * the outbox is written, and their own behaviour is covered next to them.
 */
import { ADA_ARMORED } from '../../pgp/__tests__/fixtures';
import { Session } from '../../auth';
import { Identity, PLACEHOLDER_SUBJECT } from '../../core';
import { MailClient } from '../../mail/types';
import { holdReason } from '../../outbox/outbox';
import { ContactKey } from '../../store/keyring';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { State } from '../types';

/** Referenced only inside function bodies, so `jest.mock` may hoist above it. */
const mockLookup = jest.fn<Promise<{ armored: string } | null>, [string]>();

// Reached through `config.ts` and the auth provider; it is a native module and
// there is no native binary under jest.
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../keys', () => ({
  directory: {
    listedAt: 'the test directory',
    lookup: (email: string) => mockLookup(email),
    publish: jest.fn(),
  },
  // The harvest is the inbox's business, not the send path's.
  harvestAutocrypt: jest.fn(async (keyring: unknown) => keyring),
}));

jest.mock('../../store/keyring', () => ({
  ...jest.requireActual('../../store/keyring'),
  saveKeyring: jest.fn(async () => {}),
  loadKeyring: jest.fn(async () => ({})),
}));

jest.mock('../../store/outboxStore', () => ({
  ...jest.requireActual('../../store/outboxStore'),
  saveOutbox: jest.fn(async () => {}),
  loadOutbox: jest.fn(async () => ({})),
}));

jest.mock('../../store/inviteStore', () => ({
  ...jest.requireActual('../../store/inviteStore'),
  saveInvites: jest.fn(async () => {}),
  loadInvites: jest.fn(async () => ({})),
}));

const SESSION: Session = {
  provider: 'gmail',
  email: 'me@example.com',
  accessToken: 'token',
  expiresAt: Date.now() + 3_600_000,
};

const IDENTITY: Identity = {
  email: 'me@example.com',
  fingerprint: '080C45453D89F0655C84569DB4922B2C8B0DF22B',
  publicKeyArmored: ADA_ARMORED,
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

const MESSAGE = { to: ['ada@example.com'], subject: 'Quarterly numbers', body: 'Attached, as promised.' };

function harness(over: Partial<State> = {}) {
  const wire: string[] = [];
  const store = createStore(
    { ...initialState(), booting: false, session: SESSION, identity: IDENTITY, ...over },
    () => {},
  );
  const { services, mail } = createServices(store);

  const client: MailClient = {
    kind: 'gmail',
    address: SESSION.email,
    listInbox: async () => [],
    getRaw: async () => '',
    send: async (rfc822) => {
      wire.push(rfc822);
    },
    updateFlags: async () => {},
  };
  mail.current = client;

  return { store, services, wire };
}

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue(null);
});

describe('deliver — every recipient has a key', () => {
  it('encrypts and sends, and queues nothing', async () => {
    const { services, store, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    const outcome = await services.send.sendEncrypted(MESSAGE);

    expect(outcome).toEqual({ status: 'sent' });
    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain('multipart/encrypted');
    expect(store.get().scheduled).toEqual({});
  });

  it('puts neither the subject nor the body on the wire', async () => {
    const { services, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    await services.send.sendEncrypted(MESSAGE);

    expect(wire[0]).toContain(PLACEHOLDER_SUBJECT);
    expect(wire[0]).not.toContain(MESSAGE.subject);
    expect(wire[0]).not.toContain(MESSAGE.body);
  });
});

describe('deliver — a recipient has no key', () => {
  it('holds the message rather than sending it', async () => {
    const { services, store, wire } = harness();

    const outcome = await services.send.sendEncrypted(MESSAGE);

    expect(outcome).toEqual({ status: 'queued', pending: ['ada@example.com'] });

    const held = Object.values(store.get().scheduled);
    expect(held).toHaveLength(1);
    expect(holdReason(held[0])).toBe('awaiting-key');
    expect(held[0]).toMatchObject({ subject: MESSAGE.subject, body: MESSAGE.body, pending: ['ada@example.com'] });

    // One email left the device, and it is the invite — never the message.
    expect(wire).toHaveLength(1);
    expect(wire[0]).not.toContain(MESSAGE.subject);
    expect(wire[0]).not.toContain(MESSAGE.body);
  });

  it('invites them, carrying our key and nothing about the message', async () => {
    const { services, store, wire } = harness();

    await services.send.sendEncrypted(MESSAGE);

    expect(wire[0]).toContain('To: ada@example.com');
    expect(wire[0]).toContain('An encrypted message is waiting for you');
    expect(wire[0]).toContain('Autocrypt:');
    expect(store.get().invites['ada@example.com']).toBeDefined();
  });

  it('does not invite the same address twice for a second held message', async () => {
    const { services, wire } = harness();

    await services.send.sendEncrypted(MESSAGE);
    await services.send.sendEncrypted({ ...MESSAGE, subject: 'One more thing' });

    expect(wire).toHaveLength(1);
  });

  it('replaces the same outbox entry when a held message is retried', async () => {
    const { services, store } = harness();

    await services.send.sendEncrypted(MESSAGE);
    const [id] = Object.keys(store.get().scheduled);

    const outcome = await services.scheduler.sendScheduledNow(id);

    expect(outcome).toEqual({ status: 'queued', pending: ['ada@example.com'] });
    expect(Object.keys(store.get().scheduled)).toEqual([id]);
  });

  it('delivers the held message once a key turns up', async () => {
    const { services, store, wire } = harness();
    await services.send.sendEncrypted(MESSAGE);
    const [id] = Object.keys(store.get().scheduled);

    store.patch({ keyring: { 'ada@example.com': contact() } });
    await services.scheduler.drainHeld();

    expect(store.get().scheduled).toEqual({});
    expect(wire).toHaveLength(2);
    expect(wire[1]).toContain('multipart/encrypted');
    expect(id).toBeDefined();
  });
});

describe('deliver — a recipient key changed fingerprint', () => {
  it('refuses outright: nothing sent, nothing queued', async () => {
    const { services, store, wire } = harness({
      keyring: { 'ada@example.com': contact({ trust: 'changed' }) },
    });

    await expect(services.send.sendEncrypted(MESSAGE)).rejects.toThrow(/changed fingerprint/);

    expect(wire).toEqual([]);
    expect(store.get().scheduled).toEqual({});
  });

  it('will not schedule one for later either', async () => {
    const { services, store } = harness({
      keyring: { 'ada@example.com': contact({ trust: 'changed' }) },
    });

    await expect(
      services.scheduler.scheduleSend({ ...MESSAGE, sendAt: '2099-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(/changed fingerprint/);

    expect(store.get().scheduled).toEqual({});
  });
});

describe('sendPlain', () => {
  it('sends in the clear, because that is what the user asked for', async () => {
    const { services, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    await services.send.sendPlain(MESSAGE);

    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain(MESSAGE.subject);
    expect(wire[0]).toContain(MESSAGE.body);
    expect(wire[0]).not.toContain('multipart/encrypted');
  });

  it('never branches on the recipient\'s key state', async () => {
    // No keyring, so the encrypted path would have held this and gone to the
    // directory. A plaintext send must do neither.
    const { services, store } = harness();

    await services.send.sendPlain(MESSAGE);

    expect(mockLookup).not.toHaveBeenCalled();
    expect(store.get().scheduled).toEqual({});
  });

  it('still carries our own Autocrypt header', async () => {
    const { services, wire } = harness();

    await services.send.sendPlain(MESSAGE);

    expect(wire[0]).toContain('Autocrypt:');
  });
});

describe('deliver — threading rides on the wire (feature 0.7)', () => {
  const THREADING = {
    inReplyTo: '<orig-42@partner.com>',
    references: ['<root-1@partner.com>', '<orig-42@partner.com>'],
  };

  it('emits In-Reply-To / References on the envelope while the real subject stays hidden', async () => {
    const { services, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    await services.send.sendEncrypted({ ...MESSAGE, ...THREADING });

    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain('In-Reply-To: <orig-42@partner.com>');
    expect(wire[0]).toContain('References: <root-1@partner.com> <orig-42@partner.com>');
    // Threading is provider metadata and rides in the clear; the message itself
    // still does not — the subject is the placeholder, the body absent.
    expect(wire[0]).toContain(PLACEHOLDER_SUBJECT);
    expect(wire[0]).not.toContain(MESSAGE.subject);
    expect(wire[0]).not.toContain(MESSAGE.body);
  });

  it('threads a plaintext reply too', async () => {
    const { services, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    await services.send.sendPlain({ ...MESSAGE, ...THREADING });

    expect(wire[0]).toContain('In-Reply-To: <orig-42@partner.com>');
    expect(wire[0]).toContain('References: <root-1@partner.com> <orig-42@partner.com>');
  });
});

describe('deliver — Reply-All to a mix of keyed and keyless recipients (rule 1)', () => {
  const REPLY_ALL = {
    to: ['ada@example.com', 'stranger@example.com'],
    subject: 'Re: Quarterly numbers',
    body: 'Looping in the team.',
    inReplyTo: '<orig-42@partner.com>',
    references: ['<orig-42@partner.com>'],
  };

  it('holds the whole reply and preserves its threading, putting nothing in the clear', async () => {
    // ada has a key; stranger does not — so the send is held for everyone, not
    // split into "encrypt the ones we can". The reply must not go out plaintext.
    const { services, store, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    const outcome = await services.send.sendEncrypted(REPLY_ALL);

    expect(outcome).toEqual({ status: 'queued', pending: ['stranger@example.com'] });

    const held = Object.values(store.get().scheduled);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      to: REPLY_ALL.to,
      inReplyTo: REPLY_ALL.inReplyTo,
      references: REPLY_ALL.references,
      pending: ['stranger@example.com'],
    });

    // Only the contentless invite left the device — never the reply, and the
    // invite is its own message, so it carries no thread headers.
    expect(wire).toHaveLength(1);
    expect(wire[0]).not.toContain(REPLY_ALL.body);
    expect(wire[0]).not.toContain('In-Reply-To:');
  });

  it('a changed key among the recipients blocks the whole reply outright', async () => {
    const { services, store, wire } = harness({
      keyring: {
        'ada@example.com': contact(),
        'stranger@example.com': contact({ email: 'stranger@example.com', trust: 'changed' }),
      },
    });

    await expect(services.send.sendEncrypted(REPLY_ALL)).rejects.toThrow(/changed fingerprint/);

    expect(wire).toEqual([]);
    expect(store.get().scheduled).toEqual({});
  });
});
