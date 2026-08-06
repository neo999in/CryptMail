/**
 * Persistence for the local search index (search/search.ts).
 *
 * This holds decrypted subjects and bodies — a plaintext copy of exactly the
 * mail the user encrypted — which makes it the most sensitive of the local
 * stores and the strongest reason `secureJson` exists. It remains the cache a
 * "no-plaintext-cache" high-security mode would disable outright
 * (data-model.md); encrypting it at rest narrows the exposure but does not
 * remove the copy.
 */
import { SearchIndex } from '../search/search';
import { loadJson, saveJson } from './secureJson';

export const SEARCH_STORE_KEY = 'cryptmail.searchindex.v1';

export async function loadSearchIndex(): Promise<SearchIndex> {
  return loadJson<SearchIndex>(SEARCH_STORE_KEY, {});
}

export async function saveSearchIndex(index: SearchIndex): Promise<void> {
  await saveJson(SEARCH_STORE_KEY, index);
}
