/**
 * Gmail sign-in through Google Play services, for more than one mailbox.
 *
 * There is no redirect URI and no PKCE exchange here, because Google no longer
 * accepts a custom URI scheme from an Android OAuth client — see
 * `docs/superpowers/specs/2026-08-08-google-auth-native-design.md`.
 *
 * Nothing is persisted, and no token is ever logged. Play services holds the
 * refresh token and mints access tokens on demand, so this module keeps no
 * long-lived secret at all.
 *
 * ## How two mailboxes fit through a one-user API
 *
 * Play services has exactly one *current* user per app, which is why this file
 * used to say it could hold a single session while the multi-account plumbing
 * above it went unused. But the **grant** is per Google account and outlives
 * `signOut()` — only `revokeAccess()` removes it. So N accounts are served by
 * re-configuring Play services with `accountName` and silently signing in
 * again between them: one user in front at any instant, several reachable.
 *
 * That makes the configured account **global mutable state**, and it is the
 * whole risk of this design. Interleaving one account's `getTokens` with
 * another's `configure` hands a Gmail client a token for the wrong mailbox —
 * which reads, and could send from, the wrong inbox. Two things prevent it:
 *
 *  1. every Play-services interaction runs on one FIFO queue (`serial`), so a
 *     configure/sign-in/token triple is atomic;
 *  2. the address that comes back is checked against the one asked for before
 *     any token is handed out (`signInAs`). A mismatch fails the call.
 *
 * `accountName` is documented as an account that should be "prioritized", not
 * one that is forced. Check 2 is what makes that wording safe to build on: if
 * Play services ever ignores the hint, callers get an error rather than
 * another mailbox's mail. Verified on a device 2026-09-05 — two Gmail accounts,
 * switched silently and read side by side in a merged inbox — see
 * `docs/superpowers/specs/2026-09-05-multi-gmail-design.md`.
 */
import {
  GoogleSignin,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
} from '@react-native-google-signin/google-signin';

import { GMAIL_SCOPES, GOOGLE_WEB_CLIENT_ID, hasGoogleClient } from '../config';
import { describeError, isPermanentAuthFailure } from './revocation';
import { AuthError, AuthProvider, Session } from './types';

type User = {
  user: {
    email?: string | null;
    /** Play services returns these alongside the address; both may be absent. */
    name?: string | null;
    photo?: string | null;
  };
};

const normalise = (email: string) => email.trim().toLowerCase();

/* -------------------------------------------------------------------------- */
/*  One caller at a time                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every Play-services call, in order.
 *
 * This replaces the two single-flight slots the single-account version used.
 * Those existed because the library **overwrites** an in-flight `signInSilently`
 * or `getTokens` promise rather than queueing behind it, and the overwritten one
 * never settles — boot raced both and the inbox sat empty on a dead promise
 * (observed on a device, 2026-08-08).
 *
 * A queue fixes that same bug and the account-switching one together: it is not
 * enough for two `getTokens` calls not to collide, because between them sits a
 * `configure` that changes whose token the next call returns. The unit that has
 * to be atomic is the whole triple, not each library call.
 *
 * Tasks run whatever the previous one did — a failed refresh for one account
 * must not wedge the queue for the others.
 */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // Swallow only on this bookkeeping chain, so one rejection neither stops the
  // queue nor surfaces as an unhandled rejection. Real callers still see it.
  queue = run.catch(() => {});
  return run;
}

/**
 * Helpers suffixed `Locked` assume the caller already holds the queue.
 * Calling `serial` from inside a task would wait on a queue containing that
 * task — a deadlock, not a slow call.
 */

/* -------------------------------------------------------------------------- */
/*  Which account Play services is pointed at                                 */
/* -------------------------------------------------------------------------- */

/** `undefined` = never configured; `null` = configured with no account hint. */
let configuredAccount: string | null | undefined;

function configureForLocked(email: string | null) {
  if (configuredAccount !== undefined && configuredAccount === email) return;
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    scopes: GMAIL_SCOPES,
    // Omitted rather than passed as undefined when there is no hint, so the
    // library sees the same options object it would have got before.
    ...(email ? { accountName: email } : {}),
  });
  configuredAccount = email;
}

/** Addresses reached this session, so a blanket `signOut()` can cover them. */
const seen = new Set<string>();

/**
 * Access tokens, in memory, per account.
 *
 * The single-account version deliberately cached nothing: Play services was
 * asked afresh every time. That is no longer free. A merged-inbox refresh is
 * `limit + 1` requests *per account* (`mail/gmail.ts`), and without a cache each
 * one would re-point Play services at a different user and silently sign in
 * again — the account thrash would dominate the sync and multiply the window in
 * which the wrong account is in front.
 *
 * The TTL is far shorter than a Google access token's real hour. It is not an
 * expiry — Play services still owns that — but a bound on how long a revoked
 * grant can keep being served from memory. A token that has actually died
 * inside the window still surfaces: `mail/gmail.ts` turns a 401 into
 * `reauth-required`.
 *
 * Never persisted, so it dies with the process.
 */
const tokens = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_TTL_MS = 5 * 60_000;

/** Play services owns expiry; `Session.expiresAt` is advisory only. */
const ADVISORY_TTL_MS = 3600_000;

function cachedToken(email: string): string | null {
  const held = tokens.get(email);
  if (!held) return null;
  if (held.expiresAt <= Date.now()) {
    tokens.delete(email);
    return null;
  }
  return held.token;
}

/* -------------------------------------------------------------------------- */
/*  Play-services primitives                                                  */
/* -------------------------------------------------------------------------- */

async function requirePlayServicesLocked() {
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch (e) {
    throw new AuthError(
      `Google sign-in needs Google Play services, which this device does not have: ${describeError(e)}`,
      'failed',
    );
  }
}

/**
 * Put one account in front and confirm it is the one that arrived.
 *
 * `email` is `null` for "whoever Play services already has", which is what a
 * first launch and a pre-multi-account install need.
 */
async function signInAsLocked(email: string | null): Promise<User> {
  configureForLocked(email);

  const response = await GoogleSignin.signInSilently();
  if (isNoSavedCredentialFoundResponse(response) || !isSuccessResponse(response)) {
    throw new AuthError('Not signed in.', 'reauth-required');
  }

  const got = normalise(response.data.user.email ?? '');
  if (email && got !== email) {
    // Deliberately `failed`, not `reauth-required`. The grant may be perfectly
    // good — this says Play services ignored the account hint, which signing in
    // again does not fix and which must not tear down a working session. The
    // asymmetry `revocation.ts` protects cuts this way: never call something
    // permanent because it was unrecognised.
    throw new AuthError(
      `Google returned ${got || 'a different account'} when asked for ${email}, so this device cannot hold both mailboxes at once.`,
      'failed',
    );
  }

  seen.add(got);
  return response.data;
}

/** A token for the account already in front. Fills the cache under `email`. */
async function tokenLocked(email: string): Promise<string> {
  try {
    const { accessToken } = await GoogleSignin.getTokens();
    tokens.set(email, { token: accessToken, expiresAt: Date.now() + TOKEN_TTL_MS });
    return accessToken;
  } catch (e) {
    if (isPermanentAuthFailure(e)) {
      // The grant is gone; nothing cached can ever work again. Clearing it here
      // is what stops every later call failing the same way — and it clears
      // **this** account only, so the other mailbox is untouched.
      await forgetLocked(email);
      throw new AuthError(
        `Access to ${email} was revoked or expired. Sign in again to continue.`,
        'reauth-required',
      );
    }
    // Offline, or Google returning a 5xx. Keep the session: signing the user
    // out over a dropped connection loses a perfectly good grant.
    throw new AuthError(`Could not refresh the session: ${describeError(e)}`, 'failed');
  }
}

async function sessionFromLocked(user: User): Promise<Session> {
  const email = normalise(user.user.email ?? '');
  return {
    provider: 'gmail',
    email,
    accessToken: await tokenLocked(email),
    expiresAt: Date.now() + ADVISORY_TTL_MS,
    // Straight from the sign-in response — `getTokens` is not asked again and
    // no profile endpoint is called. `?? undefined` because the library returns
    // `null` for an account with no picture, and `Session` says absent.
    name: user.user.name ?? undefined,
    photo: user.user.photo ?? undefined,
  };
}

/** Drop one account's local sign-in state. The grant itself survives. */
async function forgetLocked(email: string) {
  tokens.delete(email);
  seen.delete(email);
  configureForLocked(email);
  await GoogleSignin.signOut();
  // Whatever is in front now is not known, so the next call must reconfigure
  // rather than trust the memoised hint.
  configuredAccount = undefined;
}

/* -------------------------------------------------------------------------- */
/*  The provider                                                              */
/* -------------------------------------------------------------------------- */

export const googleAuth: AuthProvider = {
  provider: 'gmail',

  /**
   * Connect one more mailbox.
   *
   * Signing the current client out first is what makes this "add an account"
   * rather than "return the account already in front": with a user signed in,
   * Play services can answer `signIn()` without ever showing the picker, so
   * adding a second mailbox would silently re-add the first.
   */
  async signIn(): Promise<Session> {
    if (!hasGoogleClient) {
      throw new AuthError(
        'No Google client id is configured (EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).',
        'not-configured',
      );
    }

    return serial(async () => {
      configureForLocked(null);
      await requirePlayServicesLocked();
      // Best-effort: nobody may be signed in, and that is not a failure to add
      // an account.
      await GoogleSignin.signOut().catch(() => {});
      configuredAccount = null;

      const response = await GoogleSignin.signIn();
      if (!isSuccessResponse(response)) {
        throw new AuthError('Sign-in was cancelled.', 'cancelled');
      }
      const session = await sessionFromLocked(response.data);
      seen.add(session.email);
      // Play services is now pointed at the account the user picked, and the
      // memoised hint has to agree with that or the next call would skip a
      // needed reconfigure.
      configuredAccount = session.email;
      return session;
    });
  },

  async restoreAll(known: string[] = []): Promise<Session[]> {
    if (!hasGoogleClient) return [];

    const addresses = [...new Set(known.map(normalise).filter(Boolean))];

    // Nothing stored: restore whoever is in front. This is a first launch, or
    // an install from before the account registry existed.
    if (addresses.length === 0) {
      try {
        return [await serial(async () => sessionFromLocked(await signInAsLocked(null)))];
      } catch (e) {
        if (e instanceof AuthError && e.code === 'reauth-required') return [];
        throw e;
      }
    }

    const sessions: Session[] = [];
    const failures: unknown[] = [];

    for (const address of addresses) {
      try {
        sessions.push(await serial(async () => sessionFromLocked(await signInAsLocked(address))));
      } catch (e) {
        failures.push(e);
      }
    }

    // One mailbox restored is a working app, so a second one that is revoked,
    // or that Play services would not hand over, is simply absent — the state
    // layer marks it as needing a sign-in. Nothing restored *and* something
    // failed is a different situation (an offline launch, most often) and has
    // to reach the user as an error rather than as a silent sign-out.
    if (sessions.length === 0 && failures.length > 0) throw failures[0];
    return sessions;
  },

  async signOut(email?: string): Promise<void> {
    return serial(async () => {
      if (email) {
        await forgetLocked(normalise(email));
        return;
      }
      // Play services only signs out the user in front, so "everything" means
      // walking the accounts this process has actually pointed it at.
      for (const address of [...seen]) await forgetLocked(address);
      tokens.clear();
      configureForLocked(null);
      await GoogleSignin.signOut();
    });
  },

  async freshAccessToken(email: string): Promise<string> {
    const address = normalise(email);

    const held = cachedToken(address);
    if (held) return held;

    return serial(async () => {
      // Re-checked inside the queue: several requests for the same mailbox
      // queue up together, and only the first should reach Play services.
      const filled = cachedToken(address);
      if (filled) return filled;

      await signInAsLocked(address);
      return tokenLocked(address);
    });
  },
};

/** Test seam: the queue, the cache and the configured account are module state. */
export const __resetGoogleAuthForTests = () => {
  queue = Promise.resolve();
  configuredAccount = undefined;
  tokens.clear();
  seen.clear();
};
