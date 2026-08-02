/**
 * Design tokens, ported 1:1 from docs/design/system-design.html.
 * Keep names aligned with the CSS custom properties so the mockup and the app
 * stay comparable.
 */
import { TextStyle, ViewStyle } from 'react-native';

export const color = {
  ground: '#0C0F14',
  ground2: '#0A0D11',
  panel: '#141A22',
  panel2: '#1A222D',
  chip: '#1C2531',
  line: '#263140',
  lineSoft: '#1B232F',
  ink: '#E8ECF3',
  inkDim: '#9AA6B6',
  inkFaint: '#67717F',
  brass: '#EBB863',
  brassDark: '#C99A4E',
  brassBg: '#2A2214',
  brassInk: '#241A08',
  mint: '#57D6A3',
  mintBg: '#12271F',
  mintInk: '#A7E6CC',
  mintLine: 'rgba(87,214,163,0.30)',
  coral: '#F2795E',
  coralBg: '#2C1A15',
  coralInk: '#F0BCAD',
  coralLine: 'rgba(242,121,94,0.30)',
  body: '#D3DAE4',

  /** Focus ring + pressed wash, derived from brass so states stay on-palette. */
  focus: 'rgba(235,184,99,0.55)',
  press: 'rgba(235,184,99,0.10)',
  /** Scrim behind sheets and popovers. */
  scrim: 'rgba(6,8,11,0.72)',

  /** Cool accent — used only for the ambient aurora glow, never for UI chrome. */
  violet: '#8CA0FF',
} as const;

/**
 * Frosted-glass surface tokens. A glass surface is a `BlurView` (real gaussian
 * blur of the aurora behind it) plus a semi-opaque tint on top — the tint is
 * what carries the brand color and doubles as the fallback if blur is weak or
 * unavailable, so these fills are deliberately opaque enough to stand alone.
 */
export const glass = {
  /** Neutral panel glass — the default card/surface. */
  fill: 'rgba(20,26,34,0.58)',
  /** Denser glass for bars that must stay legible over busy content. */
  fillStrong: 'rgba(14,18,24,0.72)',
  /** Brass-tinted glass for the primary action (FAB, hero mark). */
  fillBrass: 'rgba(42,34,20,0.55)',
  /** Coral-tinted glass for the blocked/warn send state. */
  fillWarn: 'rgba(44,26,21,0.60)',
  /** Lit top-edge hairline that reads as a glass rim. */
  hairline: 'rgba(255,255,255,0.10)',
  hairlineBrass: 'rgba(235,184,99,0.42)',
  /** Blur strengths (expo-blur `intensity`, 1–100). */
  blur: { soft: 22, medium: 40, strong: 64 },
} as const;

export const radius = {
  lg: 14,
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

/**
 * Font families. The custom faces are loaded once in App.tsx (expo-font) and
 * referenced here by their exact registered name. Custom fonts do not
 * synthesize weight from `fontWeight` reliably across native and web, so each
 * weight is addressed as its own family — reach for these, not `fontWeight`.
 *
 *  · Space Grotesk  — display voice: the brand, screen titles, subject lines.
 *  · Manrope        — reading and UI: body copy, rows, buttons, labels.
 *  · JetBrains Mono — cryptographic truth: fingerprints, addresses, timestamps.
 *
 * Three families, three jobs. The mono is not a costume for "technical" — it is
 * reserved for the machine-exact strings a security product lives on.
 */
export const font = {
  display: 'SpaceGrotesk_500Medium',
  displayBold: 'SpaceGrotesk_700Bold',

  sans: 'Manrope_400Regular',
  sansMedium: 'Manrope_500Medium',
  sansSemibold: 'Manrope_600SemiBold',
  sansBold: 'Manrope_700Bold',
  sansExtrabold: 'Manrope_800ExtraBold',

  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

/**
 * Type scale. Weight lives in the family name now (see `font`), so a role is a
 * face plus a size — never a stray `fontWeight`. Seven roles cover the whole
 * app: two display sizes, three sans sizes, and two mono sizes.
 */
export const type = {
  /** Screen titles — Inbox, message subject. */
  display: { fontFamily: font.displayBold, fontSize: 20, letterSpacing: -0.4 },
  /** Card titles. */
  heading: { fontFamily: font.displayBold, fontSize: 17, letterSpacing: -0.3 },
  /** Row headline — sender name, provider label, button text. */
  strong: { fontFamily: font.sansSemibold, fontSize: 14.5 },
  /** Reading copy and explanatory text. */
  body: { fontFamily: font.sans, fontSize: 14, lineHeight: 21 },
  /** Secondary row text — subject line, snippet, notes. */
  small: { fontFamily: font.sans, fontSize: 12.5, lineHeight: 18 },
  /** Mono metadata — addresses, timestamps, fingerprints. */
  meta: { fontFamily: font.mono, fontSize: 11.5 },
  /** Mono eyebrow — uppercase labels and section heads. */
  eyebrow: { fontFamily: font.mono, fontSize: 10.5, letterSpacing: 1, textTransform: 'uppercase' },
} satisfies Record<string, TextStyle>;

/**
 * Elevation. Only three levels — a raised control, a floating action, and a
 * sheet — so surfaces read as a stack rather than a pile.
 *
 * `boxShadow` rather than the `shadow*` props: those are deprecated as of
 * RN 0.81 and warn on every render.
 */
export const shadow = {
  raised: { boxShadow: '0 2px 5px rgba(0,0,0,0.22)' },
  floating: { boxShadow: '0 4px 12px rgba(0,0,0,0.38)' },
  sheet: { boxShadow: '0 -6px 24px rgba(0,0,0,0.45)' },
} satisfies Record<string, ViewStyle>;

/** Motion. Short and consistent: anything longer reads as lag, not polish. */
export const motion = {
  fast: 120,
  base: 180,
} as const;

/** Avatar tints, cycled deterministically per address. */
export const avatarTints = [color.brass, color.mint, '#8CA0FF', color.coral];
