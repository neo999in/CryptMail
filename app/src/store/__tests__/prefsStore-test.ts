/**
 * Appearance preferences.
 *
 * The load path is the interesting part: these values are read straight into
 * styles, so an accent name with no colour behind it would have every call site
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
    const stored = { theme: 'system', accent: 'green', density: 'compact' } as const;

    expect(normalisePrefs(stored)).toEqual(stored);
  });

  it('falls back to blue for an accent this build has no colour for', () => {
    const prefs = normalisePrefs({ accent: 'chartreuse' as never, density: 'cosy', theme: 'dark' });

    expect(prefs.accent).toBe(DEFAULT_PREFS.accent);
    // The rest of the value survives — one bad field is not a reset.
    expect(prefs.density).toBe('cosy');
  });

  it('falls back per field, not wholesale', () => {
    const prefs = normalisePrefs({ theme: 'sepia' as never, accent: 'pink', density: 'huge' as never });

    expect(prefs).toEqual({ theme: DEFAULT_PREFS.theme, accent: 'pink', density: DEFAULT_PREFS.density });
  });

  it('is idempotent', () => {
    const once = normalisePrefs({ theme: 'nonsense' as never, accent: 'red', density: 'roomy' });

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
