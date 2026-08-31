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
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const SEARCH_STORE_KEY = 'cryptmail.searchindex.v1';

export async function loadSearchIndex(account: AccountId): Promise<SearchIndex> {
  return loadScopedJson<SearchIndex>(SEARCH_STORE_KEY, account, {});
}

export async function saveSearchIndex(account: AccountId, index: SearchIndex): Promise<void> {
  await saveScopedJson(SEARCH_STORE_KEY, account, index);
}
