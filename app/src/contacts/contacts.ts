/**
 * The address book, and the trust record behind it.
 *
 * Two halves, merged into one list:
 *
 *  · the **keyring** — every address this device holds a public key for, with
 *    the trust mark that already decides whether a send is allowed;
 *  · the **mail** — every address that has written to this mailbox or been
 *    written to from it, whether or not it has a key.
 *
 * The second half is what makes this an address book rather than a second view
 * of the Keys screen, and the first is what makes it a trust dashboard. A
 * contact with no key is not an omission: it is precisely the state that holds a
 * message in the outbox behind an invite, so it has to be visible.
 *
 * Pure module — no storage, no network, no React, and **no decryption**. Every
 * field here comes from a cleartext envelope header or from the keyring, so a
 * mailbox full of unopened ciphertext yields the same contact list as one that
 * has been read end to end. Nothing is derived from a message body.
 *
 * The keyring half is complete the moment an account is loaded. The observed
 * half grows as mail is fetched — a caller that has never opened Sent has not
 * seen its addresses — and this module reports what it was handed rather than
 * implying it has seen everything.
 */
import { MailSummary } from '../mail/types';
import { ContactKey, Keyring } from '../store/keyring';

/**
 * A contact's trust state: the keyring's `Trust`, plus the case a keyring cannot
 * represent — an address seen in the mail that has no key at all.
 *
 * `none` is deliberately not called "unknown". Nothing about it is unknown: we
 * know there is no key, and we know exactly what that means for a send.
 */
export type ContactTrust = 'verified' | 'seen' | 'changed' | 'none';

export type Contact = {
  /** Lower-cased — the same canonical form the keyring is keyed by. */
  email: string;
  /** From the key's User ID, or the most recent `From` header that named them. */
  name?: string;
  trust: ContactTrust;
  /** The stored key, when there is one. Absent for a contact seen only in mail. */
  key?: ContactKey;
  /** When the key on file was first seen on this device. */
  keyFirstSeen?: string;
  /** When a *different* fingerprint last arrived for this address, if ever. */
  keyChangedAt?: string;
  /** The fingerprint replaced at `keyChangedAt`. */
  previousFingerprint?: string;
  /** When the safety number was last compared out of band. */
  verifiedAt?: string;
  /** How the key reached this device. */
  keySource?: ContactKey['source'];
  /** Messages this device has seen *from* this address. */
  received: number;
  /** Messages seen addressed *to* it — as recipient or as a co-recipient. */
  addressed: number;
  /** The newest message involving them, in either direction. */
  lastMessageAt?: string;
};

export type ContactsInput = {
  keyring: Keyring;
  /**
   * Every message this device holds — inbox, Sent, Archive, Trash, whatever the
   * caller has loaded. Order does not matter.
   */
  messages: MailSummary[];
  /**
   * The signed-in address, or all of them. Never listed as a contact: the
   * account's own address is on nearly every message and would sit at the top of
   * its own address book claiming to be verified.
   */
  self?: string | string[];
  /**
   * Messages to leave out of the *observed* half — junk, in practice.
   *
   * A predicate rather than a flag, because deciding what is spam needs the
   * personal model and the user's own marks, and this module is not going to
   * grow a dependency on either. The keyring half is never filtered: a key the
   * user imported stays listed whatever folder the mail landed in.
   */
  isJunk?: (message: MailSummary) => boolean;
};

const canonical = (email: string) => email.trim().toLowerCase();

/** The later of two ISO timestamps, either of which may be absent. */
const newer = (a: string | undefined, b: string | undefined): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
};

/**
 * Merge the keyring and the mail into one list, alphabetical by display name.
 *
 * Alphabetical rather than worst-trust-first: this is the list someone scans for
 * a person, and re-ordering it as trust changes would move a row out from under
 * the finger already reaching for it. The states that need attention are
 * surfaced by `trustSummary` and by the screen's filter instead.
 */
export function buildContacts({ keyring, messages, self, isJunk }: ContactsInput): Contact[] {
  const mine = new Set(
    (typeof self === 'string' ? [self] : (self ?? [])).map(canonical).filter((e) => e.length > 0),
  );

  const byEmail = new Map<string, Contact>();

  const touch = (email: string, name?: string): Contact | null => {
    const key = canonical(email);
    if (!key || mine.has(key)) return null;

    let contact = byEmail.get(key);
    if (!contact) {
      const stored = keyring[key];
      contact = {
        email: key,
        name: stored?.name,
        trust: stored?.trust ?? 'none',
        key: stored,
        keyFirstSeen: stored?.firstSeen,
        keyChangedAt: stored?.changedAt,
        previousFingerprint: stored?.previousFingerprint,
        verifiedAt: stored?.verifiedAt,
        keySource: stored?.source,
        received: 0,
        addressed: 0,
      };
      byEmail.set(key, contact);
    }
    // A keyring name wins: it came out of a key's User ID, while a `From`
    // display name is whatever the sender typed into their own mail client.
    if (name && !contact.name) contact.name = name;
    return contact;
  };

  for (const email of Object.keys(keyring)) touch(email);

  for (const message of messages) {
    if (isJunk?.(message)) continue;

    const from = touch(message.from.address, message.from.name);
    if (from) {
      from.received += 1;
      from.lastMessageAt = newer(from.lastMessageAt, message.date);
    }

    for (const recipient of message.to) {
      // A `to` entry can still be a full `Name <a@b>` header depending on the
      // connector, so take the address out rather than trusting the string.
      const to = touch(addressPart(recipient));
      if (!to) continue;
      to.addressed += 1;
      to.lastMessageAt = newer(to.lastMessageAt, message.date);
    }
  }

  return [...byEmail.values()].sort(byDisplayName);
}

/** `Ada Lovelace <ada@example.com>` → `ada@example.com`; a bare address passes through. */
function addressPart(header: string): string {
  const angled = header.match(/<([^>]+)>/);
  return canonical(angled ? angled[1] : header);
}

const labelOf = (contact: Contact) => (contact.name ?? contact.email).toLowerCase();

function byDisplayName(a: Contact, b: Contact): number {
  return labelOf(a).localeCompare(labelOf(b)) || a.email.localeCompare(b.email);
}

/** How many contacts sit in each trust state — the dashboard's headline. */
export function trustSummary(contacts: Contact[]): Record<ContactTrust | 'total', number> {
  const summary = { total: contacts.length, verified: 0, seen: 0, changed: 0, none: 0 };
  for (const contact of contacts) summary[contact.trust] += 1;
  return summary;
}

/**
 * Contacts matching what has been typed so far — Compose's autocomplete.
 *
 * Ranked rather than merely filtered, because the first suggestion is the one
 * that gets picked: an address that *starts* with the query beats one that
 * merely contains it, and among equals the most recently corresponded-with wins.
 *
 * Trust is deliberately **not** part of the ranking. Burying the contacts with
 * no key would hide exactly the people the invite-and-hold path exists for, and
 * the badge on each suggestion already says what the state is.
 */
export function searchContacts(contacts: Contact[], query: string, limit = 6): Contact[] {
  const q = canonical(query);
  if (!q) return [];

  const scored: { contact: Contact; rank: number }[] = [];
  for (const contact of contacts) {
    const name = contact.name?.toLowerCase() ?? '';
    const rank =
      contact.email.startsWith(q) || name.startsWith(q)
        ? 0
        : contact.email.includes(q) || name.includes(q)
          ? 1
          : -1;
    if (rank >= 0) scored.push({ contact, rank });
  }

  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (b.contact.lastMessageAt ?? '').localeCompare(a.contact.lastMessageAt ?? '') ||
        byDisplayName(a.contact, b.contact),
    )
    .slice(0, limit)
    .map((entry) => entry.contact);
}
