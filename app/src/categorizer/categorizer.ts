/**
 * Client-side categorization of mail — the "smart inbox" done on-device.
 *
 * The provider cannot read encrypted mail, so any Gmail-style categorization has
 * to run here, after local decrypt (features.md §0.1, "Client-side filters &
 * rules"). This module is the read-side sibling of the search index: like
 * `messageMatchesQuery`, it classifies plaintext mail on its header subject +
 * provider snippet, and encrypted mail only on the content this device has
 * already decrypted (`SearchIndex`). Encrypted mail the user has never opened has
 * no readable content, so it stays in `primary` — its ciphertext placeholder
 * subject is never inspected.
 *
 * Deliberately pure: no React, no storage, no network. Keyword tables are a
 * heuristic; spam and phishing are decided by the weighted-symbol engine in
 * `spam/` rather than by keywords, because "the word *invoice* appears" is a fine
 * reason to file something under Bills and a terrible reason to hide it.
 */
import { linkify } from '../lib/links';
import { MailSummary } from '../mail/types';
import { SearchIndex } from '../search/search';
import { classifyMessage } from '../spam/spam';
import type { SpamInput, SpamMark, SpamModel, SpamVerdict } from '../spam/spam';

export type Category = 'primary' | 'purchases' | 'bills' | 'promotions' | 'spam';

/** Every category, in the order the inbox drawer lists them. */
export const CATEGORIES: Category[] = ['primary', 'purchases', 'bills', 'promotions', 'spam'];

/** Human-readable names — shared by the drawer rows and the inbox title. */
export const CATEGORY_LABELS: Record<Category, string> = {
  primary: 'Primary',
  purchases: 'Purchases',
  bills: 'Bills',
  promotions: 'Promotions',
  spam: 'Spam',
};

// Lowercase substrings. Multi-word entries match verbatim (e.g. "payment due").
// Bills win over purchases win over promotions: a message that is both a bill and
// an ad is a bill first, and "your order" beats a "sale" mention in the same mail.
const BILL_KEYWORDS = [
  'invoice',
  'statement',
  'bill',
  'billing',
  'payment due',
  'past due',
  'amount due',
  'balance due',
  'minimum payment',
  'autopay',
  'due date',
  'e-bill',
];

const PURCHASE_KEYWORDS = [
  'order confirmation',
  'your order',
  'order #',
  'receipt',
  'purchase',
  'shipped',
  'shipping',
  'out for delivery',
  'delivered',
  'tracking number',
  'tracking',
];

const PROMOTION_KEYWORDS = [
  '% off',
  'sale',
  'discount',
  'coupon',
  'promo',
  'special offer',
  'limited time',
  'save now',
  'deal',
  'newsletter',
  'unsubscribe',
];

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

/**
 * Categorize a chunk of already-readable text (subject + body/snippet).
 *
 * Spam is checked first so a flagged message never masquerades as a bill or an
 * order; the rest is first-match by precedence, defaulting to `primary`.
 *
 * The optional second argument is a verdict already computed by the spam engine —
 * which is how a caller that has the full message (headers, links, attachments)
 * gets header- and link-based detection out of this function. Called with one
 * argument, as every existing caller does, the text is scored on its content
 * alone: still a real classification, just working from less evidence.
 */
export function categorize(text: string, verdict?: SpamVerdict | null): Category {
  if (checkIsSpam(text, verdict)) return 'spam';

  const t = text.toLowerCase();
  if (includesAny(t, BILL_KEYWORDS)) return 'bills';
  if (includesAny(t, PURCHASE_KEYWORDS)) return 'purchases';
  if (includesAny(t, PROMOTION_KEYWORDS)) return 'promotions';
  return 'primary';
}

/**
 * Whether a message belongs in the spam bucket.
 *
 * Kept as a boolean, and kept at this name, because that is what the categorizer
 * needs and what every existing caller expects — but the decision now comes from
 * `spam/spam.ts`, where it is a weighted sum of named symbols across headers,
 * content, links, attachments and the user's own corrections.
 *
 * Two ways to call it:
 *
 * - `checkIsSpam(text)` — content-only. Used where only readable text is at hand,
 *   which is the case for the `categorize(text)` overload above.
 * - `checkIsSpam(text, verdict)` — with a verdict the caller already computed from
 *   the whole message. Preferred, because headers and links are where phishing
 *   actually shows.
 *
 * Both spam and phishing-suspicious return `true`: the bucket is one bucket, and
 * the distinction between the two is surfaced by the message view rather than by
 * where the mail is filed.
 */
export function checkIsSpam(emailText: string, verdict?: SpamVerdict | null): boolean {
  if (verdict) return verdict.classification !== 'legitimate';
  const text = typeof emailText === 'string' ? emailText : '';
  if (text.trim() === '') return false;
  // No headers, so no `from` and no authentication: the engine sees content only
  // and its header rules simply do not fire. That is the correct behaviour, not a
  // degraded one — absent evidence contributes nothing either way.
  return classifyMessage({ body: text }).classification !== 'legitimate';
}

/**
 * What a caller can supply so a summary can be scored on more than its text.
 *
 * All optional. With none of it, `categorizeMessage` behaves exactly as it did
 * before the spam engine existed, plus content scoring.
 */
export type SpamContext = {
  /** The personal Bayes model. Absent or untrained means rules-only. */
  model?: SpamModel;
  /** The user's explicit marks, by message id. A mark wins over any score. */
  marks?: Record<string, SpamMark>;
  /** The signed-in address, so a lookalike of the user's own domain is visible. */
  selfAddress?: string;
  /** Anchor pairs from an HTML part, when the message has been opened. */
  links?: SpamInput['links'];
};

/**
 * The URLs written in readable prose, as link pairs.
 *
 * An anchor's *text* is what makes a link deceptive, and plain text has no
 * anchors — so each pair here is labelled with the URL itself. That is not a
 * shortcut: it is the truthful pairing, and it is what keeps the text-versus-href
 * rules silent on prose (a URL cannot misrepresent itself) while the rules that
 * read the URL's own structure — a bare IP, a lookalike domain, an embedded
 * redirect — still see it.
 *
 * `linkify` is reused rather than re-implemented because it already applies the
 * scheme rule the app depends on elsewhere: only `http(s)` is ever recognised.
 */
function linksFromText(text: string | undefined): SpamInput['links'] {
  if (!text) return undefined;
  const links = linkify(text)
    .filter((segment) => segment.url)
    .map((segment) => ({ href: segment.url as string, text: segment.url as string }));
  return links.length > 0 ? links : undefined;
}

/**
 * Categorize an inbox row, honouring the encryption boundary.
 *
 * Plaintext mail is read from its header subject + provider snippet. Encrypted
 * mail is read only from content decrypted on this device (`index`); with no such
 * content — an unopened message — there is nothing to inspect, so it stays in
 * `primary` rather than having its ciphertext placeholder classified.
 *
 * The boundary is why the spam engine is handed a *constructed* input rather than
 * a raw message: headers are cleartext and always readable, but the subject and
 * body passed in are only ever text this device already holds in the clear.
 */
export function categorizeMessage(
  summary: MailSummary,
  encrypted: boolean,
  index: SearchIndex,
  context: SpamContext = {},
): Category {
  const verdict = verdictFor(summary, encrypted, index, context);
  if (encrypted) {
    const content = index[summary.id];
    // Nothing decrypted here. Header evidence is still readable and still counts —
    // a message that fails DMARC while claiming to be a bank is suspicious whether
    // or not its body has been opened — but there is no text to keyword-match, so
    // the non-spam categories cannot apply.
    if (!content) return verdict.classification !== 'legitimate' ? 'spam' : 'primary';
    return categorize(`${content.subject} ${content.body}`, verdict);
  }
  return categorize(`${summary.subject} ${summary.snippet}`, verdict);
}

/**
 * The full verdict for one inbox row.
 *
 * Exported because the message view shows *why* something was flagged, and
 * recomputing it there from a different input would risk the banner disagreeing
 * with the bucket.
 */
export function verdictFor(
  summary: MailSummary,
  encrypted: boolean,
  index: SearchIndex,
  context: SpamContext = {},
): SpamVerdict {
  return classifyMessage(spamInputFor(summary, encrypted, index, context), {
    model: context.model,
    mark: context.marks?.[summary.id] ?? null,
  });
}

/**
 * Everything about one message that may legitimately be classified — and nothing
 * that may not.
 *
 * Split out of `verdictFor` because the same input is what the personal model
 * trains on when the user marks a message. Scoring and learning reading the same
 * function is what guarantees they respect the same encryption boundary: if the
 * body is not readable here, it is neither scored nor learned.
 */
export function spamInputFor(
  summary: MailSummary,
  encrypted: boolean,
  index: SearchIndex,
  context: SpamContext = {},
): SpamInput {
  const content = encrypted ? index[summary.id] : undefined;
  const readable = encrypted
    ? content
      ? { subject: content.subject, body: content.body }
      : // Only headers. The placeholder subject and the provider's snippet of an
        // encrypted message are ciphertext artefacts, not content, and are never
        // scored.
        { subject: undefined, body: undefined }
    : { subject: summary.subject, body: summary.snippet };

  return {
    from: summary.from,
    to: summary.to,
    subject: readable.subject,
    body: readable.body,
    // Anchor pairs from an opened message's HTML part when the caller has them;
    // otherwise the URLs visible in the readable text. Never the ciphertext.
    links: context.links ?? linksFromText(readable.body),
    headers: {
      replyTo: summary.replyTo,
      authenticationResults: summary.authenticationResults,
      listUnsubscribe: summary.listUnsubscribe,
      returnPath: summary.returnPath,
      messageId: summary.messageId,
    },
    selfAddress: context.selfAddress,
  };
}

/**
 * Tally unread messages per category — the numbers the drawer badges show.
 * Read messages are ignored; the badge is an "unread here" count.
 */
export function unreadCountsByCategory(
  items: { summary: MailSummary; encrypted: boolean }[],
  index: SearchIndex,
  context: SpamContext = {},
): Record<Category, number> {
  const counts: Record<Category, number> = { primary: 0, purchases: 0, bills: 0, promotions: 0, spam: 0 };
  for (const { summary, encrypted } of items) {
    if (!summary.unread) continue;
    counts[categorizeMessage(summary, encrypted, index, context)] += 1;
  }
  return counts;
}
