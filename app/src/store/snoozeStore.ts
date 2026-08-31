/**
 * Persistence for the snooze map (snooze/snooze.ts).
 *
 * Keyed by account like every other mailbox store: the map is message ids, and
 * an id only means anything inside the mailbox it came from. A global map would
 * hide a row in one account because a row in another was snoozed, and would
 * survive removing the account it belonged to.
 *
 * It holds ids and timestamps, never message content, but it still goes through
 * `secureJson` — that is what `loadScopedJson` does, and a second storage path
 * for one small map is not worth the exception.
 */
import { SnoozeMap } from '../snooze/snooze';
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const SNOOZE_STORE_KEY = 'cryptmail.snooze.v1';

export async function loadSnoozes(account: AccountId): Promise<SnoozeMap> {
  return loadScopedJson<SnoozeMap>(SNOOZE_STORE_KEY, account, {});
}

export async function saveSnoozes(account: AccountId, snoozes: SnoozeMap): Promise<void> {
  await saveScopedJson(SNOOZE_STORE_KEY, account, snoozes);
}
