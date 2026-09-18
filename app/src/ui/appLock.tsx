/**
 * The live app lock: whether CryptMail is locked right now, and the actions
 * that lock, unlock and configure it.
 *
 * In `ui/` beside `mailPrefs.tsx` rather than in `state/`, and for the same
 * reason: `AppState` is the seam to core, mail, auth, keys and store, and a
 * screen lock is none of them. It never touches a message or a key — it only
 * decides whether the UI may be seen. The rules themselves are pure and tested
 * (`applock/appLock.ts`); the device's biometric check is `lib/biometrics.ts`.
 *
 * When it locks:
 *   - on launch, whenever a PIN is set;
 *   - on coming back to the foreground after longer in the background than the
 *     chosen timeout — unless the trip away was something CryptMail opened
 *     itself (`lib/lockExemption.ts`) and was short;
 *   - on "Lock now".
 *
 * The rest of the app stays mounted under the lock, so a half-written reply is
 * still there after unlocking. `AppLockGate` is what covers it.
 */
import * as Crypto from 'expo-crypto';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState as OsAppState } from 'react-native';

import {
  afterFailure,
  afterSuccess,
  AppLockPrefs,
  checkPin,
  cooldownRemaining,
  DEFAULT_APP_LOCK,
  describeWait,
  isLockEnabled,
  LockTimeout,
  makePinVerifier,
  needsRehash,
  PIN_SALT_BYTES,
  shouldLockOnReturn,
} from '../applock/appLock';
import {
  authenticateBiometric,
  BiometricAvailability,
  biometricAvailability,
  BiometricKind,
  biometricKind,
  BiometricOutcome,
} from '../lib/biometrics';
import { awayIsExpected, EXEMPTION_LIMIT_MS } from '../lib/lockExemption';
import { initStorage } from '../store';
import { loadAppLock, saveAppLock } from '../store/appLockStore';

export type PinAttempt = { ok: true } | { ok: false; message: string };

type AppLock = {
  /** True until the stored settings have been read. Nothing is shown meanwhile. */
  loading: boolean;
  /** A PIN is set. */
  enabled: boolean;
  /** The lock screen is up. */
  locked: boolean;
  biometrics: boolean;
  timeout: LockTimeout;
  /** Digits in the PIN, so the pad can check as soon as they are in. 0 with no PIN. */
  pinLength: number;
  /** Epoch ms until which no PIN is checked. 0 when not cooling down. */
  lockedUntil: number;
  /** Whether this device can offer a strong fingerprint or face check at all. */
  biometricSupport: BiometricAvailability | null;
  biometricKind: BiometricKind;

  /** Check a PIN against the stored one, counting it towards the cooldown. Does not unlock. */
  verifyPin: (pin: string) => Promise<PinAttempt>;
  /** `verifyPin`, and unlock on success. */
  unlockWithPin: (pin: string) => Promise<PinAttempt>;
  unlockWithBiometrics: () => Promise<BiometricOutcome>;
  /** Set or replace the PIN. The caller has confirmed it, and checked the old one. */
  setPin: (pin: string) => Promise<void>;
  /** Remove the PIN, and with it the lock and the fingerprint. The caller has checked the PIN. */
  disable: () => Promise<void>;
  /** Turning it on needs a successful scan first, so it is known to work. */
  setBiometrics: (on: boolean) => Promise<BiometricOutcome | 'ok'>;
  setTimeout: (timeout: LockTimeout) => void;
  lockNow: () => void;
  /** Ask the device again — after the user may have enrolled a fingerprint. */
  refreshBiometricSupport: () => void;
};

const AppLockContext = createContext<AppLock | null>(null);

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<AppLockPrefs>(DEFAULT_APP_LOCK);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [support, setSupport] = useState<BiometricAvailability | null>(null);
  const [kind, setKind] = useState<BiometricKind>('biometrics');

  // The newest prefs for the AppState listener and for writes that land after
  // an `await` (the KDF), which must build on what is current, not on the
  // render that started them.
  const current = useRef<AppLockPrefs>(DEFAULT_APP_LOCK);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const away = useRef<{ at: number; expected: boolean } | null>(null);

  /** Apply now, persist in order. A lost write here costs a setting, never access. */
  const commit = useCallback((next: AppLockPrefs) => {
    current.current = next;
    setPrefs(next);
    saving.current = saving.current.then(() => saveAppLock(next)).catch(() => {});
  }, []);

  const refreshBiometricSupport = useCallback(() => {
    void biometricAvailability().then(setSupport);
    void biometricKind().then(setKind);
  }, []);

  useEffect(() => {
    let live = true;
    // A sibling of `AppState`'s provider, so storage is not guaranteed ready —
    // `initStorage()` is memoised, as `ui/mailPrefs.tsx` explains.
    initStorage()
      .then(() => loadAppLock())
      .then((stored) => {
        if (!live) return;
        current.current = stored;
        setPrefs(stored);
        setLocked(isLockEnabled(stored));
      })
      .catch(() => {
        // Only a store that fails to *authenticate* gets here — `loadJson`
        // already degrades a corrupt blob to the default. That means someone
        // wrote the app's storage, and a UI gate is no defence against them
        // anyway (they could as well delete the key); `docs/app-lock.md`.
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    refreshBiometricSupport();
    return () => {
      live = false;
    };
  }, [refreshBiometricSupport]);

  useEffect(() => {
    const subscription = OsAppState.addEventListener('change', (next) => {
      const now = Date.now();
      if (next === 'background') {
        // Only the first departure counts: a picker that itself backgrounds
        // twice must not reset the clock.
        if (!away.current) away.current = { at: now, expected: awayIsExpected() };
        return;
      }
      if (next !== 'active' || !away.current) return;
      const left = away.current;
      away.current = null;
      if (left.expected && now - left.at < EXEMPTION_LIMIT_MS && now >= left.at) return;
      if (shouldLockOnReturn(current.current, left.at, now)) setLocked(true);
    });
    return () => subscription.remove();
  }, []);

  const verifyPin = useCallback(
    async (pin: string): Promise<PinAttempt> => {
      const before = current.current;
      if (!before.pin) return { ok: false, message: 'No PIN is set.' };
      const wait = cooldownRemaining(before, Date.now());
      if (wait > 0) return { ok: false, message: `Too many wrong PINs. Try again in ${describeWait(wait)}.` };

      const right = await checkPin(pin, before.pin);
      const latest = current.current;
      if (right) {
        if (latest.failures > 0 || latest.lockedUntil > 0) commit(afterSuccess(latest));
        // An older, slower verifier: the PIN is known right now, so replace it
        // — after answering, so the lock lifts without waiting on it.
        if (latest.pin && needsRehash(latest.pin)) {
          void makePinVerifier(pin, Crypto.getRandomBytes(PIN_SALT_BYTES)).then((verifier) =>
            commit({ ...current.current, pin: verifier }),
          );
        }
        return { ok: true };
      }
      const failed = afterFailure(latest, Date.now());
      commit(failed);
      const next = cooldownRemaining(failed, Date.now());
      return {
        ok: false,
        message: next > 0 ? `Wrong PIN. Try again in ${describeWait(next)}.` : 'Wrong PIN. Try again.',
      };
    },
    [commit],
  );

  const unlockWithPin = useCallback(
    async (pin: string) => {
      const attempt = await verifyPin(pin);
      if (attempt.ok) setLocked(false);
      return attempt;
    },
    [verifyPin],
  );

  const unlockWithBiometrics = useCallback(async () => {
    if (!current.current.biometrics) return 'unavailable' as const;
    const outcome = await authenticateBiometric('Unlock CryptMail');
    if (outcome === 'ok') {
      const latest = current.current;
      // A fingerprint is a separate factor, so it clears a PIN cooldown too —
      // the system counts and locks out its own failed scans.
      if (latest.failures > 0 || latest.lockedUntil > 0) commit(afterSuccess(latest));
      setLocked(false);
    }
    return outcome;
  }, [commit]);

  const setPin = useCallback(
    async (pin: string) => {
      const verifier = await makePinVerifier(pin, Crypto.getRandomBytes(PIN_SALT_BYTES));
      commit({ ...current.current, pin: verifier, failures: 0, lockedUntil: 0 });
    },
    [commit],
  );

  const disable = useCallback(async () => {
    commit({ ...current.current, pin: null, biometrics: false, failures: 0, lockedUntil: 0 });
    setLocked(false);
  }, [commit]);

  const setBiometrics = useCallback(
    async (on: boolean) => {
      if (!on) {
        commit({ ...current.current, biometrics: false });
        return 'ok' as const;
      }
      if (!current.current.pin) return 'unavailable' as const;
      const outcome = await authenticateBiometric('Confirm to use for CryptMail');
      if (outcome === 'ok') commit({ ...current.current, biometrics: true });
      return outcome;
    },
    [commit],
  );

  const setTimeoutPref = useCallback(
    (timeout: LockTimeout) => commit({ ...current.current, timeout }),
    [commit],
  );

  const lockNow = useCallback(() => {
    if (isLockEnabled(current.current)) setLocked(true);
  }, []);

  const value = useMemo<AppLock>(
    () => ({
      loading,
      enabled: isLockEnabled(prefs),
      locked,
      biometrics: prefs.biometrics,
      timeout: prefs.timeout,
      pinLength: prefs.pin?.length ?? 0,
      lockedUntil: prefs.lockedUntil,
      biometricSupport: support,
      biometricKind: kind,
      verifyPin,
      unlockWithPin,
      unlockWithBiometrics,
      setPin,
      disable,
      setBiometrics,
      setTimeout: setTimeoutPref,
      lockNow,
      refreshBiometricSupport,
    }),
    [
      disable,
      kind,
      loading,
      lockNow,
      locked,
      prefs,
      refreshBiometricSupport,
      setBiometrics,
      setPin,
      setTimeoutPref,
      support,
      unlockWithBiometrics,
      unlockWithPin,
      verifyPin,
    ],
  );

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
}

export function useAppLock(): AppLock {
  const ctx = useContext(AppLockContext);
  if (!ctx) throw new Error('useAppLock must be used within an AppLockProvider');
  return ctx;
}
