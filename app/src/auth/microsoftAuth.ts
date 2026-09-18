/**
 * Outlook.com / Microsoft 365 sign-in: OAuth 2.0 authorization code + PKCE, in
 * the system browser.
 *
 * This is the flow Google refuses and Microsoft asks for. A public client on
 * the Microsoft identity platform may redirect to a custom scheme
 * (`cryptmail://auth`), so there is no native SDK and no Play-services
 * dependency — which is also why Outlook works on the web build, where Gmail
 * cannot.
 *
 * ## What is held, and where
 *
 * Unlike `googleAuth`, this module owns a long-lived secret: Microsoft hands
 * the **refresh token** to the app rather than keeping it in a system service.
 * It goes to the OS keystore (`expo-secure-store`), one entry per mailbox, and
 * nowhere else — never onto `Session`, which flows into app state. On web there
 * is no keystore, and the token falls back to AsyncStorage; that is the same
 * `weak` level `storageReason()` already reports for every other web store.
 *
 * Access tokens live in memory only, until a minute before they expire.
 *
 * ## Signing out
 *
 * Microsoft has no revocation endpoint for a public client's refresh token, so
 * signing out deletes it from this device and that is all. The grant itself
 * stays on the account until the user removes the app at
 * account.live.com/consent/Manage (personal) or myapps.microsoft.com (work).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { GRAPH_SCOPES, hasMicrosoftClient, MS_AUTHORITY, MS_CLIENT_ID } from '../config';
import {
  addressFromProfile,
  authorizeUrl,
  base64UrlFromBase64,
  bytesToBase64Url,
  credentialKey,
  formBody,
  isReauthError,
  photoDataUri,
  readRedirect,
} from './microsoftToken';
import { whileAway } from '../lib/lockExemption';
import { describeError } from './revocation';
import { AuthError, AuthProvider, Session } from './types';

/** Registered as-is in Azure — see docs/running-it.md §1c. */
function redirectUri(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin;
  return 'cryptmail://auth';
}

const normalise = (email: string) => email.trim().toLowerCase();

/* -------------------------------------------------------------------------- */
/*  The refresh token, per mailbox                                            */
/* -------------------------------------------------------------------------- */

type Credential = { refreshToken: string; name?: string };

/** Every address with a stored credential, so a blanket sign-out can find them. */
const INDEX_KEY = 'cryptmail.ms.v1.index';

const keystore = Platform.OS !== 'web';
const readSecret = (k: string) => (keystore ? SecureStore.getItemAsync(k) : AsyncStorage.getItem(k));
const writeSecret = (k: string, v: string) =>
  keystore ? SecureStore.setItemAsync(k, v) : AsyncStorage.setItem(k, v);
const dropSecret = (k: string) => (keystore ? SecureStore.deleteItemAsync(k) : AsyncStorage.removeItem(k));

async function readIndex(): Promise<string[]> {
  try {
    const raw = await readSecret(INDEX_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

async function loadCredential(email: string): Promise<Credential | null> {
  const raw = await readSecret(credentialKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Credential;
  } catch {
    return null;
  }
}

async function saveCredential(email: string, credential: Credential) {
  await writeSecret(credentialKey(email), JSON.stringify(credential));
  const index = await readIndex();
  if (!index.includes(email)) await writeSecret(INDEX_KEY, JSON.stringify([...index, email]));
}

async function forget(email: string) {
  tokens.delete(email);
  await dropSecret(credentialKey(email));
  const index = await readIndex();
  if (index.includes(email)) await writeSecret(INDEX_KEY, JSON.stringify(index.filter((e) => e !== email)));
}

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                    */
/* -------------------------------------------------------------------------- */

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

/** An `AuthError` that remembers the OAuth `error` code it came from. */
type TokenError = AuthError & { oauthCode?: string };

const tokens = new Map<string, { token: string; expiresAt: number }>();

/**
 * One refresh per mailbox at a time.
 *
 * Microsoft rotates the refresh token on every use. Two refreshes racing on the
 * same stored token would each save a different successor, and whichever wrote
 * second might hold one Microsoft has already superseded.
 */
const inflight = new Map<string, Promise<string>>();

/** A minute's margin, so a token is never handed out to expire mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

async function tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(`${MS_AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ client_id: MS_CLIENT_ID, scope: GRAPH_SCOPES.join(' '), ...fields }),
    });
  } catch (e) {
    throw new AuthError(`Could not reach Microsoft: ${describeError(e)}`, 'failed');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    const detail = body.error_description?.split('\n')[0] ?? body.error ?? `HTTP ${res.status}`;
    const error: TokenError = new AuthError(`Microsoft refused the sign-in: ${detail}`, 'failed');
    error.oauthCode = body.error;
    throw error;
  }
  return body as TokenResponse;
}

function remember(email: string, response: TokenResponse): number {
  const expiresAt = Date.now() + response.expires_in * 1000 - EXPIRY_MARGIN_MS;
  tokens.set(email, { token: response.access_token, expiresAt });
  return expiresAt;
}

/** Refresh one mailbox, saving the rotated token. Throws `reauth-required` if the grant is gone. */
async function refresh(email: string): Promise<{ token: string; expiresAt: number; name?: string }> {
  const credential = await loadCredential(email);
  if (!credential) throw new AuthError(`${email} is not signed in on this device.`, 'reauth-required');

  let response: TokenResponse;
  try {
    response = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credential.refreshToken });
  } catch (e) {
    if (isReauthError((e as TokenError).oauthCode)) {
      // The grant is gone; the stored token can never work again. This mailbox
      // only — any other one on the device is untouched.
      await forget(email);
      throw new AuthError(`Access to ${email} was revoked or expired. Sign in again to continue.`, 'reauth-required');
    }
    // Offline, or Microsoft returning a 5xx. Keep the credential.
    throw e;
  }
  if (response.refresh_token) await saveCredential(email, { ...credential, refreshToken: response.refresh_token });
  return { token: response.access_token, expiresAt: remember(email, response), name: credential.name };
}

function refreshOnce(email: string): Promise<string> {
  const running = inflight.get(email);
  if (running) return running;
  const run = refresh(email)
    .then((r) => r.token)
    .finally(() => inflight.delete(email));
  inflight.set(email, run);
  return run;
}

/** Who the token belongs to. Asked of Graph, not read off the id token — see `addressFromProfile`. */
async function profileFor(accessToken: string): Promise<{ email: string; name?: string }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new AuthError(`Microsoft signed you in but would not say which mailbox (HTTP ${res.status}).`, 'failed');
  }
  const profile = (await res.json()) as { displayName?: string; mail?: string; userPrincipalName?: string };
  const email = addressFromProfile(profile);
  if (!email) throw new AuthError('This Microsoft account has no mailbox address.', 'failed');
  return { email, name: profile.displayName || undefined };
}

/**
 * The account's own picture, as a `data:` URI.
 *
 * Graph serves the photo as bytes behind the bearer token, so there is no URL
 * `Avatar` could load the way it loads Google's. The small size is asked for
 * first because the result rides on the account's registry ref; personal
 * accounts may not offer sized photos, so the plain one is the fallback.
 *
 * Fetched on every restore, not only at sign-in, because `register` rebuilds
 * the ref from the session and a session without a photo would erase the one
 * stored — the same reason Google's is re-read from each silent sign-in.
 *
 * Never throws. No photo is the ordinary case, and a failure here must not
 * cost the user a sign-in that otherwise worked.
 */
async function photoFor(accessToken: string): Promise<string | undefined> {
  for (const path of ['/me/photos/96x96/$value', '/me/photo/$value']) {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) continue;
      return photoDataUri(new Uint8Array(await res.arrayBuffer()), res.headers.get('Content-Type'));
    } catch {
      // Offline, or a shape this platform's fetch cannot read. Initials it is.
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  The provider                                                              */
/* -------------------------------------------------------------------------- */

export const microsoftAuth: AuthProvider = {
  provider: 'outlook',

  async signIn(): Promise<Session> {
    if (!hasMicrosoftClient) {
      throw new AuthError('No Microsoft client id is configured (EXPO_PUBLIC_MS_CLIENT_ID).', 'not-configured');
    }

    const verifier = bytesToBase64Url(Crypto.getRandomBytes(32));
    const challenge = base64UrlFromBase64(
      await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
        encoding: Crypto.CryptoEncoding.BASE64,
      }),
    );
    const state = bytesToBase64Url(Crypto.getRandomBytes(16));
    const redirect = redirectUri();

    // The browser is ours to open, so returning from it does not trip the app lock.
    const result = await whileAway(() =>
      WebBrowser.openAuthSessionAsync(
        authorizeUrl({
          authority: MS_AUTHORITY,
          clientId: MS_CLIENT_ID,
          redirectUri: redirect,
          scopes: GRAPH_SCOPES,
          challenge,
          state,
        }),
        redirect,
      ),
    );
    if (result.type !== 'success') throw new AuthError('Sign-in was cancelled.', 'cancelled');

    const outcome = readRedirect(result.url, state);
    if (outcome.kind === 'cancelled') throw new AuthError('Sign-in was cancelled.', 'cancelled');
    if (outcome.kind === 'error') throw new AuthError(`Microsoft sign-in failed: ${outcome.message}`, 'failed');

    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code: outcome.code,
      redirect_uri: redirect,
      code_verifier: verifier,
    });
    if (!response.refresh_token) {
      // `offline_access` was not granted. The session would die within the hour
      // with nothing able to renew it, so refuse now rather than then.
      throw new AuthError('Microsoft did not grant offline access, so this mailbox could not stay signed in.', 'failed');
    }

    const [{ email, name }, photo] = await Promise.all([
      profileFor(response.access_token),
      photoFor(response.access_token),
    ]);
    await saveCredential(email, { refreshToken: response.refresh_token, name });
    const expiresAt = remember(email, response);
    return { provider: 'outlook', email, accessToken: response.access_token, expiresAt, name, photo };
  },

  async restoreAll(known: string[] = []): Promise<Session[]> {
    if (!hasMicrosoftClient) return [];

    // No "whoever is in front" here — unlike Play services there is no system
    // account to ask. Only the addresses the registry names are restored.
    const sessions: Session[] = [];
    const failures: unknown[] = [];
    for (const address of [...new Set(known.map(normalise).filter(Boolean))]) {
      try {
        const { token, expiresAt, name } = await refresh(address);
        const photo = await photoFor(token);
        sessions.push({ provider: 'outlook', email: address, accessToken: token, expiresAt, name, photo });
      } catch (e) {
        failures.push(e);
      }
    }
    // The same rule as `googleAuth.restoreAll`: one working mailbox is a working
    // app, and nothing restored with something failed is an error, not a sign-out.
    if (sessions.length === 0 && failures.length > 0) throw failures[0];
    return sessions;
  },

  async signOut(email?: string): Promise<void> {
    const addresses = email ? [normalise(email)] : await readIndex();
    for (const address of addresses) await forget(address);
    if (!email) tokens.clear();
  },

  async freshAccessToken(email: string): Promise<string> {
    const address = normalise(email);
    const held = tokens.get(address);
    if (held && held.expiresAt > Date.now()) return held.token;
    return refreshOnce(address);
  },
};

/** Test seam: the token cache and the in-flight refreshes are module state. */
export const __resetMicrosoftAuthForTests = () => {
  tokens.clear();
  inflight.clear();
};
