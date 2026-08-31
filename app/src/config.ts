/**
 * Prototype configuration.
 *
 * Two capabilities, decided independently at startup:
 *
 *  · mail   — `gmail` when a Google client id is configured *and* Play-services
 *             sign-in is available, else `unconfigured`: there is no mailbox at
 *             all, and the app says so rather than inventing one.
 *  · crypto — `real` when the native core is linked, else the non-cryptographic
 *             `demo` stand-in.
 *
 * There used to be a third state here — demo *mail*, served from fixtures in
 * `mail/demoMail.ts`. It is gone. Fake mail and fake crypto are not the same
 * kind of stand-in: fake crypto is loudly reported as insecure and still
 * exercises the real send path, whereas a fake mailbox quietly replaced the
 * thing the product is, and every screen had to be read twice to know which one
 * it was describing. The crypto stand-in stays and is still reported.
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
 *   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=xxxxx.apps.googleusercontent.com
 */
import { GoogleSignin } from '@react-native-google-signin/google-signin';

import { core } from './core';
import { protectionLevel } from './store/localCrypto';

/**
 * The **Web**-type client id, even though this runs on Android — the sign-in
 * library uses it to identify the backend that tokens are minted for. The
 * Android client (package + signing SHA-1) also has to exist in the console, but
 * is never named here: Play services matches it implicitly.
 */
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

/**
 * Read, send, and change flags. `updateFlags` calls `messages.modify`, so star,
 * archive and mark-read 403 without this — and those are built, shipped UI.
 *
 * The trade is deliberate and worth stating: `gmail.modify` reads on the consent
 * screen as permission to change and delete mail, which is broader than this app
 * needs for anything but flags. Raising it later would force every user to
 * re-consent, so it is chosen up front rather than discovered.
 */
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
];

export const hasGoogleClient = GOOGLE_WEB_CLIENT_ID.length > 0;
export const hasNativeCore = core.kind === 'native';

/**
 * Whether Play-services sign-in can run at all. False on web, where the native
 * module does not exist — and a web build that claimed a real mailbox would be
 * the same silent downgrade as trap 1 in the handoff, where a working core was
 * reported missing.
 */
export const hasSignInModule = typeof GoogleSignin?.configure === 'function';

export type MailMode = 'gmail' | 'unconfigured';
export type CryptoMode = 'real' | 'demo';
export type AppMode = 'live' | 'degraded';

/** A reachable mailbox, or none. There is no fixture mailbox any more. */
export const mailMode: MailMode = hasGoogleClient && hasSignInModule ? 'gmail' : 'unconfigured';

/** Real encryption or the encoded stand-in. Independent of where mail comes from. */
export const cryptoMode: CryptoMode = hasNativeCore ? 'real' : 'demo';

/** Both halves real — the only configuration in which the product claim holds. */
export const appMode: AppMode = mailMode === 'gmail' && cryptoMode === 'real' ? 'live' : 'degraded';

/** Whether signing in can do anything at all. False leaves the connect screen inert. */
export const canConnectMailbox = mailMode === 'gmail';

/**
 * Why local data is not fully protected at rest, or null when it is.
 *
 * Separate from `degradedReason()` because the two are independent: real
 * crypto on a platform with no keystore still leaves the device key beside the
 * data it protects. Reported for the same reason — a weakened guarantee the
 * user cannot see is worse than one they can.
 */
export function storageReason(): string | null {
  switch (protectionLevel()) {
    case 'keystore':
      return null;
    case 'weak':
      return 'This platform has no secure keystore, so the key protecting local data is stored beside it.';
    default:
      return 'Local storage encryption has not been initialised yet.';
  }
}

/**
 * Why the app is not fully live — shown to the user rather than hidden.
 *
 * Each half is reported separately: "real Gmail, fake crypto" and "no mailbox
 * at all" mean very different things for the user's safety, and the first is
 * the one that must never be allowed to look normal.
 */
export function degradedReason(): string | null {
  if (appMode === 'live') return null;

  if (mailMode === 'unconfigured' && cryptoMode === 'demo') {
    return 'No mailbox and no real encryption: this build has neither a Google OAuth client (M3) nor the Rust crypto core (M2).';
  }
  // The dangerous one, and the reason this function exists: mail is real, so
  // everything on screen looks like the product, and the user has to be told
  // plainly that none of it is actually encrypted.
  if (cryptoMode === 'demo') {
    return 'Real Gmail, demo crypto: the native core is not linked, so nothing is really encrypted.';
  }
  if (hasGoogleClient && !hasSignInModule) {
    return 'No mailbox: Google sign-in needs Play services, which this platform does not have.';
  }
  return 'No mailbox: set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in app/.env to connect one.';
}
