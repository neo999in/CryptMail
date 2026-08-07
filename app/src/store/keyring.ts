/**
 * The local keyring: contacts' public keys (data-model.md `contact_keys`).
 *
 * Only *public* keys live here; the private key never leaves the crypto core.
 * Encrypted at rest through `secureJson` all the same — a keyring is not secret,
 * but it is exactly the record of who someone corresponds with, and the trust
 * marks in it are security decisions an attacker with write access could
 * quietly downgrade.
 */
import { PublicKeyInfo, Trust } from '../core';
import { loadJson, saveJson } from './secureJson';

export type ContactKey = PublicKeyInfo & {
  name?: string;
  trust: Trust;
  source: 'manual' | 'autocrypt';
  firstSeen: string;
  lastSeen: string;
  /** When the safety number was last compared out of band, if ever. */
  verifiedAt?: string;
};

export const KEYRING_STORE_KEY = 'cryptmail.keyring.v1';

export type Keyring = Record<string, ContactKey>;

export async function loadKeyring(): Promise<Keyring> {
  return loadJson<Keyring>(KEYRING_STORE_KEY, {});
}

export async function saveKeyring(keyring: Keyring): Promise<void> {
  await saveJson(KEYRING_STORE_KEY, keyring);
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
      [key.email]: {
        ...existing,
        ...key,
        name: name ?? existing.name,
        trust: 'changed',
        source,
        lastSeen: now,
        // The old verification attested to the *old* key. Carrying the
        // timestamp over would show "verified 3 March" beside a key nobody has
        // ever checked.
        verifiedAt: undefined,
      },
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
      // Carried explicitly: `...key` is a PublicKeyInfo and has no notion of
      // verification, so without this line re-seeing an unchanged key via
      // Autocrypt keeps `trust: 'verified'` but loses the date it was checked.
      verifiedAt: existing?.verifiedAt,
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
