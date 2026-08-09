/**
 * URLs inside a message body, and the parts of one worth showing a human.
 *
 * A message body is rendered as text, not HTML — there is no markup to carry a
 * link, so the only thing that can make a URL tappable is finding it in the
 * prose. That is a parsing job, and where it stops is a security decision rather
 * than a feature decision:
 *
 * **Only `http://` and `https://` are ever linkified.** Nothing else — no bare
 * `www.`, no `mailto:`, and above all no `javascript:`, `data:` or `file:`. Mail
 * is attacker-supplied text, and a scheme that executes or reads local state is
 * the one thing that must never become a thing the reader can tap by accident.
 * Excluding bare `www.` is the same rule seen from the other side: it would mean
 * *inventing* a scheme for text the sender never wrote one for.
 *
 * The other half of the design lives in the screen: a tap opens a confirmation
 * sheet showing the host, not the browser. Detection here is deliberately
 * generous about what counts as a link, because nothing is opened without the
 * reader seeing where it goes first.
 */

/**
 * A run of body text, and the URL it links to if it is one.
 *
 * `text` is always what to display; a segment with a `url` displays the URL
 * itself, so the destination is on screen before anything is tapped. Rendering
 * a different label than the target is how a link lies about where it goes.
 */
export type Segment = { text: string; url?: string };

/**
 * Everything up to the first character that cannot appear in a URL in running
 * text. Angle brackets and quotes end a URL because prose wraps them around one
 * (`<https://…>`); the trailing punctuation of a sentence is stripped after.
 */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`\\]+/gi;

/**
 * Sentence punctuation that follows a URL far more often than it belongs to one:
 * `see https://example.com/a.` ends a sentence, it does not fetch `a.`.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** Closing brackets, and the opener that would justify keeping one. */
const BRACKET_PAIRS: [open: string, close: string][] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
];

/**
 * Drop the punctuation that ended the sentence rather than the URL.
 *
 * A closing bracket is kept only when the URL opened one itself — Wikipedia
 * addresses really do end in `)` — so `(see https://example.com/a)` loses the
 * bracket while `https://en.wikipedia.org/wiki/Ruby_(gem)` keeps it.
 */
function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const before = out;
    out = out.replace(TRAILING_PUNCTUATION, '');
    for (const [open, close] of BRACKET_PAIRS) {
      while (out.endsWith(close) && countOf(out, close) > countOf(out, open)) {
        out = out.slice(0, -1);
      }
    }
    if (out === before) return out;
  }
}

const countOf = (text: string, char: string) => text.split(char).length - 1;

/** The scheme, host and path of a URL, or null if it has no usable host. */
function parts(url: string): { scheme: string; host: string; path: string } | null {
  const match = /^(https?):\/\/(.*)$/i.exec(url);
  if (!match) return null;
  const rest = match[2];
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const path = cut === -1 ? '' : rest.slice(cut);

  // Everything before the last `@` is userinfo, which is *not* the host:
  // `https://keys.openpgp.org@evil.example/verify/x` is a request to
  // `evil.example`. Reading the host as the text after the scheme is the classic
  // way a host check is defeated, so the split happens here, once, rather than
  // in each caller.
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const host = hostPort.replace(/:\d+$/, '').toLowerCase();
  if (!host) return null;

  return { scheme: match[1].toLowerCase(), host, path };
}

/** The host a URL actually resolves to, lowercased, without userinfo or port. */
export function hostOf(url: string): string | null {
  return parts(url)?.host ?? null;
}

/** The path of a URL, including any query and fragment. `''` when it has none. */
export function pathOf(url: string): string | null {
  const parsed = parts(url);
  return parsed ? parsed.path : null;
}

/**
 * Split body text into displayable runs, with the http(s) URLs marked.
 *
 * The segments concatenate back to the original text exactly, so a caller that
 * renders every `text` in order shows the message unchanged.
 */
export function linkify(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  const scan = new RegExp(URL_IN_TEXT.source, 'gi');
  for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
    const start = match.index;
    // `seehttps://x.example` is not a link the sender wrote; a scheme has to
    // begin a word. Without this, any word ending in "http" swallows what
    // follows it.
    if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) continue;

    const url = trimTrailing(match[0]);
    if (!hostOf(url)) continue;

    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ text: url, url });
    cursor = start + url.length;
    // The trimmed punctuation belongs to the prose, so scanning resumes there
    // rather than at the end of the raw match.
    scan.lastIndex = cursor;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
