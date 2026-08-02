/**
 * Prototype configuration.
 *
 * The app runs in one of two modes, decided at startup:
 *
 *  · live — a real Google OAuth client is configured AND the native crypto core
 *           is linked. Real mail, real encryption.
 *  · demo — anything missing. Fixtures + the non-cryptographic demo core, with
 *           encrypted sending to real recipients disabled. The UI says so.
 *
 * Set the client id in an `.env` file at the app root (Expo reads EXPO_PUBLIC_*
 * at build time):
 *
 *   EXPO_PUBLIC_GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
 */
import { core } from './core';

export const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '';

/** Least-privilege: read the inbox, send mail. Nothing else. (M3) */
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

export const hasGoogleClient = GOOGLE_CLIENT_ID.length > 0;
export const hasNativeCore = core.kind === 'native';

export type AppMode = 'live' | 'demo';
export const appMode: AppMode = hasGoogleClient && hasNativeCore ? 'live' : 'demo';

/** Why the app is in demo mode — shown to the user rather than hidden. */
export function demoReason(): string | null {
  if (appMode === 'live') return null;
  if (!hasNativeCore && !hasGoogleClient) {
    return 'Demo mode: the Rust crypto core (M2) and Google OAuth client (M3) are not wired up yet.';
  }
  if (!hasNativeCore) return 'Demo mode: the Rust crypto core is not linked, so nothing is really encrypted.';
  return 'Demo mode: no Google OAuth client is configured, so mail is served from fixtures.';
}
