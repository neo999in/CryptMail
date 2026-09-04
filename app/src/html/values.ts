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
import { adaptBackground, adaptBorder, adaptForeground, parseColor } from './colors';

/** What a value may need to know about the surroundings it is read into. */
export type ValueContext = {
  /** Adapt the sender's palette to a dark ground. */
  dark: boolean;
  /** The loaded face per weight, since React Native synthesizes none. */
  faces?: { regular: string; medium: string; semibold: string; bold: string };
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

/** Reads one declaration's value: what to emit, or null to drop it. */
export type Normalise = (raw: string, ctx: ValueContext) => string | Emit | null;

const UNIT = '(?:px|pt|em|rem)';

/** One of a fixed set of words, and nothing else. */
export function keyword(...allowed: string[]): Normalise {
  const set = new Set(allowed);
  return (raw) => {
    const value = raw.trim().toLowerCase();
    return set.has(value) ? value : null;
  };
}

/**
 * A length.
 *
 * Percentages are opt-in per property rather than allowed globally, because
 * they translate for some and not others: a percentage *width* is a share of
 * the parent's width, which every parent has, while a percentage *height* is a
 * share of something React Native usually leaves unbounded.
 */
export function length(options: { percent?: boolean } = {}): Normalise {
  const pattern = new RegExp(`^-?(?:0|[0-9]*\\.?[0-9]+(?:${UNIT}${options.percent ? '|%' : ''}))$`);
  return (raw) => {
    const value = raw.trim().toLowerCase();
    return pattern.test(value) ? value : null;
  };
}

/**
 * One to four lengths — the margin and padding shorthands.
 *
 * Read component by component, which is the whole point: a shorthand is
 * several values travelling together, and one unreadable component should cost
 * that component rather than the declaration.
 */
export function lengths(options: { percent?: boolean } = {}): Normalise {
  const one = length({ percent: options.percent });
  return (raw, ctx) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts.length > 4) return null;

    const read = parts.map((part) => one(part, ctx));
    return read.every((part): part is string => typeof part === 'string') ? read.join(' ') : null;
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
    // Not colours to parse, but meaningful and safe.
    if (/^(transparent|inherit|currentcolor)$/i.test(value)) return value.toLowerCase();

    if (!parseColor(value)) {
      // A bare word this module cannot resolve is still passed through: React
      // Native knows the whole CSS named set and `colors.ts` deliberately does
      // not, since it only needs the names whose *lightness* it must correct.
      // `crimson` goes to the renderer unadapted, which is where a saturated
      // colour was going to end up anyway. A word carries no parenthesis, so
      // there is nothing for a `url()` or an `expression()` to hide in.
      return /^[a-z]+$/i.test(value) ? value.toLowerCase() : null;
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

/**
 * A line height, as an absolute length.
 *
 * CSS's two commonest forms are relative to the font size and the renderer
 * wants a number. `em` is the one relative unit the engine resolves, so a bare
 * `1.5` and a `150%` — the same instruction written twice — both become that.
 * `normal` has no equivalent and is dropped, which leaves the tag's own line
 * height standing rather than an invalid one.
 */
export const lineHeight: Normalise = (raw, ctx) => {
  const value = raw.trim().toLowerCase();
  if (value === 'normal') return null;

  const unitless = /^[0-9]*\.?[0-9]+$/.exec(value);
  if (unitless) return `${unitless[0]}em`;

  const percent = /^([0-9]*\.?[0-9]+)%$/.exec(value);
  if (percent) return `${+percent[1] / 100}em`;

  return length()(value, ctx);
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
  const width = length();
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
