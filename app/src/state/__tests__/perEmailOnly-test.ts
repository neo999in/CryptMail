/**
 * Per-email keys only: nothing the user writes is ever sealed to a long-term
 * key, and first contact goes through a contentless handshake.
 *
 * Against the real service graph with the core faked, because what is under
 * test is the sequencing — hold, handshake, answer, drain — and every "nothing
 * leaked" assertion is made against the bytes a fake provider was handed.
 */
import { Session } from '../../auth';
import { HANDSHAKE_SUBJECT } from '../../core/mime';
import { DecryptedMessage, Identity } from '../../core';
import { MailClient } from '../../mail/types';
import { holdReason } from '../../outbox/outbox';
import { ContactKey } from '../../store/keyring';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem, State } from '../types';

type Status = 'self' | 'session' | 'offer' | 'none';

/** What the fake core reports per armored key; `self` for our own. */
const mockStatus = new Map<string, Status>();
/** What `parseEncrypted` returns for a raw message, by its text. */
const mockOpened = new Map<string, DecryptedMessage>();
const mockArchived = new Map<string, DecryptedMessage>();
let mockHandshakeLog: Record<string, string> = {};

jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: { configure: jest.fn() } }));

jest.mock('../../core', () => {
  const actual = jest.requireActual('../../core');
  const mime = jest.requireActual('../../core/mime');
  return {
    ...actual,
    core: {
      kind: 'native',
      sessionStatus: jest.fn(async (_email: string, keys: string[]) =>
        keys.map((k) => mockStatus.get(k) ?? 'none'),
      ),
      buildEncrypted: jest.fn(async (req: { to: string[]; subject: string; body: string; handshake?: boolean }) =>
        mime.buildEncryptedEnvelope({
          from: 'me@example.com',
          to: req.to,
          armored: `-----BEGIN PGP MESSAGE-----\nCryptMail-Session: AAAA\n\nsealed:${req.subject}\n-----END PGP MESSAGE-----`,
          handshake: req.handshake,
        }),
      ),
      buildHandshake: jest.fn(async (req: { to: string }) =>
        mime.buildEncryptedEnvelope({
          from: 'me@example.com',
          to: [req.to],
          armored: '-----BEGIN PGP MESSAGE-----\nCryptMail-Offer: AAAA\n\nhello\n-----END PGP MESSAGE-----',
          handshake: true,
        }),
      ),
      parseEncrypted: jest.fn(async (raw: string) => {
        const opened = mockOpened.get(raw);
        if (!opened) throw new actual.CoreError('cannot open', 'decrypt-failed');
        return opened;
      }),
    },
  };
});

jest.mock('../../keys', () => ({
  directory: { listedAt: 'the test directory', lookup: async () => null, publish: jest.fn() },
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
jest.mock('../../store/handshakeStore', () => ({
  ...jest.requireActual('../../store/handshakeStore'),
  loadHandshakes: jest.fn(async () => mockHandshakeLog),
  saveHandshakes: jest.fn(async (_account: string, log: Record<string, string>) => {
    mockHandshakeLog = log;
  }),
}));
jest.mock('../../store/archiveStore', () => ({
  archive: jest.fn(async (_account: string, raw: string, decrypted: DecryptedMessage) => {
    mockArchived.set(raw, decrypted);
  }),
  readArchived: jest.fn(async (_account: string, raw: string) => mockArchived.get(raw) ?? null),
}));

const ACCOUNT = 'gmail:me@example.com';
const SESSION: Session = { provider: 'gmail', email: 'me@example.com', accessToken: 't', expiresAt: Date.now() + 3_600_000 };
const IDENTITY: Identity = {
  email: 'me@example.com',
  fingerprint: 'AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000',
  publicKeyArmored: 'MY-KEY',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const ADA_KEY = 'ADA-KEY';
const ADA_FP = '9999888877776666555544443333222211110000';
const ada = (): ContactKey => ({
  email: 'ada@example.com',
  fingerprint: ADA_FP,
  armored: ADA_KEY,
  trust: 'seen',
  source: 'autocrypt',
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-01T00:00:00.000Z',
});

const MESSAGE = { to: ['ada@example.com'], subject: 'Quarterly numbers', body: 'Attached, as promised.' };

function harness(over: Partial<State> = {}) {
  const wire: string[] = [];
  const raws = new Map<string, string>();
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: SESSION,
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: SESSION.email }],
      activeAccount: ACCOUNT,
      identity: IDENTITY,
      keyring: { 'ada@example.com': ada() },
      ...over,
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  const client: MailClient = {
    kind: 'gmail',
    address: SESSION.email,
    list: async () => ({ messages: [] }),
    getRaw: async (id) => raws.get(id) ?? '',
    send: async (rfc822) => {
      wire.push(rfc822);
    },
    updateFlags: async () => {},
  };
  mail.current = client;
  return { store, services, wire, raws };
}

/** An inbox row for a handshake that arrived, with its raw text registered. */
function arrived(h: ReturnType<typeof harness>, id: string, raw: string, opened: DecryptedMessage, over: Partial<InboxItem> = {}): InboxItem {
  h.raws.set(id, raw);
  mockOpened.set(raw, opened);
  return {
    id,
    from: { address: 'ada@example.com' },
    to: ['me@example.com'],
    date: '2026-09-19T00:00:00.000Z',
    subject: HANDSHAKE_SUBJECT,
    snippet: '',
    unread: true,
    starred: false,
    account: ACCOUNT,
    ...over,
  };
}

const hello = (over: Partial<DecryptedMessage> = {}): DecryptedMessage => ({
  subject: 'Setting up per-email keys',
  body: '…',
  attachments: [],
  signature: 'valid',
  signerFingerprint: ADA_FP,
  forwardSecret: false,
  ...over,
});

beforeEach(() => {
  mockStatus.clear();
  mockOpened.clear();
  mockArchived.clear();
  mockHandshakeLog = {};
  mockStatus.set('MY-KEY', 'self');
});

describe('sending with per-email keys only', () => {
  it('holds a message for someone with no session, and sends them only a contentless handshake', async () => {
    const h = harness();
    const outcome = await h.services.send.sendEncrypted(MESSAGE);

    expect(outcome).toEqual({ status: 'queued', pending: ['ada@example.com'], waitingFor: 'session' });
    const [held] = Object.values(h.store.get().scheduled);
    expect(holdReason(held)).toBe('awaiting-session');
    expect(held.pending).toEqual(['ada@example.com']);

    expect(h.wire).toHaveLength(1);
    expect(h.wire[0]).toContain(`Subject: ${HANDSHAKE_SUBJECT}`);
    expect(h.wire[0]).not.toContain('Quarterly numbers');
    expect(h.wire[0]).not.toContain('Attached, as promised.');
  });

  it('sends one handshake a day per address, however often the message is retried', async () => {
    const h = harness();
    await h.services.send.sendEncrypted(MESSAGE);
    await h.services.scheduler.drainHeld();
    await h.services.scheduler.drainHeld();
    expect(h.wire).toHaveLength(1);
  });

  it('sends the held message once the session exists, sealed with a per-email key', async () => {
    const h = harness();
    await h.services.send.sendEncrypted(MESSAGE);

    mockStatus.set(ADA_KEY, 'session');
    await h.services.scheduler.drainHeld();

    expect(h.store.get().scheduled).toEqual({});
    expect(h.wire).toHaveLength(2);
    expect(h.wire[1]).toContain('CryptMail-Session:');
    expect(h.wire[1]).not.toContain(HANDSHAKE_SUBJECT);
  });

  it('seals straight away when it holds their offer', async () => {
    const h = harness();
    mockStatus.set(ADA_KEY, 'offer');
    expect(await h.services.send.sendEncrypted(MESSAGE)).toEqual({ status: 'sent' });
    expect(h.wire[0]).toContain('CryptMail-Session:');
  });

  it('refuses a message only to yourself — it cannot have a per-email key', async () => {
    const h = harness();
    await expect(h.services.send.sendEncrypted({ ...MESSAGE, to: ['me@example.com'] })).rejects.toMatchObject({
      code: 'no-key',
    });
    expect(h.wire).toHaveLength(0);
    expect(h.store.get().scheduled).toEqual({});
  });

  it('refuses to put anything on the wire the core did not seal with a per-email key', async () => {
    const h = harness();
    mockStatus.set(ADA_KEY, 'session');
    const { core } = jest.requireMock('../../core') as { core: { buildEncrypted: jest.Mock } };
    core.buildEncrypted.mockResolvedValueOnce(
      'Subject: x\n\n-----BEGIN PGP MESSAGE-----\n\nlong-term\n-----END PGP MESSAGE-----',
    );
    await expect(h.services.send.sendEncrypted(MESSAGE)).rejects.toThrow(/not sealed with per-email keys/);
    expect(h.wire).toHaveLength(0);
  });
});

describe('answering handshakes during a sync', () => {
  it('answers a first contact with a per-email-keyed acknowledgement, kept before it leaves', async () => {
    const h = harness();
    mockStatus.set(ADA_KEY, 'offer');
    await h.services.handshake.answer([arrived(h, 'm1', 'RAW-HELLO', hello())]);

    expect(h.wire).toHaveLength(1);
    expect(h.wire[0]).toContain(`Subject: ${HANDSHAKE_SUBJECT}`);
    expect(h.wire[0]).toContain('CryptMail-Session:');
    expect(mockArchived.get(h.wire[0])?.forwardSecret).toBe(true);
  });

  it('does not answer twice once the session exists', async () => {
    const h = harness();
    mockStatus.set(ADA_KEY, 'session');
    await h.services.handshake.answer([arrived(h, 'm1', 'RAW-HELLO', hello())]);
    expect(h.wire).toHaveLength(0);
  });

  it('does not answer a handshake whose signature is not the contact’s key', async () => {
    const h = harness();
    mockStatus.set(ADA_KEY, 'offer');
    await h.services.handshake.answer([
      arrived(h, 'm1', 'RAW-A', hello({ signature: 'invalid' })),
      arrived(h, 'm2', 'RAW-B', hello({ signerFingerprint: 'SOMEONE-ELSE' })),
    ]);
    expect(h.wire).toHaveLength(0);
  });

  it('opens an acknowledgement, keeps it, and does not reply to it', async () => {
    const h = harness();
    const ack = hello({ subject: 'Per-email keys are set up', forwardSecret: true });
    await h.services.handshake.answer([arrived(h, 'm1', 'RAW-ACK', ack)]);

    expect(mockArchived.get('RAW-ACK')).toEqual(ack);
    expect(h.wire).toHaveLength(0);
  });

  it('ignores ordinary mail, our own handshakes, and other accounts’', async () => {
    const h = harness();
    mockStatus.set(ADA_KEY, 'offer');
    await h.services.handshake.answer([
      arrived(h, 'm1', 'RAW-1', hello(), { subject: '[Encrypted message]' }),
      arrived(h, 'm2', 'RAW-2', hello(), { from: { address: 'me@example.com' } }),
      arrived(h, 'm3', 'RAW-3', hello(), { account: 'gmail:other@example.com' }),
    ]);
    expect(h.wire).toHaveLength(0);
  });
});
