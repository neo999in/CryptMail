/**
 * Rich-text compose, as text operations — the pure half of features.md 0.9's
 * compose side.
 *
 * `ui/RichTextComposer.tsx` is the editor; this module is everything about its
 * output that can be decided without one. No React, no webview.
 *
 * ## Why the text survives
 *
 * A message written as rich text still leaves with a `text/plain` alternative
 * (message-format.md), and that alternative is not an afterthought: it is what
 * the search index stores, what `isDraftEmpty` reads, what the signature code
 * reasons about, and what a recipient without an HTML reader sees. So the
 * composer's HTML and the text derived from it travel together, and the text is
 * derived — never edited on its own while the HTML exists.
 *
 * ## The HTML this reads
 *
 * The editor's own output: `<p>`, `<br>`, `<strong>`, `<em>`, `<s>`,
 * `<ul>/<ol>/<li>`, `<blockquote>`, `<a href>`, `<hr>`, and `<pre>/<code>`. It
 * is written for that, and for a draft that was written by it — not as a
 * general HTML-to-text converter. Inbound mail has `mail/plainBody.ts` and
 * `html/sanitize.ts`, which are a different and much messier problem.
 *
 * Paragraph-per-line is the mapping in both directions: `textToHtml` makes each
 * line a `<p>` (an empty line an empty one, which is what the editor itself
 * writes for a blank line) and `htmlToText` makes each `<p>` a line. That is
 * what makes plain → rich → plain an identity for text with no formatting, and
 * it is why switching formatting on is free while switching it off only asks
 * when there is formatting to lose.
 */
import { signatureBlock } from '../signature/signature';

/* ------------------------------------------------------------ escaping ---- */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/* -------------------------------------------------------- text → html ---- */

/**
 * Plain text as editor HTML: a paragraph per line, and a run of `>` lines as a
 * blockquote — which is how a reply's quoted text arrives from `mail/reply.ts`,
 * and what it should look like once formatting is on.
 */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (/^>/.test(lines[i])) {
      const quoted: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) quoted.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<blockquote>${textToHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    const line = lines[i++];
    out.push(line === '' ? '<p></p>' : `<p>${escapeHtml(line)}</p>`);
  }
  return out.join('');
}

/* -------------------------------------------------------- html → text ---- */

const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre']);

/**
 * The text alternative of editor HTML.
 *
 * Lists keep their markers (`- `, `1. `), a blockquote its `> ` prefix, a rule
 * becomes `---`, and a link whose label is not its address keeps both —
 * `label <https://…>` — because a `text/plain` reader that loses the address
 * has lost the link.
 */
export function htmlToText(html: string): string {
  const lines: string[] = [];
  let line = '';
  /** Whether anything (even an empty paragraph) has opened the current line. */
  let open = false;
  let quote = 0;
  let pre = 0;
  const lists: { ordered: boolean; n: number }[] = [];
  /** The marker the next line in a list item starts with, once. */
  let marker: string | null = null;
  const links: { href: string; start: number }[] = [];

  const push = () => {
    const indent = lists.length > 0 ? '   '.repeat(lists.length - 1) : '';
    const lead = marker !== null ? indent + marker : lists.length > 0 ? indent + '   ' : '';
    marker = null;
    const text = lead + line;
    const prefix = quote > 0 ? (text === '' ? '>'.repeat(quote) : '> '.repeat(quote)) : '';
    lines.push(prefix + text);
    line = '';
    open = false;
  };
  const flush = () => {
    if (line !== '' || open) push();
  };

  const tokens = html.match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>$/.exec(token);
    if (!tag) {
      const raw = decodeEntities(token);
      if (pre === 0) {
        line += raw.replace(/\s+/g, ' ');
        continue;
      }
      const [first, ...rest] = raw.split('\n');
      line += first;
      for (const part of rest) {
        push();
        line = part;
      }
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    const attrs = tag[3];

    if (name === 'br') {
      push();
    } else if (name === 'hr') {
      flush();
      line = '---';
      push();
    } else if (BLOCKS.has(name)) {
      if (closing) {
        // `<p></p>` is a blank line the user typed, and it has to stay one.
        open = true;
        push();
        if (name === 'pre') pre = Math.max(0, pre - 1);
      } else {
        flush();
        open = true;
        if (name === 'pre') pre++;
      }
    } else if (name === 'blockquote') {
      flush();
      quote = closing ? Math.max(0, quote - 1) : quote + 1;
    } else if (name === 'ul' || name === 'ol') {
      flush();
      if (closing) lists.pop();
      else lists.push({ ordered: name === 'ol', n: startOf(attrs) });
    } else if (name === 'li') {
      flush();
      const list = lists[lists.length - 1];
      if (!closing && list) marker = list.ordered ? `${list.n++}. ` : '- ';
    } else if (name === 'a') {
      if (!closing) {
        links.push({ href: hrefOf(attrs), start: line.length });
      } else {
        const link = links.pop();
        if (link?.href) {
          const label = line.slice(link.start).trim();
          const bare = link.href.replace(/^mailto:/i, '');
          if (label !== link.href && label !== bare) line += label === '' ? link.href : ` <${link.href}>`;
        }
      }
    }
  }
  flush();

  return lines.join('\n').replace(/\s+$/, '');
}

function hrefOf(attrs: string): string {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

function startOf(attrs: string): number {
  const match = /\bstart\s*=\s*"?(\d+)/i.exec(attrs);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * Whether editor HTML carries anything plain text would not — so that turning
 * formatting off can ask only when something would actually be lost.
 */
export function hasFormatting(html: string): boolean {
  return normaliseEditorHtml(textToHtml(htmlToText(html))) !== normaliseEditorHtml(html);
}

/**
 * The editor writes `<p></p>` and `<p><br></p>` interchangeably for a blank
 * line, and trailing blank lines are not formatting.
 */
function normaliseEditorHtml(html: string): string {
  return html
    .replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '<p></p>')
    .replace(/>\s+</g, '><')
    .trim()
    .replace(/(<p><\/p>)+$/, '');
}

/**
 * `isOnlySignature` for rich text: nothing written but the seeded block.
 * Compared line by line with trailing spaces dropped, since the editor may
 * drop the separator's.
 */
export function isOnlySignatureHtml(html: string, signature: string | undefined): boolean {
  const text = htmlToText(html);
  if (text.trim() === '') return true;
  const block = signatureBlock(signature);
  if (block === '') return false;
  const lines = (s: string) => s.trim().split('\n').map((l) => l.trimEnd()).join('\n');
  return lines(text) === lines(block);
}

/* ----------------------------------------------------------- signature ---- */

/** The top-level paragraphs of editor HTML, with where each sits in the string. */
function paragraphs(html: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const re = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: htmlToText(m[0]) });
  }
  return out;
}

/**
 * `swapSignature` for a message being written as rich text.
 *
 * Same rules as the text version — only an intact block is replaced, and a
 * message with none gains one only if it is otherwise empty — but matched
 * paragraph by paragraph, since the editor is free to drop the separator's
 * trailing space when it serialises. The block's lines have to be consecutive
 * paragraphs for it to count as intact.
 */
export function swapSignatureHtml(html: string, from: string | undefined, to: string | undefined): string {
  const oldBlock = signatureBlock(from);
  const newBlock = signatureBlock(to);
  if (oldBlock === newBlock) return html;
  if (oldBlock === '') return htmlToText(html).trim() === '' ? textToHtml(newBlock) : html;

  const want = oldBlock.replace(/^\n\n/, '').split('\n').map((l) => l.trimEnd());
  const paras = paragraphs(html);
  for (let i = 0; i + want.length <= paras.length; i++) {
    const run = paras.slice(i, i + want.length);
    if (!run.every((p, k) => p.text.trimEnd() === want[k])) continue;
    // Adjacent in the markup, not merely in order — a list or quote between
    // two of them means the user rearranged it, and it is theirs now.
    if (!run.every((p, k) => k === 0 || html.slice(run[k - 1].end, p.start).trim() === '')) continue;

    let start = run[0].start;
    const end = run[run.length - 1].end;
    const replacement = newBlock === '' ? '' : textToHtml(newBlock.replace(/^\n\n/, ''));
    if (newBlock === '') {
      // The blank paragraphs the block was seeded with go with it.
      for (let k = i - 1, gone = 0; k >= 0 && gone < 2 && paras[k].text === ''; k--, gone++) {
        if (html.slice(paras[k].end, start).trim() !== '') break;
        start = paras[k].start;
      }
    }
    return html.slice(0, start) + replacement + html.slice(end);
  }
  return html;
}
