/**
 * When each address was last sent an invite.
 *
 * An invite is a plaintext email to someone who has never heard of CryptMail.
 * Sending one per queued message would turn a person writing three notes to a
 * colleague into three identical "install this app" emails from an address that
 * colleague trusts — which is spam, and would get the sender's mailbox
 * classified as such. One per address per week is enough for something whose
 * only job is to be noticed once.
 *
 * Only addresses and timestamps live here: no subjects, no bodies. It is still
 * sealed like every other store, because a list of who someone is trying to
 * reach is exactly the metadata the product exists to keep local.
 */
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const INVITE_STORE_KEY = 'cryptmail.invites.v1';

/** ISO timestamp of the last invite sent, keyed by lower-cased address. */
export type InviteLog = Record<string, string>;

/** One invite per address per week. */
export const INVITE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadInvites(account: AccountId): Promise<InviteLog> {
  return loadScopedJson<InviteLog>(INVITE_STORE_KEY, account, {});
}

export async function saveInvites(account: AccountId, log: InviteLog): Promise<void> {
  await saveScopedJson(INVITE_STORE_KEY, account, log);
}

const canonical = (email: string) => email.trim().toLowerCase();

/** Whether this address is due an invite (pure). */
export function shouldInvite(log: InviteLog, email: string, now: Date = new Date()): boolean {
  const last = log[canonical(email)];
  if (!last) return true;
  const at = Date.parse(last);
  // An unparseable timestamp is treated as "never", not as "just now": failing
  // towards a duplicate invite is better than failing towards silence.
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= INVITE_WINDOW_MS;
}

/** Record that an invite went out (pure). */
export function recordInvite(log: InviteLog, email: string, now: Date = new Date()): InviteLog {
  return { ...log, [canonical(email)]: now.toISOString() };
}
