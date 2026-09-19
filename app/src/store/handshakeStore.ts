/**
 * When each address was last sent a handshake.
 *
 * A message held for per-email keys goes back through `deliver` on every drain
 * — every sync and every scheduler tick — and each pass would otherwise send
 * the contact another handshake. One per address per day is enough: the
 * contact's CryptMail answers the first one it sees, and someone who does not
 * use CryptMail gains nothing from a second.
 *
 * Addresses and timestamps only, sealed like every other store, for the same
 * reason as `inviteStore`: who someone is trying to reach is metadata.
 */
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const HANDSHAKE_STORE_KEY = 'cryptmail.handshakes.v1';

/** ISO timestamp of the last handshake sent, keyed by lower-cased address. */
export type HandshakeLog = Record<string, string>;

export const HANDSHAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function loadHandshakes(account: AccountId): Promise<HandshakeLog> {
  return loadScopedJson<HandshakeLog>(HANDSHAKE_STORE_KEY, account, {});
}

export async function saveHandshakes(account: AccountId, log: HandshakeLog): Promise<void> {
  await saveScopedJson(HANDSHAKE_STORE_KEY, account, log);
}

const canonical = (email: string) => email.trim().toLowerCase();

/** Whether this address is due a handshake (pure). An unreadable time counts as never. */
export function shouldHandshake(log: HandshakeLog, email: string, now: Date = new Date()): boolean {
  const at = Date.parse(log[canonical(email)] ?? '');
  return Number.isNaN(at) || now.getTime() - at >= HANDSHAKE_WINDOW_MS;
}

export function recordHandshake(log: HandshakeLog, email: string, now: Date = new Date()): HandshakeLog {
  return { ...log, [canonical(email)]: now.toISOString() };
}
