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

/**
 * Named colours, as hex.
 *
 * Weighted towards the pale end on purpose. A named colour that goes
 * unrecognised is not adapted, and an unadapted *light* name is a white card
 * left white on a black page — the one failure that actually shows. A missed
 * `crimson` would have been left alone anyway for being saturated, so the
 * greys, off-whites and the handful of dark names are what earn their place
 * here; the rest of CSS's 148 are omitted rather than pretended at.
 */
const KEYWORDS: Record<string, string> = {
  white: '#ffffff',
  ivory: '#fffff0',
  snow: '#fffafa',
  floralwhite: '#fffaf0',
  ghostwhite: '#f8f8ff',
  mintcream: '#f5fffa',
  azure: '#f0ffff',
  aliceblue: '#f0f8ff',
  seashell: '#fff5ee',
  oldlace: '#fdf5e6',
  linen: '#faf0e6',
  cornsilk: '#fff8dc',
  honeydew: '#f0fff0',
  lavender: '#e6e6fa',
  beige: '#f5f5dc',
  whitesmoke: '#f5f5f5',
  gainsboro: '#dcdcdc',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  silver: '#c0c0c0',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  gray: '#808080',
  grey: '#808080',
  dimgray: '#696969',
  dimgrey: '#696969',
  black: '#000000',
};

/**
 * Every colour name CSS defines, as a set — for deciding whether a bare word is
 * a colour at all.
 *
 * Separate from `KEYWORDS` above and doing a different job. That map exists to
 * *adapt* a handful of names whose lightness matters on a black ground; this
 * set exists to *refuse* every word that is not a colour, and it has to be
 * complete to do it.
 *
 * The gap between the two is what let `background: url(...) no-repeat` become
 * `background-color: url`. A bare word used to be passed through untouched, on
 * the reasoning that React Native knows the whole named set and this module
 * only needs the pale end of it — but "any word" is not "any colour name", and
 * a background shorthand is full of words that are neither: `url`, `cover`,
 * `center`, `no-repeat`. React Native cannot parse those, and one of them
 * reaching a style took the rest of the message's body down with it, leaving a
 * logo and a screen of black. A value this module cannot vouch for is dropped
 * like any other.
 */
export const COLOR_NAMES: ReadonlySet<string> = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood',
  'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray',
  'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen',
  'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen',
  'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod',
  'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red',
  'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
]);

export function parseColor(input: string): Rgb | null {
  const value = KEYWORDS[input.trim().toLowerCase()] ?? input.trim().toLowerCase();

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

  const hsl = /^hsla?\(\s*([0-9.-]+)(?:deg)?[\s,]+([0-9.]+)%[\s,]+([0-9.]+)%/.exec(value);
  if (hsl) return fromHsl(+hsl[1], +hsl[2] / 100, +hsl[3] / 100);

  return null;
}

/** hsl() is rare in hand-written mail and routine in anything generated. */
function fromHsl(hue: number, s: number, l: number): Rgb {
  const h = (((hue % 360) + 360) % 360) / 360;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  };
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
  const hsl = /hsla?\([^)]*\)/.exec(value);
  if (hsl) return hsl[0];
  return null;
}
