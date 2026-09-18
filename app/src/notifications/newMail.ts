/**
 * Which rows of a sync are *new mail* — the thing a notification announces.
 *
 * `policy.ts` decides what a notification may say; this decides whether there
 * is anything to say at all. Pure: no React, no platform APIs, no storage. The
 * caller loads and saves the ledger (`store/notifyStore.ts`).
 *
 * ## What counts as new
 *
 * A provider list is a snapshot, not a feed, so "new" is worked out against a
 * per-mailbox ledger of ids this device has already looked at. A row is
 * announced when it is:
 *
 * - **not seen before** — every row a sync returns is recorded, announced or
 *   not, so reading a message elsewhere and marking it unread again does not
 *   announce it a second time;
 * - **unread**, **in the inbox** (not in the provider's junk folder), and **not
 *   from this mailbox's own address** — the three things Gmail and Outlook also
 *   stay quiet about;
 * - **recent** — dated after the ledger started watching, less a little slack
 *   for delivery lag, and no older than `MAX_AGE_MS`. That is what keeps an
 *   archived message moved back to the inbox, or a wider sync window, from
 *   announcing mail from last year;
 * - and, when the scope is `primary`, **not in one of the provider's other
 *   tabs** (Promotions, Social, Updates, Forums) — Gmail's own default. Only
 *   plaintext mail can be in one: an encrypted message's labels are the
 *   provider's reading of ciphertext, and it is always Primary here, as it is
 *   in the categoriser.
 *
 * The first sync a ledger ever sees only *primes* it: everything in it is
 * recorded, nothing is announced. Connecting a mailbox is not an event that
 * should produce "20 new messages".
 *
 * ## Pending
 *
 * `pending` is what the notification currently on the shade counts — mail
 * announced and not yet looked at. A second message arriving before the first
 * was read makes one "2 new messages", not two notifications, and a pending
 * message that has since been read (here or in another client) drops out of
 * the count. The user looking at the mailbox clears it (`clearPending`).
 */
import { providerFiledAsJunk } from '../categorizer/categorizer';
import { PLACEHOLDER_SUBJECT } from '../core';
import { MailSummary } from '../mail/types';
import { NewMail } from './policy';

/** Which inbox mail announces itself. */
export type NotifyScope = 'primary' | 'all';

export const NOTIFY_SCOPES: readonly NotifyScope[] = ['primary', 'all'];

export const NOTIFY_SCOPE_LABEL: Record<NotifyScope, string> = {
  primary: 'Primary only',
  all: 'All inbox mail',
};

export type NotifyLedger = {
  /** ISO time this device started watching the mailbox; `null` until primed. */
  since: string | null;
  /** Ids already looked at, oldest first, bounded by `SEEN_CAP`. */
  seen: string[];
  /** Announced and not yet looked at. What the shade's notification counts. */
  pending: string[];
};

export const EMPTY_LEDGER: NotifyLedger = { since: null, seen: [], pending: [] };

/** Enough to cover several pages of a busy inbox; a ledger is ids only. */
export const SEEN_CAP = 500;

/** Nothing older than two days is news, whatever the ledger says. */
export const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** A message sent just before watching began may be delivered just after. */
export const SINCE_SLACK_MS = 10 * 60 * 1000;

/** The provider tabs that are not Primary (`categorizer.ts` reads the same labels). */
const OTHER_TABS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];

export const isEncryptedSummary = (row: MailSummary): boolean => row.subject.trim() === PLACEHOLDER_SUBJECT;

export type ObserveOptions = {
  /** This mailbox's own address; mail from it is never announced. */
  self: string;
  scope: NotifyScope;
  now: Date;
};

export type Observation = {
  ledger: NotifyLedger;
  /** Rows announced by this sync for the first time. */
  fresh: MailSummary[];
  /** Every row the notification should now count, newest first. */
  pending: MailSummary[];
};

/** Whether a row is the kind of mail that announces itself, ignoring the ledger. */
export function isNotifiable(row: MailSummary, options: ObserveOptions & { since: string }): boolean {
  if (!row.unread) return false;
  if (row.from.address.trim().toLowerCase() === options.self.trim().toLowerCase()) return false;
  const encrypted = isEncryptedSummary(row);
  // Junk and tabs are the provider's verdict on content it could read; on
  // ciphertext it could read nothing, so neither silences encrypted mail.
  if (!encrypted && providerFiledAsJunk(row.labels)) return false;
  if (!encrypted && options.scope === 'primary' && row.labels?.some((l) => OTHER_TABS.includes(l))) return false;

  const at = Date.parse(row.date);
  if (Number.isNaN(at)) return false;
  const now = options.now.getTime();
  if (now - at > MAX_AGE_MS) return false;
  return at >= Date.parse(options.since) - SINCE_SLACK_MS;
}

/**
 * Fold one sync's rows for one mailbox into its ledger.
 *
 * `rows` is whatever the sync listed — newest page, merged or not — and need
 * not be complete: a pending id that is no longer in it is dropped from the
 * count rather than kept on faith, so the number on the shade errs low.
 */
export function observe(ledger: NotifyLedger, rows: readonly MailSummary[], options: ObserveOptions): Observation {
  if (!ledger.since) {
    return {
      ledger: { since: options.now.toISOString(), seen: capSeen(rows.map((r) => r.id)), pending: [] },
      fresh: [],
      pending: [],
    };
  }

  const seen = new Set(ledger.seen);
  const since = ledger.since;
  const fresh = rows.filter((row) => !seen.has(row.id) && isNotifiable(row, { ...options, since }));

  const unreadById = new Map(rows.filter((r) => r.unread).map((r) => [r.id, r]));
  const pendingIds = [...new Set([...ledger.pending, ...fresh.map((r) => r.id)])].filter((id) => unreadById.has(id));
  const pending = pendingIds
    .map((id) => unreadById.get(id)!)
    .sort((a, b) => b.date.localeCompare(a.date));

  const newlySeen = rows.map((r) => r.id).filter((id) => !seen.has(id));
  return {
    ledger: { since, seen: capSeen([...ledger.seen, ...newlySeen]), pending: pendingIds },
    fresh,
    pending,
  };
}

/** The user has looked: nothing is pending, and the shade can be cleared. */
export function clearPending(ledger: NotifyLedger): NotifyLedger {
  return ledger.pending.length === 0 ? ledger : { ...ledger, pending: [] };
}

/** Whether two ledgers differ enough to be worth writing back. */
export function ledgerChanged(a: NotifyLedger, b: NotifyLedger): boolean {
  return a.since !== b.since || !sameIds(a.seen, b.seen) || !sameIds(a.pending, b.pending);
}

/**
 * What the policy is told about one row.
 *
 * `readable` is the content this device decrypted and indexed, if it has. An
 * encrypted row without it is `decrypted: false`, and `policy.ts` will then
 * show nothing of it — not even its `From`, which is unauthenticated until the
 * signature has been checked (policy rule 3).
 */
export function toNewMail(row: MailSummary, readable?: { subject: string; body: string }): NewMail {
  const encrypted = isEncryptedSummary(row);
  if (encrypted) {
    return {
      from: row.from.address,
      fromName: row.from.name,
      subject: readable?.subject,
      snippet: readable?.body,
      encrypted: true,
      decrypted: !!readable,
    };
  }
  return {
    from: row.from.address,
    fromName: row.from.name,
    subject: row.subject,
    snippet: row.snippet,
    encrypted: false,
    decrypted: false,
  };
}

function capSeen(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  return unique.length > SEEN_CAP ? unique.slice(unique.length - SEEN_CAP) : unique;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
