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
 *  3. `react-native-render-html`'s transient render engine applies its own
 *     safe property allowlist when it parses what survives into RN styles —
 *     `position: fixed`, `z-index`, `pointer-events` and friends are dropped a
 *     second time, independently of what is allowed here. `exclusiveFilter`
 *     below is the same idea applied a little earlier.
 *
 * The one auditable contract is the exported `sanitizeConfig` — review that
 * object, not the library.
 */
import sanitize from 'sanitize-html';

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
      'font-family': [/^\s*[A-Za-z0-9 '"(),-]+\s*$/],
      'font-size': [LENGTH],
      'font-weight': [FONT_WEIGHT],
      'font-style': [FONT_STYLE],
      'line-height': [/^\s*(normal|[0-9.]+(?:px|em|rem|%)?)\s*$/],
      'text-align': [TEXT_ALIGN],
      'text-decoration': [TEXT_DECORATION],
      'text-transform': [/^\s*(none|uppercase|lowercase|capitalize)\s*$/],
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
  // A positioning or pointer-capture declaration excludes its element **whole**,
  // rather than rendering it at a layer the reader did not intend (the classic
  // fixed-overlay spam trick). sanitize-html calls this on the *raw* style,
  // before allowedStyles filters it, so the regex anchors to declaration
  // boundaries: `position:` at the start or after a `;`, never `-position:`
  // inside an innocent compound like `background-position`.
  exclusiveFilter: (frame) =>
    frame.tag !== 'style' &&
    /(?:^|;)\s*(position|z-index|pointer-events)\s*:/i.test(frame.attribs.style ?? ''),
};

/**
 * Sanitise a raw HTML string against the allowlist above.
 *
 * Never throws on malformed markup; `sanitize-html` rebuilds what it can parse
 * and drops the rest.
 */
export function sanitizeHtml(html: string): string {
  return sanitize(html, sanitizeConfig);
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
 * The one entry point the reader uses: resolve theme CSS variables first, then
 * apply the allowlist.
 */
export function sanitizePipeline(html: string, vars?: Record<string, string>): string {
  const resolved = vars ? resolveCssVars(html, vars) : html;
  return sanitizeHtml(resolved);
}
