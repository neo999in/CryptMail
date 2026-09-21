/**
 * Reopening encrypted mail reads the provider's bytes back from this device.
 *
 * Pinned from the service's side, against a provider that counts its fetches:
 * a second open of an encrypted message must not reach the network, and plain
 * mail must never be written to the cache at all — the cache is for ciphertext
 * only (`store/rawCache.ts`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { core } from '../../core';
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

/**
 * A message the core can actually open.
 *
 * It used to be a hand-written envelope whose ciphertext read `not really`,
 * which looked encrypted and decrypted to nothing. That was load-bearing for
 * the old behaviour — bytes were cached on the strength of `looksEncrypted`
 * alone — and it hid the bug this file now pins: a message that never opens
 * must never be cached, or one bad fetch is permanent.
 */
let ENCRYPTED = '';

beforeAll(async () => {
  ENCRYPTED = await core.buildEncrypted({
    from: 'alice@example.com',
    to: ['me@example.com'],
    subject: 'Hello',
    body: 'a real one',
    // The demo core refuses a message with no recipients; it never reads the
    // key itself, so a well-formed placeholder is enough.
    recipientKeys: ['-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----'],
  });
});

/** Shaped like encrypted mail, and pure nonsense inside. */
const UNOPENABLE = [
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

/**
 * Lets the un-awaited cache write land.
 *
 * More than one tick because the write is fire-and-forget *and* now sits below
 * the decrypt: it used to start before `openMessage` awaited anything else, so
 * those awaits carried it along, and a single tick was enough. Sealing the
 * bytes is itself asynchronous, so this drains a few.
 */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

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

  /**
   * The failure this guards against, seen between two installs on 2026-09-20:
   * Gmail re-encoded a Level 2 body, the armor markers survived so the message
   * still "looked encrypted", and it was cached before anything tried to open
   * it. Every reopen then read the damaged copy back from disk and the message
   * was never requested from the provider again — a transport hiccup turned
   * into permanent data loss.
   */
  it('does not cache a message that failed to open, so a bad fetch is not permanent', async () => {
    const { services, getRaw, writes } = harness(UNOPENABLE);

    await services.mailbox.openMessage(ROW);
    await settle();
    await services.mailbox.openMessage(ROW);

    expect(writes).toHaveLength(0);
    // Asked again rather than served the copy that could not be read.
    expect(getRaw).toHaveBeenCalledTimes(2);
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
