/**
 * The local keyring: contacts' public keys (data-model.md `contact_keys`).
 *
 * Prototype storage is AsyncStorage-backed JSON rather than SQLite/SQLCipher —
 * see "Known debt" in prototype-plan.md. Only *public* keys live here; the
 * private key never leaves the crypto core.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { PublicKeyInfo, Trust } from '../core';
import { getAsyncItemMigrating } from '../lib/legacyStorageKey';

export type ContactKey = PublicKeyInfo & {
  name?: string;
  trust: Trust;
  source: 'manual' | 'autocrypt';
  firstSeen: string;
  lastSeen: string;
};

const STORE_KEY = 'cryptmail.keyring.v1';

export type Keyring = Record<string, ContactKey>;

export async function loadKeyring(): Promise<Keyring> {
  const stored = await getAsyncItemMigrating(STORE_KEY);
  return stored ? (JSON.parse(stored) as Keyring) : {};
}

export async function saveKeyring(keyring: Keyring): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(keyring));
}

/**
 * Add or refresh a contact key.
 *
 * A key that arrives for an address we already know, with a *different*
 * fingerprint, is marked `changed` — never silently replaced. The prototype has
 * no verification UI (known debt), but it must not lose that signal.
 */
export function upsertKey(
  keyring: Keyring,
  key: PublicKeyInfo,
  source: ContactKey['source'],
  name?: string,
): Keyring {
  const now = new Date().toISOString();
  const existing = keyring[key.email];

  if (existing && existing.fingerprint !== key.fingerprint) {
    return {
      ...keyring,
      [key.email]: { ...existing, ...key, name: name ?? existing.name, trust: 'changed', source, lastSeen: now },
    };
  }

  return {
    ...keyring,
    [key.email]: {
      ...key,
      name: name ?? existing?.name,
      trust: existing?.trust ?? 'seen',
      source: existing?.source ?? source,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    },
  };
}

export function removeKey(keyring: Keyring, email: string): Keyring {
  const next = { ...keyring };
  delete next[email];
  return next;
}

export const findKey = (keyring: Keyring, email: string): ContactKey | undefined =>
  keyring[email.trim().toLowerCase()];
