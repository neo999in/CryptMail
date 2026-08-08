/**
 * Key resolution for a list of recipients — the input to rule 1.
 *
 * Pure, and deliberately outside `AppState`: this decides whether a send is
 * allowed at all, so it is the one piece of the send path worth testing on its
 * own.
 */
import { Identity } from '../core';
import { ContactKey, findKey, Keyring } from '../store/keyring';

/** Per-recipient outcome of key resolution — drives Compose's fail-safe. */
export type RecipientState = {
  email: string;
  key?: ContactKey;
  status: 'ok' | 'verified' | 'changed' | 'missing';
};

const canonical = (email: string) => email.trim().toLowerCase();

/**
 * This device's own key, shaped as a keyring entry.
 *
 * The identity is never written to the keyring — it is not a contact, and
 * storing it there would let `upsertKey` mark our *own* key `changed`. But
 * mailing yourself is the first thing a new user tries, and without this it
 * fails as "no key" with nothing the user can do about it.
 *
 * `verified` because it is this device's own key: there is no out-of-band
 * comparison to make.
 */
const ownKey = (identity: Identity): ContactKey => ({
  email: canonical(identity.email),
  fingerprint: identity.fingerprint,
  armored: identity.publicKeyArmored,
  trust: 'verified',
  source: 'manual',
  firstSeen: identity.createdAt,
  lastSeen: identity.createdAt,
});

export function resolveRecipientStates(
  keyring: Keyring,
  identity: Identity | null,
  emails: string[],
): RecipientState[] {
  return emails.map((email) => {
    // Our own address resolves from the identity, never the keyring — a stale
    // entry for our own address must not be able to block us from ourselves.
    if (identity && canonical(email) === canonical(identity.email)) {
      return { email, key: ownKey(identity), status: 'verified' };
    }

    const key = findKey(keyring, email);
    if (!key) return { email, status: 'missing' };
    if (key.trust === 'changed') return { email, key, status: 'changed' };
    return { email, key, status: key.trust === 'verified' ? 'verified' : 'ok' };
  });
}
