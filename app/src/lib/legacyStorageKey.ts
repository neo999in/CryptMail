/**
 * Reads a value that may still sit under the app's former `ciphermail.*` key
 * prefix, from before the rename to CryptMail.
 *
 * An install that predates the rename holds its keyring, drafts, outbox, search
 * index, demo identity and session under the old prefix. Dropping those would
 * silently lose a user's contact keys, so every store reads through here: on the
 * first read the value is carried over to the `cryptmail.*` key and the old one
 * is deleted, making the migration a one-time, self-clearing step.
 *
 * Works for both AsyncStorage and expo-secure-store, which disagree on method
 * names, via the small adapter shape below.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

const LEGACY_PREFIX = 'ciphermail.';
const CURRENT_PREFIX = 'cryptmail.';

/** `cryptmail.keyring.v1` → `ciphermail.keyring.v1`; anything else is unchanged. */
export function legacyKeyFor(key: string): string {
  return key.startsWith(CURRENT_PREFIX) ? `${LEGACY_PREFIX}${key.slice(CURRENT_PREFIX.length)}` : key;
}

/**
 * `store.getItem(key)`, falling back once to the pre-rename key and migrating it.
 *
 * Returns null only when neither key holds a value. A failure to clean up the old
 * key is not fatal — the caller still gets its data, and the next read repeats
 * the (idempotent) move.
 */
export async function getItemMigrating(store: KeyValueStore, key: string): Promise<string | null> {
  const current = await store.getItem(key);
  if (current !== null) return current;

  const legacy = legacyKeyFor(key);
  if (legacy === key) return null;

  const carried = await store.getItem(legacy);
  if (carried === null) return null;

  await store.setItem(key, carried);
  try {
    await store.removeItem(legacy);
  } catch {
    // Keeping the stale copy is harmless; the value is already under the new key.
  }
  return carried;
}

/** `getItemMigrating` against AsyncStorage — what every local store here uses. */
export function getAsyncItemMigrating(key: string): Promise<string | null> {
  return getItemMigrating(
    {
      getItem: (k) => AsyncStorage.getItem(k),
      setItem: (k, v) => AsyncStorage.setItem(k, v),
      removeItem: (k) => AsyncStorage.removeItem(k),
    },
    key,
  );
}
