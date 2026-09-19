/**
 * Opening forward-secret mail.
 *
 * Such a message decrypts exactly once — the core destroys its key in the act
 * of opening it — so the reader must keep what it said the first time, read
 * that copy every time after, and never lose a message it has just decrypted
 * because keeping it failed.
 */
import { core, DecryptedMessage, PLACEHOLDER_SUBJECT } from '../../core';
import { MailClient } from '../../mail/types';
import { accountIdFor } from '../../store/accountScope';
import { ArchiveBackend, setArchiveBackendForTests } from '../../store/archiveStore';
import { initLocalCrypto, resetLocalCryptoForTests } from '../../store/localCrypto';
import { setRawCacheBackendForTests } from '../../store/rawCache';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem } from '../types';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../store/searchIndex', () => ({
  ...jest.requireActual('../../store/searchIndex'),
  saveSearchIndex: jest.fn(async () => {}),
  loadSearchIndex: jest.fn(async () => ({})),
}));

jest.mock('../../store/keyring', () => ({
  ...jest.requireActual('../../store/keyring'),
  saveKeyring: jest.fn(async () => {}),
  loadKeyring: jest.fn(async () => ({})),
}));

const ACCOUNT = accountIdFor('gmail', 'me@example.com');

const RAW = [
  'From: ada@example.com',
  'To: me@example.com',
  `Subject: ${PLACEHOLDER_SUBJECT}`,
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
  '',
  '--b',
  'Content-Type: application/octet-stream',
  '',
  '-----BEGIN PGP MESSAGE-----',
  'CryptMail-Session: AAAA',
  '',
  'hQIMA0x9',
  '-----END PGP MESSAGE-----',
  '--b--',
].join('\r\n');

const SUMMARY: InboxItem = {
  account: ACCOUNT,
  id: 'fs-1',
  from: { address: 'ada@example.com', name: 'Ada' },
  to: ['me@example.com'],
  date: '2026-09-19T12:00:00.000Z',
  subject: PLACEHOLDER_SUBJECT,
  snippet: '',
  unread: true,
  starred: false,
};

const DECRYPTED: DecryptedMessage = {
  subject: 'The real subject',
  body: 'What only Ada and I can read.',
  signature: 'valid',
  signerFingerprint: 'ADA',
  attachments: [],
  forwardSecret: true,
};

function harness() {
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: { provider: 'gmail', email: 'me@example.com', accessToken: 't', expiresAt: Date.now() + 3_600_000 },
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: 'me@example.com' }],
      activeAccount: ACCOUNT,
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  const client: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    list: async () => ({ messages: [] }),
    getRaw: async () => RAW,
    send: async () => {},
    updateFlags: async () => {},
  };
  mail.current = client;
  return services;
}

/** Decrypts once, then fails as the real core does: the one-time key is gone. */
function oneTimeCore() {
  let used = false;
  return jest.spyOn(core, 'parseEncrypted').mockImplementation(async () => {
    if (used) throw new Error('decrypt-failed: the one-time key no longer exists');
    used = true;
    return DECRYPTED;
  });
}

function memoryArchive(): ArchiveBackend {
  const files = new Map<string, string>();
  return {
    read: async (dir, name) => files.get(`${dir}/${name}`) ?? null,
    write: async (dir, name, value) => void files.set(`${dir}/${name}`, value),
    clear: async () => files.clear(),
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
  };
}

beforeEach(async () => {
  resetLocalCryptoForTests();
  const secrets: Record<string, string> = {};
  await initLocalCrypto(
    { getItem: async (k) => secrets[k] ?? null, setItem: async (k, v) => void (secrets[k] = v) },
    'keystore',
  );
  setRawCacheBackendForTests(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  setArchiveBackendForTests(undefined);
  setRawCacheBackendForTests(undefined);
});

it('reads a forward-secret message again from the copy kept the first time', async () => {
  const decrypt = oneTimeCore();
  setArchiveBackendForTests(memoryArchive());
  const services = harness();

  const first = await services.mailbox.openMessage(SUMMARY);
  const second = await services.mailbox.openMessage(SUMMARY);

  expect(first.body).toBe(DECRYPTED.body);
  expect(second.body).toBe(DECRYPTED.body);
  expect(second.subject).toBe(DECRYPTED.subject);
  expect(second.error).toBeUndefined();
  // The second open never asked the core: its key no longer exists.
  expect(decrypt).toHaveBeenCalledTimes(1);
});

it('still shows a message it could not keep, and says it will not open again', async () => {
  oneTimeCore();
  setArchiveBackendForTests(null);
  const services = harness();

  const opened = await services.mailbox.openMessage(SUMMARY);

  expect(opened.body).toBe(DECRYPTED.body);
  expect(opened.error).toBeUndefined();
  expect(opened.notice).toMatch(/can’t be opened again/);
});

it('keeps nothing for an ordinary encrypted message', async () => {
  jest.spyOn(core, 'parseEncrypted').mockResolvedValue({ ...DECRYPTED, forwardSecret: false });
  const archive = memoryArchive();
  const write = jest.spyOn(archive, 'write');
  setArchiveBackendForTests(archive);

  await harness().mailbox.openMessage(SUMMARY);
  expect(write).not.toHaveBeenCalled();
});
