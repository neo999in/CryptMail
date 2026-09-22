/**
 * The archive of forward-secret mail.
 *
 * For these messages it is the only copy left, so what matters differs from
 * `rawCache`:
 *
 *  - an entry is found again from the provider's copy of the message, even
 *    after the provider has rewritten its line endings;
 *  - it is found by the ciphertext, so another message cannot claim it;
 *  - what goes to disk is sealed;
 *  - a failed write is loud, because silence would lose a message for good.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { DecryptedMessage } from '../../core/types';
import { accountIdFor } from '../accountScope';
import {
  archive,
  ArchiveBackend,
  archiveKeyFor,
  clearArchive,
  exportArchive,
  importArchive,
  readArchived,
  setArchiveBackendForTests,
} from '../archiveStore';
import { initLocalCrypto, isSealed, resetLocalCryptoForTests, SecretStore } from '../localCrypto';

const ME = accountIdFor('gmail', 'me@example.com');
const OTHER = accountIdFor('gmail', 'other@example.com');

const sealedMessage = (payload: string, messageId = '<a@example.com>') =>
  [
    'From: alice@example.com',
    `Message-ID: ${messageId}`,
    'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"',
    '',
    '-----BEGIN PGP MESSAGE-----',
    'CryptMail-Offer: AAAA',
    'CryptMail-Session: BBBB',
    '',
    payload,
    '-----END PGP MESSAGE-----',
  ].join('\n');

const DECRYPTED: DecryptedMessage = {
  subject: 'The contract',
  body: 'Signed copy attached.',
  signature: 'valid',
  signerFingerprint: 'AAAA',
  attachments: [],
  forwardSecret: true,
};

function memorySecrets(): SecretStore {
  const data: Record<string, string> = {};
  return {
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

function memoryBackend() {
  const dirs = new Map<string, Map<string, string>>();
  const backend: ArchiveBackend = {
    read: async (dir, name) => dirs.get(dir)?.get(name) ?? null,
    write: async (dir, name, value) => {
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir)!.set(name, value);
    },
    clear: async (dir) => {
      dirs.delete(dir);
    },
    list: async (dir) => [...(dirs.get(dir)?.keys() ?? [])],
  };
  return { backend, dirs };
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetLocalCryptoForTests();
  await initLocalCrypto(memorySecrets(), 'keystore');
});

afterEach(() => setArchiveBackendForTests(undefined));

describe('archiveKeyFor', () => {
  it('is the same for the copy we built and the copy the provider returns with CRLF', () => {
    const built = sealedMessage('hQIMA0x9');
    expect(archiveKeyFor(built.replace(/\n/g, '\r\n'))).toBe(archiveKeyFor(built));
  });

  it('follows the ciphertext, not the Message-ID', () => {
    expect(archiveKeyFor(sealedMessage('one', '<same@x>'))).not.toBe(archiveKeyFor(sealedMessage('two', '<same@x>')));
  });

  it('is null for a message with no armored block', () => {
    expect(archiveKeyFor('Subject: hi\n\nplain')).toBeNull();
  });
});

describe('the archive', () => {
  it('returns what was archived, from the provider’s copy of the message', async () => {
    const { backend } = memoryBackend();
    setArchiveBackendForTests(backend);
    const sent = sealedMessage('hQIMA0x9');

    await archive(ME, sent, DECRYPTED);
    expect(await readArchived(ME, sent.replace(/\n/g, '\r\n'))).toEqual(DECRYPTED);
  });

  it('seals what it writes', async () => {
    const { backend, dirs } = memoryBackend();
    setArchiveBackendForTests(backend);
    await archive(ME, sealedMessage('x'), DECRYPTED);

    const [stored] = [...[...dirs.values()][0].values()];
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain('The contract');
  });

  it('keeps each account’s archive to itself', async () => {
    const { backend } = memoryBackend();
    setArchiveBackendForTests(backend);
    await archive(ME, sealedMessage('x'), DECRYPTED);
    expect(await readArchived(OTHER, sealedMessage('x'))).toBeNull();
  });

  it('is emptied when the account is cleared', async () => {
    const { backend } = memoryBackend();
    setArchiveBackendForTests(backend);
    await archive(ME, sealedMessage('x'), DECRYPTED);
    await clearArchive(ME);
    expect(await readArchived(ME, sealedMessage('x'))).toBeNull();
  });

  it('refuses loudly where there is nowhere to keep it', async () => {
    setArchiveBackendForTests(null);
    await expect(archive(ME, sealedMessage('x'), DECRYPTED)).rejects.toThrow();
    expect(await readArchived(ME, sealedMessage('x'))).toBeNull();
  });

  it('refuses a message with no armored block rather than filing it under nothing', async () => {
    setArchiveBackendForTests(memoryBackend().backend);
    await expect(archive(ME, 'Subject: hi\n\nplain', DECRYPTED)).rejects.toThrow();
  });
});

describe('moving the archive to another phone', () => {
  it('arrives readable under the new phone’s device key', async () => {
    const { backend } = memoryBackend();
    setArchiveBackendForTests(backend);
    await archive(ME, sealedMessage('one'), DECRYPTED);
    await archive(ME, sealedMessage('two'), { ...DECRYPTED, subject: 'Second' });
    const out = await exportArchive(ME);
    expect(out).toMatchObject({ count: 2, unreadable: 0 });

    // The new phone: its own device key, its own disk.
    resetLocalCryptoForTests();
    await initLocalCrypto(memorySecrets(), 'keystore');
    const next = memoryBackend();
    setArchiveBackendForTests(next.backend);
    expect(await importArchive(ME, out.archive)).toBe(2);

    expect(await readArchived(ME, sealedMessage('one'))).toEqual(DECRYPTED);
    expect((await readArchived(ME, sealedMessage('two')))?.subject).toBe('Second');
    for (const stored of [...next.dirs.values()].flatMap((d) => [...d.values()])) {
      expect(isSealed(stored)).toBe(true);
    }
  });

  it('counts an entry that will not open instead of dropping it silently', async () => {
    const { backend, dirs } = memoryBackend();
    setArchiveBackendForTests(backend);
    await archive(ME, sealedMessage('one'), DECRYPTED);
    const dir = [...dirs.values()][0];
    dir.set('f'.repeat(64), 'garbage');
    expect(await exportArchive(ME)).toMatchObject({ count: 1, unreadable: 1 });
  });

  it('takes only its own account, and an empty archive is nothing to do', async () => {
    const { backend } = memoryBackend();
    setArchiveBackendForTests(backend);
    await archive(OTHER, sealedMessage('x'), DECRYPTED);
    const out = await exportArchive(ME);
    expect(out.count).toBe(0);
    expect(await importArchive(ME, out.archive)).toBe(0);
    expect(await importArchive(ME, '')).toBe(0);
  });

  it('refuses an entry name that could reach outside the archive', async () => {
    setArchiveBackendForTests(memoryBackend().backend);
    const hostile = JSON.stringify({ v: 1, entries: [['../../identity', DECRYPTED]] });
    await expect(importArchive(ME, hostile)).rejects.toThrow(/damaged/);
    await expect(importArchive(ME, '{not json')).rejects.toThrow(/damaged/);
  });
});
