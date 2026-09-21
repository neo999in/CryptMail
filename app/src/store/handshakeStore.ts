/**
 * What happened to the last handshake sent to each address.
 *
 * A message held for per-email keys goes back through `deliver` on every drain
 * — every sync and every scheduler tick — and each pass would otherwise send
 * the contact another handshake. So a handshake that went out is not sent
 * again by itself: the contact's CryptMail answers the first one it sees,
 * someone who does not use CryptMail gains nothing from a second, and two
 * offers in flight can cross. Only after a week, in case the first was lost,
 * does a drain try again — or sooner, when the user asks (`clearHandshake`).
 *
 * A handshake that *failed* is recorded too, with why, so the outbox can say
 * so instead of showing a bare "queued". It is retried after a short pause:
 * a failure put nothing on the wire, so retrying costs no one an email.
 *
 * Addresses, timestamps and error text only, sealed like every other store,
 * for the same reason as `inviteStore`: who someone is trying to reach is
 * metadata.
 */
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const HANDSHAKE_STORE_KEY = 'cryptmail.handshakes.v1';

export type HandshakeEntry =
  | { outcome: 'sent'; at: string }
  | { outcome: 'failed'; at: string; error: string };

/**
 * Keyed by lower-cased address. A bare string is the earlier format — the time
 * a handshake was sent — and reads as `sent`.
 */
export type HandshakeLog = Record<string, HandshakeEntry | string>;

/** How long a sent handshake stands before a drain sends another by itself. */
export const HANDSHAKE_RESEND_MS = 7 * 24 * 60 * 60 * 1000;
/** How long after a failure a drain tries again. */
export const HANDSHAKE_RETRY_MS = 5 * 60 * 1000;

export async function loadHandshakes(account: AccountId): Promise<HandshakeLog> {
  return loadScopedJson<HandshakeLog>(HANDSHAKE_STORE_KEY, account, {});
}

export async function saveHandshakes(account: AccountId, log: HandshakeLog): Promise<void> {
  await saveScopedJson(HANDSHAKE_STORE_KEY, account, log);
}

const canonical = (email: string) => email.trim().toLowerCase();

/** The last handshake to this address, or `null` if none was ever tried (pure). */
export function handshakeEntry(log: HandshakeLog, email: string): HandshakeEntry | null {
  const raw = log[canonical(email)];
  if (raw === undefined) return null;
  return typeof raw === 'string' ? { outcome: 'sent', at: raw } : raw;
}

/** Whether a drain should send this address a handshake now (pure). An unreadable time counts as never. */
export function shouldHandshake(log: HandshakeLog, email: string, now: Date = new Date()): boolean {
  const entry = handshakeEntry(log, email);
  if (!entry) return true;
  const at = Date.parse(entry.at);
  if (Number.isNaN(at)) return true;
  const wait = entry.outcome === 'sent' ? HANDSHAKE_RESEND_MS : HANDSHAKE_RETRY_MS;
  return now.getTime() - at >= wait;
}

export function recordHandshake(log: HandshakeLog, email: string, now: Date = new Date()): HandshakeLog {
  return { ...log, [canonical(email)]: { outcome: 'sent', at: now.toISOString() } };
}

export function recordHandshakeFailure(
  log: HandshakeLog,
  email: string,
  error: string,
  now: Date = new Date(),
): HandshakeLog {
  return { ...log, [canonical(email)]: { outcome: 'failed', at: now.toISOString(), error } };
}

/** Forget this address, so the next attempt sends regardless of the last one. */
export function clearHandshake(log: HandshakeLog, email: string): HandshakeLog {
  const { [canonical(email)]: _gone, ...rest } = log;
  return rest;
}
