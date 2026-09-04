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
    // `width` and `height` are the size the sender drew the image at, and the
    // renderer reads them off the element to lay it out before the bytes
    // arrive. Without them it falls back to the file's own pixel dimensions,
    // and a 20-point social icon shipped as a 2x asset came out a third of the
    // size the sender asked for, with its neighbours touching it.
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    // The only classes in the document, and this module wrote both: `prepare`
    // drops every class the sender sent before adding one of its own. See
    // STACK_CLASS and INLINE_CLASS.
    tr: ['class'],
    div: ['class'],
    span: ['class'],
    table: ['class'],
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
 * merge and then dropped. The one class that reaches the renderer is the one
 * this module writes itself, on a row it has decided must stack; see
 * `STACK_CLASS`.
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
    .replace(FONT_TAG, (_m, slash: string, attrs: string) => (slash ? '</span>' : `<span${attrs}>`))
    // A box that held nothing but a picture goes with the picture. See
    // DECORATIVE_BOX.
    .replace(DECORATIVE_BOX, (whole: string, tag: string, attrs: string) =>
      HAS_BACKGROUND_IMAGE.test(attrs) ? (CELL_NAME.test(tag) ? `<${tag}></${tag}>` : '') : whole,
    )
    // Rows too crowded to stay rows on a phone are marked here, where the
    // cells are still countable. See STACKED_ROW.
    .replace(ROW, (whole: string, attrs: string, cells: string) =>
      crowded(cells) ? `<tr${attrs} ${STACK_MARKER}>${unshare(cells)}</tr>` : whole,
    );

  // And the opposite case: siblings that asked to share a line. See INLINE_CLASS.
  return sanitize(inlineRuns(centred), {
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
          'data-cm-stack': stack,
          'data-cm-inline': inline,
          'data-cm-inline-item': inlineItem,
          align: _align,
          bgcolor: _bgcolor,
          // Read as a declaration like the rest — except on an image, where the
          // renderer wants the attribute itself. See `allowedAttributes`.
          width: widthAttribute,
          height: heightAttribute,
          color: _color,
          face: _face,
          size: _size,
          // Dropped so the *read* style is the only one that can survive. The
          // property table is the style gate now, and leaving the original
          // here would route every declaration around it.
          style: _style,
          ...rest
        } = attribs;
        const sized =
          tagName === 'img'
            ? { ...rest, ...(widthAttribute ? { width: widthAttribute } : {}),
                ...(heightAttribute ? { height: heightAttribute } : {}) }
            : rest;
        const kept = style ? { ...sized, style } : sized;
        // The only classes in the document, and this module wrote both.
        const marked = stack
          ? STACK_CLASS
          : inline
            ? INLINE_CLASS
            : inlineItem
              ? INLINE_ITEM_CLASS
              : undefined;
        return {
          tagName: boxed ? 'div' : tagName,
          attribs: marked ? { ...kept, class: marked } : kept,
        };
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


/** An element with no content of its own, and what it was styled with. */
const DECORATIVE_BOX = /<(div|span|p|a|td|th|section|article)\b([^>]*)>\s*<\/\1\s*>/gi;
const HAS_BACKGROUND_IMAGE = /background(?:-image)?\s*:[^;"']*url\s*\(/i;
const CELL_NAME = /^t[dh]$/i;

/**
 * An empty box that existed to show a picture, removed along with the picture.
 *
 * `<div style="width:146px;height:146px;background:url(hand_wave.gif)"></div>`
 * is how a template draws a hero, an avatar, an icon or a rule, and this reader
 * cannot draw any of them: `background` is read for its colour and a URL is not
 * one. What was left was the *size* — a 146-point hole between the logo and the
 * headline, with nothing in it and no way for a reader to tell that anything
 * was ever meant to be there.
 *
 * The same call `<img>` already gets, and for the same reason: an image the
 * renderer cannot fetch is removed rather than emptied, because a blank gap is
 * not a smaller version of a picture. A cell keeps its place in the row —
 * removing one would renumber the columns beside it — and loses its sizing.
 *
 * Only elements that are *empty* qualify. A box with a background image behind
 * its own text keeps both its text and its space.
 */


/** An element that asked to sit on a line with its siblings. */
const INLINE_ELEMENT = /<(table|div|span)\b([^>]*)>/gi;
/** The same, anchored: is the *next* thing another one of them? */
const NEXT_SIBLING = /<(table|div|span)\b([^>]*)>/y;
const INLINE_DISPLAY = /display\s*:\s*inline(?:-block|-table)?/i;
/** Whitespace, and the conditional comments a template leaves between them. */
const BETWEEN_SIBLINGS = /(?:\s|<!--[\s\S]*?-->)*/y;
/** An opening or closing tag of one name, for finding where an element ends. */
const elementEdges = (tag: string) => new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');

/**
 * How far one element reaches, counting its own kind on the way.
 *
 * A social icon is a table inside a table, so the first `</table>` after the
 * opening one is not its end. Null when the markup does not close what it
 * opened, or runs past anything worth scanning — a malformed message loses the
 * rearrangement, not its content.
 */
function elementEnd(html: string, tag: string, start: number): number | null {
  const edges = elementEdges(tag);
  edges.lastIndex = start;
  let depth = 0;
  for (let edge = edges.exec(html); edge; edge = edges.exec(html)) {
    depth += edge[1] ? -1 : 1;
    if (depth === 0) return edges.lastIndex;
    if (edges.lastIndex - start > MAX_ELEMENT) return null;
  }
  return null;
}

/** Nothing laid out inline is worth scanning past this much markup. */
const MAX_ELEMENT = 20_000;

/**
 * Siblings that asked to share a line, wrapped in something that gives them one.
 *
 * `display:inline-table` is how a footer's social icons are strung together —
 * each is a table of its own, and the declaration is the only thing keeping
 * them side by side. React Native has no inline display: every one of them
 * became a block, and four icons came down the left margin as a ladder.
 *
 * A row is not something an element can ask for on its own behalf — the *parent*
 * has to be told to lay its children out in one — so a run of them is wrapped
 * in a box this reader styles, which is the smallest thing that can be true of
 * a group rather than of an element.
 *
 * Only short runs qualify, by the same budget `crowded` spends: icons, badges
 * and buttons fit on a line and were written to be on one, while the other
 * common inline-block — a template's desktop columns, each holding a paragraph
 * — does not fit and is better left stacked, which is what a responsive
 * template asks for at this width anyway.
 */
function inlineRuns(html: string): string {
  const finder = INLINE_ELEMENT;
  finder.lastIndex = 0;
  let out = '';
  let cursor = 0;

  for (let open = finder.exec(html); open; open = finder.exec(html)) {
    if (open.index < cursor || !INLINE_DISPLAY.test(open[2])) continue;

    let end = elementEnd(html, open[1], open.index);
    if (end === null) continue;

    // Where each member's opening tag ends, so a run can be spaced from the
    // inside as well as arranged from the outside.
    const members = [open.index + open[0].length - 1];
    for (;;) {
      BETWEEN_SIBLINGS.lastIndex = end;
      BETWEEN_SIBLINGS.exec(html);
      const at = BETWEEN_SIBLINGS.lastIndex;

      NEXT_SIBLING.lastIndex = at;
      const next = NEXT_SIBLING.exec(html);
      if (!next || !INLINE_DISPLAY.test(next[2])) break;

      const reach = elementEnd(html, next[1], at);
      if (reach === null) break;
      end = reach;
      members.push(at + next[0].length - 1);
    }

    const run = html.slice(open.index, end);
    if (members.length < 2 || textOf(run).length > LINE_BUDGET) continue;

    out += html.slice(cursor, open.index) + `<div ${INLINE_MARKER}>${spaced(html, open.index, members, end)}</div>`;
    cursor = end;
    finder.lastIndex = end;
  }
  return out + html.slice(cursor);
}

/**
 * A run rebuilt with each member marked, so the reader can space them apart.
 *
 * The separation an email writes between such elements is a padding two levels
 * inside each one's own table, and it does not survive being laid out as a flex
 * item — four social icons came out touching, their glyphs overlapping. The
 * marker goes on the members rather than the wrapper because the one style that
 * would do it from outside, `gap`, is not a property the renderer's own
 * validator knows.
 */
function spaced(html: string, start: number, members: number[], end: number): string {
  let out = '';
  let cursor = start;
  for (const at of members) {
    out += `${html.slice(cursor, at)} ${INLINE_ITEM_MARKER}`;
    cursor = at;
  }
  return out + html.slice(cursor, end);
}

/**
 * The class a run of them carries, and what the reader lays it out by.
 *
 * Same channel as `STACK_CLASS` and for the same reason: a class is the one
 * thing `react-native-render-html` styles by name, and the sender's own classes
 * are gone before either of these is added.
 */
export const INLINE_CLASS = 'cm-inline';
const INLINE_MARKER = `data-cm-inline="1"`;

/** The same, for one member of such a run. See `spaced`. */
export const INLINE_ITEM_CLASS = 'cm-inline-item';
const INLINE_ITEM_MARKER = `data-cm-inline-item="1"`;

/**
 * A row with nothing but cells in it, and the cells inside it.
 *
 * Innermost by construction: the body may not contain another `<tr>`, so a row
 * that wraps a nested table is skipped and the nested rows are matched instead.
 * That is the right level, because it is the innermost row whose cells are the
 * columns a reader actually sees.
 */
const ROW = /<tr\b([^>]*)>((?:(?!<\/?tr\b)[\s\S]){0,50000}?)<\/tr\s*>/gi;

/** A cell, with whatever it holds — used to decide whether the row is crowded. */
const CELL_CONTENT = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi;
const TAGS = /<[^>]*>/g;
/** Source indentation, which is not text a reader sees. */
const RUNS_OF_SPACE = /\s+/g;

/**
 * Roughly how many characters of body text fit across a phone's column.
 *
 * Measured rather than reasoned: 15.5px Manrope on the reader's own content
 * width comes to somewhere in the mid-forties. It does not need to be exact —
 * it is the line between "these cells share a line" and "these cells cannot",
 * and everything near it reads acceptably either way.
 */
const LINE_BUDGET = 45;

/**
 * Whether this row is a row of columns rather than a row of cells.
 *
 * Two questions, and both have to answer yes. *How many cells* — two are the
 * label and the figure a statement is made of, and they read correctly side by
 * side, so three is where a row starts being a layout. And *how much text* —
 * three cells carrying sentences do not fit across a phone and break words to
 * get there, while three carrying a social icon each fit easily and stacking
 * them turns a footer into a ladder. A row of short labels sits below the
 * budget and is left alone; a row of three call-to-action sentences is three
 * times over it.
 */
function crowded(cells: string): boolean {
  let count = 0;
  let text = 0;
  for (const cell of cells.matchAll(CELL_CONTENT)) {
    count += 1;
    text += textOf(cell[1]).length;
  }
  return count >= 3 && text > LINE_BUDGET;
}

/**
 * The words in a fragment of markup, without its markup or its indentation.
 *
 * Collapsed on purpose: the newlines and indentation a template generator
 * leaves between tags are not width, and counting them called a name and an
 * amount a crowded row.
 */
function textOf(markup: string): string {
  return markup.replace(TAGS, ' ').replace(RUNS_OF_SPACE, ' ').trim();
}


/** A cell's opening tag, and the two ways it can claim a share of the row. */
const CELL_TAG = /<t[dh]\b[^>]*>/gi;
const SHARE_ATTRIBUTE = /\s+width\s*=\s*(?:"[0-9.]+%"|'[0-9.]+%'|[0-9.]+%)/gi;
const SHARE_DECLARATION = /(["';])\s*width\s*:\s*[0-9.]+%\s*;?/gi;

/**
 * Take the percentage widths off the cells of a row that is about to stack.
 *
 * `width:33%` is a third *of the row*, which is exactly what the sender meant
 * and exactly what stops meaning anything once the row is read downwards: three
 * buttons under one another, each a third of the screen wide, in a column down
 * the left. A share of a row has no reading in a column, so it is dropped and
 * the cell takes the width it is given. A pixel width is left alone — it is a
 * measurement rather than a share, and it still says something true.
 *
 * Only the cells' own opening tags are touched, and only inside a row already
 * matched as innermost, so nothing nested can be reached from here.
 */
function unshare(cells: string): string {
  return cells.replace(CELL_TAG, (tag) =>
    tag.replace(SHARE_ATTRIBUTE, '').replace(SHARE_DECLARATION, '$1'),
  );
}

/**
 * What marks a row that must stack, and what the reader styles it by.
 *
 * A `<tr>` lays its cells out in a row and divides the width between them,
 * which is what a table is for and is wrong for what email uses a table *as*.
 * Three call-to-action cells written for a 600px column get a third of a phone
 * each, and "Microsoft Services Agreement" comes out four lines deep with a
 * word broken across two of them. A responsive template says so itself — in an
 * `@media` block this reader cannot honour — so the decision is made here
 * instead, at the only point where the cells can be counted.
 *
 * `crowded` above is the threshold, and it asks two questions rather than one:
 * how many cells, and how much text in them. `class` is the
 * carrier because it is the one channel `react-native-render-html` styles by
 * name, and the sender's own classes are dropped a few lines below before this
 * one is added — so nothing but this can arrive by it.
 */
export const STACK_CLASS = 'cm-stack';
const STACK_MARKER = `data-cm-stack="1"`;

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
