/**
 * Prototype configuration.
 *
 * **Gmail is the only mailbox.** There is no fixture mail path in the app: the
 * mail capability is not a mode any more, it is the product. What remains
 * conditional is whether Gmail can be *reached* — a client id has to be
 * configured and Play-services sign-in has to exist on this platform — and when
 * it cannot, the app says so and sign-in fails. It does not substitute dummy
 * mail, which was the previous behaviour and is exactly the silent downgrade
 * this file exists to prevent: a user cannot tell a fixture inbox from a real
 * one by looking at it.
 *
 * That leaves one capability decided at startup:
 *
 *  · crypto — `real` when the native core is linked, else the non-cryptographic
 *             `demo` stand-in.
 *
 * Mail and crypto were once a single `appMode` requiring *both*, which meant a
 * valid OAuth client still yielded demo fixtures until the Rust core existed —
 * so M3/M4 (Gmail transport) could not be commissioned before M5/M6
 * (encryption), the opposite of the ordering prototype-plan.md argues for. With
 * mail no longer switchable, `cryptoMode` alone carries the product claim:
 * `real` means the encryption is real, and the mailbox already is.
 *
 * Set the client id in an `.env` file at the app root (Expo reads EXPO_PUBLIC_*
 * at build time, so Metro must be restarted after a change):
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

export type CryptoMode = 'real' | 'demo';
export type AppMode = 'live' | 'demo';

/**
 * Whether a real Gmail sign-in can be attempted at all.
 *
 * Both halves are configuration, not product modes: a missing client id and a
 * platform without Play services are the two reasons sign-in cannot run, and
 * `mailUnavailableReason()` names whichever applies. Neither one produces
 * fixture mail — the mailbox is always Gmail.
 */
export const canUseGmail = hasGoogleClient && hasSignInModule;

/** Real encryption or the encoded stand-in. Independent of the mailbox. */
export const cryptoMode: CryptoMode = hasNativeCore ? 'real' : 'demo';

/**
 * Whether the product claim holds end to end.
 *
 * Mail is real by construction now, so this tracks the crypto alone. Kept as its
 * own name because it is what the UI asks — "is anything here still a stand-in?"
 * — and because the answer will change again when the native core lands.
 */
export const appMode: AppMode = cryptoMode === 'real' ? 'live' : 'demo';

/**
 * Why a Gmail sign-in cannot be attempted, or null when it can.
 *
 * Shown on the Connect screen *before* the button is pressed, because the
 * alternative is a sign-in that fails with a library error the user cannot act
 * on. This is a setup problem with a specific fix, and it is stated as one.
 */
export function mailUnavailableReason(): string | null {
  if (!hasGoogleClient) {
    return 'No Google OAuth client is configured. Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in app/.env and restart Metro.';
  }
  if (!hasSignInModule) {
    return 'Gmail sign-in needs Google Play services, which this platform does not have. Run the Android build rather than web.';
  }
  return null;
}

/**
 * Why local data is not fully protected at rest, or null when it is.
 *
 * Separate from `demoReason()` because the two are independent: real crypto on
 * a platform with no keystore still leaves the device key beside the data it
 * protects. Reported for the same reason — a weakened guarantee the user cannot
 * see is worse than one they can.
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
 * Why the app is not fully live, or null when it is.
 *
 * Only the crypto can be a stand-in now, and this is the sentence that says so.
 * The mailbox is real whenever there is one at all, so a *reachability* problem
 * is a different sentence with a different fix — see `mailUnavailableReason()`.
 */
export function demoReason(): string | null {
  if (appMode === 'live') return null;
  return 'Demo crypto: the native core is not linked, so nothing is really encrypted. Your mail is real.';
}
