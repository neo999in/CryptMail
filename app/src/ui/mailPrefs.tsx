/**
 * The live mail preferences — today, what each swipe direction does.
 *
 * Deliberately here and not in `state/`, for exactly the reason
 * `ui/appearance.tsx` is: `AppState` is the seam to the five subsystems (core,
 * mail, auth, keys, store), and a gesture preference is none of them. It never
 * touches a message or a key — it only decides which action a row *offers*, and
 * running that action still goes through `useApp()` like everything else
 * (`ui/swipeRun.ts`). It is view state that happens to be persisted, which is
 * what this folder already holds.
 *
 * Reading it: `useMailPrefs()`. Both sides are independent — `setSwipe('left',
 * …)` writes one field of the stored object and leaves the other exactly as it
 * was, which is the guarantee the Swipe options screen is built on.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { initStorage } from '../store';
import {
  DEFAULT_MAIL_PREFS,
  loadMailPrefs,
  MailPrefs,
  saveMailPrefs,
} from '../store/mailPrefsStore';
import { SwipeAction, SwipeDirection } from '../swipe/swipe';

type MailPreferences = MailPrefs & {
  /** True until the stored prefs have been read; rows swipe on the defaults. */
  loading: boolean;
  /** Set one side. The other is untouched, on screen and on disk. */
  setSwipe: (direction: SwipeDirection, action: SwipeAction) => void;
  /** What one side does, without the caller learning the field names. */
  swipeFor: (direction: SwipeDirection) => SwipeAction;
};

const MailPrefsContext = createContext<MailPreferences | null>(null);

export function MailPrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<MailPrefs>(DEFAULT_MAIL_PREFS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    // Same reasoning as `ui/appearance.tsx`: this provider is a sibling of
    // `AppState`'s rather than a child, so nothing else guarantees storage is
    // ready first. `initStorage()` is memoised, so this either does the one
    // real init or joins the promise another boot is already awaiting.
    initStorage()
      .then(() => loadMailPrefs())
      .then((stored) => {
        if (live) setPrefs(stored);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Apply immediately, persist in the background — as appearance does, and for
   * the same reason: a picker that waited on storage would feel broken, and a
   * failed write costs a preference rather than data.
   */
  const setSwipe = useCallback((direction: SwipeDirection, action: SwipeAction) => {
    setPrefs((current) => {
      const next: MailPrefs =
        direction === 'left' ? { ...current, swipeLeft: action } : { ...current, swipeRight: action };
      void saveMailPrefs(next);
      return next;
    });
  }, []);

  const value = useMemo<MailPreferences>(
    () => ({
      ...prefs,
      loading,
      setSwipe,
      swipeFor: (direction) => (direction === 'left' ? prefs.swipeLeft : prefs.swipeRight),
    }),
    [loading, prefs, setSwipe],
  );

  return <MailPrefsContext.Provider value={value}>{children}</MailPrefsContext.Provider>;
}

export function useMailPrefs(): MailPreferences {
  const ctx = useContext(MailPrefsContext);
  if (!ctx) throw new Error('useMailPrefs must be used within a MailPrefsProvider');
  return ctx;
}
