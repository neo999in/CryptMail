/**
 * Boot-time initialisation of local storage encryption.
 *
 * Kept apart from `localCrypto.ts` so that module stays free of platform
 * detection and is trivially testable: it takes a `SecretStore` and is told
 * which protection level that store represents.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { ACCOUNTS_STORE_KEY } from './accountsStore';
import { initLocalCrypto, ProtectionLevel, SecretStore } from './localCrypto';
import { resealPlaintext } from './secureJson';
import { DRAFTS_STORE_KEY } from './draftsStore';
import { INVITE_STORE_KEY } from './inviteStore';
import { KEYRING_STORE_KEY } from './keyring';
import { OUTBOX_STORE_KEY } from './outboxStore';
import { PREFS_STORE_KEY } from './prefsStore';
import { PUBLISH_STORE_KEY } from './publishStore';
import { RECOVERY_STORE_KEY } from './recoveryStore';
import { SEARCH_STORE_KEY } from './searchIndex';
import { SNOOZE_STORE_KEY } from './snoozeStore';
import { SPAM_STORE_KEY } from './spamModelStore';

/**
 * The stores that belong to one account, by their unscoped base key.
 *
 * `store/accountScope.ts` turns each of these into a per-account key. The list
 * is what "forget this account" deletes, so a base key missing from it is data
 * that survives removing the mailbox it belongs to — completeness matters.
 */
export const PER_ACCOUNT_STORE_KEYS = [
  KEYRING_STORE_KEY,
  DRAFTS_STORE_KEY,
  OUTBOX_STORE_KEY,
  SEARCH_STORE_KEY,
  RECOVERY_STORE_KEY,
  PUBLISH_STORE_KEY,
  INVITE_STORE_KEY,
  SPAM_STORE_KEY,
  SNOOZE_STORE_KEY,
];

/**
 * Every store whose contents are sealed. Order is irrelevant; completeness is not.
 *
 * These are the *unscoped* keys, which is what the boot sweep wants: a
 * per-account key is only ever written by `saveScopedJson`, and that always
 * seals. What can still be sitting in the clear is a value written by an
 * install that predates either encryption or accounts — and the second of those
 * is read once more, by `loadScopedJson`, on the way into an account.
 */
export const SEALED_STORE_KEYS = [...PER_ACCOUNT_STORE_KEYS, ACCOUNTS_STORE_KEY, PREFS_STORE_KEY];

/**
 * Pick where the data-encryption key lives.
 *
 * `expo-secure-store` has no web implementation — there is no Keychain in a
 * browser — so the web build falls back to AsyncStorage, which puts the key
 * beside the data it protects. That is not real protection, and it is reported
 * as `weak` rather than papered over. It matches the existing platform
 * boundary: web already cannot do real crypto, since a Kotlin module cannot
 * load in a browser.
 */
async function chooseSecretStore(): Promise<{ store: SecretStore; level: ProtectionLevel }> {
  const keystoreAvailable = Platform.OS !== 'web' && (await SecureStore.isAvailableAsync());

  if (keystoreAvailable) {
    return {
      level: 'keystore',
      store: {
        getItem: (k) => SecureStore.getItemAsync(k),
        setItem: (k, v) => SecureStore.setItemAsync(k, v),
      },
    };
  }

  return {
    level: 'weak',
    store: {
      getItem: (k) => AsyncStorage.getItem(k),
      setItem: (k, v) => AsyncStorage.setItem(k, v),
    },
  };
}

let storageReady: Promise<{ protection: ProtectionLevel; upgraded: string[] }> | null = null;

/**
 * Prepare local encryption and upgrade anything still written in the clear.
 *
 * Must run before any store is read. The re-seal sweep matters for an install
 * that predates encryption: without it a keyring written months ago would stay
 * plaintext on disk until something happened to rewrite it, which for a keyring
 * might be never.
 *
 * Memoised, and deliberately so: `AppState`'s boot sequence is not the only
 * caller any more — `ui/appearance.tsx` reads a store too, and mounts as a
 * sibling of `AppState`'s provider rather than inside it, so nothing
 * guarantees one runs before the other. Every caller awaiting the same
 * promise is what makes "call this first" true regardless of mount order,
 * the way `initLocalCrypto`'s own module-level `dek` already does one layer
 * down.
 */
export function initStorage(): Promise<{ protection: ProtectionLevel; upgraded: string[] }> {
  if (!storageReady) storageReady = doInitStorage();
  return storageReady;
}

async function doInitStorage(): Promise<{ protection: ProtectionLevel; upgraded: string[] }> {
  const { store, level } = await chooseSecretStore();
  await initLocalCrypto(store, level);
  const upgraded = await resealPlaintext(SEALED_STORE_KEYS);
  return { protection: level, upgraded };
}

export { protectionLevel } from './localCrypto';
export type { ProtectionLevel } from './localCrypto';
