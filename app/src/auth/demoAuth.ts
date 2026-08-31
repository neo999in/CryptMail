/** Demo sign-in: no network, no tokens, a small fixed set of identities. */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getAsyncItemMigrating } from '../lib/legacyStorageKey';
import { DEMO_ADDRESSES } from '../mail/demoMail';
import { AuthProvider, Session } from './types';

const STORE_KEY = 'cryptmail.session.demo';

const sessionFor = (email: string): Session => ({
  provider: 'demo',
  email,
  accessToken: 'demo',
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/**
 * Read what is stored, tolerating the single-session shape written before
 * multi-account existed.
 *
 * That shape was one `Session` object, not an array. Migrating it here rather
 * than at a call site means an existing demo install opens on the mailbox it
 * was already using instead of the sign-in screen.
 */
async function stored(): Promise<Session[]> {
  const raw = await getAsyncItemMigrating(STORE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Session | Session[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function write(sessions: Session[]): Promise<void> {
  if (sessions.length === 0) {
    await AsyncStorage.removeItem(STORE_KEY);
    return;
  }
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(sessions));
}

export const demoAuth: AuthProvider = {
  provider: 'demo',

  /**
   * Connect the next demo mailbox that is not already connected.
   *
   * There is no account picker to show and no credential to type, so "sign in
   * again" has to mean something: it walks `DEMO_ADDRESSES`, which is what
   * makes two accounts reachable in demo mode at all. With all of them
   * connected it re-returns the first, so the button is never a dead end.
   */
  async signIn() {
    await new Promise((r) => setTimeout(r, 500));
    const sessions = await stored();
    const next = DEMO_ADDRESSES.find((email) => !sessions.some((s) => s.email === email));
    if (!next) return sessions[0];

    const session = sessionFor(next);
    await write([...sessions, session]);
    return session;
  },

  restoreAll: stored,

  async signOut(email?: string) {
    if (email === undefined) {
      await write([]);
      return;
    }
    await write((await stored()).filter((s) => s.email !== email));
  },

  async freshAccessToken() {
    return 'demo';
  },
};
