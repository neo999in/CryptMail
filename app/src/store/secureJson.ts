/**
 * The one path every local store writes through.
 *
 * Combines three concerns that were previously repeated in four files, and that
 * have to happen in a specific order:
 *
 *   1. the pre-rename `ciphermail.*` key migration (`legacyStorageKey.ts`),
 *   2. decryption, and
 *   3. the upgrade of values written before encryption existed.
 *
 * Reads tolerate plaintext; writes are always sealed. So an install that
 * predates encryption keeps its data and is upgraded the first time anything
 * changes, without a migration step that could half-fail.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getAsyncItemMigrating } from '../lib/legacyStorageKey';
import { isSealed, seal, unseal } from './localCrypto';

/**
 * Read and decrypt a JSON value, or `fallback` if nothing is stored.
 *
 * Unreadable data returns `fallback` rather than throwing: a corrupt drafts blob
 * must not make the app unbootable. A failure to *authenticate* is different
 * and is re-thrown by `unseal` — see the note there.
 */
export async function loadJson<T>(storeKey: string, fallback: T): Promise<T> {
  const stored = await getAsyncItemMigrating(storeKey);
  if (stored === null) return fallback;

  const json = unseal(stored);
  try {
    return JSON.parse(json) as T;
  } catch {
    // Not valid JSON — an interrupted write, or data from an older shape.
    return fallback;
  }
}

export async function saveJson<T>(storeKey: string, value: T): Promise<void> {
  await AsyncStorage.setItem(storeKey, seal(JSON.stringify(value)));
}

/**
 * Whether a stored value is still plaintext. Used by the boot-time sweep, so an
 * install that predates encryption does not sit unprotected until the user
 * happens to edit each store.
 */
export async function isStoredPlaintext(storeKey: string): Promise<boolean> {
  const stored = await getAsyncItemMigrating(storeKey);
  return stored !== null && !isSealed(stored);
}

/**
 * Re-seal any store still holding plaintext.
 *
 * Without this, a pre-existing keyring stays readable on disk until something
 * writes to it — which for a keyring might be never. Runs once at boot and is a
 * no-op on an install that is already sealed.
 */
export async function resealPlaintext(storeKeys: string[]): Promise<string[]> {
  const upgraded: string[] = [];
  for (const storeKey of storeKeys) {
    const stored = await getAsyncItemMigrating(storeKey);
    if (stored === null || isSealed(stored)) continue;
    await AsyncStorage.setItem(storeKey, seal(stored));
    upgraded.push(storeKey);
  }
  return upgraded;
}
