/**
 * The cache of fetched encrypted mail.
 *
 * What matters is that it can only ever make opening faster, never wrong:
 *
 *  - what goes to disk is sealed, and what comes back is the provider's bytes
 *    exactly;
 *  - anything short of a clean hit — tampered, unsealed, oversized, no file
 *    system — is a miss, not an error, and a bad entry is dropped;
 *  - it is bounded, oldest written first, and clearing an account empties it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { accountIdFor } from '../accountScope';
import { initLocalCrypto, isSealed, resetLocalCryptoForTests, SecretStore } from '../localCrypto';
import {
  clearRawCache,
  evictionFor,
  fileNameFor,
  RAW_CACHE_MAX_ENTRY_BYTES,
  RawCacheBackend,
  rawCacheBytes,
  readCachedRaw,
  setRawCacheBackendForTests,
  writeCachedRaw,
} from '../rawCache';

const ME = accountIdFor('gmail', 'me@example.com');
const OTHER = accountIdFor('gmail', 'other@example.com');

const RAW = [
  'From: alice@example.com',
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"',
  '',
  '-----BEGIN PGP MESSAGE-----',
  'hQIMA0x9...',
  '-----END PGP MESSAGE-----',
].join('\r\n');

function memorySecrets(): SecretStore {
  const data: Record<string, string> = {};
  return {
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

/** Files by directory, then name, with a clock so eviction order is decidable. */
function memoryBackend() {
  const dirs = new Map<string, Map<string, { value: string; written: number }>>();
  let clock = 0;
  const backend: RawCacheBackend = {
    read: async (dir, name) => dirs.get(dir)?.get(name)?.value ?? null,
    write: async (dir, name, value) => {
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir)!.set(name, { value, written: ++clock });
    },
    remove: async (dir, name) => {
      dirs.get(dir)?.delete(name);
    },
    entries: async (dir) =>
      [...(dirs.get(dir) ?? new Map()).entries()].map(([name, f]) => ({
        name,
        bytes: f.value.length,
        written: f.written,
      })),
    clear: async (dir) => {
      dirs.delete(dir);
    },
  };
  return { backend, dirs };
}

let files: ReturnType<typeof memoryBackend>;

beforeEach(async () => {
  await AsyncStorage.clear();
  resetLocalCryptoForTests();
  await initLocalCrypto(memorySecrets(), 'keystore');
  files = memoryBackend();
  setRawCacheBackendForTests(files.backend);
});

afterAll(() => setRawCacheBackendForTests(undefined));

describe('rawCache', () => {
  it('returns exactly the bytes it was given, and stores them sealed', async () => {
    await writeCachedRaw(ME, 'msg-1', RAW);

    expect(await readCachedRaw(ME, 'msg-1')).toBe(RAW);
    const onDisk = files.dirs.get(fileNameFor(ME))!.get(fileNameFor('msg-1'))!.value;
    expect(isSealed(onDisk)).toBe(true);
    expect(onDisk).not.toContain('alice@example.com');
  });

  it('misses for an id it never saw, and for another account', async () => {
    await writeCachedRaw(ME, 'msg-1', RAW);

    expect(await readCachedRaw(ME, 'msg-2')).toBeNull();
    expect(await readCachedRaw(OTHER, 'msg-1')).toBeNull();
  });

  it('drops an entry that does not authenticate, rather than returning it', async () => {
    await writeCachedRaw(ME, 'msg-1', RAW);
    const dir = files.dirs.get(fileNameFor(ME))!;
    const entry = dir.get(fileNameFor('msg-1'))!;
    entry.value = entry.value.slice(0, -4) + 'AAAA';

    expect(await readCachedRaw(ME, 'msg-1')).toBeNull();
    expect(dir.has(fileNameFor('msg-1'))).toBe(false);
  });

  it('treats an unsealed file as foreign', async () => {
    await files.backend.write(fileNameFor(ME), fileNameFor('msg-1'), RAW);

    expect(await readCachedRaw(ME, 'msg-1')).toBeNull();
  });

  it('does not keep a message over the size cap', async () => {
    await writeCachedRaw(ME, 'big', 'x'.repeat(RAW_CACHE_MAX_ENTRY_BYTES + 1));

    expect(await readCachedRaw(ME, 'big')).toBeNull();
  });

  it('clears one account without touching another', async () => {
    await writeCachedRaw(ME, 'msg-1', RAW);
    await writeCachedRaw(OTHER, 'msg-1', RAW);

    await clearRawCache(ME);

    expect(await readCachedRaw(ME, 'msg-1')).toBeNull();
    expect(await rawCacheBytes(ME)).toBe(0);
    expect(await readCachedRaw(OTHER, 'msg-1')).toBe(RAW);
  });

  it('is a silent miss where there is no file system', async () => {
    setRawCacheBackendForTests(null);

    await writeCachedRaw(ME, 'msg-1', RAW);
    expect(await readCachedRaw(ME, 'msg-1')).toBeNull();
    expect(await rawCacheBytes(ME)).toBe(0);
  });

  it('names files with a fixed-length hash, whatever the id', () => {
    const graphId = 'AAMkAGI2TG93AAA=' + '/+'.repeat(80);
    expect(fileNameFor(graphId)).toMatch(/^[0-9a-f]{64}$/);
    expect(fileNameFor(ME)).not.toContain('@');
  });
});

describe('evictionFor', () => {
  const entries = [
    { name: 'new', bytes: 40, written: 3 },
    { name: 'old', bytes: 40, written: 1 },
    { name: 'mid', bytes: 40, written: 2 },
  ];

  it('removes nothing while under the cap', () => {
    expect(evictionFor(entries, 120)).toEqual([]);
  });

  it('removes the oldest written until the rest fit', () => {
    expect(evictionFor(entries, 100)).toEqual(['old']);
    expect(evictionFor(entries, 40)).toEqual(['old', 'mid']);
  });
});
