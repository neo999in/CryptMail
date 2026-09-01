/**
 * Design tokens.
 *
 * The look is the one described in [docs/design/ui-rework.md](../../docs/design/ui-rework.md):
 * bordered cards floating on a true-black ground rather than filled bars, an
 * accent used sparingly (selection and one primary action, not every control),
 * underline tabs instead of a filled pill segment, and Manrope as the whole UI
 * voice. This borrows the restraint of shadcn/nativecn-style component
 * libraries — a hairline border doing the work a fill used to — rather than
 * the flat, fully-tinted bars of a stock mail client. `docs/design/system-design.html`
 * is an even earlier look and is kept only as history.
 *
 * The one thing carried forward unchanged throughout: the ground is true
 * black, with no ambient wash over it. See `ui/AppBackground.tsx` for why.
 */
import { TextStyle, ViewStyle } from 'react-native';

/* --------------------------------------------------------------- accent ---- */

/**
 * The accent — the colour of a selected tab, an unread count, the FAB, a date
 * stamp — is **not** chosen on its own. It comes from the chosen aurora
 * palette's `accent`, below.
 *
 * There used to be six standalone accent swatches here and a separate aurora
 * picker beside them. Two colour controls on one screen read as one setting
 * that half the app ignored: nothing explained why the band stayed cyan when
 * the accent went red. One palette now colours both, so the choice is whole.
 *
 * Trust colour is deliberately **not** part of it. `mint` (verified) and
 * `coral` (blocked, key changed) are fixed at every palette, because what a
 * signature proved is not a matter of taste and a user must not be able to
 * recolour it into something it isn't.
 */

/** Ink that stays legible on top of a filled accent — every accent is mid-tone. */
export const ON_ACCENT = '#0B0F14';

/* -------------------------------------------------------- aurora bands ---- */

/**
 * The aurora palettes offered in Display & Appearance, ported as-is from the
 * `reacticx-aurora` component — three ribbon hues over a near-black sky that
 * falls to true black.
 *
 * These are **not** the accent, and picking one does not change it: the band is
 * the one surface in the app that carries its own colour. They live here rather
 * than in `ui/aurora/` because `store/prefsStore` has to validate a stored id
 * and nothing in `store/` may import from `ui/` — the same reason `accents` and
 * `DENSITIES` are here.
 *
 * Every sky bottoms out at `#000000`, so whichever is chosen the band still
 * meets the app's true-black ground cleanly on an OLED panel. A palette added
 * here must keep that property.
 */
export type AuroraPalette = {
  id: string;
  /** As the reference names it, shown beside the swatches. */
  name: string;
  /** The three ribbon hues, in the order the shader mixes them. */
  auroraColors: [string, string, string];
  /** `[top, bottom]` of the sky the ribbons are laid over. */
  skyColors: [string, string];
  /** The palette's own tint, for anything tuned to sit beside the band. */
  accent: string;
};

export const AURORA_PALETTES: AuroraPalette[] = [
  {
    id: 'borealis',
    name: 'Borealis Cyan',
    auroraColors: ['#44DCEA', '#968CFF', '#4ADE80'],
    skyColors: ['#090B14', '#000000'],
    accent: '#44DCEA',
  },
  {
    id: 'emerald',
    name: 'Emerald Forest',
    auroraColors: ['#10B981', '#34D399', '#059669'],
    skyColors: ['#04120D', '#000000'],
    accent: '#10B981',
  },
  {
    id: 'violet',
    name: 'Cosmic Violet',
    auroraColors: ['#8B5CF6', '#EC4899', '#3B82F6'],
    skyColors: ['#0D0B18', '#000000'],
    accent: '#8B5CF6',
  },
  {
    id: 'solar',
    name: 'Solar Horizon',
    auroraColors: ['#F59E0B', '#EF4444', '#F43F5E'],
    skyColors: ['#140D0B', '#000000'],
    accent: '#F59E0B',
  },
  {
    id: 'arctic',
    name: 'Arctic Glow',
    auroraColors: ['#38BDF8', '#818CF8', '#A78BFA'],
    skyColors: ['#080C1A', '#000000'],
    accent: '#38BDF8',
  },
];

export const AURORA_PALETTE_IDS = AURORA_PALETTES.map((p) => p.id);

export const DEFAULT_AURORA_PALETTE: AuroraPalette = AURORA_PALETTES[0];

/** Looks a palette up by id, falling back to the default rather than throwing. */
export function auroraPalette(id?: string): AuroraPalette {
  return AURORA_PALETTES.find((p) => p.id === id) ?? DEFAULT_AURORA_PALETTE;
}

/**
 * A low-opacity wash of a colour, for a selected state that should read as a
 * tinted card rather than a solid block. `alpha` is 0–1.
 *
 * Every accent here is a 6-digit hex, so appending a 2-digit alpha suffix is
 * exact — no colour math, no rgba() parsing.
 */
export function tint(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

/**
 * The accent as a plain constant, for the module-scope `StyleSheet.create` calls
 * that cannot read a hook.
 *
 * Prefer `useAccent()` — a style that bakes this in will not follow the user's
 * choice. Reach for it only where the value is genuinely fixed (a default
 * argument, a placeholder) and apply the live accent inline at the call site.
 */
export const defaultAccent = DEFAULT_AURORA_PALETTE.accent;

/* -------------------------------------------------------------- surfaces ---- */

export const color = {
  /**
   * True black.
   *
   * On an OLED panel a `#000000` pixel is switched off — no light, no power, and
   * a contrast ratio nothing else can reach. The list surface *is* this colour;
   * only the bars lift off it.
   */
  ground: '#000000',
  /** A recessed inset inside a panel — a code block, a ciphertext dump. */
  ground2: '#0A0A0A',

  /** Top bars, the drawer panel, sheets — the flat grey that lifts off black. */
  surface: '#1F1F1F',
  /**
   * A card floating directly on the true-black ground — barely lighter than
   * `ground`, doing its work with `border` rather than a fill. This is the
   * mail row, the settings group, the rail's active tile: bordered cards with
   * air between them, not a continuous filled list.
   */
  card: '#0D0D0D',
  cardPress: '#141414',
  /** The hairline around a card. Quieter than `line`, which still separates
   *  rows inside a flat list where one survives (the filter sheet, a menu). */
  border: 'rgba(255,255,255,0.09)',
  borderStrong: 'rgba(255,255,255,0.16)',
  /** A control resting on `surface`: the Filter pill, a settings search field. */
  surfaceRaised: '#2A2A2A',
  /** The track of a segmented control. */
  segment: '#262626',
  /** The selected thumb inside that track. */
  segmentActive: '#4D4D4D',

  /** Hairline between rows and under bars. */
  line: '#262626',
  /** The fainter rule used inside a panel. */
  lineSoft: '#1A1A1A',
  /** Whole-row press wash — neutral, so it reads at any accent. */
  rowPress: 'rgba(255,255,255,0.06)',

  ink: '#F2F2F2',
  inkDim: '#A3A3A3',
  inkFaint: '#6E6E6E',
  body: '#E0E0E0',

  /** Verified / protected. Fixed at every accent — see `accents`. */
  mint: '#34D399',
  mintBg: '#0E241B',
  mintInk: '#A7E6CC',
  mintLine: 'rgba(52,211,153,0.30)',
  /** Blocked, key changed, destructive. Fixed at every accent. */
  coral: '#F2795E',
  coralBg: '#2C1A15',
  coralInk: '#F0BCAD',
  coralLine: 'rgba(242,121,94,0.30)',

  /** Scrim behind sheets and popovers — black, so it dims towards the ground. */
  scrim: 'rgba(0,0,0,0.78)',

  /**
   * The previous palette's brass family and panel greys.
   *
   * @deprecated Kept only so screens still on the old look keep compiling while
   * the rework lands screen by screen. Nothing new should reference these: the
   * accent comes from `useAccent()`, surfaces from `surface`/`surfaceRaised`.
   */
  brass: '#EBB863',
  brassDark: '#C99A4E',
  brassBg: '#2A2214',
  brassInk: '#241A08',
  panel: '#1A1A1A',
  panel2: '#242424',
  chip: '#242424',
  focus: 'rgba(59,147,247,0.55)',
  press: 'rgba(255,255,255,0.06)',
} as const;

/**
 * Blur is now used in exactly one place — the scrim behind a modal sheet — so
 * these are the tokens for that and nothing else. Panels are flat fills.
 *
 * @deprecated `fill`, `fillStrong`, `fillBrass` and `fillWarn` survive for the
 * screens not yet reworked; `Glass` itself is on its way out of everything but
 * `Sheet`.
 */
export const glass = {
  fill: 'rgba(31,31,31,0.92)',
  fillStrong: 'rgba(20,20,20,0.96)',
  fillBrass: 'rgba(42,34,20,0.55)',
  fillWarn: 'rgba(44,26,21,0.60)',
  hairline: 'rgba(255,255,255,0.08)',
  hairlineBrass: 'rgba(235,184,99,0.42)',
  blur: { soft: 22, medium: 40, strong: 64 },
} as const;

export const radius = {
  /** Cards: the mail row, a settings group, the rail's active tile. */
  xl: 18,
  lg: 14,
  /** Controls: buttons, fields, icon buttons. */
  sm: 9,
  xs: 6,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
} as const;

/* -------------------------------------------------------------- density ---- */

export type Density = 'compact' | 'cosy' | 'roomy';

export const DENSITIES: Density[] = ['compact', 'cosy', 'roomy'];

export const DEFAULT_DENSITY: Density = 'roomy';

/**
 * How much air a list row gets. Vertical padding and row height only — **never
 * font size**: density is about how much fits on screen, not how readable the
 * text is, and shrinking type to fit more is how a mail app becomes unusable.
 *
 * `cosy` is 1, so the scale is a no-op until Display & Appearance can set it.
 */
export const densityScale: Record<Density, number> = {
  compact: 0.72,
  cosy: 1,
  roomy: 1.24,
};

/** Row padding for a density, in points. */
export function rowPadding(density: Density): number {
  return Math.round(11 * densityScale[density]);
}

/* ----------------------------------------------------------------- type ---- */

/**
 * Font families. Loaded once in App.tsx (expo-font) and referenced here by their
 * exact registered name. Custom faces do not synthesize weight from `fontWeight`
 * reliably, so each weight is addressed as its own family — reach for these,
 * never `fontWeight`.
 *
 *  · Manrope        — the UI. Rows, headers, buttons, settings, body copy.
 *  · JetBrains Mono — cryptographic truth: fingerprints, safety numbers, raw
 *                     addresses in the key screens. Nowhere else.
 *  · Space Grotesk  — retained for the connect/setup screens' brand voice only.
 */
export const font = {
  sans: 'Manrope_400Regular',
  sansMedium: 'Manrope_500Medium',
  sansSemibold: 'Manrope_600SemiBold',
  sansBold: 'Manrope_700Bold',
  sansExtrabold: 'Manrope_800ExtraBold',

  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',

  display: 'SpaceGrotesk_500Medium',
  displayBold: 'SpaceGrotesk_700Bold',
} as const;

/**
 * Type scale. Weight lives in the family name, so a role is a face plus a size —
 * never a stray `fontWeight`.
 *
 * The row roles are the reference's: a mail row is three lines of one family at
 * three weights, which is what lets the subject lead without a colour trick.
 */
export const type = {
  /** Screen titles — "Inbox", "Settings". */
  display: { fontFamily: font.sansBold, fontSize: 21, letterSpacing: -0.3 },
  /** Card and section titles. */
  heading: { fontFamily: font.sansBold, fontSize: 17, letterSpacing: -0.2 },

  /** Mail row line 1 — sender. */
  row: { fontFamily: font.sansSemibold, fontSize: 15 },
  /** Mail row line 2 — subject. */
  rowSubject: { fontFamily: font.sansSemibold, fontSize: 15, lineHeight: 20 },
  /** Mail row line 3 — snippet. */
  rowSub: { fontFamily: font.sans, fontSize: 14, lineHeight: 19 },
  /** The right-aligned date stamp; drawn in the accent. */
  date: { fontFamily: font.sansMedium, fontSize: 13 },

  /** An underline tab's label. */
  tab: { fontFamily: font.sansSemibold, fontSize: 14.5 },
  /** A settings row's label, and a drawer destination. */
  settingsRow: { fontFamily: font.sans, fontSize: 16 },
  /** The value line under it — "Dark / Blue / Roomy". */
  settingsValue: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 18 },

  /** Button text and other emphasised UI. */
  strong: { fontFamily: font.sansSemibold, fontSize: 14.5 },
  /** Reading copy and explanatory text. */
  body: { fontFamily: font.sans, fontSize: 14, lineHeight: 21 },
  /** Secondary text — notes, hints. */
  small: { fontFamily: font.sans, fontSize: 12.5, lineHeight: 18 },

  /** Mono metadata — fingerprints, safety numbers, timestamps. */
  meta: { fontFamily: font.mono, fontSize: 11.5 },
  /** Section head above a settings group. Drawn in the accent, not uppercase. */
  section: { fontFamily: font.sansSemibold, fontSize: 13.5 },
  /** Uppercase mono eyebrow, now only in the key screens. */
  eyebrow: { fontFamily: font.mono, fontSize: 10.5, letterSpacing: 1, textTransform: 'uppercase' },
} satisfies Record<string, TextStyle>;

/**
 * Elevation. Flat surfaces need almost none of it — a bar sits on the ground by
 * being lighter than it, not by casting a shadow. What is left is the FAB and
 * the sheet, which genuinely float.
 *
 * `boxShadow` rather than the `shadow*` props: those are deprecated as of
 * RN 0.81 and warn on every render.
 */
export const shadow = {
  raised: { boxShadow: '0 1px 2px rgba(0,0,0,0.30)' },
  floating: { boxShadow: '0 4px 12px rgba(0,0,0,0.45)' },
  sheet: { boxShadow: '0 -6px 24px rgba(0,0,0,0.5)' },
} satisfies Record<string, ViewStyle>;

/** Motion. Short and consistent: anything longer reads as lag, not polish. */
export const motion = {
  fast: 120,
  base: 180,
} as const;

/**
 * Avatar tints, cycled deterministically per address. Muted enough that a column
 * of them reads as a column, not as confetti.
 */
export const avatarTints = ['#3B93F7', '#8B5CF6', '#EC4899', '#F97316', '#14B8A6', '#64748B'];
