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
  fontSizePx,
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
function valueOf(result: string | Emit | Emit[] | null): string | null {
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
  // `oblique` is read as `italic`: the engine's own enumeration stops at the
  // two, so passing it through was a declaration that vanished a layer later.
  'font-style': { read: obliqueAsItalic },
  // Emits its own property: a family when there are faces to name, the weight
  // itself when there are not. See `values.fontWeight`.
  'font-weight': { read: fontWeight },
  'line-height': { read: lineHeight },
  'letter-spacing': { read: px },
  // `start` and `end` are the logical pair, and the engine takes neither. RN's
  // `auto` *is* start — it follows the writing direction — so that is the
  // faithful reading; `end` has no counterpart and takes the physical side.
  'text-align': { read: textAlignValue },
  // No `overline`: React Native draws three of the four, and the engine's own
  // list stops at the three for that reason.
  'text-decoration': { read: keyword('none', 'underline', 'line-through') },
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
  // `auto` is the intrinsic size, which is what both models already do — but
  // saying so matters on an image: `width:100%;height:auto` is how every
  // template keeps a hero's aspect ratio, and dropping the second half left
  // the renderer holding a width with a stale intrinsic height beside it.
  height: { read: autoOr(sizePx) },
  'max-height': { read: sizePx },
  'min-width': { read: sizePxOrPercent },
  'min-height': { read: sizePx },

  // `auto` is deliberately absent from the margins. It is how every email
  // centres its body — `max-width:600px;margin:auto` is the standard wrapper —
  // and it is the one margin value that means something different in the two
  // models. In CSS the block still fills the width available to it, up to the
  // maximum; in React Native an auto margin makes the box shrink to fit its
  // content, and a wrapper full of stretchy children collapses to a sliver.
  // Dropping it is the faithful reading: what was asked for is "centred,
  // capped at 600", and the cap is the half that survives translation.
  margin: { read: lengths({ percent: true, property: 'margin' }) },
  'margin-top': { read: pxOrPercent },
  'margin-right': { read: pxOrPercent },
  'margin-bottom': { read: pxOrPercent },
  'margin-left': { read: pxOrPercent },
  // Padding, unlike margin, has no negative reading at all.
  padding: { read: lengths({ percent: true, sign: 'non-negative', property: 'padding' }) },
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
  // The four corners, which a rounded button or a card with a flat bottom
  // writes one at a time. Each is its own property in React Native too, so the
  // translation is the name; without them a pill rendered as a rectangle.
  'border-top-left-radius': { read: sizePx },
  'border-top-right-radius': { read: sizePx },
  'border-bottom-left-radius': { read: sizePx },
  'border-bottom-right-radius': { read: sizePx },

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

/** A normaliser that also takes `auto`, the intrinsic size both models have. */
function autoOr(read: Normalise): Normalise {
  return (raw, ctx) => (raw.trim().toLowerCase() === 'auto' ? 'auto' : read(raw, ctx));
}

const fontStyle = keyword('normal', 'italic', 'oblique');

function obliqueAsItalic(raw: string, ctx: ValueContext): string | null {
  const value = valueOf(fontStyle(raw, ctx));
  return value === 'oblique' ? 'italic' : value;
}

const textAlign = keyword('left', 'right', 'center', 'justify', 'start', 'end');

function textAlignValue(raw: string, ctx: ValueContext): string | null {
  const value = valueOf(textAlign(raw, ctx));
  if (value === 'start') return 'auto';
  if (value === 'end') return 'right';
  return value;
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
  // What the element's own padding adds to the box it declared. See `padded`.
  const inset = padded(style);
  // The element's own size, found before anything is read, because
  // `line-height` is a ratio of it and the renderer resolves `em` against a
  // fixed root instead. Declared twice, the last one wins, as CSS says.
  const declared = declaredFontSize(style);
  const inner = declared === null ? ctx : { ...ctx, fontSize: declared };

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

    const read = entry.read(raw, inner);
    if (read === null) {
      recordDropped(property);
      continue;
    }

    // One declaration in, one *or more* out: a shorthand that lost a component
    // comes back as the longhands for the sides that survived.
    const emitted =
      typeof read === 'string' ? [{ property: entry.emitAs ?? property, value: read }] : [read].flat();
    for (const { property: name, value } of emitted) out.push(`${name}:${borderBox(name, value, inset)}`);
  }

  return out.join(';');
}


/**
 * The two models a box is measured in, reconciled.
 *
 * CSS measures `width` as the *content* and adds padding outside it; React
 * Native measures it as the whole box and fits the padding inside. Email is
 * written in the first, so `width:20px;padding:0 6px` — one social icon, and
 * the shape of every padded button — asked for a 32-point box around a
 * 20-point image and got a 20-point box with 12 points of padding eating it.
 * Four icons in a row came out overlapping each other.
 *
 * So a declared size is read as the sender measured it and emitted as the
 * renderer will read it: the padding on that axis is added back. Only pixels
 * on both sides can be added — a percentage is a share of something this layer
 * cannot see — and an element that says `box-sizing:border-box` is already
 * speaking the renderer's language and is left alone.
 */
const HORIZONTAL = new Set(['width', 'max-width', 'min-width']);
const VERTICAL = new Set(['height', 'max-height', 'min-height']);
const BORDER_BOX = /box-sizing\s*:\s*border-box/i;
const PX_VALUE = /^([0-9.]+)px$/;

function borderBox(property: string, value: string, inset: Inset): string {
  const add = HORIZONTAL.has(property) ? inset.x : VERTICAL.has(property) ? inset.y : 0;
  if (add === 0) return value;

  const px = PX_VALUE.exec(value);
  return px ? `${Math.round((Number.parseFloat(px[1]) + add) * 100) / 100}px` : value;
}

type Inset = { x: number; y: number };

/**
 * How much padding the element puts inside its own declared size.
 *
 * Read off the raw declarations rather than the emitted ones, because the
 * shorthand may be read into longhands and either spelling has to count. Zero
 * on every route this cannot measure: a percentage, a border-box element, or
 * an element with no padding at all.
 */
function padded(style: string): Inset {
  if (BORDER_BOX.test(style)) return NO_INSET;

  const sides = { top: 0, right: 0, bottom: 0, left: 0 };
  let found = false;

  for (const declaration of style.split(';')) {
    const at = declaration.indexOf(':');
    if (at < 0) continue;
    const property = declaration.slice(0, at).trim().toLowerCase();
    const raw = declaration.slice(at + 1).replace(/!\s*important/gi, '').trim();

    if (property === 'padding') {
      const parts = raw.split(/\s+/).filter(Boolean).map(pixels);
      const expansion = SHORTHAND[parts.length];
      if (!expansion) continue;
      SIDE_ORDER.forEach((side, index) => {
        sides[side] = parts[expansion[index]] ?? 0;
      });
      found = true;
      continue;
    }
    const side = PADDING_SIDE[property];
    if (side) {
      sides[side] = pixels(raw);
      found = true;
    }
  }

  return found ? { x: sides.left + sides.right, y: sides.top + sides.bottom } : NO_INSET;
}

const NO_INSET: Inset = { x: 0, y: 0 };
const SIDE_ORDER = ['top', 'right', 'bottom', 'left'] as const;
const SHORTHAND: Record<number, [number, number, number, number]> = {
  1: [0, 0, 0, 0],
  2: [0, 1, 0, 1],
  3: [0, 1, 2, 1],
  4: [0, 1, 2, 3],
};
const PADDING_SIDE: Record<string, (typeof SIDE_ORDER)[number] | undefined> = {
  'padding-top': 'top',
  'padding-right': 'right',
  'padding-bottom': 'bottom',
  'padding-left': 'left',
};

/** A padding component in pixels, or zero for one this cannot add. */
function pixels(raw: string): number {
  const px = PX_VALUE.exec(raw.trim().toLowerCase());
  if (px) return Number.parseFloat(px[1]);
  return raw.trim() === '0' ? 0 : 0;
}

/**
 * The font size an element sets on itself, in pixels, or null when it sets none.
 *
 * Read straight off the declaration text rather than from the emitted style,
 * because `line-height` may be read before `font-size` is and the ratio needs
 * the size either way.
 */
function declaredFontSize(style: string): number | null {
  let found: number | null = null;
  for (const declaration of style.split(';')) {
    const at = declaration.indexOf(':');
    if (at < 0) continue;
    if (declaration.slice(0, at).trim().toLowerCase() !== 'font-size') continue;
    const px = fontSizePx(declaration.slice(at + 1).replace(/!\s*important/gi, '').trim());
    if (px !== null) found = px;
  }
  return found;
}
