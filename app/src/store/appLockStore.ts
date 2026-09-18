/**
 * App lock settings: the PIN verifier, fingerprint on/off, the timeout, and the
 * wrong-PIN count with its cooldown.
 *
 * Global rather than per-account: the lock is in front of the whole app, every
 * mailbox behind it, so it is deliberately **not** in `PER_ACCOUNT_STORE_KEYS`
 * and removing an account leaves it alone.
 *
 * Sealed through `secureJson` and listed in `SEALED_STORE_KEYS`. Here that is
 * not just uniformity: the verifier is only as slow to brute-force as its KDF,
 * and sealing it means doing that needs the keystore's device key first. The
 * failure count lives beside it so that killing the app does not reset the
 * cooldown.
 */
import { AppLockPrefs, DEFAULT_APP_LOCK, normaliseAppLock } from '../applock/appLock';
import { loadJson, saveJson } from './secureJson';

export const APP_LOCK_STORE_KEY = 'cryptmail.applock.v1';

export async function loadAppLock(): Promise<AppLockPrefs> {
  return normaliseAppLock(await loadJson<Partial<AppLockPrefs>>(APP_LOCK_STORE_KEY, DEFAULT_APP_LOCK));
}

export async function saveAppLock(prefs: AppLockPrefs): Promise<AppLockPrefs> {
  const next = normaliseAppLock(prefs);
  await saveJson(APP_LOCK_STORE_KEY, next);
  return next;
}
