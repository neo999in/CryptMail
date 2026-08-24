/**
 * Undo send — scheduling a near-future send and cancelling it.
 *
 * Tests the undo-send flow end-to-end through the real service graph:
 *
 *  · `scheduleSend` with a short delay puts the message in the outbox.
 *  · `cancelScheduled` removes it, and a draft can be restored.
 *  · `run()` delivers the message when the due time arrives.
 *
 * The stores are stubbed (same reason as send-test.ts).
 */
import { ADA_ARMORED } from '../../pgp/__tests__/fixtures';
import { Session } from '../../auth';
import { Identity } from '../../core';
import { MailClient } from '../../mail/types';
import { holdReason } from '../../outbox/outbox';
import { ContactKey } from '../../store/keyring';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { State } from '../types';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../keys', () => ({
  directory: {
    listedAt: 'the test directory',
    lookup: jest.fn(async () => null),
    publish: jest.fn(),
  },
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

jest.mock('../../store/draftsStore', () => ({
  ...jest.requireActual('../../store/draftsStore'),
  saveDrafts: jest.fn(async () => {}),
  loadDrafts: jest.fn(async () => ({})),
}));

const SESSION: Session = {
  provider: 'demo',
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

const contact = (): ContactKey => ({
  email: 'ada@example.com',
  fingerprint: '9999888877776666555544443333222211110000',
  armored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nada\n-----END PGP PUBLIC KEY BLOCK-----',
  trust: 'seen',
  source: 'manual',
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-01T00:00:00.000Z',
});

const MESSAGE = {
  id: 'draft-undo-1',
  to: ['ada@example.com'],
  subject: 'Quarterly numbers',
  body: 'Attached, as promised.',
};

function harness(over: Partial<State> = {}) {
  const wire: string[] = [];
  const store = createStore(
    { ...initialState(), booting: false, session: SESSION, identity: IDENTITY, ...over },
    () => {},
  );
  const { services, mail } = createServices(store);

  const client: MailClient = {
    kind: 'demo',
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

describe('undo send — scheduleSend with a short delay', () => {
  afterEach(() => {
    // Clear the one-shot timer the scheduler sets for near-future sends,
    // so it does not hold the process open after the test finishes.
    jest.clearAllTimers();
  });
  it('places the message in the outbox with reason=time', async () => {
    const { services, store } = harness({ keyring: { 'ada@example.com': contact() } });

    const sendAt = new Date(Date.now() + 5_000).toISOString();
    await services.scheduler.scheduleSend({ ...MESSAGE, sendAt });

    const items = Object.values(store.get().scheduled);
    expect(items).toHaveLength(1);
    expect(holdReason(items[0])).toBe('time');
    expect(items[0].sendAt).toBe(sendAt);
    expect(items[0].subject).toBe(MESSAGE.subject);
  });

  it('cancelScheduled removes the message from the outbox', async () => {
    const { services, store } = harness({ keyring: { 'ada@example.com': contact() } });

    const sendAt = new Date(Date.now() + 5_000).toISOString();
    await services.scheduler.scheduleSend({ ...MESSAGE, sendAt });

    const [id] = Object.keys(store.get().scheduled);
    await services.scheduler.cancelScheduled(id);

    expect(store.get().scheduled).toEqual({});
  });

  it('undo within window leaves nothing in the mailbox', async () => {
    const { services, store, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    const sendAt = new Date(Date.now() + 5_000).toISOString();
    await services.scheduler.scheduleSend({ ...MESSAGE, sendAt });

    const [id] = Object.keys(store.get().scheduled);
    await services.scheduler.cancelScheduled(id);

    // Nothing should have been sent
    expect(wire).toHaveLength(0);
    expect(store.get().scheduled).toEqual({});
  });

  it('undo restores the message as a draft', async () => {
    const { services, store } = harness({ keyring: { 'ada@example.com': contact() } });

    const sendAt = new Date(Date.now() + 5_000).toISOString();
    await services.scheduler.scheduleSend({ ...MESSAGE, sendAt });

    const [id] = Object.keys(store.get().scheduled);

    // Simulate undo: cancel scheduled + save as draft
    await services.scheduler.cancelScheduled(id);
    await services.drafts.saveDraft({
      id,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      body: MESSAGE.body,
      updatedAt: new Date().toISOString(),
    });

    expect(store.get().scheduled).toEqual({});
    expect(store.get().drafts[id]).toBeDefined();
    expect(store.get().drafts[id].subject).toBe(MESSAGE.subject);
  });

  it('delivers exactly once when the due time arrives', async () => {
    const { services, store, wire } = harness({ keyring: { 'ada@example.com': contact() } });

    // Schedule a message that is already due (sendAt in the past). This is
    // exactly what happens when the scheduler tick fires after the undo window
    // expires: the outbox entry's sendAt is in the past and `dueScheduled`
    // picks it up.
    const sendAt = new Date(Date.now() - 1_000).toISOString();
    await services.scheduler.scheduleSend({ ...MESSAGE, sendAt });

    expect(Object.keys(store.get().scheduled)).toHaveLength(1);
    expect(wire).toHaveLength(0);

    await services.scheduler.run();

    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain('multipart/encrypted');
    expect(store.get().scheduled).toEqual({});
  });
});
