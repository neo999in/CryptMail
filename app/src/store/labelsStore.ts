/**
 * Persistence for local labels (`labels/labels.ts`).
 *
 * Keyed by account: the map is message ids, and an id only means anything
 * inside the mailbox it came from. Sealed like every other store — label names
 * are the user's own summary of their mail, which is precisely the kind of
 * thing this app keeps off the provider and off a readable disk.
 */
import { LabelState, normaliseLabelState } from '../labels/labels';
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const LABELS_STORE_KEY = 'cryptmail.labels.v1';

export async function loadLabels(account: AccountId): Promise<LabelState> {
  return normaliseLabelState(await loadScopedJson<Partial<LabelState>>(LABELS_STORE_KEY, account, {}));
}

export async function saveLabels(account: AccountId, state: LabelState): Promise<void> {
  await saveScopedJson(LABELS_STORE_KEY, account, state);
}
