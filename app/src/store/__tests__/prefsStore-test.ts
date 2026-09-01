/**
 * Appearance preferences.
 *
 * The load path is the interesting part: these values are read straight into
 * styles, so a palette id with no colours behind it would have every call site
 * fall back on its own. `normalisePrefs` is the single place that decides, and
 * these cases are the ways a bad value can arrive — an older build, a newer
 * build, a half-written blob.
 */
import {
  DEFAULT_PREFS,
  LIGHT_THEME_AVAILABLE,
  normalisePrefs,
  resolveTheme,
} from '../prefsStore';

describe('normalisePrefs', () => {
  it('returns the defaults for a missing store', () => {
    expect(normalisePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalisePrefs(undefined)).toEqual(DEFAULT_PREFS);
  });

  it('keeps a fully valid stored value', () => {
    const stored = { theme: 'system', density: 'compact', auroraPalette: 'violet' } as const;

    expect(normalisePrefs(stored)).toEqual(stored);
  });

  it('falls back to borealis for a palette this build has no colours for', () => {
    const prefs = normalisePrefs({
      theme: 'dark',
      density: 'cosy',
      auroraPalette: 'chartreuse-curtain',
    });

    expect(prefs.auroraPalette).toBe(DEFAULT_PREFS.auroraPalette);
    // The rest of the value survives — one bad field is not a reset.
    expect(prefs.density).toBe('cosy');
  });

  it('falls back per field, not wholesale', () => {
    const prefs = normalisePrefs({
      theme: 'sepia' as never,
      density: 'huge' as never,
      auroraPalette: 'emerald',
    });

    expect(prefs).toEqual({
      theme: DEFAULT_PREFS.theme,
      density: DEFAULT_PREFS.density,
      auroraPalette: 'emerald',
    });
  });

  /**
   * Accent used to be its own stored field with its own six swatches. It is now
   * derived from the palette, so a store written by an older build still has an
   * `accent` in it. It must be dropped rather than carried through — a `Prefs`
   * with a stray field would be saved straight back and outlive the migration.
   */
  it('drops the accent an older build stored', () => {
    const prefs = normalisePrefs({ theme: 'dark', accent: 'red', density: 'roomy' } as never);

    expect(prefs).not.toHaveProperty('accent');
    expect(prefs).toEqual({
      theme: 'dark',
      density: 'roomy',
      auroraPalette: DEFAULT_PREFS.auroraPalette,
    });
  });

  it('is idempotent', () => {
    const once = normalisePrefs({
      theme: 'nonsense' as never,
      density: 'roomy',
      auroraPalette: 'nope',
    });

    expect(normalisePrefs(once)).toEqual(once);
  });
});

describe('resolveTheme', () => {
  it('renders dark whatever is stored, while no light palette exists', () => {
    expect(LIGHT_THEME_AVAILABLE).toBe(false);
    expect(resolveTheme('light')).toBe('dark');
    expect(resolveTheme('system')).toBe('dark');
    expect(resolveTheme('dark')).toBe('dark');
  });
});
