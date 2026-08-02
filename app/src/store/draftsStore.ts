/**
 * Persistence for compose drafts (drafts/drafts.ts).
 *
 * AsyncStorage-backed JSON, like the keyring and search index. Drafts contain
 * unsent message text, so this is plaintext at rest — the same "known debt" a
 * SQLCipher / encrypt-to-self follow-up would close (prototype-plan.md).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Drafts } from '../drafts/drafts';

const STORE_KEY = 'ciphermail.drafts.v1';

export async function loadDrafts(): Promise<Drafts> {
  const stored = await AsyncStorage.getItem(STORE_KEY);
  return stored ? (JSON.parse(stored) as Drafts) : {};
}

export async function saveDrafts(drafts: Drafts): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(drafts));
}
