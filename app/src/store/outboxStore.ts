/**
 * Persistence for the scheduled-send outbox (outbox/outbox.ts).
 *
 * Holds unsent message text, so like the drafts store it is encrypted at rest
 * through `secureJson`.
 */
import { ScheduledOutbox } from '../outbox/outbox';
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const OUTBOX_STORE_KEY = 'cryptmail.outbox.v1';

export async function loadOutbox(account: AccountId): Promise<ScheduledOutbox> {
  return loadScopedJson<ScheduledOutbox>(OUTBOX_STORE_KEY, account, {});
}

export async function saveOutbox(account: AccountId, outbox: ScheduledOutbox): Promise<void> {
  await saveScopedJson(OUTBOX_STORE_KEY, account, outbox);
}
