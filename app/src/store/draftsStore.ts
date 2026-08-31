/**
 * Persistence for compose drafts (drafts/drafts.ts).
 *
 * Drafts hold unsent message text, so they go through `secureJson` and are
 * encrypted at rest under the device key — see `localCrypto.ts`.
 */
import { Drafts } from '../drafts/drafts';
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const DRAFTS_STORE_KEY = 'cryptmail.drafts.v1';

export async function loadDrafts(account: AccountId): Promise<Drafts> {
  return loadScopedJson<Drafts>(DRAFTS_STORE_KEY, account, {});
}

export async function saveDrafts(account: AccountId, drafts: Drafts): Promise<void> {
  await saveScopedJson(DRAFTS_STORE_KEY, account, drafts);
}
