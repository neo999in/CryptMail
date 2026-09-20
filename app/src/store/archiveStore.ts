/**
 * Decrypted copies of forward-secret mail — the only copy there is.
 *
 * A forward-secret message is sealed under a key that is destroyed the moment
 * it is used (`core/src/session.rs`). Gmail keeps the ciphertext forever, but
 * nothing anywhere can open it a second time — not this device, not the
 * sender's. So the first time one is opened, and when one is sent, what it
 * said is kept here, sealed with the device key.
 *
 * ## The trade, stated plainly
 *
 * This is decrypted mail on disk, which `rawCache.ts` deliberately never is.
 * The difference is that there is no alternative: without this, a
 * forward-secret message could be read once and never again. What it costs is
 * that this copy is exactly as safe as the device — anyone who can unlock the
 * app can read it. What forward secrecy still buys is everything off the
 * device: the copy at the provider, and anything a stolen long-term key or a
 * future quantum computer could have opened, opens nothing.
 *
 * Normal mail is never stored here. It still decrypts on demand, on any device,
 * forever, and `searchIndex` remains its only decrypted trace.
 *
 * ## Keyed by the ciphertext, not the provider's id
 *
 * `MailClient.send` returns no id, so a message we sent can only be found again
 * by its content. The key is a hash of the armored block with all whitespace
 * removed — providers rewrite line endings — which is the same on the copy we
 * built and the copy the provider hands back. It also cannot be steered: a
 * message that borrows another's `Message-ID` does not borrow its ciphertext.
 *
 * ## Durable, and never evicted
 *
 * Unlike `rawCache`, a lost entry is a lost message, so these files live in
 * the app's document directory, which the OS does not clear, and nothing here
 * expires. Moving to a new phone carries them over through device transfer
 * (`exportArchive` / `importArchive`), opened here and sealed by the core for
 * the journey, since the device key they are sealed under stays behind.
 * Removing an account clears them explicitly, as it does `rawCache`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Platform } from 'react-native';

import { extractArmor } from '../core/mime';
import { extractQkdArmor } from '../core/qkd';
import type { DecryptedMessage } from '../core/types';
import { utf8ToBytes } from '../lib/base64';
import { AccountId } from './accountScope';
import { isSealed, seal, unseal } from './localCrypto';

/** The name this store answers to in storage usage. Not an AsyncStorage key. */
export const ARCHIVE_STORE_KEY = 'cryptmail.archive.v1';

export type ArchiveBackend = {
  read(account: string, name: string): Promise<string | null>;
  write(account: string, name: string, value: string): Promise<void>;
  clear(account: string): Promise<void>;
  /** Every entry name in one account's archive. */
  list(account: string): Promise<string[]>;
};

let backend: ArchiveBackend | null | undefined;

/** Tests hand in a memory backend; `null` behaves like a platform with no file system. */
export function setArchiveBackendForTests(next: ArchiveBackend | null | undefined): void {
  backend = next;
}

function active(): ArchiveBackend | null {
  if (backend === undefined) {
    try {
      backend = Platform.OS === 'web' ? null : fileBackend();
    } catch {
      backend = null;
    }
  }
  return backend;
}

/**
 * The archive key for a message: its armored block, whitespace stripped, hashed.
 * `null` when the message carries no armored block, and so cannot be archived.
 */
export function archiveKeyFor(rfc822: string): string | null {
  // Level 2/3 mail opens once too — its quantum keys are deleted as it does.
  const armor = extractArmor(rfc822) ?? extractQkdArmor(rfc822);
  if (!armor) return null;
  return bytesToHex(sha256(utf8ToBytes(armor.replace(/\s+/g, ''))));
}

/** The archived decryption of this message, or `null` if there is none. */
export async function readArchived(account: AccountId, rfc822: string): Promise<DecryptedMessage | null> {
  const b = active();
  const key = archiveKeyFor(rfc822);
  if (!b || !key) return null;
  try {
    const stored = await b.read(accountDir(account), key);
    if (stored === null || !isSealed(stored)) return null;
    return JSON.parse(unseal(stored)) as DecryptedMessage;
  } catch {
    // Unlike a cache miss this is a message that may now be unreadable, but
    // deleting the file would make that certain. Leave it for a later attempt.
    return null;
  }
}

/**
 * Keep a forward-secret message's decryption. **Throws** on failure — this is
 * the only copy, so the caller must know when it was not kept.
 */
export async function archive(account: AccountId, rfc822: string, decrypted: DecryptedMessage): Promise<void> {
  const b = active();
  const key = archiveKeyFor(rfc822);
  if (!b) throw new Error('This device has no storage for forward-secret mail.');
  if (!key) throw new Error('This message has no encrypted block to archive.');
  await b.write(accountDir(account), key, seal(JSON.stringify(decrypted)));
}

/** Everything archived for one account, gone — for removing or resetting it. */
export async function clearArchive(account: AccountId): Promise<void> {
  await active()?.clear(accountDir(account)).catch(() => {});
}

/** What travels in a device transfer: every entry, opened, keyed as it was. */
type ArchiveExport = { v: 1; entries: [string, DecryptedMessage][] };

const ENTRY_NAME = /^[0-9a-f]{64}$/;

/**
 * Everything archived for one account, opened, as one string for a device
 * transfer — which the core seals before it goes anywhere. The device key this
 * archive is sealed under does not travel, so the entries have to be opened
 * here and resealed on the other side.
 *
 * `unreadable` counts entries that would not open. They are left where they are
 * and not sent, and the caller says so: a transfer must not quietly arrive short.
 */
export async function exportArchive(
  account: AccountId,
): Promise<{ archive: string; count: number; unreadable: number }> {
  const b = active();
  const entries: ArchiveExport['entries'] = [];
  let unreadable = 0;
  if (b) {
    const dir = accountDir(account);
    for (const name of await b.list(dir)) {
      if (!ENTRY_NAME.test(name)) continue;
      try {
        const stored = await b.read(dir, name);
        if (stored === null || !isSealed(stored)) throw new Error('not sealed');
        entries.push([name, JSON.parse(unseal(stored)) as DecryptedMessage]);
      } catch {
        unreadable += 1;
      }
    }
  }
  const out: ArchiveExport = { v: 1, entries };
  return { archive: JSON.stringify(out), count: entries.length, unreadable };
}

/**
 * Keep what a transfer brought, sealed under this device's key. Returns how
 * many entries were kept. **Throws** if any cannot be written — as `archive`
 * does, and for the same reason. An empty string is an empty archive.
 */
export async function importArchive(account: AccountId, archived: string): Promise<number> {
  if (!archived) return 0;
  let parsed: ArchiveExport;
  try {
    parsed = JSON.parse(archived) as ArchiveExport;
  } catch {
    throw new Error('The archived mail in this transfer is damaged.');
  }
  if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('The archived mail in this transfer is from a newer version of CryptMail.');
  }
  if (parsed.entries.length === 0) return 0;

  const b = active();
  if (!b) throw new Error('This device has no storage for forward-secret mail.');
  const dir = accountDir(account);
  for (const [name, message] of parsed.entries) {
    if (!ENTRY_NAME.test(name)) throw new Error('The archived mail in this transfer is damaged.');
    await b.write(dir, name, seal(JSON.stringify(message)));
  }
  return parsed.entries.length;
}

function accountDir(account: AccountId): string {
  return bytesToHex(sha256(utf8ToBytes(account)));
}

/**
 * `expo-file-system`, required lazily so importing this module does not load a
 * native module — jest has no binary for it. The document directory, not the
 * cache: see the module note.
 */
function fileBackend(): ArchiveBackend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system');

  const dirFor = (account: string) => new Directory(Paths.document, 'archive', account);
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
    async clear(account) {
      const dir = dirFor(account);
      if (dir.exists) dir.delete();
    },
    async list(account) {
      const dir = dirFor(account);
      return dir.exists ? dir.list().map((entry) => entry.name) : [];
    },
  };
}
