/**
 * The live appearance preferences — accent, density, theme.
 *
 * Deliberately here and not in `state/`. `AppState` is the seam to the five
 * subsystems (core, mail, auth, keys, store); appearance is none of them, it
 * never touches a message or a key, and putting it there would widen the one
 * boundary the architecture depends on staying narrow. It is view state that
 * happens to be persisted, which is exactly what `ui/inboxFilter.tsx` is too.
 *
 * Reading it: `useAccent()` for a colour, `useAppearance()` for the whole thing
 * plus the setters. Styles built at module scope with `StyleSheet.create` cannot
 * call a hook, so anything accented is applied inline at the call site — see
 * `defaultAccent` in the theme for the fixed fallback and why it is not the
 * thing to reach for.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_PREFS,
  loadPrefs,
  Prefs,
  resolveTheme,
  savePrefs,
  ThemeChoice,
} from '../store/prefsStore';
import { AccentName, accentColor, Density, rowPadding } from '../theme';

type Appearance = Prefs & {
  /** The stored `theme` as it actually renders. Dark, for now. */
  resolvedTheme: 'dark';
  /** The accent as a colour, ready to drop into a style. */
  accentColor: string;
  /** Row padding for the current density, so screens don't re-derive it. */
  rowPadding: number;
  /** True until the stored prefs have been read; screens render defaults. */
  loading: boolean;
  setTheme: (theme: ThemeChoice) => void;
  setAccent: (accent: AccentName) => void;
  setDensity: (density: Density) => void;
};

const AppearanceContext = createContext<Appearance | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadPrefs()
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
   * Apply immediately, persist in the background. A swatch tap that waited on
   * storage would feel broken, and a failed write costs the user a preference,
   * not data — so it is not worth blocking the paint or surfacing an error.
   */
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      void savePrefs(next);
      return next;
    });
  }, []);

  const value = useMemo<Appearance>(
    () => ({
      ...prefs,
      resolvedTheme: resolveTheme(prefs.theme),
      accentColor: accentColor(prefs.accent),
      rowPadding: rowPadding(prefs.density),
      loading,
      setTheme: (theme) => update({ theme }),
      setAccent: (accent) => update({ accent }),
      setDensity: (density) => update({ density }),
    }),
    [loading, prefs, update],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): Appearance {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used within an AppearanceProvider');
  return ctx;
}

/** The accent colour alone — the common case by a wide margin. */
export function useAccent(): string {
  return useAppearance().accentColor;
}
