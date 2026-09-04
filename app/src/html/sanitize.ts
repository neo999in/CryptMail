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
export function sanitizeHtml(html: string, rules?: CssRules, faces?: WeightFaces): string {
  const merged = prepare(html, rules ?? emptyRules());
  return sanitize(faces ? resolveFontWeights(merged, faces) : merged, sanitizeConfig);
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
  return sanitize(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    transformTags: {
      '*': (tagName, attribs) => {
        const style = mergeDeclarations(tagName, attribs, rules);
        if (style && POSITIONING.test(style)) return { tagName: EXCLUDED_TAG, attribs: {} };
        // class and id have done their work; neither survives the real config,
        // and dropping them here keeps them out of this pass's own output.
        const { class: _class, id: _id, ...rest } = attribs;
        return { tagName, attribs: style ? { ...rest, style } : rest };
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
 * The weight pass runs *after* the merge, because a `font-weight` is as likely
 * to arrive from a class as from a `style=`, and before the allowlist, because
 * what it produces is a `font-family` that still has to be validated.
 */
export function sanitizePipeline(
  html: string,
  vars?: Record<string, string>,
  faces?: WeightFaces,
): string {
  const resolved = vars ? resolveCssVars(html, vars) : html;
  // Rules are read from the resolved markup, so a `var()` written inside a
  // `<style>` block resolves the same way one written inline does.
  return sanitizeHtml(resolved, extractRules(resolved), faces);
}
