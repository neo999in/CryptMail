/**
 * Gmail sign-in through Google Play services.
 *
 * There is no redirect URI and no PKCE exchange here, because Google no longer
 * accepts a custom URI scheme from an Android OAuth client — see
 * `docs/superpowers/specs/2026-08-08-google-auth-native-design.md`.
 *
 * Nothing is persisted, and no token is ever logged. Play services holds the
 * refresh token and mints access tokens on demand, so this module keeps no
 * long-lived secret at all — an improvement on the previous design, which wrote
 * both tokens to secure storage.
 */
import {
  GoogleSignin,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
} from '@react-native-google-signin/google-signin';

import { GMAIL_SCOPES, GOOGLE_WEB_CLIENT_ID, hasGoogleClient } from '../config';
import { describeError, isPermanentAuthFailure } from './revocation';
import { AuthError, AuthProvider, Session } from './types';

let configured = false;

function configure() {
  if (configured) return;
  GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, scopes: GMAIL_SCOPES });
  configured = true;
}

async function requirePlayServices() {
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
 * One shared call at a time, per library method.
 *
 * The library overwrites an in-flight promise rather than queueing behind it,
 * and the overwritten one never settles — so whoever was awaiting it waits
 * forever. It does this for **both** `signInSilently` and `getTokens`, and boot
 * hits both: `AppState` calls `restore()` while the Gmail client it has just
 * built asks for a token, so two silent sign-ins and then two `getTokens` race.
 * The inbox sat empty on a dead promise. Observed on a device, 2026-08-08.
 *
 * Sharing the promise keeps the design's "no cached session" property — Play
 * services is still the only source of truth — while making concurrent callers
 * safe. It deliberately does not cache a *result*: the slot is released as soon
 * as the call settles, so the next caller still asks Play services afresh.
 */
type Slot<T> = { current: Promise<T> | null };

function shared<T>(slot: Slot<T>, start: () => Promise<T>): Promise<T> {
  if (slot.current) return slot.current;

  const started = start();
  slot.current = started;
  // Release the slot however it settles, so the next call starts a fresh
  // attempt. The catch only stops this bookkeeping chain from surfacing as an
  // unhandled rejection; real callers still see the error.
  void started
    .finally(() => {
      if (slot.current === started) slot.current = null;
    })
    .catch(() => {});

  return started;
}

const silentSlot: Slot<Awaited<ReturnType<typeof GoogleSignin.signInSilently>>> = { current: null };
const tokensSlot: Slot<Awaited<ReturnType<typeof GoogleSignin.getTokens>>> = { current: null };

const signInSilentlyShared = () => shared(silentSlot, () => GoogleSignin.signInSilently());
const getTokensShared = () => shared(tokensSlot, () => GoogleSignin.getTokens());

/** Play services owns expiry; this is advisory, so callers keep a sane number. */
const ADVISORY_TTL_MS = 3600_000;

async function sessionFrom(user: { user: { email?: string | null } }): Promise<Session> {
  const { accessToken } = await getTokensShared();
  return {
    provider: 'gmail',
    email: (user.user.email ?? '').toLowerCase(),
    accessToken,
    expiresAt: Date.now() + ADVISORY_TTL_MS,
  };
}

export const googleAuth: AuthProvider = {
  provider: 'gmail',

  async signIn(): Promise<Session> {
    if (!hasGoogleClient) {
      throw new AuthError(
        'No Google client id is configured (EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).',
        'not-configured',
      );
    }
    configure();
    await requirePlayServices();

    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw new AuthError('Sign-in was cancelled.', 'cancelled');
    }
    return sessionFrom(response.data);
  },

  async restore(): Promise<Session | null> {
    if (!hasGoogleClient) return null;
    configure();

    const response = await signInSilentlyShared();
    if (isNoSavedCredentialFoundResponse(response) || !isSuccessResponse(response)) return null;
    return sessionFrom(response.data);
  },

  async signOut(): Promise<void> {
    configure();
    await GoogleSignin.signOut();
  },

  async freshAccessToken(): Promise<string> {
    configure();
    // `signInSilently` returns either a success or `noSavedCredentialFound`;
    // ruling the latter out is what narrows it, since `isSuccessResponse` is
    // typed against the interactive response union.
    const response = await signInSilentlyShared();
    if (isNoSavedCredentialFoundResponse(response) || !isSuccessResponse(response)) {
      throw new AuthError('Not signed in.', 'reauth-required');
    }

    try {
      const { accessToken } = await getTokensShared();
      return accessToken;
    } catch (e) {
      if (isPermanentAuthFailure(e)) {
        // The grant is gone; nothing cached can ever work again. Clearing it
        // here is what stops every later call failing the same way.
        await GoogleSignin.signOut();
        throw new AuthError(
          'Access to your Google account was revoked or expired. Sign in again to continue.',
          'reauth-required',
        );
      }
      // Offline, or Google returning a 5xx. Keep the session: signing the user
      // out over a dropped connection loses a perfectly good grant.
      throw new AuthError(`Could not refresh the session: ${describeError(e)}`, 'failed');
    }
  },
};
