/**
 * Persistence for the scheduled-send outbox (outbox/outbox.ts).
 *
 * Holds unsent message text, so like the drafts store it is encrypted at rest
 * through `secureJson`.
 */
import { ScheduledOutbox } from '../outbox/outbox';
import { loadJson, saveJson } from './secureJson';

export const OUTBOX_STORE_KEY = 'cryptmail.outbox.v1';

export async function loadOutbox(): Promise<ScheduledOutbox> {
  return loadJson<ScheduledOutbox>(OUTBOX_STORE_KEY, {});
}

export async function saveOutbox(outbox: ScheduledOutbox): Promise<void> {
  await saveJson(OUTBOX_STORE_KEY, outbox);
}
