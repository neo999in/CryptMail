/**
 * Gmail OAuth 2.0 with PKCE and no client secret (prototype-plan.md M3).
 *
 * Tokens are persisted in expo-secure-store (Android Keystore-backed), never in
 * AsyncStorage, and never logged.
 */
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

import { GMAIL_SCOPES, GOOGLE_CLIENT_ID, hasGoogleClient } from '../config';
import { decodeUtf8Base64, fromBase64Url } from '../lib/base64';
import { getItemMigrating, KeyValueStore } from '../lib/legacyStorageKey';
import { AuthError, AuthProvider, Session } from './types';

const STORE_KEY = 'cryptmail.session.gmail';
const EXPIRY_SKEW_MS = 60_000;

/** expo-secure-store behind the shared `KeyValueStore` shape, for the key migration. */
const secureStore: KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const redirectUri = AuthSession.makeRedirectUri({ scheme: 'cryptmail', path: 'oauth' });

let cached: Session | null = null;

export const googleAuth: AuthProvider = {
  provider: 'gmail',

  async signIn(): Promise<Session> {
    if (!hasGoogleClient) {
      throw new AuthError('No Google OAuth client id is configured (EXPO_PUBLIC_GOOGLE_CLIENT_ID).', 'not-configured');
    }

    const request = new AuthSession.AuthRequest({
      clientId: GOOGLE_CLIENT_ID,
      redirectUri,
      scopes: GMAIL_SCOPES,
      usePKCE: true,
      // offline + consent so we actually receive a refresh token on first grant.
      extraParams: { access_type: 'offline', prompt: 'consent' },
    });

    const result = await request.promptAsync(discovery);
    if (result.type === 'cancel' || result.type === 'dismiss') {
      throw new AuthError('Sign-in was cancelled.', 'cancelled');
    }
    if (result.type !== 'success') {
      throw new AuthError('Sign-in failed.', 'failed');
    }

    const tokens = await AuthSession.exchangeCodeAsync(
      {
        clientId: GOOGLE_CLIENT_ID,
        code: result.params.code,
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier ?? '' },
      },
      discovery,
    );

    const session: Session = {
      provider: 'gmail',
      email: emailFromIdToken(tokens.idToken) ?? '',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? undefined,
      expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
    };
    await persist(session);
    return session;
  },

  async restore(): Promise<Session | null> {
    if (cached) return cached;
    const stored = await getItemMigrating(secureStore, STORE_KEY);
    cached = stored ? (JSON.parse(stored) as Session) : null;
    return cached;
  },

  async signOut(): Promise<void> {
    cached = null;
    await SecureStore.deleteItemAsync(STORE_KEY);
  },

  async freshAccessToken(): Promise<string> {
    const session = await googleAuth.restore();
    if (!session) throw new AuthError('Not signed in.', 'failed');
    if (session.expiresAt - EXPIRY_SKEW_MS > Date.now()) return session.accessToken;
    if (!session.refreshToken) {
      // Known prototype debt: no re-prompt flow yet (prototype-plan.md).
      throw new AuthError('Session expired and no refresh token is available — sign in again.', 'failed');
    }

    const refreshed = await AuthSession.refreshAsync(
      { clientId: GOOGLE_CLIENT_ID, refreshToken: session.refreshToken, scopes: GMAIL_SCOPES },
      discovery,
    );
    const next: Session = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? session.refreshToken,
      expiresAt: Date.now() + (refreshed.expiresIn ?? 3600) * 1000,
    };
    await persist(next);
    return next.accessToken;
  },
};

async function persist(session: Session) {
  cached = session;
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(session));
}

/** The address comes from the id_token, so no extra round trip on sign-in. */
function emailFromIdToken(idToken?: string | null): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(decodeUtf8Base64(fromBase64Url(idToken.split('.')[1]))) as { email?: string };
    return payload.email?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
