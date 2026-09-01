/**
 * Appearance preferences: theme, colour, density.
 *
 * Global rather than per-account, like `accountsStore` and for the same kind of
 * reason — how the app looks is a property of this device, not of a mailbox.
 * Switching accounts must not restyle the app under the user. So this key is
 * deliberately **not** in `PER_ACCOUNT_STORE_KEYS`, and removing an account
 * leaves it alone.
 *
 * Sealed like every other store, through `secureJson`. There is no secret in
 * here, but the sweep in `store/index.ts` works off a list of keys and a store
 * that opts out of it is a store someone has to remember is different.
 */
import {
  AURORA_PALETTE_IDS,
  DEFAULT_AURORA_PALETTE,
  DEFAULT_DENSITY,
  Density,
  DENSITIES,
} from '../theme';
import { loadJson, saveJson } from './secureJson';

export const PREFS_STORE_KEY = 'cryptmail.prefs.v1';

/**
 * `light` is storable and is honoured as a *preference*, but the app currently
 * resolves it to dark — see `resolveTheme`. Every screen is drawn for a dark
 * ground; a light palette is separate work, and half of the screens converted
 * is worse than none. The picker shows the option disabled and says so.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export type Prefs = {
  theme: ThemeChoice;
  density: Density;
  /**
   * An `AURORA_PALETTES` id — the app's whole colour choice. It sets the aurora
   * band *and* the accent, which is why there is no separate `accent` field:
   * the two were split and nothing on screen explained why one moved without
   * the other. A stored `accent` from an older build is simply ignored here.
   */
  auroraPalette: string;
};

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  density: DEFAULT_DENSITY,
  auroraPalette: DEFAULT_AURORA_PALETTE.id,
};

const THEMES: ThemeChoice[] = ['light', 'dark', 'system'];

/**
 * Whether a light palette exists yet. The Appearance screen reads this to
 * decide whether to disable the Light radio, so the flag and the behaviour of
 * `resolveTheme` cannot drift apart.
 */
export const LIGHT_THEME_AVAILABLE = false;

/**
 * What a stored choice actually renders as.
 *
 * Until `LIGHT_THEME_AVAILABLE`, everything resolves to dark — including
 * `system` on a light-mode device. The stored preference is kept intact so it
 * starts working the day the palette lands, rather than being silently
 * rewritten to `dark` on load.
 */
export function resolveTheme(_choice: ThemeChoice): 'dark' {
  return 'dark';
}

/**
 * Coerce anything read off disk into a valid `Prefs`.
 *
 * A value from a future build, a hand-edited store, or a half-written blob must
 * not be able to hand a screen a palette id with no colours behind it — the
 * band and every accent read would fall back inconsistently. One place decides.
 *
 * Unknown keys are dropped rather than carried, so the `accent` an older build
 * stored does not survive into a `Prefs` that no longer has the field.
 */
export function normalisePrefs(value: Partial<Prefs> | null | undefined): Prefs {
  const theme = value?.theme;
  const density = value?.density;
  const aurora = value?.auroraPalette;
  return {
    theme: theme && THEMES.includes(theme) ? theme : DEFAULT_PREFS.theme,
    density: density && DENSITIES.includes(density) ? density : DEFAULT_PREFS.density,
    auroraPalette:
      aurora && AURORA_PALETTE_IDS.includes(aurora) ? aurora : DEFAULT_PREFS.auroraPalette,
  };
}

export async function loadPrefs(): Promise<Prefs> {
  return normalisePrefs(await loadJson<Partial<Prefs>>(PREFS_STORE_KEY, DEFAULT_PREFS));
}

export async function savePrefs(prefs: Prefs): Promise<Prefs> {
  const next = normalisePrefs(prefs);
  await saveJson(PREFS_STORE_KEY, next);
  return next;
}
