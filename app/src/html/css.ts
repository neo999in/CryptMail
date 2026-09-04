/**
 * `<style>` blocks, turned into inline styles before anything is sanitised.
 *
 * Real HTML email is styled by classes in a `<head><style>` block, not by
 * `style=` on every tag — so a reader that only honours inline styles shows a
 * newsletter's structure with none of its design. But a stylesheet is also the
 * wrong thing to hand a renderer: it can name selectors the sanitizer never
 * sees, and it is the classic place to hide a remote fetch.
 *
 * So this module does not *apply* CSS. It reads the declarations out of the
 * style blocks and hands them to `sanitize.ts`, which merges them onto the
 * matching element's own `style` attribute. Every declaration therefore lands
 * in the one place already audited — `allowedStyles` — and a property or value
 * that would be rejected inline is rejected here too, by the same regexes.
 * `<style>` itself is still dropped, tag and contents both.
 *
 * ## What is deliberately not supported
 *
 * Tag, `.class` and `#id` selectors, and comma-separated groups of them. Not
 * descendant or child combinators, not pseudo-classes, not attribute selectors:
 * the merge happens per element as the sanitizer walks it, with no ancestor
 * context to match against. `@media` and `@import` are skipped whole — the
 * first because a rule that depends on viewport is not a rule this renderer can
 * honour, the second because it is a network fetch wearing a stylesheet's
 * clothes.
 */

/** Declarations by selector name, in source order, per selector kind. */
export type CssRules = {
  tags: Map<string, string>;
  classes: Map<string, string>;
  ids: Map<string, string>;
};

export function emptyRules(): CssRules {
  return { tags: new Map(), classes: new Map(), ids: new Map() };
}

/** Nothing in here is worth scanning past this much markup. */
const MAX_CSS = 200_000;

/** A `<style …>…</style>` block. Bounded, and it never spans two blocks. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]{0,50000}?)<\/style\s*>/gi;

/** `selector, selector { declarations }` — one rule. */
const RULE = /([^{}]{1,2000})\{([^{}]{0,5000})\}/g;

/** A comment, or an at-rule and whatever block belongs to it. */
const COMMENTS = /\/\*[\s\S]*?\*\//g;
const AT_RULE_BLOCK = /@[a-zA-Z-]+[^{;]{0,500}\{(?:[^{}]|\{[^{}]*\})*\}/g;
const AT_RULE_STATEMENT = /@[a-zA-Z-]+[^;{]{0,500};/g;

/**
 * Every declaration block in a message's `<style>` blocks, by selector.
 *
 * A selector seen twice is merged rather than replaced, later winning on
 * conflict — which is what a browser's cascade does for equal specificity, and
 * is why the values are concatenated in source order.
 */
export function extractRules(html: string): CssRules {
  const rules = emptyRules();
  if (html.length > MAX_CSS * 4) return rules;

  let css = '';
  for (const block of html.matchAll(STYLE_BLOCK)) {
    css += `${block[1]}\n`;
    if (css.length > MAX_CSS) break;
  }
  if (css === '') return rules;

  css = css
    .replace(COMMENTS, ' ')
    // Order matters: the block form first, so `@media { … }` goes whole rather
    // than leaving its inner rules behind as though they were unconditional.
    .replace(AT_RULE_BLOCK, ' ')
    .replace(AT_RULE_STATEMENT, ' ');

  for (const rule of css.matchAll(RULE)) {
    const declarations = rule[2].trim();
    if (declarations === '') continue;

    for (const selector of rule[1].split(',')) {
      const trimmed = selector.trim();
      if (trimmed === '') continue;

      const target = bucketFor(trimmed, rules);
      if (!target) continue;

      const [map, name] = target;
      const existing = map.get(name);
      map.set(name, existing ? `${existing};${declarations}` : declarations);
    }
  }
  return rules;
}

/** Which map a selector belongs in, or null when it is a shape we don't match. */
function bucketFor(selector: string, rules: CssRules): [Map<string, string>, string] | null {
  if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(selector)) {
    return [rules.tags, selector.toLowerCase()];
  }
  if (/^\.[a-zA-Z_][\w-]*$/.test(selector)) {
    return [rules.classes, selector.slice(1)];
  }
  if (/^#[a-zA-Z_][\w-]*$/.test(selector)) {
    return [rules.ids, selector.slice(1)];
  }
  return null;
}

/**
 * The style attribute one element should carry, stylesheet merged under its own.
 *
 * Cascade order, weakest first: tag, then class, then id, then whatever the
 * element already had inline. Inline last is the whole point — a sender who
 * wrote `style=` on the element meant it to win, and CSS says so too.
 *
 * `!important` is stripped rather than honoured. Honouring it would mean
 * re-ordering the merge per declaration, and the one thing it is used for in
 * email — beating a client's own stylesheet — does not apply to a renderer that
 * has no stylesheet of its own.
 */
export function mergeDeclarations(
  tag: string,
  attribs: Record<string, string>,
  rules: CssRules,
): string | undefined {
  const parts: string[] = [];

  const tagRule = rules.tags.get(tag.toLowerCase());
  if (tagRule) parts.push(tagRule);

  if (attribs.class) {
    for (const name of attribs.class.trim().split(/\s+/)) {
      const classRule = rules.classes.get(name);
      if (classRule) parts.push(classRule);
    }
  }

  if (attribs.id) {
    const idRule = rules.ids.get(attribs.id.trim());
    if (idRule) parts.push(idRule);
  }

  if (attribs.style) parts.push(attribs.style);
  if (parts.length === 0) return undefined;

  return parts
    .join(';')
    .replace(/!\s*important/gi, '')
    .replace(/;{2,}/g, ';')
    .replace(/^;|;$/g, '')
    .trim();
}
