/**
 * The live appearance preferences — colour, density, theme.
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

import { initStorage } from '../store';
import {
  DEFAULT_PREFS,
  loadPrefs,
  Prefs,
  resolveTheme,
  savePrefs,
  ThemeChoice,
} from '../store/prefsStore';
import { AuroraPalette, auroraPalette, Density, rowPadding } from '../theme';

type Appearance = Prefs & {
  /** The stored `theme` as it actually renders. Dark, for now. */
  resolvedTheme: 'dark';
  /** The chosen palette's accent, ready to drop into a style. */
  accentColor: string;
  /** Row padding for the current density, so screens don't re-derive it. */
  rowPadding: number;
  /** The chosen aurora palette, resolved from the stored id. */
  auroraColors: AuroraPalette;
  /** True until the stored prefs have been read; screens render defaults. */
  loading: boolean;
  setTheme: (theme: ThemeChoice) => void;
  setDensity: (density: Density) => void;
  setAuroraPalette: (id: string) => void;
};

const AppearanceContext = createContext<Appearance | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    // This provider mounts as a sibling of `AppState`'s, not inside it, so
    // nothing else guarantees storage is ready before this effect fires —
    // `initStorage()` is memoised, so this either does the one real init or
    // joins the promise `AppState`'s own boot is already awaiting.
    initStorage()
      .then(() => loadPrefs())
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
      accentColor: auroraPalette(prefs.auroraPalette).accent,
      rowPadding: rowPadding(prefs.density),
      auroraColors: auroraPalette(prefs.auroraPalette),
      loading,
      setTheme: (theme) => update({ theme }),
      setDensity: (density) => update({ density }),
      setAuroraPalette: (auroraPalette) => update({ auroraPalette }),
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

/**
 * The accent colour alone — the common case by a wide margin.
 *
 * It is the chosen aurora palette's own accent. One palette colours the band
 * and the UI, so this and `useAuroraPalette()` can never disagree.
 */
export function useAccent(): string {
  return useAppearance().accentColor;
}

/**
 * The whole chosen palette — the band's ribbons and sky, not just its accent.
 * Only the aurora itself needs this; everything else wants `useAccent()`.
 */
export function useAuroraPalette(): AuroraPalette {
  return useAppearance().auroraColors;
}
