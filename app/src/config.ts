/**
 * Prototype configuration.
 *
 * Two capabilities, decided independently at startup:
 *
 *  · mail   — `gmail` when a Google OAuth client id is configured, else `demo`
 *             fixtures.
 *  · crypto — `real` when the native core is linked, else the non-cryptographic
 *             `demo` stand-in.
 *
 * These were once a single `appMode` requiring *both*, which meant a valid
 * OAuth client still yielded demo fixtures until the Rust core existed — so
 * M3/M4 (Gmail transport) could not be commissioned before M5/M6 (encryption),
 * the opposite of the ordering prototype-plan.md argues for. Splitting them
 * lets transport be proven on its own, so that when an encrypted send later
 * fails you already know the transport works.
 *
 * `appMode` is retained as the conjunction: 'live' means the product claim
 * holds end to end — real mail *and* real crypto.
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

export type MailMode = 'gmail' | 'demo';
export type CryptoMode = 'real' | 'demo';
export type AppMode = 'live' | 'demo';

/** Real mailbox or fixtures. Independent of whether the crypto is real. */
export const mailMode: MailMode = hasGoogleClient ? 'gmail' : 'demo';

/** Real encryption or the encoded stand-in. Independent of where mail comes from. */
export const cryptoMode: CryptoMode = hasNativeCore ? 'real' : 'demo';

/** Both halves real — the only configuration in which the product claim holds. */
export const appMode: AppMode = mailMode === 'gmail' && cryptoMode === 'real' ? 'live' : 'demo';

/**
 * Why the app is not fully live — shown to the user rather than hidden.
 *
 * Each half is reported separately, because "real Gmail, fake crypto" and
 * "fake mail, real crypto" are both useful configurations during the build and
 * mean very different things for the user's safety.
 */
export function demoReason(): string | null {
  if (appMode === 'live') return null;
  if (cryptoMode === 'demo' && mailMode === 'demo') {
    return 'Demo mode: the Rust crypto core (M2) and Google OAuth client (M3) are not wired up yet.';
  }
  if (cryptoMode === 'demo') {
    return 'Real Gmail, demo crypto: the native core is not linked, so nothing is really encrypted.';
  }
  return 'Real encryption, demo mailbox: no Google OAuth client is configured, so mail is served from fixtures.';
}
