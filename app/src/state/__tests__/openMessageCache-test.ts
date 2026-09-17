/**
 * Reopening encrypted mail reads the provider's bytes back from this device.
 *
 * Pinned from the service's side, against a provider that counts its fetches:
 * a second open of an encrypted message must not reach the network, and plain
 * mail must never be written to the cache at all — the cache is for ciphertext
 * only (`store/rawCache.ts`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { MailClient } from '../../mail/types';
import { accountIdFor } from '../../store/accountScope';
import { initLocalCrypto, resetLocalCryptoForTests } from '../../store/localCrypto';
import { RawCacheBackend, setRawCacheBackendForTests } from '../../store/rawCache';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem } from '../types';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../store/searchIndex', () => ({
  ...jest.requireActual('../../store/searchIndex'),
  saveSearchIndex: jest.fn(async () => {}),
}));

const ACCOUNT = accountIdFor('gmail', 'me@example.com');

const ROW: InboxItem = {
  account: ACCOUNT,
  id: 'msg-1',
  from: { address: 'alice@example.com', name: 'Alice' },
  to: ['me@example.com'],
  date: '2026-09-01T12:00:00.000Z',
  subject: '[Encrypted message]',
  snippet: '',
  unread: true,
  starred: false,
};

const ENCRYPTED = [
  'From: alice@example.com',
  'Subject: [Encrypted message]',
  'MIME-Version: 1.0',
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
  '',
  '--b',
  'Content-Type: application/pgp-encrypted',
  '',
  'Version: 1',
  '--b',
  'Content-Type: application/octet-stream',
  '',
  '-----BEGIN PGP MESSAGE-----',
  'not really',
  '-----END PGP MESSAGE-----',
  '--b--',
].join('\r\n');

const PLAIN = ['From: alice@example.com', 'Subject: Hi', 'Content-Type: text/plain', '', 'Hello'].join('\r\n');

/** Lets the un-awaited cache write land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(raw: string) {
  const writes: string[] = [];
  const files = new Map<string, string>();
  const backend: RawCacheBackend = {
    read: async (dir, name) => files.get(`${dir}/${name}`) ?? null,
    write: async (dir, name, value) => {
      writes.push(name);
      files.set(`${dir}/${name}`, value);
    },
    remove: async (dir, name) => {
      files.delete(`${dir}/${name}`);
    },
    entries: async () => [],
    clear: async () => files.clear(),
  };
  setRawCacheBackendForTests(backend);

  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: { provider: 'gmail', email: 'me@example.com', accessToken: 't', expiresAt: Date.now() + 3_600_000 },
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: 'me@example.com' }],
      activeAccount: ACCOUNT,
      messages: [ROW],
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  const getRaw = jest.fn(async () => raw);
  const client: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    list: async () => ({ messages: [] }),
    getRaw,
    send: async () => {},
    updateFlags: async () => {},
  };
  mail.current = client;
  return { services, getRaw, writes };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetLocalCryptoForTests();
  const secrets: Record<string, string> = {};
  await initLocalCrypto(
    {
      getItem: async (k) => secrets[k] ?? null,
      setItem: async (k, v) => {
        secrets[k] = v;
      },
    },
    'keystore',
  );
});

afterAll(() => setRawCacheBackendForTests(undefined));

describe('openMessage and the raw cache', () => {
  it('fetches encrypted mail once, then reads it back from the device', async () => {
    const { services, getRaw, writes } = harness(ENCRYPTED);

    const first = await services.mailbox.openMessage(ROW);
    await settle();
    const second = await services.mailbox.openMessage(ROW);

    expect(getRaw).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(second.raw).toBe(first.raw);
    expect(second.encryption.kind).toBe('encrypted');
  });

  it('never caches plain mail', async () => {
    const { services, getRaw, writes } = harness(PLAIN);

    await services.mailbox.openMessage(ROW);
    await settle();
    await services.mailbox.openMessage(ROW);

    expect(writes).toHaveLength(0);
    expect(getRaw).toHaveBeenCalledTimes(2);
  });
});
