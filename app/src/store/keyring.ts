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
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

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
  /**
   * When a key last arrived for this address under a *different* fingerprint.
   *
   * Kept for good, including after the new key is verified — "this address has
   * changed key before" is a fact about the correspondent that stays true, and
   * it is the one thing the trust badge alone cannot say once `trust` has moved
   * off `changed`. The contacts dashboard reads it (`contacts/contacts.ts`).
   *
   * Absent means either that no change has been recorded or that the entry
   * predates this field. It is written going forward only, and nothing infers a
   * change from its absence.
   */
  changedAt?: string;
  /** The fingerprint that was replaced at `changedAt`, so the old one can be shown. */
  previousFingerprint?: string;
  /**
   * Every other key that has arrived for this address, newest first.
   *
   * One address can carry more than one key at once — a second device, an old
   * PGP client still in use, or someone substituting theirs. Only `fingerprint`
   * above is ever encrypted to; these are kept so the user can compare each
   * one's safety number and choose (`chooseKey`), rather than the ring
   * flip-flopping to whichever key the last message happened to carry.
   */
  otherKeys?: OtherKey[];
};

/** A key seen for an address that is not the one in use. */
export type OtherKey = {
  fingerprint: string;
  armored: string;
  userId?: string;
  source: ContactKey['source'];
  firstSeen: string;
  lastSeen: string;
  /**
   * The user compared safety numbers and chose a different key over this one.
   * Seeing it again then changes nothing and blocks nothing: that question has
   * been answered by a person, which is all a `changed` block ever asks for.
   */
  setAside?: boolean;
};

/** Other keys for this address the user has not yet decided about. */
export const undecidedKeys = (contact: ContactKey): OtherKey[] =>
  (contact.otherKeys ?? []).filter((k) => !k.setAside);

const asOther = (key: ContactKey, setAside?: boolean): OtherKey => ({
  fingerprint: key.fingerprint,
  armored: key.armored,
  userId: key.userId,
  source: key.source,
  firstSeen: key.firstSeen,
  lastSeen: key.lastSeen,
  setAside,
});

/** `others` with `key` put first, and any older entry for its fingerprint dropped. */
function withOther(others: OtherKey[] | undefined, key: OtherKey): OtherKey[] {
  return [key, ...(others ?? []).filter((k) => k.fingerprint !== key.fingerprint)];
}

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

export async function loadKeyring(account: AccountId): Promise<Keyring> {
  return loadScopedJson<Keyring>(KEYRING_STORE_KEY, account, {});
}

export async function saveKeyring(account: AccountId, keyring: Keyring): Promise<void> {
  await saveScopedJson(KEYRING_STORE_KEY, account, keyring);
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
    const known = existing.otherKeys?.find((k) => k.fingerprint === key.fingerprint);
    // A key the user already compared and chose against. Noted, not adopted:
    // blocking again would ask a question they have answered.
    if (known?.setAside) {
      return {
        ...keyring,
        [key.email]: { ...existing, otherKeys: withOther(existing.otherKeys, { ...known, lastSeen: now }) },
      };
    }
    // The key being replaced is kept, not dropped: if this turns out to be a
    // second device or a substitution, it is the one the user may want back.
    const otherKeys = withOther(
      existing.otherKeys?.filter((k) => k.fingerprint !== key.fingerprint),
      asOther(existing),
    );
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
        // Recorded for both outcomes, and a proven rotation included: the
        // fingerprint under this address did change, and a contact whose key
        // rotates is exactly what the dashboard is for. What the evidence
        // decides is whether it *blocks* — `trust` above — not whether it
        // happened.
        changedAt: now,
        previousFingerprint: existing.fingerprint,
        // The old verification attested to the *old* key. Carrying the
        // timestamp over would show "verified 3 March" beside a key nobody has
        // ever checked.
        verifiedAt: undefined,
        firstSeen: known?.firstSeen ?? now,
        otherKeys,
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
      // Same reason, and the history half of it: re-seeing the current key must
      // not erase the record that an earlier one was replaced.
      changedAt: existing?.changedAt,
      previousFingerprint: existing?.previousFingerprint,
      otherKeys: existing?.otherKeys,
    },
  };
}

/**
 * Settle which key an address uses, after the user compared its safety number.
 *
 * `fingerprint` may be the key in use or any other key seen for the address.
 * It becomes the one in use, `verified`; every other key is set aside, so it
 * no longer blocks when it turns up again. Returns null if the fingerprint is
 * not a key this address has — a stale screen must not certify anything.
 */
export function chooseKey(keyring: Keyring, email: string, fingerprint: string, now = new Date()): Keyring | null {
  const existing = findKey(keyring, email);
  if (!existing) return null;
  const at = now.toISOString();
  const setAside = (others: OtherKey[] | undefined) => (others ?? []).map((k) => ({ ...k, setAside: true }));

  if (existing.fingerprint === fingerprint) {
    return {
      ...keyring,
      [existing.email]: { ...existing, trust: 'verified', verifiedAt: at, otherKeys: setAside(existing.otherKeys) },
    };
  }

  const chosen = existing.otherKeys?.find((k) => k.fingerprint === fingerprint);
  if (!chosen) return null;
  return {
    ...keyring,
    [existing.email]: {
      ...existing,
      fingerprint: chosen.fingerprint,
      armored: chosen.armored,
      userId: chosen.userId,
      source: chosen.source,
      firstSeen: chosen.firstSeen,
      lastSeen: chosen.lastSeen,
      trust: 'verified',
      verifiedAt: at,
      changedAt: at,
      previousFingerprint: existing.fingerprint,
      otherKeys: setAside(withOther(existing.otherKeys?.filter((k) => k !== chosen), asOther(existing))),
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
