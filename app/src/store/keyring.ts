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
  /**
   * How this key reached the device. `directory` is a keyserver lookup — see
   * `keys/discovery.ts` — and is never grounds for more trust than `seen`.
   */
  source: 'manual' | 'autocrypt' | 'directory';
  firstSeen: string;
  lastSeen: string;
  /** When the safety number was last compared out of band, if ever. */
  verifiedAt?: string;
};

/**
 * Whether a key change is demonstrably the contact's own doing.
 *
 * `self-signed` means the new key carries a valid signature made by the key it
 * replaces, which only its holder could produce — so the change is a rotation,
 * not a substitution, and blocking it would be a support burden with no
 * security value (docs/key-management.md, "Key rotation and expiry").
 *
 * Producing that evidence is a core operation and needs the Rust core; until it
 * exists every caller passes `none`, which is today's behaviour exactly.
 */
export type RotationEvidence = 'none' | 'self-signed';

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
 * fingerprint, is marked `changed` — never silently replaced — unless it comes
 * with `rotation: 'self-signed'`, which is proof the contact rotated it
 * themselves. Without that proof the change is indistinguishable from key
 * substitution, and rule 1 applies: sending stops until a human looks at it.
 */
export function upsertKey(
  keyring: Keyring,
  key: PublicKeyInfo,
  source: ContactKey['source'],
  name?: string,
  options: { rotation?: RotationEvidence } = {},
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
        // A proven rotation lands where any newly-seen key lands: trusted on
        // first use, and *not* verified — the signature says the same person
        // made this key, not that anyone has compared its safety number.
        trust: options.rotation === 'self-signed' ? 'seen' : 'changed',
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
