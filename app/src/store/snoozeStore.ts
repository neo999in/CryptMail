/**
 * Persistence for the snooze map (snooze/snooze.ts).
 *
 * Snooze entries only contain a message id and timestamps — not message
 * content — so plain AsyncStorage (not secureJson) is sufficient.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { SnoozeMap } from '../snooze/snooze';

export const SNOOZE_STORE_KEY = 'cryptmail.snooze.v1';

export async function loadSnoozes(): Promise<SnoozeMap> {
  try {
    const raw = await AsyncStorage.getItem(SNOOZE_STORE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SnoozeMap;
  } catch {
    return {};
  }
}

export async function saveSnoozes(snoozes: SnoozeMap): Promise<void> {
  await AsyncStorage.setItem(SNOOZE_STORE_KEY, JSON.stringify(snoozes));
}
