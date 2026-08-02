/**
 * Persistence for the local search index (search/search.ts).
 *
 * Like the keyring, the prototype stores this as AsyncStorage-backed JSON rather
 * than SQLite/SQLCipher — see "Known debt" in prototype-plan.md. Because it holds
 * decrypted subjects and bodies, this is exactly the plaintext cache a
 * "no-plaintext-cache" high-security mode would disable (data-model.md).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { SearchIndex } from '../search/search';

const STORE_KEY = 'ciphermail.searchindex.v1';

export async function loadSearchIndex(): Promise<SearchIndex> {
  const stored = await AsyncStorage.getItem(STORE_KEY);
  return stored ? (JSON.parse(stored) as SearchIndex) : {};
}

export async function saveSearchIndex(index: SearchIndex): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(index));
}
