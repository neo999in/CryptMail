/**
 * Quantum links being set up, and how each one ended.
 *
 * An exchange is three messages over as many syncs (`state/bb84.ts`), so
 * something has to remember that one is under way: without it, every sync
 * would start another, and a reply to the first would then match an exchange
 * the core had already replaced. One at a time per address, and a stalled one
 * gives up after `LINK_WINDOW_MS` so a lost message is not permanent.
 *
 * Addresses and timestamps only, sealed like every other store — who someone
 * is setting up a link with is metadata, the same argument as `inviteStore`
 * and `handshakeStore`.
 */
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const LINK_STORE_KEY = 'cryptmail.quantumlinks.v1';

/** Where an exchange with one address got to. */
export type LinkState = 'starting' | 'linked' | 'refused';

export type LinkEntry = { at: string; state: LinkState };

/** Keyed by lower-cased address. */
export type LinkLog = Record<string, LinkEntry>;

/** After this long with no answer, an exchange may be started again. */
export const LINK_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function loadLinks(account: AccountId): Promise<LinkLog> {
  return loadScopedJson<LinkLog>(LINK_STORE_KEY, account, {});
}

export async function saveLinks(account: AccountId, log: LinkLog): Promise<void> {
  await saveScopedJson(LINK_STORE_KEY, account, log);
}

const canonical = (email: string) => email.trim().toLowerCase();

/**
 * May an exchange with this address be started (pure)? Only one may be in
 * flight, but a finished or stale one is no obstacle — relinking is allowed,
 * and a channel that looked watched is worth trying again.
 */
export function shouldLink(log: LinkLog, email: string, now: Date = new Date()): boolean {
  const entry = log[canonical(email)];
  if (!entry || entry.state !== 'starting') return true;
  const at = Date.parse(entry.at);
  return Number.isNaN(at) || now.getTime() - at >= LINK_WINDOW_MS;
}

export function recordLink(
  log: LinkLog,
  email: string,
  state: LinkState = 'starting',
  now: Date = new Date(),
): LinkLog {
  return { ...log, [canonical(email)]: { at: now.toISOString(), state } };
}

/** What became of the exchange with this address, if there was one. */
export function linkState(log: LinkLog, email: string): LinkState | null {
  return log[canonical(email)]?.state ?? null;
}
