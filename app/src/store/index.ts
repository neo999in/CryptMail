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

import { initLocalCrypto, ProtectionLevel, SecretStore } from './localCrypto';
import { resealPlaintext } from './secureJson';
import { DRAFTS_STORE_KEY } from './draftsStore';
import { KEYRING_STORE_KEY } from './keyring';
import { OUTBOX_STORE_KEY } from './outboxStore';
import { SEARCH_STORE_KEY } from './searchIndex';

/** Every store whose contents are sealed. Order is irrelevant; completeness is not. */
export const SEALED_STORE_KEYS = [
  KEYRING_STORE_KEY,
  DRAFTS_STORE_KEY,
  OUTBOX_STORE_KEY,
  SEARCH_STORE_KEY,
];

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

/**
 * Prepare local encryption and upgrade anything still written in the clear.
 *
 * Must run before any store is read. The re-seal sweep matters for an install
 * that predates encryption: without it a keyring written months ago would stay
 * plaintext on disk until something happened to rewrite it, which for a keyring
 * might be never.
 */
export async function initStorage(): Promise<{ protection: ProtectionLevel; upgraded: string[] }> {
  const { store, level } = await chooseSecretStore();
  await initLocalCrypto(store, level);
  const upgraded = await resealPlaintext(SEALED_STORE_KEYS);
  return { protection: level, upgraded };
}

export { protectionLevel } from './localCrypto';
export type { ProtectionLevel } from './localCrypto';
