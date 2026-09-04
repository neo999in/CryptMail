/**
 * Every CSS property this reader understands, and how each one is read.
 *
 * This table is the whole style gate. Nothing reaches the renderer that is not
 * a property named here with a value its normaliser returned, so reviewing
 * what an email is allowed to do to the page means reading this file and
 * `values.ts` — not tracing a value through an allowlist, a renderer's own
 * filter, and whatever falls between them.
 *
 * That "between them" is why the table exists. Safety and translatability used
 * to be separate judgements, and the gap between them was silent in both
 * directions: a declaration could be permitted and unusable (`height: 100%`,
 * which React Native resolves against an unbounded parent, so a button filled
 * the screen), or usable and refused (`margin: 16px 0`, rejected for the bare
 * `0`, so the element lost its spacing entirely). Neither left a trace. Each
 * was found by a person noticing a broken message and asking why.
 *
 * A property absent from this table is not an oversight to be fixed by adding
 * it — it is a property whose translation nobody has worked out. Adding an
 * entry means deciding what React Native should receive for every value CSS
 * allows, which is exactly the work that was being skipped when a regex was
 * pasted in and the failures left to turn up one message at a time.
 */
import {
  border,
  color,
  Emit,
  fontFamily,
  fontWeight,
  keyword,
  length,
  lengths,
  lineHeight,
  Normalise,
  ValueContext,
} from './values';

/**
 * A property whose value is emitted under a *different* name.
 *
 * The renaming is the translation. `font-weight` becomes a `font-family`
 * because that is how a weight is addressed when the faces do not synthesize;
 * `background` becomes `background-color` because the shorthand can carry a
 * remote fetch and only its colour is wanted.
 */
type Property = { read: Normalise; emitAs?: string };

/** Narrow a normaliser's result to a plain value, for the ones that compose. */
function valueOf(result: string | Emit | null): string | null {
  return typeof result === 'string' ? result : null;
}

const px = length();
const pxOrPercent = length({ percent: true });
/** A size the platform will not accept as zero — see `values.Sign`. */
const positivePx = length({ sign: 'positive' });
/** A box dimension: zero is a legitimate spacer, negative is not a size. */
const sizePx = length({ sign: 'non-negative' });
const sizePxOrPercent = length({ percent: true, sign: 'non-negative' });

/**
 * The absolute-only properties, and why each one is.
 *
 * A percentage needs something to be a percentage *of*. Width has it — every
 * parent has a width, and a share of it means the same thing in both layout
 * models. The others do not: React Native takes a number of points for a font
 * size, and leaves a parent's height unbounded far more often than CSS does.
 */
export const PROPERTIES: Record<string, Property> = {
  /* ---------------------------------------------------------------- text ---- */
  color: { read: color('foreground') },
  'font-family': { read: fontFamily },
  // Positive, not merely numeric. `font-size: 0` is how a template collapses
  // the whitespace between inline-blocks, and React Native throws on it:
  // letter spacing is a ratio of the font size, and the platform will not
  // divide by zero. The crash surfaces as a blank render error screen with the
  // message nowhere in sight.
  'font-size': { read: positivePx },
  'font-style': { read: keyword('normal', 'italic', 'oblique') },
  // Emits its own property: a family when there are faces to name, the weight
  // itself when there are not. See `values.fontWeight`.
  'font-weight': { read: fontWeight },
  'line-height': { read: lineHeight },
  'letter-spacing': { read: px },
  'text-align': { read: keyword('left', 'right', 'center', 'justify', 'start', 'end') },
  'text-decoration': { read: keyword('none', 'underline', 'line-through', 'overline') },
  'text-transform': { read: keyword('none', 'uppercase', 'lowercase', 'capitalize') },

  /* --------------------------------------------------------------- boxes ---- */
  // `display` decides whether a box is a box at all: React Native draws no
  // border, radius or background on a nested inline element, so an email
  // button — invariably a styled span inside an anchor — needs this to be a
  // box before any of its other declarations mean anything. `none` earns its
  // place separately: it is how every sender hides the preheader line.
  display: { read: displayValue },
  // A width in pixels is a *desktop column* measurement — email is written for
  // 600px and says so in a hundred places — so it is read as a maximum, the
  // same as the `width` attribute and for the same reason: taken literally it
  // pushes the message off the side of a phone, and the reader has no way to
  // scale the way a browser would. A percentage is left as a width, since a
  // share of the parent is already relative and means what it says.
  width: { read: widthValue },
  'max-width': { read: sizePxOrPercent },
  height: { read: sizePx },
  'max-height': { read: sizePx },

  // `auto` is deliberately absent from the margins. It is how every email
  // centres its body — `max-width:600px;margin:auto` is the standard wrapper —
  // and it is the one margin value that means something different in the two
  // models. In CSS the block still fills the width available to it, up to the
  // maximum; in React Native an auto margin makes the box shrink to fit its
  // content, and a wrapper full of stretchy children collapses to a sliver.
  // Dropping it is the faithful reading: what was asked for is "centred,
  // capped at 600", and the cap is the half that survives translation.
  margin: { read: lengths({ percent: true }) },
  'margin-top': { read: pxOrPercent },
  'margin-right': { read: pxOrPercent },
  'margin-bottom': { read: pxOrPercent },
  'margin-left': { read: pxOrPercent },
  // Padding, unlike margin, has no negative reading at all.
  padding: { read: lengths({ percent: true, sign: 'non-negative' }) },
  'padding-top': { read: sizePxOrPercent },
  'padding-right': { read: sizePxOrPercent },
  'padding-bottom': { read: sizePxOrPercent },
  'padding-left': { read: sizePxOrPercent },

  /* ------------------------------------------------------------- borders ---- */
  border: { read: border() },
  'border-top': { read: border() },
  'border-right': { read: border() },
  'border-bottom': { read: border() },
  'border-left': { read: border() },
  'border-color': { read: color('border') },
  'border-top-color': { read: color('border') },
  'border-right-color': { read: color('border') },
  'border-bottom-color': { read: color('border') },
  'border-left-color': { read: color('border') },
  'border-width': { read: sizePx },
  'border-top-width': { read: sizePx },
  'border-right-width': { read: sizePx },
  'border-bottom-width': { read: sizePx },
  'border-left-width': { read: sizePx },
  'border-style': { read: keyword('none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'ridge', 'groove', 'inset', 'outset') },
  'border-top-style': { read: keyword('none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'ridge', 'groove', 'inset', 'outset') },
  'border-right-style': { read: keyword('none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'ridge', 'groove', 'inset', 'outset') },
  'border-bottom-style': { read: keyword('none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'ridge', 'groove', 'inset', 'outset') },
  'border-left-style': { read: keyword('none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'ridge', 'groove', 'inset', 'outset') },
  'border-radius': { read: sizePx },

  /* -------------------------------------------------------- backgrounds ---- */
  'background-color': { read: color('background') },
  // The shorthand is read for its colour and emitted as one. Converting rather
  // than allowing is the point: `background` can carry `url(...)`, so letting
  // it through as written would be a remote fetch by another name.
  background: { read: backgroundShorthand, emitAs: 'background-color' },
};

/**
 * The declarations this reader dropped, most recent first.
 *
 * Kept so the gaps announce themselves instead of waiting to be noticed in a
 * rendered message. A property that shows up here repeatedly across real mail
 * is one the table should learn to read — and that is a question this can now
 * answer, rather than one that needed somebody to open the right email.
 */
const dropped = new Map<string, number>();

export function recordDropped(property: string): void {
  dropped.set(property, (dropped.get(property) ?? 0) + 1);
}

/** What has been dropped so far, commonest first. Diagnostics only. */
export function droppedDeclarations(): { property: string; count: number }[] {
  return [...dropped]
    .map(([property, count]) => ({ property, count }))
    .sort((a, b) => b.count - a.count);
}

export function resetDroppedDeclarations(): void {
  dropped.clear();
}

/**
 * The colour inside a `background` shorthand, including a gradient's first stop.
 *
 * Nothing here draws a gradient, and a flat band of the sender's own colour is
 * far closer to what they drew than the nothing that would render otherwise.
 */
function backgroundShorthand(raw: string, ctx: ValueContext): string | null {
  const hex = /#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/.exec(raw);
  const candidate = hex ? hex[0] : firstWord(raw);
  if (!candidate) return null;
  return valueOf(color('background')(candidate, ctx));
}

/**
 * A display mode React Native has.
 *
 * `inline-block` is not one of them, and `block` is the closer of the two that
 * are: the element gets a box of its own, which is the whole reason a sender
 * reached for inline-block on a button.
 */
function widthValue(raw: string, ctx: ValueContext): string | Emit | null {
  const value = sizePxOrPercent(raw, ctx);
  if (typeof value !== 'string') return null;
  return value.endsWith('%') ? value : { property: 'max-width', value };
}

function displayValue(raw: string, ctx: ValueContext): string | null {
  const mode = valueOf(keyword('none', 'block', 'inline', 'inline-block', 'flex')(raw, ctx));
  if (mode === null) return null;
  return mode === 'inline-block' ? 'block' : mode;
}

function firstWord(raw: string): string | null {
  for (const word of raw.toLowerCase().split(/[\s,()]+/)) {
    if (/^[a-z]+$/.test(word) && word !== 'none' && word !== 'repeat') return word;
  }
  return null;
}

/**
 * Read a style attribute, keeping only what survives its property's normaliser.
 *
 * Declarations are read one at a time and kept or dropped one at a time, so an
 * unreadable one costs itself and nothing else. `!important` is stripped rather
 * than honoured: it exists to beat a client's own stylesheet, and this renderer
 * has none to beat.
 */
export function readStyle(style: string, ctx: ValueContext): string {
  const out: string[] = [];

  for (const declaration of style.split(';')) {
    const at = declaration.indexOf(':');
    if (at < 0) continue;

    const property = declaration.slice(0, at).trim().toLowerCase();
    const raw = declaration.slice(at + 1).replace(/!\s*important/gi, '').trim();
    if (property === '' || raw === '') continue;

    const entry = PROPERTIES[property];
    if (!entry) {
      recordDropped(property);
      continue;
    }

    const read = entry.read(raw, ctx);
    if (read === null) {
      recordDropped(property);
      continue;
    }

    const emitted =
      typeof read === 'string' ? { property: entry.emitAs ?? property, value: read } : read;
    out.push(`${emitted.property}:${emitted.value}`);
  }

  return out.join(';');
}
