/**
 * Persistence for the scheduled-send outbox (outbox/outbox.ts).
 *
 * AsyncStorage-backed JSON, like the drafts store. Holds unsent message text, so
 * it is plaintext at rest — the same "known debt" as the other local stores.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ScheduledOutbox } from '../outbox/outbox';
import { getAsyncItemMigrating } from '../lib/legacyStorageKey';

const STORE_KEY = 'cryptmail.outbox.v1';

export async function loadOutbox(): Promise<ScheduledOutbox> {
  const stored = await getAsyncItemMigrating(STORE_KEY);
  return stored ? (JSON.parse(stored) as ScheduledOutbox) : {};
}

export async function saveOutbox(outbox: ScheduledOutbox): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(outbox));
}
