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
 * Simple selectors and compounds of them: `p`, `.lead`, `#hero`, `p.lead`,
 * `.a.b`, and comma-separated groups. Not descendant or child combinators, not
 * pseudo-classes, not attribute selectors — the merge happens per element as
 * the sanitizer walks it, with no ancestor context to match against, so a
 * `.card h1` cannot be evaluated here at all. `@media` and `@import` are
 * skipped whole: the first because a rule that depends on viewport is not one
 * this renderer can honour, the second because it is a network fetch wearing a
 * stylesheet's clothes.
 */

/**
 * A selector that names more than one thing at once: `p.lead`, `.a.b`,
 * `td#total.wide`. Every part has to match the same element.
 */
type Compound = {
  tag: string | null;
  classes: string[];
  id: string | null;
  declarations: string;
};

/** Declarations by selector name, in source order, per selector kind. */
export type CssRules = {
  tags: Map<string, string>;
  classes: Map<string, string>;
  ids: Map<string, string>;
  /** Kept in source order: they are more specific than any single map above. */
  compounds: Compound[];
};

export function emptyRules(): CssRules {
  return { tags: new Map(), classes: new Map(), ids: new Map(), compounds: [] };
}

/** Nothing in here is worth scanning past this much markup. */
const MAX_CSS = 200_000;

/** A `<style …>…</style>` block. Bounded, and it never spans two blocks. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]{0,50000}?)<\/style\s*>/gi;

/** `selector, selector { declarations }` — one rule. */
const RULE = /([^{}]{1,2000})\{([^{}]{0,5000})\}/g;

/** A CSS comment. */
const COMMENTS = /\/\*[\s\S]*?\*\//g;

/**
 * The `<!-- -->` a stylesheet is still wrapped in.
 *
 * It hid the CSS from browsers that predate the `<style>` tag, which is not a
 * concern anyone has had for twenty-five years — and Word writes it on every
 * message it generates all the same, as do most template generators of that
 * lineage. The markers are not CSS, so the first selector in the block arrives
 * with `<!--` glued to the front of it, matches no shape this module knows, and
 * is dropped along with its declarations. In Word's output that first rule is
 * `p.MsoNormal, li.MsoNormal, div.MsoNormal` — the body font, size and
 * spacing — so an Outlook message lost its typography while every later rule
 * applied, which reads as a selector bug and is a two-character one.
 *
 * Deleted rather than treated as a comment: these do not delimit a region, they
 * bracket the whole sheet, and the CSS between them is meant to be read.
 */
const CDO_CDC = /<!--|-->/g;

/** An at-rule and whatever block belongs to it. */
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
    .replace(CDO_CDC, ' ')
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
      if (target) {
        const [map, name] = target;
        const existing = map.get(name);
        map.set(name, existing ? `${existing};${declarations}` : declarations);
        continue;
      }

      const compound = parseCompound(trimmed);
      if (compound) rules.compounds.push({ ...compound, declarations });
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

/** Every part of a compound selector, or null if it is a shape we cannot match. */
function parseCompound(selector: string): Omit<Compound, 'declarations'> | null {
  // One optional tag, then any number of .class and #id parts, and nothing
  // else — a space or a `>` means an ancestor is involved and we are out.
  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:[.#][a-zA-Z_][\w-]*)+$|^(?:[.#][a-zA-Z_][\w-]*){2,}$/.test(selector)) {
    return null;
  }

  const tagMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(selector);
  const tag = tagMatch ? tagMatch[0].toLowerCase() : null;
  const classes: string[] = [];
  let id: string | null = null;

  for (const part of selector.slice(tag ? tag.length : 0).match(/[.#][a-zA-Z_][\w-]*/g) ?? []) {
    if (part[0] === '.') classes.push(part.slice(1));
    else id = part.slice(1);
  }
  return { tag, classes, id };
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

  const elementId = attribs.id?.trim();
  if (elementId) {
    const idRule = rules.ids.get(elementId);
    if (idRule) parts.push(idRule);
  }

  // Compounds last of the stylesheet rules, because naming more things about
  // an element is what specificity means.
  if (rules.compounds.length > 0) {
    const own = new Set(attribs.class ? attribs.class.trim().split(/\s+/) : []);
    for (const rule of rules.compounds) {
      if (rule.tag && rule.tag !== tag.toLowerCase()) continue;
      if (rule.id && rule.id !== elementId) continue;
      if (!rule.classes.every((name) => own.has(name))) continue;
      parts.push(rule.declarations);
    }
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
