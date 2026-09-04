/**
 * CSS values, read into what React Native can actually consume.
 *
 * This module exists because of a failure that kept recurring in a shape worth
 * naming. Safety and *translatability* used to be decided in different places:
 * a regex allowlist said what was permitted, and the renderer independently
 * decided what it could use. A declaration that passed the first and failed the
 * second went nowhere, silently — `font-size:120%` and `height:100%` are both
 * valid CSS, both harmless, and both meaningless here. And because the check
 * was a regex over the whole value, one component it had not anticipated took
 * the entire declaration with it: `margin: 16px 0` failed on the bare `0`, and
 * those elements lost their spacing completely rather than partially.
 *
 * So a value is not matched here, it is *read*. Each normaliser returns what
 * React Native should receive, or null when there is no faithful reading — and
 * null means exactly one thing, that this declaration is dropped, rather than
 * being indistinguishable from a value nobody thought to allow.
 *
 * Anything a normaliser returns, it built or validated itself. That is what
 * lets these double as the safety gate rather than sitting behind one:
 * `url(...)` and `expression(...)` do not survive being read as a colour or a
 * length, because they are not one.
 */
import { adaptBackground, adaptBorder, adaptForeground, COLOR_NAMES, parseColor } from './colors';

/** What a value may need to know about the surroundings it is read into. */
export type ValueContext = {
  /** Adapt the sender's palette to a dark ground. */
  dark: boolean;
  /** The loaded face per weight, since React Native synthesizes none. */
  faces?: { regular: string; medium: string; semibold: string; bold: string };
  /**
   * The font size this element declares, in pixels, when it declares one.
   *
   * Only `line-height` reads it, and it has to: the renderer resolves `em`
   * against a fixed 16px root rather than against the element's own size, so a
   * ratio converted to `em` comes out at body scale on a headline. See
   * `lineHeight`.
   */
  fontSize?: number;
};

/**
 * What a normaliser produces: a value, or a whole declaration when the
 * translation changes which property is being set.
 *
 * The renaming *is* the translation in those cases, so it belongs with the
 * value rather than beside it in the table: a weight becomes a family only
 * when there are faces to name, and a `background` becomes a `background-color`
 * only once a colour has been found in it. Fixing the destination in the table
 * would force both to be true unconditionally.
 */
export type Emit = { property: string; value: string };

/**
 * Reads one declaration's value: what to emit, or null to drop it.
 *
 * Several declarations may come back where one went in. That is how a shorthand
 * survives a component it cannot read — see `lengths`.
 */
export type Normalise = (raw: string, ctx: ValueContext) => string | Emit | Emit[] | null;

/**
 * The length units that survive the trip.
 *
 * Not a taste list: it is exactly the set `@native-html/css-processor` can turn
 * into a number of points — the absolute ones by a fixed multiplier, `em`/`ex`
 * against the root font size. A unit outside it reaches the renderer and is
 * dropped there instead, which is the silent half of the failure this module
 * exists to end, so the two lists are kept the same on purpose.
 *
 * `ex` earns its place despite looking archaic: it is what Gmail writes into
 * every reply it quotes (`margin:0 0 0 .8ex;padding-left:1ex`), so leaving it
 * out cost every quoted thread its indent. `in`, `cm`, `mm` and `pc` are
 * Word's, which reaches mail through Outlook. `ch`, `vw` and `vh` stay out —
 * the processor knows the spellings and computes nothing for them.
 */
const UNIT = '(?:px|pt|pc|in|cm|mm|em|rem|ex)';

/** One of a fixed set of words, and nothing else. */
export function keyword(...allowed: string[]): Normalise {
  const set = new Set(allowed);
  return (raw) => {
    const value = raw.trim().toLowerCase();
    return set.has(value) ? value : null;
  };
}

/**
 * How much of the number line a property will accept.
 *
 * Not pedantry: React Native *throws* on some of what CSS permits.
 * `font-size: 0` is ordinary in mail — it is how a template collapses the
 * whitespace between inline-blocks — and it takes the renderer down, because
 * letter spacing is computed as a ratio of the font size and the platform
 * refuses to divide by zero. A valid, safe, common declaration that crashes
 * the screen is exactly the failure this module was built to end, so the
 * domain is stated per property rather than assumed.
 */
export type Sign = 'any' | 'non-negative' | 'positive';

/**
 * A length.
 *
 * Percentages are opt-in per property rather than allowed globally, because
 * they translate for some and not others: a percentage *width* is a share of
 * the parent's width, which every parent has, while a percentage *height* is a
 * share of something React Native usually leaves unbounded.
 *
 * The magnitude is checked as a *number*, not as text — `0`, `0px` and `0.0em`
 * are one value wearing three spellings, and a pattern that only knew the
 * first would let the other two through to the crash.
 */
export function length(options: { percent?: boolean; sign?: Sign } = {}): Normalise {
  const unit = options.percent ? UNIT + '|%' : UNIT;
  const pattern = new RegExp('^-?(?:[0-9]*\\.?[0-9]+)(' + unit + ')?$');
  const sign = options.sign ?? 'any';

  return (raw) => {
    const value = raw.trim().toLowerCase();
    const match = pattern.exec(value);
    if (!match) return null;

    const magnitude = Number.parseFloat(value);
    if (!Number.isFinite(magnitude)) return null;
    // A bare number is only a length when it is zero: `12` is not `12px`.
    if (!match[1] && magnitude !== 0) return null;

    if (sign === 'positive' && magnitude <= 0) return null;
    if (sign === 'non-negative' && magnitude < 0) return null;
    return value;
  };
}

/** The sides a one-to-four value shorthand names, by how many values it has. */
const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** Which component of the shorthand each side takes, per number of values. */
const EXPANSION: Record<number, [number, number, number, number]> = {
  1: [0, 0, 0, 0],
  2: [0, 1, 0, 1],
  3: [0, 1, 2, 1],
  4: [0, 1, 2, 3],
};

/**
 * One to four lengths — the margin and padding shorthands.
 *
 * Read component by component, which is the whole point: a shorthand is several
 * values travelling together, and one unreadable component should cost that
 * component rather than the declaration. Where every component reads, the
 * shorthand is emitted as written. Where some do not, what is left is emitted
 * as the longhands for the sides that do read, and the rest are dropped.
 *
 * `margin: 0 auto` is the case that matters and it is everywhere: the standard
 * centred body wrapper, and the reset that takes the browser's default margin
 * off a heading, are the same declaration. Refusing it whole — which is what
 * happened while a shorthand was all-or-nothing — meant the reset went with the
 * centring, and every `<p>` and `<h1>` in the message kept a margin its author
 * had explicitly removed. `auto` itself still has no reading here: Yoga honours
 * it by shrinking the box to its content, so a wrapper full of stretched
 * children collapses to a sliver.
 */
export function lengths(
  options: { percent?: boolean; sign?: Sign; property?: string } = {},
): Normalise {
  const one = length({ percent: options.percent, sign: options.sign });
  return (raw, ctx) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    const expansion = EXPANSION[parts.length];
    if (!expansion) return null;

    const read = parts.map((part) => one(part, ctx));
    if (read.every((part): part is string => typeof part === 'string')) return read.join(' ');
    if (!options.property) return null;

    const out: Emit[] = [];
    expansion.forEach((component, side) => {
      const value = read[component];
      if (typeof value === 'string') {
        out.push({ property: `${options.property}-${SIDES[side]}`, value });
      }
    });
    return out.length > 0 ? out : null;
  };
}

/**
 * A colour, adapted to the ground it will be read on.
 *
 * The role matters because adaptation is one-directional per role: a light
 * *background* is darkened and a dark one left alone, while a dark *foreground*
 * is lightened and a light one left. See `colors.ts`.
 */
export function color(role: 'foreground' | 'background' | 'border'): Normalise {
  const adapt =
    role === 'background' ? adaptBackground : role === 'border' ? adaptBorder : adaptForeground;

  return (raw, ctx) => {
    const value = raw.trim();
    // `transparent` is a colour React Native has. `inherit` and `currentcolor`
    // are not: they are instructions to a cascade, and they fall through to the
    // name check below, which refuses them. That is also what they asked for —
    // an element stating no colour of its own inherits one.
    if (/^transparent$/i.test(value)) return 'transparent';

    if (!parseColor(value)) {
      // A named colour this module does not adapt is still passed through:
      // `colors.ts` keeps only the names whose *lightness* it must correct, and
      // `crimson` goes to the renderer unadapted, which is where a saturated
      // colour was going to end up anyway. It is checked against the full CSS
      // set rather than against "is a word", because the words in a background
      // shorthand — `url`, `cover`, `no-repeat` — are not colours, and React
      // Native given one of those renders nothing from there on.
      return COLOR_NAMES.has(value.toLowerCase()) ? value.toLowerCase() : null;
    }
    return (ctx.dark && adapt(value)) || value;
  };
}

/**
 * A font stack, kept as written rather than resolved.
 *
 * The engine is handed the app's loaded faces as its system fonts and picks
 * what it recognises, so a stack naming Arial then Helvetica then sans-serif
 * falls through to the platform default on its own. Quotes and commas are the
 * whole syntax; anything carrying a parenthesis is not a font stack.
 */
export const fontFamily: Normalise = (raw) => {
  const value = raw.trim();
  return /^[A-Za-z0-9_\- '",.]+$/.test(value) ? value : null;
};

/**
 * A weight, as the face that weight means.
 *
 * Manrope ships one file per weight and React Native synthesizes none, so
 * `fontWeight: '600'` over the regular face renders regular, silently. The
 * app's own rule is to address a weight by its family; this applies that rule
 * to markup written by someone else.
 */
export const fontWeight: Normalise = (raw, ctx) => {
  const value = raw.trim().toLowerCase();
  const known = /^(normal|bold|bolder|lighter)$/.test(value) || /^[1-9]00$/.test(value);
  if (!known) return null;

  // No faces configured means no family to name, so the weight is passed
  // through as itself. A consumer on the platform's own font gets bold that
  // way, because that font *does* synthesize; this app always supplies faces
  // precisely because Manrope does not.
  if (!ctx.faces) return { property: 'font-weight', value };

  const face =
    value === 'bold' || value === 'bolder'
      ? ctx.faces.bold
      : value === 'normal' || value === 'lighter'
        ? ctx.faces.regular
        : Number(value) >= 700
          ? ctx.faces.bold
          : Number(value) >= 600
            ? ctx.faces.semibold
            : Number(value) >= 500
              ? ctx.faces.medium
              : ctx.faces.regular;

  return { property: 'font-family', value: face };
};

/** How many pixels one CSS length is, for the units that convert absolutely. */
const PX_PER_UNIT: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 9.6 / 2.54,
  // Against the engine's own 16px root, which is what it resolves them to.
  em: 16,
  rem: 16,
  ex: 16 * 0.63,
};

/**
 * A declared font size in pixels, or null when it is not one this can measure.
 *
 * Exported for `readStyle`, which reads an element's own `font-size` before it
 * reads anything else so that `line-height` has something to be a ratio of.
 */
export function fontSizePx(raw: string): number | null {
  const match = new RegExp('^([0-9]*\\.?[0-9]+)' + UNIT + '$').exec(raw.trim().toLowerCase());
  if (!match) return null;
  const unit = match[0].slice(match[1].length);
  const px = Number.parseFloat(match[1]) * (PX_PER_UNIT[unit] ?? 0);
  return Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * A ratio line-height, resolved against the size it is a ratio of.
 *
 * The engine computes `em` against a **fixed 16px root**, not against the
 * element's own font size — so `font-size:38px;line-height:1.1`, the shape
 * every marketing headline is written in, came out as a 17.6px line under 38px
 * type and the words printed on top of each other. Where the element states its
 * size the ratio is resolved here, in pixels, and the engine is handed a number
 * it cannot misread. Where it does not, `em` still stands: the inherited size
 * is not visible from this layer, and 16 is within half a point of the reader's
 * own body text.
 */
function ratioLineHeight(ratio: number, ctx: ValueContext): string | null {
  if (!(ratio > 0)) return null;
  if (!ctx.fontSize) return `${ratio}em`;
  return `${Math.round(ratio * ctx.fontSize * 100) / 100}px`;
}

/**
 * A line height, as an absolute length.
 *
 * CSS's two commonest forms are ratios of the font size and the renderer wants
 * a number, so a bare `1.5` and a `150%` — the same instruction written twice —
 * both go through `ratioLineHeight`. `normal` has no equivalent and is dropped,
 * which leaves the tag's own line height standing rather than an invalid one.
 */
export const lineHeight: Normalise = (raw, ctx) => {
  const value = raw.trim().toLowerCase();
  if (value === 'normal') return null;

  // Zero is checked on every route in, not only the one that reaches the
  // length check below: a bare `0` and a `0%` are the same collapsed line as
  // `0px`, and resolving them first would walk them straight past it.
  const unitless = /^[0-9]*\.?[0-9]+$/.exec(value);
  if (unitless) return ratioLineHeight(+unitless[0], ctx);

  const percent = /^([0-9]*\.?[0-9]+)%$/.exec(value);
  if (percent) return ratioLineHeight(+percent[1] / 100, ctx);

  // Positive for the same reason as font-size: a zero line height is a
  // spacer-row trick in CSS and a collapsed, unmeasurable line here.
  return length({ sign: 'positive' })(value, ctx);
};

/**
 * A border shorthand: width, style and colour, in any order and any subset.
 *
 * Read as three independent slots rather than matched as a pattern, so
 * `1px solid`, `solid #ccc` and `2px` all work. Every one of those appears in
 * real mail, and a positional regex only ever handles the shapes it was
 * written for — which is how `border-bottom: 2px solid #e5e5e5` and its
 * cousins kept being the thing that got dropped.
 */
export function border(): Normalise {
  const width = length({ sign: 'non-negative' });
  const style = keyword(
    'none',
    'hidden',
    'solid',
    'dashed',
    'dotted',
    'double',
    'ridge',
    'groove',
    'inset',
    'outset',
  );
  const colour = color('border');

  return (raw, ctx) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts.length > 3) return null;

    const out: string[] = [];
    let seenWidth = false;
    let seenStyle = false;
    let seenColor = false;

    for (const part of parts) {
      if (!seenWidth && width(part, ctx)) {
        out.push(part.toLowerCase());
        seenWidth = true;
        continue;
      }
      if (!seenStyle && style(part, ctx)) {
        out.push(part.toLowerCase());
        seenStyle = true;
        continue;
      }
      if (!seenColor) {
        const adapted = colour(part, ctx);
        if (typeof adapted === 'string') {
          out.push(adapted);
          seenColor = true;
          continue;
        }
      }
      return null;
    }
    return out.length > 0 ? out.join(' ') : null;
  };
}
