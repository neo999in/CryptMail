/**
 * The provider's bytes for encrypted mail this device has already fetched.
 *
 * Opening a message was a `getRaw` every time — the whole MIME message over the
 * network — before the core could decrypt anything, so reopening a message
 * waited on Gmail for bytes this device had held a minute ago. This keeps those
 * bytes so a second open is a local read and a local decrypt.
 *
 * ## Ciphertext only, and why that is the line
 *
 * What is cached is exactly what the provider stores: a PGP/MIME message still
 * encrypted to the recipient's key. It is *never* the decrypted tree. A copy of
 * the plaintext would be readable with the device key alone, which the app
 * unlocks without the user; this copy still needs the private key and its
 * passphrase, which is the same bar the mail sitting at Gmail has to clear.
 * `searchIndex` remains the only decrypted mail on disk, and it is bounded.
 *
 * Plain mail is not cached at all — the caller only offers encrypted bytes — so
 * this module never holds a readable message body, sealed or not.
 *
 * ## Why files, and not AsyncStorage
 *
 * AsyncStorage on Android is one SQLite database capped at 6 MB for the whole
 * app. A single encrypted message with an attachment can be most of that, and a
 * full database fails *every* store's writes — the keyring and outbox included.
 * So each message is its own file under the app's cache directory, which the OS
 * may also clear under storage pressure; losing it costs one refetch.
 *
 * Each file is still sealed with `localCrypto`, like every other store: the
 * body is ciphertext, but the headers around it name the sender, recipients and
 * date, and those are no less sensitive here than in `mailCacheStore`.
 *
 * ## It is a cache
 *
 * A read that fails, a file that does not authenticate, a platform with no file
 * system (web) — every one of them is a miss, never an error. Opening a message
 * must work exactly as it did before this existed whenever this cannot help.
 * The provider's copy of a message never changes under the same id, which is
 * what makes caching by id sound; nothing here expires.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Platform } from 'react-native';

import { utf8ByteLength, utf8ToBytes } from '../lib/base64';
import { AccountId } from './accountScope';
import { isSealed, seal, unseal } from './localCrypto';

/** The name this store answers to in storage usage. Not an AsyncStorage key. */
export const RAW_CACHE_STORE_KEY = 'cryptmail.rawcache.v1';

/**
 * Larger messages are not kept.
 *
 * Sealing runs in JavaScript over the whole string, and a message this size is
 * almost always one carrying an attachment — the rare case, and the one where a
 * refetch is least surprising. Ordinary encrypted mail is tens of kilobytes.
 */
export const RAW_CACHE_MAX_ENTRY_BYTES = 1_500_000;

/** Per account. Oldest written goes first once a write takes it past this. */
export const RAW_CACHE_MAX_BYTES = 25_000_000;

/** One cached file, by its name on disk (see `fileNameFor`), not by message id. */
export type RawCacheEntry = { name: string; bytes: number; written: number };

/**
 * Where the bytes actually go. Swappable so the policy can be tested without a
 * device. Both `account` and `name` arrive already passed through `fileNameFor`.
 */
export type RawCacheBackend = {
  read(account: string, name: string): Promise<string | null>;
  write(account: string, name: string, value: string): Promise<void>;
  remove(account: string, name: string): Promise<void>;
  entries(account: string): Promise<RawCacheEntry[]>;
  clear(account: string): Promise<void>;
};

let backend: RawCacheBackend | null | undefined;

/** Tests hand in a memory backend; `null` behaves like a platform with no file system. */
export function setRawCacheBackendForTests(next: RawCacheBackend | null | undefined): void {
  backend = next;
}

function active(): RawCacheBackend | null {
  if (backend === undefined) {
    try {
      backend = Platform.OS === 'web' ? null : fileBackend();
    } catch {
      // No native module to load (a build without it, or jest). Same as web.
      backend = null;
    }
  }
  return backend;
}

/** This message's cached bytes, or `null` for anything short of a clean hit. */
export async function readCachedRaw(account: AccountId, id: string): Promise<string | null> {
  const b = active();
  if (!b) return null;
  const dir = fileNameFor(account);
  const name = fileNameFor(id);
  try {
    const stored = await b.read(dir, name);
    if (stored === null) return null;
    // Every write is sealed, so an unsealed file is not one this module wrote.
    if (!isSealed(stored)) throw new Error('unsealed cache entry');
    return unseal(stored);
  } catch {
    // Corrupt, truncated, or failing to authenticate: drop it so the refetch
    // that follows replaces it rather than meeting it again next time.
    await b.remove(dir, name).catch(() => {});
    return null;
  }
}

/**
 * Keep an encrypted message's bytes. Never throws: a failed write is a future miss.
 *
 * The caller decides what is encrypted — see the module note — and this does not
 * re-check, because the check belongs to the core, not to storage.
 */
export async function writeCachedRaw(account: AccountId, id: string, raw: string): Promise<void> {
  const b = active();
  if (!b || utf8ByteLength(raw) > RAW_CACHE_MAX_ENTRY_BYTES) return;
  const dir = fileNameFor(account);
  try {
    await b.write(dir, fileNameFor(id), seal(raw));
    for (const stale of evictionFor(await b.entries(dir), RAW_CACHE_MAX_BYTES)) {
      await b.remove(dir, stale);
    }
  } catch {
    // Out of space, or the directory went away underneath us. Nothing to do.
  }
}

/** Everything cached for one account, gone — for removing or resetting it. */
export async function clearRawCache(account: AccountId): Promise<void> {
  await active()?.clear(fileNameFor(account)).catch(() => {});
}

/** Bytes on disk for one account, measured without unsealing anything. */
export async function rawCacheBytes(account: AccountId): Promise<number> {
  const b = active();
  if (!b) return 0;
  try {
    return (await b.entries(fileNameFor(account))).reduce((sum, e) => sum + e.bytes, 0);
  } catch {
    return 0;
  }
}

/** Which entries to delete so the rest fit in `maxBytes`: the oldest written, first. */
export function evictionFor(entries: RawCacheEntry[], maxBytes: number): string[] {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const doomed: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.written - b.written)) {
    if (total <= maxBytes) break;
    doomed.push(entry.name);
    total -= entry.bytes;
  }
  return doomed;
}

/**
 * A file name that is safe for any id or account: SHA-256, in hex.
 *
 * Account ids carry `:` and `@`, and Graph message ids carry `/`, `+` and `=`
 * and run to ~150 characters, so no reversible encoding of them fits the
 * 255-byte limit on a file name. A hash always does, and it also keeps the
 * mailbox's address out of the directory listing.
 */
export function fileNameFor(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

/**
 * `expo-file-system`, required lazily so importing this module does not load a
 * native module — the state layer imports it, and jest has no binary for it.
 */
function fileBackend(): RawCacheBackend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system');

  const dirFor = (account: string) => new Directory(Paths.cache, 'rawcache', account);
  const fileFor = (account: string, name: string) => new File(dirFor(account), name);

  return {
    async read(account, name) {
      const file = fileFor(account, name);
      return file.exists ? file.text() : null;
    },
    async write(account, name, value) {
      const dir = dirFor(account);
      if (!dir.exists) dir.create({ intermediates: true });
      const file = fileFor(account, name);
      if (!file.exists) file.create();
      file.write(value);
    },
    async remove(account, name) {
      const file = fileFor(account, name);
      if (file.exists) file.delete();
    },
    async entries(account) {
      const dir = dirFor(account);
      if (!dir.exists) return [];
      return dir.list().flatMap((item) => {
        if (!(item instanceof File)) return [];
        const info = item.info();
        return [{ name: item.name, bytes: info.size ?? 0, written: info.modificationTime ?? 0 }];
      });
    },
    async clear(account) {
      const dir = dirFor(account);
      if (dir.exists) dir.delete();
    },
  };
}
