/**
 * The single place inbound HTML is made safe to render.
 *
 * This is docs/features.md §0.9's mandated `html/sanitize.ts`: **one auditable
 * module** with an allowlist of tags and attributes. Its done-when is that a
 * hostile fixture — script tags, `onerror`, remote CSS, data-URI payloads —
 * renders inert, which `__tests__/sanitize-test.ts` asserts against this
 * module's own exports.
 *
 * Defence is layered, and each layer is a different library's job:
 *
 *  1. `sanitize-html` parses the markup and rebuilds it from the allowlist
 *     below. Tags, attributes and URL schemes that are not listed never leave
 *     it. This is the coarse filter: it is what keeps `<script>`, `onerror`,
 *     `javascript:` and `data:` out of the string the renderer ever sees.
 *  2. `resolveCssVars` runs first and rewrites `var(--name)` references inside
 *     `style` attributes to concrete values, because the renderer's style
 *     parser does not evaluate CSS variables. That is what makes "apply CSS
 *     variables for dark/light matching" real — the map comes from the caller,
 *     and this module only ever substitutes known names or their fallback.
 *  3. `<style>` blocks are read by `./css.ts` and merged onto each element's
 *     own `style` attribute as the sanitizer walks it, so a class-styled
 *     newsletter keeps its design. Nothing is trusted by that route that would
 *     not be trusted inline: the merged value goes through `allowedStyles`
 *     below like any other. The `<style>` tag itself is still discarded whole,
 *     contents included (`sanitize-html` treats it as a non-text tag).
 *  4. `react-native-render-html`'s transient render engine applies its own
 *     safe property allowlist when it parses what survives into RN styles —
 *     `position: fixed`, `z-index`, `pointer-events` and friends are dropped a
 *     second time, independently of what is allowed here. `exclusiveFilter`
 *     below is the same idea applied a little earlier.
 *
 * The one auditable contract is the exported `sanitizeConfig` — review that
 * object, not the library.
 */
import sanitize from 'sanitize-html';

import {
  adaptBackground,
  adaptBorder,
  adaptForeground,
  colorInShorthand,
  parseColor,
} from './colors';
import { CssRules, emptyRules, extractRules, mergeDeclarations } from './css';

/**
 * What a positioned element is renamed to before the allowlist runs.
 *
 * Not a real tag, and deliberately not one an email could contain: it exists
 * for the length of one pass, and `nonTextTags` below turns it into a deletion.
 */
const EXCLUDED_TAG = 'cryptmail-excluded';

/**
 * The declarations that mean "render me somewhere the reader did not intend".
 *
 * Narrow on purpose, and narrower than it first looks like it should be. None
 * of `position`, `z-index` or `pointer-events` is in `allowedStyles`, so none
 * of them can ever reach the renderer — stripping them is automatic and needs
 * no help. This regex decides something stronger: whether to delete the element
 * *and its text*, on the grounds that the sender only ever meant it to be seen
 * through the effect that was stripped.
 *
 * Deleting content is the expensive answer, so it is reserved for the two
 * declarations that have no innocent reading in an email: `position: fixed`,
 * which is how an overlay is pinned over whatever is beneath it, and
 * `pointer-events: none`, which is how a tap is passed through to something
 * else.
 *
 * `position: absolute` and `position: relative` are deliberately absent. Both
 * are ordinary layout — real newsletters position a large share of their
 * structure, images included — and matching them deleted whole legitimate
 * sections the moment `<style>` blocks began to be read, which is a worse
 * failure than the one being defended against. With the property stripped, such
 * an element simply flows inline, where it is visible and therefore judgeable.
 * `z-index` is nothing on its own: it orders elements that are already
 * positioned, and the positioned one is what this catches.
 */
const POSITIONING = /(?:^|;)\s*(?:position\s*:\s*fixed|pointer-events\s*:\s*none)/i;

/**
 * A colour: hex, rgb()/hsl(), or a plain CSS keyword.
 *
 * A bare word is how emails write `color:red` — it cannot smuggle anything
 * executable, because `url(...)` and `expression(...)` carry parentheses and
 * neither matches `[a-zA-Z][a-zA-Z0-9]*`. The renderer's own prop allowlist
 * still decides the *property*; this only constrains the value.
 */
const COLOR = /^\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z][a-zA-Z0-9]*)\s*$/;

/** A length with a unit, or 0. */
const LENGTH = /^\s*(0|[0-9.]+(?:px|em|rem|%|pt))\s*$/;

/** One or more space-separated lengths, 0, or auto — margin/padding shorthands. */
const LENGTHS = /^\s*(0|auto|[0-9.]+(?:px|em|rem|%|pt)(?:\s+[0-9.]+(?:px|em|rem|%|pt))*)\s*$/;

/** A border line: width, optional style, optional colour — never url(). */
const BORDER = /^\s*(none|hidden|solid|dashed|dotted|double|ridge|groove|inset|outset|[0-9.]+(?:px|em|pt|rem)(?:\s+(?:solid|dashed|dotted|double|ridge|groove|inset|outset|none))?(?:\s+(?:#[0-9a-fA-F]{3,8}|[a-zA-Z][a-zA-Z0-9]*))?)\s*$/;

const FONT_WEIGHT = /^\s*(normal|bold|bolder|lighter|[1-9]00)\s*$/;
const FONT_STYLE = /^\s*(normal|italic|oblique)\s*$/;
const TEXT_ALIGN = /^\s*(left|right|center|justify|start|end)\s*$/;
const TEXT_DECORATION = /^\s*((?:underline|line-through|overline|none)(?:\s+(?:underline|line-through|overline))*)\s*$/;

/**
 * The allowlist itself.
 *
 * Attributes are listed per tag, with `'*'` applying to every tag. Inline
 * `style` is the only `'*'` attribute because an email's fonts and colours live
 * there and the renderer re-validates every property against its own safe set —
 * but what *values* a property may take is decided here, in `allowedStyles`.
 */
export const sanitizeConfig: sanitize.IOptions = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
    'blockquote', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href'],
    img: ['src', 'alt'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    '*': ['style'],
  },
  allowedStyles: {
    '*': {
      color: [COLOR],
      'background-color': [COLOR],
      'font-family': [/^\s*[A-Za-z0-9_ '"(),-]+\s*$/],
      'font-size': [LENGTH],
      'font-weight': [FONT_WEIGHT],
      'font-style': [FONT_STYLE],
      'line-height': [/^\s*(normal|[0-9.]+(?:px|em|rem|%)?)\s*$/],
      'text-align': [TEXT_ALIGN],
      'text-decoration': [TEXT_DECORATION],
      'text-transform': [/^\s*(none|uppercase|lowercase|capitalize)\s*$/],
      // `display` decides whether a box is a box at all. React Native draws no
      // border, radius or background on a *nested inline* element, so an email
      // button — invariably a styled <span> inside an <a> — arrived as bare
      // blue text with its outline silently dropped. `none` matters just as
      // much: it is how every sender hides the preheader line that would
      // otherwise be repeated at the top of the message.
      display: [/^\s*(none|block|inline|inline-block|flex)\s*$/],
      'letter-spacing': [/^\s*-?[0-9.]+(?:px|em|rem)\s*$/],
      margin: [LENGTHS],
      'margin-top': [LENGTHS],
      'margin-right': [LENGTHS],
      'margin-bottom': [LENGTHS],
      'margin-left': [LENGTHS],
      padding: [LENGTHS],
      'padding-top': [LENGTHS],
      'padding-right': [LENGTHS],
      'padding-bottom': [LENGTHS],
      'padding-left': [LENGTHS],
      border: [BORDER],
      'border-top': [BORDER],
      'border-right': [BORDER],
      'border-bottom': [BORDER],
      'border-left': [BORDER],
      'border-color': [COLOR],
      'border-top-color': [COLOR],
      'border-right-color': [COLOR],
      'border-bottom-color': [COLOR],
      'border-left-color': [COLOR],
      'border-width': [LENGTH],
      'border-radius': [LENGTH],
      width: [LENGTH],
      height: [LENGTH],
      'max-width': [LENGTH],
      'max-height': [LENGTH],
    },
  },
  // Only http/https ever becomes a navigable or fetchable URL — the same
  // rule lib/links.ts applies to plaintext bodies. javascript:, data:, file:
  // and mailto: are dropped from href/src outright.
  allowedSchemes: ['http', 'https'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  // `//host/path` would otherwise survive the scheme gate as "relative". It is
  // a network load all the same — drop it, matching "http/https only".
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // Tags whose *contents* go with them. The library's own four, plus the
  // sentinel `prepare` renames a positioned element to — without it here that
  // element would be unwrapped and its hidden text would render as body copy,
  // which is the outcome the exclusion exists to prevent.
  nonTextTags: ['script', 'style', 'textarea', 'option', EXCLUDED_TAG],
  // Second line only. `prepare` below is what actually catches a positioned
  // element, because it is the one place the raw style is still visible: by the
  // time a frame reaches here, a `style` holding *nothing but* disallowed
  // properties has already been emptied and dropped, so `position:fixed` on its
  // own would look like no style at all. This still fires for an element whose
  // style survived filtering, and costs nothing to keep.
  exclusiveFilter: (frame) =>
    frame.tag !== 'style' && POSITIONING.test(frame.attribs.style ?? ''),
};

/**
 * Sanitise a raw HTML string against the allowlist above.
 *
 * Never throws on malformed markup; `sanitize-html` rebuilds what it can parse
 * and drops the rest.
 *
 * `rules` are the declarations from the message's own `<style>` blocks. They are
 * merged onto each element *before* `allowedStyles` runs, so a stylesheet can
 * only set what an inline style could — and `class`/`id` are read during that
 * merge and then dropped, since neither is in `allowedAttributes`.
 */
export function sanitizeHtml(
  html: string,
  rules?: CssRules,
  faces?: WeightFaces,
  dark = false,
): string {
  let out = adaptDeclarations(prepare(html, rules ?? emptyRules()), dark);
  if (faces) out = resolveFontWeights(out, faces);
  return sanitize(out, sanitizeConfig);
}

/**
 * Fold the stylesheet into each element, and mark the ones that must not render.
 *
 * A separate pass, and it has to be one, for a reason that is easy to miss: the
 * allowlist below never sees a declaration it does not allow. A `style` holding
 * only `position: fixed` is emptied and the attribute removed, so by the time
 * `exclusiveFilter` runs there is nothing left to recognise — the element is
 * kept, and whatever the sender meant to hide under an overlay renders as
 * ordinary body copy. A declaration arriving by class is invisible there twice
 * over, since frames carry the element's *source* attributes.
 *
 * This pass is where the raw style still exists, so this is where both are
 * decided: the stylesheet is merged in, and an element carrying a positioning
 * declaration by either route is renamed to `EXCLUDED_TAG`, which
 * `nonTextTags` then deletes along with its contents.
 *
 * Nothing is *allowed* here — it permits every tag and attribute precisely
 * because it decides nothing about safety. Its output is never rendered; it is
 * input to `sanitizeConfig`, which remains the one gate.
 */
function prepare(html: string, rules: CssRules): string {
  // `<center>` before the walk, since it is the tag itself that carries the
  // meaning and the allowlist has no room for it.
  const centred = html.replace(CENTER_TAG, (_m, slash: string) =>
    slash ? '</div>' : '<div style="text-align:center">',
  );

  return sanitize(centred, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    transformTags: {
      '*': (tagName, attribs) => {
        // Presentational attributes go *under* the stylesheet and the element's
        // own style, matching how a browser resolves them: they are a default
        // the author can override, not an instruction that beats CSS.
        const presentational = presentationalStyle(attribs);
        const merged = mergeDeclarations(tagName, attribs, rules);
        const style = [...presentational, merged].filter(Boolean).join(';') || undefined;

        if (style && POSITIONING.test(style)) return { tagName: EXCLUDED_TAG, attribs: {} };

        // A `span` the sender turned into a box becomes one. `display:block`
        // by itself is not enough: react-native-render-html keeps a span in
        // the text tree, and React Native draws no border, radius or
        // background on a nested `Text` — so an email button, which is always
        // a styled span inside an anchor, rendered as bare coloured text.
        // Renaming it to a div is what makes the renderer give it a view of
        // its own, and a view is the only thing here that can have an edge.
        const boxed = tagName === 'span' && style ? BOX_DISPLAY.test(style) : false;
        // class, id and the presentational attributes have all done their work
        // here; none of them survives the real config, and dropping them keeps
        // them out of this pass's own output.
        const { class: _class, id: _id, align: _a, bgcolor: _b, width: _w, ...rest } = attribs;
        return { tagName: boxed ? 'div' : tagName, attribs: style ? { ...rest, style } : rest };
      },
    },
  });
}

/** A `var(--name[, fallback])` reference inside a style attribute value. */
const CSS_VAR = /var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,\s*([^)]*?)\s*)?\)/g;

/** A style attribute value, capturing the quotes so we can rebuild it. */
const STYLE_ATTR = /(\bstyle\s*=\s*)(["'])(.*?)\2/g;

/**
 * Resolve `var(--name)` references inside `style` attributes to concrete
 * values, because no RN renderer evaluates CSS variables.
 *
 * Known names come from `vars` (the caller's theme map); an unknown name uses
 * its inline fallback if one is written, and is otherwise removed. Only style
 * attribute *values* are touched — body text is never rewritten. Bounded, no
 * backtracking: the same property spam/urls.ts holds its scanners to.
 */
export function resolveCssVars(html: string, vars: Record<string, string>): string {
  return html.replace(STYLE_ATTR, (whole, prefix: string, quote: string, style: string) => {
    const resolved = style.replace(CSS_VAR, (_m, name: string, fallback?: string) => {
      const mapped = vars[`--${name}`] ?? vars[name];
      if (mapped) return mapped;
      if (fallback !== undefined && fallback.trim() !== '') return fallback.trim();
      return '';
    });
    return `${prefix}${quote}${resolved}${quote}`;
  });
}


/**
 * The presentational attributes email lays itself out with, as CSS.
 *
 * HTML email is table markup from 1999 and means it sincerely: `align="center"`
 * centres the hero, `bgcolor` paints the card, `width` sets the column. None of
 * these are in `allowedAttributes` and none of them should be — an attribute
 * that survives to the renderer is one more thing to reason about. Converting
 * them to declarations instead means they land in `allowedStyles` with
 * everything else, get the same colour adaptation, and are validated by regexes
 * that already exist. A message losing them is not a message with a slightly
 * different look; it is a centred layout rendered flush left with its cards
 * gone, which is most of the distance between this reader and a webmail one.
 *
 * `width` becomes `max-width`. The attribute is a fixed pixel count written for
 * a 600px desktop column, and honouring it literally would push every such
 * message off the side of a phone; as a maximum it still constrains an image
 * that would otherwise blow up, and lets everything else shrink to fit.
 *
 * `height` is dropped rather than converted: paired with a max-width that may
 * now be smaller than the author assumed, it would squash the image. Leaving it
 * out lets the renderer keep the intrinsic ratio.
 */
const PRESENTATIONAL: Record<string, (value: string) => string | null> = {
  align: (value) => {
    const v = value.trim().toLowerCase();
    return v === 'center' || v === 'left' || v === 'right' ? `text-align:${v}` : null;
  },
  bgcolor: (value) => (parseColor(value.trim()) ? `background-color:${value.trim()}` : null),
  width: (value) => {
    const v = value.trim();
    if (/^[0-9]+%$/.test(v)) return `max-width:${v}`;
    if (/^[0-9]+$/.test(v)) return `max-width:${v}px`;
    return null;
  },
};

/**
 * A `display` that asks for a box rather than a run of text.
 *
 * `inline-block` counts, and has to: this is tested during `prepare`, which
 * runs before `adaptDeclarations` narrows inline-block to block, so matching
 * only `block` here would never fire on the very markup it exists for.
 */
const BOX_DISPLAY = /(?:^|;)\s*display\s*:\s*(?:inline-block|block|flex)/i;

/** `<center>` is not in the allowlist, but what it means is expressible. */
const CENTER_TAG = /<(\/?)center\b([^>]*)>/gi;

function presentationalStyle(attribs: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, toDeclaration] of Object.entries(PRESENTATIONAL)) {
    const raw = attribs[name];
    if (!raw) continue;
    const declaration = toDeclaration(raw);
    if (declaration) out.push(declaration);
  }
  return out;
}

/** A single `property: value` declaration inside a style attribute. */
const DECLARATION = /(^|;)\s*([a-zA-Z-]+)\s*:\s*([^;]+)/g;

/**
 * Rewrite the declarations a native renderer cannot take at face value.
 *
 * Two jobs, and they are here together because both need the parsed
 * declaration and neither is a safety decision — the allowlist still runs
 * afterwards and still has the last word.
 *
 * The `background` shorthand becomes `background-color`. Converting rather than
 * allowing is the point: `background` can carry `url(...)`, so letting it
 * through would open a remote fetch by another name. Only a colour is lifted
 * out — including a gradient's first stop, since nothing here draws a gradient
 * and a flat band of the sender's own colour is far closer to what they drew
 * than the nothing that was rendered before.
 *
 * `display: inline-block` becomes `block`, since React Native has no
 * inline-block and `block` is the closer of the two it does have.
 *
 * Colours are adapted only when `dark` is set; everything else applies either
 * way.
 */
export function adaptDeclarations(html: string, dark: boolean): string {
  return html.replace(STYLE_ATTR, (whole, prefix: string, quote: string, style: string) => {
    const resolved = style.replace(
      DECLARATION,
      (match, lead: string, rawProperty: string, value: string) => {
        const property = rawProperty.trim().toLowerCase();

        if (property === 'display') {
          // React Native has no inline-block. `block` is the closer of the two
          // it does have: the element gets its own box, which is the whole
          // reason a sender reached for inline-block on a button.
          const mode = value.trim().toLowerCase();
          return mode === 'inline-block' ? `${lead}display:block` : match;
        }
        if (property === 'background') {
          const color = colorInShorthand(value);
          if (!color) return lead;
          const resolved = (dark && adaptBackground(color)) || color;
          return `${lead}background-color:${resolved}`;
        }
        if (!dark) return match;

        if (property === 'background-color') {
          const adapted = adaptBackground(value);
          return adapted ? `${lead}background-color:${adapted}` : match;
        }
        if (property === 'color') {
          const adapted = adaptForeground(value);
          return adapted ? `${lead}color:${adapted}` : match;
        }
        if (property.startsWith('border') && property.endsWith('color')) {
          const adapted = adaptBorder(value);
          return adapted ? `${lead}${property}:${adapted}` : match;
        }
        return match;
      },
    );
    return `${prefix}${quote}${resolved}${quote}`;
  });
}

/**
 * The loaded face to use for each CSS weight, heaviest key first.
 *
 * Supplied by the caller because this module has no business knowing the app's
 * fonts — it is the same arrangement as `vars`: the renderer cannot evaluate
 * the thing, so the caller says what it resolves to.
 */
export type WeightFaces = {
  /** 400 and `normal`. */
  regular: string;
  /** 500. */
  medium: string;
  /** 600. */
  semibold: string;
  /** 700 and up, `bold`, `bolder`. */
  bold: string;
};

/** A `font-weight: …` declaration inside a style attribute. */
const FONT_WEIGHT_DECL = /(^|;)\s*font-weight\s*:\s*([^;]+)/gi;

function faceForWeight(value: string, faces: WeightFaces): string | null {
  const weight = value.trim().toLowerCase();
  if (weight === 'normal') return faces.regular;
  if (weight === 'bold' || weight === 'bolder') return faces.bold;
  if (weight === 'lighter') return faces.regular;

  const numeric = Number(weight);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 700) return faces.bold;
  if (numeric >= 600) return faces.semibold;
  if (numeric >= 500) return faces.medium;
  return faces.regular;
}

/**
 * Rewrite `font-weight` into the concrete face that weight means.
 *
 * Manrope ships as separate files per weight, and React Native does not
 * synthesize: `fontWeight: '600'` over `Manrope_400Regular` renders regular,
 * silently. The app's own rule is therefore to address a weight by its family
 * (`font.sansSemibold`), never by `fontWeight` — and an email full of
 * `font-weight: 600` is exactly the case that rule exists for. Without this,
 * every bold thing a sender wrote arrives unbolded, which is most of the
 * difference between a newsletter that looks designed and one that looks like a
 * dump of its text.
 *
 * The declaration is *replaced*, not added to: leaving `font-weight` behind
 * would have the engine apply a second, conflicting instruction to a face that
 * cannot honour it. A weight this map does not recognise is left alone.
 */
export function resolveFontWeights(html: string, faces: WeightFaces): string {
  return html.replace(STYLE_ATTR, (whole, prefix: string, quote: string, style: string) => {
    const resolved = style.replace(FONT_WEIGHT_DECL, (match, lead: string, value: string) => {
      const face = faceForWeight(value, faces);
      return face ? `${lead}font-family:${face}` : match;
    });
    return `${prefix}${quote}${resolved}${quote}`;
  });
}

/**
 * The one entry point the reader uses.
 *
 * Order matters, and each step is there because the renderer cannot do the
 * thing itself: variables resolve to values, the stylesheet folds into the
 * elements it selects, weights become the faces they mean, and only then does
 * the allowlist decide what any of it is allowed to say.
 *
 * The colour and weight passes run *after* the merge, because either can as
 * easily arrive from a class as from a `style=`, and before the allowlist,
 * because what they produce — a `background-color`, a `font-family` — still has
 * to be validated like anything else the sender wrote.
 */
export function sanitizePipeline(
  html: string,
  vars?: Record<string, string>,
  faces?: WeightFaces,
  dark = false,
): string {
  const resolved = vars ? resolveCssVars(html, vars) : html;
  // Rules are read from the resolved markup, so a `var()` written inside a
  // `<style>` block resolves the same way one written inline does.
  return sanitizeHtml(resolved, extractRules(resolved), faces, dark);
}
