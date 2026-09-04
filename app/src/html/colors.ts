/**
 * An email's colours, adapted to a dark reader.
 *
 * Mail is written for a white page. Dropped into a true-black app, its own
 * palette turns against it: near-black body text disappears, a white card is a
 * white card, and a hairline meant to be subtle becomes the brightest thing on
 * screen. Rendering the sender's colours faithfully and rendering them legibly
 * are different goals, and only one of them is worth having.
 *
 * So neutrals are inverted and everything else is left alone. That single
 * distinction does most of the work, because it matches how mail is actually
 * built: the greys are structure — page, card, rule, body copy — and the
 * saturated colours are meaning. A brand's orange, a gain in green, a loss in
 * red: those carry the sender's intent, they already read well on black, and
 * shifting them would be inventing a design rather than adapting one.
 *
 * Inversion is one-directional per role, which is what keeps it stable under a
 * second pass and stops it fighting mail that was already dark: a *light*
 * background is darkened and a *dark* one is left, while a *dark* text colour
 * is lightened and a light one is left. A message already designed for dark
 * therefore passes through untouched.
 */

type Rgb = { r: number; g: number; b: number };

/** The handful of keywords email actually writes. Anything else is left alone. */
const KEYWORDS: Record<string, Rgb> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  silver: { r: 192, g: 192, b: 192 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  lightgray: { r: 211, g: 211, b: 211 },
  lightgrey: { r: 211, g: 211, b: 211 },
  whitesmoke: { r: 245, g: 245, b: 245 },
  gainsboro: { r: 220, g: 220, b: 220 },
};

export function parseColor(input: string): Rgb | null {
  const value = input.trim().toLowerCase();

  const keyword = KEYWORDS[value];
  if (keyword) return keyword;

  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: parseInt(digits[0] + digits[0], 16),
        g: parseInt(digits[1] + digits[1], 16),
        b: parseInt(digits[2] + digits[2], 16),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
      };
    }
    return null;
  }

  const fn = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/.exec(value);
  if (fn) {
    return { r: Math.round(+fn[1]), g: Math.round(+fn[2]), b: Math.round(+fn[3]) };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

/** 0 = black, 1 = white. Perceptual enough for deciding light from dark. */
function lightness({ r, g, b }: Rgb): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * How far this colour is from grey, 0–1.
 *
 * The whole adaptation turns on this: below the threshold a colour is
 * structure and gets inverted, above it the colour *is* the message and is
 * left exactly as the sender wrote it.
 */
function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

/** Anything more colourful than this is treated as brand, not structure. */
const NEUTRAL_LIMIT = 0.18;

/** Rescale a neutral's lightness, keeping its slight tint. */
function withLightness(rgb: Rgb, target: number): Rgb {
  const current = lightness(rgb);
  if (current === 0) return { r: target * 255, g: target * 255, b: target * 255 };
  const scale = target / current;
  return { r: rgb.r * scale, g: rgb.g * scale, b: rgb.b * scale };
}

/**
 * A background, adapted. Light neutrals become dark surfaces; everything else
 * is returned unchanged.
 *
 * The result is compressed into a narrow band near the app's own ground rather
 * than mirrored outright: a pure inversion turns `#ffffff` into `#000000`,
 * which makes a card indistinguishable from the page it sits on and loses the
 * structure the sender used it to express. White lands just above the ground,
 * and the off-whites mail layers on top of it land just above that — so a card
 * on a page still reads as a card.
 */
export function adaptBackground(value: string): string | null {
  const rgb = parseColor(value);
  if (!rgb) return null;
  if (saturation(rgb) > NEUTRAL_LIMIT) return null;

  const l = lightness(rgb);
  if (l < 0.5) return null;

  // 0.5 → 0.16, 1.0 → 0.055. Light greys stay distinguishable from white.
  const target = 0.16 - (l - 0.5) * 0.21;
  return toHex(withLightness({ r: 255, g: 255, b: 255 }, Math.max(0.04, target)));
}

/**
 * A foreground colour, adapted. Dark neutrals become light ones.
 *
 * Mid-greys are the interesting case and they are deliberately lifted rather
 * than left: `#78716c` is a perfectly readable caption on white and a murky one
 * on black, so the floor is what matters, not the inversion.
 */
export function adaptForeground(value: string): string | null {
  const rgb = parseColor(value);
  if (!rgb) return null;
  if (saturation(rgb) > NEUTRAL_LIMIT) return null;

  const l = lightness(rgb);
  if (l > 0.72) return null;

  // Mirror, then hold above a legible floor on a black ground.
  const target = Math.max(0.62, 1 - l);
  return toHex(withLightness({ r: 255, g: 255, b: 255 }, target));
}

/**
 * A border colour, adapted.
 *
 * Held well below foreground: a rule is meant to separate, not to announce, and
 * a light hairline mirrored onto black is the brightest thing in the message.
 */
export function adaptBorder(value: string): string | null {
  const rgb = parseColor(value);
  if (!rgb) return null;
  if (saturation(rgb) > NEUTRAL_LIMIT) return null;

  const l = lightness(rgb);
  if (l < 0.5) return null;
  return toHex(withLightness({ r: 255, g: 255, b: 255 }, 0.22));
}

/** The first colour in a `background` shorthand — including a gradient's first stop. */
export function colorInShorthand(value: string): string | null {
  const match = /#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/.exec(value);
  if (match) return match[0];

  for (const word of value.toLowerCase().split(/[\s,()]+/)) {
    if (KEYWORDS[word]) return word;
  }
  return null;
}
