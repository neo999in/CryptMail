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
import { readStyle } from './properties';
import { ValueContext } from './values';

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
 * The sender said not to show this.
 *
 * Overwhelmingly a preheader: the line a client puts in its list preview,
 * hidden in the body so it is not read twice. It is deleted with its contents
 * rather than passed through with `display:none` attached, because those are
 * only the same thing while the renderer honours the declaration — and a
 * rendering detail is the wrong thing for "the reader never sees this" to
 * depend on. Deleting here makes it true of the markup instead.
 */
const HIDDEN = /(?:^|;)\s*display\s*:\s*none/i;

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
  // Only http/https ever becomes a navigable or fetchable URL — the same
  // rule lib/links.ts applies to plaintext bodies. javascript:, data:, file:
  // and mailto: are dropped from href/src outright.
  allowedSchemes: ['http', 'https'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  // `//host/path` would otherwise survive the scheme gate as "relative". It is
  // a network load all the same — drop it, matching "http/https only".
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  /**
   * Tags whose *contents* go with them.
   *
   * Discarding a tag keeps its text by default, which is right for a `<span>`
   * and wrong for everything here. `<title>` is the message's subject and
   * rendered as the first line of the body; `<noscript>` and `<iframe>` carry
   * fallback copy meant for a client that could not show the real thing;
   * `<head>` holds `<meta>` content. Each of them put text on screen that no
   * mail client shows and the sender never meant a reader to see.
   *
   * The sentinel is here for the same reason: without it, an element excluded
   * for positioning would be unwrapped and the copy it was hiding would render
   * as body text, which is the outcome the exclusion exists to prevent.
   */
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'title',
    'head',
    'noscript',
    'iframe',
    'object',
    'embed',
    'applet',
    'template',
    'select',
    EXCLUDED_TAG,
  ],
  // A backstop. `prepare` is what actually catches a positioned element, since
  // it is the only point where the raw declarations still exist — a frame here
  // carries the element's *source* attributes, so anything that arrived by
  // class was never visible to this at all. Kept because it costs nothing and
  // covers a `sanitizeHtml` called without going through `prepare`'s merge.
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
export function sanitizeHtml(html: string, rules?: CssRules, ctx?: ValueContext): string {
  return sanitize(prepare(html, rules ?? emptyRules(), ctx ?? { dark: false }), sanitizeConfig);
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
function prepare(html: string, rules: CssRules, ctx: ValueContext): string {
  // `<center>` before the walk, since it is the tag itself that carries the
  // meaning and the allowlist has no room for it.
  const centred = html
    // Its own attributes come along: a `<center style="background:#eee">` is
    // both the wrapper and the instruction, and dropping the wrapper's half
    // loses a background that the rest of the pipeline would have adapted.
    // `align` rather than an inline style, so the centring merges under
    // whatever the element already said instead of overwriting it.
    .replace(CENTER_TAG, (_m, slash: string, attrs: string) =>
      slash ? '</div>' : `<div align="center"${attrs}>`,
    )
    // `<font>` becomes a span so its attributes can be read as declarations by
    // the same walk that reads every other element's.
    .replace(FONT_TAG, (_m, slash: string, attrs: string) => (slash ? '</span>' : `<span${attrs}>`));

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
        const raw = [...presentational, merged].filter(Boolean).join(';');

        // Tested against the *raw* declarations, not the read ones: `position`
        // is not in the property table, so by the time the style has been read
        // there is nothing left to recognise. This is the only point where the
        // element still admits what it was trying to do.
        if (POSITIONING.test(raw) || HIDDEN.test(raw)) {
          return { tagName: EXCLUDED_TAG, attribs: {} };
        }

        // Every declaration from every route meets the same table here, which
        // is what makes "a stylesheet buys nothing an inline style could not"
        // a fact about the code rather than an intention.
        const read = readStyle(raw, ctx);
        const style = read === '' ? undefined : read;

        // An image the renderer cannot fetch is removed rather than emptied.
        // `allowedSchemes` strips a `cid:` or `data:` src and a path-relative
        // one has no scheme to strip, and in every case what survives is an
        // `<img>` with nothing to show — which lays out as a blank gap the
        // reader has no way to interpret. Note this takes CryptMail's own
        // inline attachments with it: those are `cid:` references, and
        // resolving them against the decrypted parts is a separate job.
        if (tagName === 'img' && !/^https?:\/\//i.test(attribs.src ?? '')) {
          return { tagName: EXCLUDED_TAG, attribs: {} };
        }

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
        const {
          class: _class,
          id: _id,
          align: _align,
          bgcolor: _bgcolor,
          width: _width,
          color: _color,
          face: _face,
          size: _size,
          // Dropped so the *read* style is the only one that can survive. The
          // property table is the style gate now, and leaving the original
          // here would route every declaration around it.
          style: _style,
          ...rest
        } = attribs;
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
  // `<font color=… face=…>` predates CSS and has outlived it in mail, because
  // the templates were written once and never revisited. The tag is not in the
  // allowlist and its text survives without them, so the visible symptom is
  // copy that quietly loses its colour rather than copy that disappears.
  color: (value) => (parseColor(value.trim()) ? `color:${value.trim()}` : null),
  face: (value) => (/^[A-Za-z0-9_ '",-]+$/.test(value) ? `font-family:${value.trim()}` : null),
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

/** `<font>`, whose attributes are the only reason it is still written. */
const FONT_TAG = /<(\/?)font\b([^>]*)>/gi;

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
  faces?: ValueContext['faces'],
  dark = false,
): string {
  const resolved = vars ? resolveCssVars(html, vars) : html;
  // Rules are read from the resolved markup, so a `var()` written inside a
  // `<style>` block resolves the same way one written inline does.
  return sanitizeHtml(resolved, extractRules(resolved), { dark, faces });
}
