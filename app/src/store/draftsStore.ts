/**
 * Persistence for compose drafts (drafts/drafts.ts).
 *
 * Drafts hold unsent message text, so they go through `secureJson` and are
 * encrypted at rest under the device key — see `localCrypto.ts`.
 */
import { Drafts } from '../drafts/drafts';
import { loadJson, saveJson } from './secureJson';

export const DRAFTS_STORE_KEY = 'cryptmail.drafts.v1';

export async function loadDrafts(): Promise<Drafts> {
  return loadJson<Drafts>(DRAFTS_STORE_KEY, {});
}

export async function saveDrafts(drafts: Drafts): Promise<void> {
  await saveJson(DRAFTS_STORE_KEY, drafts);
}
