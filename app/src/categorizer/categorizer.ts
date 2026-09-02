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
 * reason to file something under Bills and a terrible reason to hide it. On
 * plaintext mail the provider's own junk verdict decides too, where it has one —
 * see `providerFiledAsJunk`.
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
 * Gmail's own tab labels. `CATEGORY_PERSONAL` is the Primary tab.
 *
 * Only `CATEGORY_PROMOTIONS` maps onto a bucket of ours; the rest matter because
 * their *presence* is Google saying it classified the message and did not find it
 * promotional. Gmail has no Bills or Purchases tab, so those stay ours — that is
 * an axis the provider does not classify on, not a disagreement with it.
 */
const PROVIDER_TABS = [
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

/**
 * The label a provider puts on mail it filed as junk.
 *
 * `SPAM` is Gmail's; `JUNK` is what the IMAP and Outlook worlds call the same
 * folder, and it is here so that adding such a connector is a connector change
 * and nothing else. Matched case-insensitively for the same reason — Gmail's
 * system labels are upper case, another provider's may not be.
 */
const PROVIDER_JUNK_LABELS = ['SPAM', 'JUNK'];

/**
 * Whether the provider filed this message as junk.
 *
 * A different kind of claim from the tab labels above, and the reason it gets its
 * own function: `CATEGORY_*` is the provider's opinion about what a message is
 * *about*, while this is where the provider actually put it. The app fetches that
 * folder (`mail/types.ts`, `Mailbox`), so without this every message in it would
 * arrive with no label our code reads and land in Primary — the app would
 * un-hide, in the inbox, mail the provider had taken out of the inbox.
 */
export const providerFiledAsJunk = (labels: string[] | undefined): boolean =>
  Array.isArray(labels) &&
  labels.some((label) => typeof label === 'string' && PROVIDER_JUNK_LABELS.includes(label.toUpperCase()));

/**
 * What the provider's labels say about a message being promotional.
 *
 * `unknown` is the honest answer for a connector that supplies no labels at all,
 * and for mail that predates the tabs — it is not "no", and it must fall through
 * to our own keywords rather than silently filing everything as Primary.
 */
function providerPromotions(labels: string[] | undefined): 'yes' | 'no' | 'unknown' {
  if (!labels) return 'unknown';
  if (labels.includes('CATEGORY_PROMOTIONS')) return 'yes';
  return labels.some((label) => PROVIDER_TABS.includes(label)) ? 'no' : 'unknown';
}

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
export function categorize(text: string, verdict?: SpamVerdict | null, labels?: string[]): Category {
  if (checkIsSpam(text, verdict)) return 'spam';

  // The provider's own junk verdict, deferred to for the same reason its
  // Promotions label is: it is reached from sending-domain reputation, complaint
  // rates and bulk-send patterns that no client can see, and it is the strongest
  // single signal available on plaintext mail. It is checked here — above the
  // commercial keywords — because Gmail's junk folder is full of mail that reads
  // like a receipt ("Refund on order 408-…"), and filing that under Purchases
  // would hide the provider's warning behind a friendly bucket.
  //
  // Skipped when the verdict is `overridden`, which means the user marked this
  // message themselves. A human's "not spam" is the one thing that outranks the
  // provider; without this guard the correction would appear to do nothing.
  if (!verdict?.overridden && providerFiledAsJunk(labels)) return 'spam';

  const t = text.toLowerCase();
  // Bills and purchases first, and independent of the provider: Gmail has no tab
  // for either, so its labels carry no opinion to defer to. Bills beat purchases
  // for the same reason as before — a bill that is also an order is a bill.
  if (includesAny(t, BILL_KEYWORDS)) return 'bills';
  if (includesAny(t, PURCHASE_KEYWORDS)) return 'purchases';

  // Promotions is the one axis Gmail does classify, and it does it better than a
  // keyword list — it has the sending domain's reputation and bulk-send patterns,
  // which no client can see. So its answer wins in both directions: a labelled
  // promo is one even with no keyword in it, and a message Google tabbed as
  // Personal or Updates is not reclassified because it happens to say "deal".
  const promotional = providerPromotions(labels);
  if (promotional === 'yes') return 'promotions';
  if (promotional === 'no') return 'primary';

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
 * Categorize an inbox row.
 *
 * **Encrypted mail is never categorised.** Not from its ciphertext, and not from
 * the plaintext this device happens to hold after opening it: a bucket is a
 * statement about a message's contents, and mail the user chose to encrypt is
 * not sorted on its contents here. It stays in `primary` and stays visible.
 *
 * That holds even when the provider filed the message as junk, and it is the one
 * place this app deliberately disagrees with its provider. A `multipart/encrypted`
 * message is unusual structure with a placeholder subject and no readable text —
 * mild spam signals, every one of them an artefact of the encryption rather than
 * anything about the message — so a junk verdict on it is not evidence. Leaving
 * such a row in `primary` un-files what the provider filed, which is something
 * this client can do and the provider's own app cannot
 * (docs/gmail-api-adoption.md). Hiding a message the user needed, in the client
 * that was meant to be the one thing on their side, is the expensive way to be
 * wrong.
 *
 * The one thing that still moves it is the user's own `spam` mark — a human
 * filing a message is not the app classifying it, and the mark has to be honoured
 * or the "mark as spam" action would silently do nothing on exactly the mail this
 * product exists for.
 *
 * Plaintext mail is read from its header subject + provider snippet, scored by
 * the spam engine, and filed with the provider's own labels where it has them
 * (`summary.labels`) — its junk verdict as well as its tab. Those labels exist
 * only because the provider could read the message, which is exactly why they are
 * never consulted above.
 */
export function categorizeMessage(
  summary: MailSummary,
  encrypted: boolean,
  index: SearchIndex,
  context: SpamContext = {},
): Category {
  const verdict = verdictFor(summary, encrypted, index, context);
  // `verdictFor` returns the unscored verdict for encrypted mail unless the user
  // marked it, so this is the mark and nothing else.
  if (encrypted) return verdict.classification === 'spam' ? 'spam' : 'primary';
  return categorize(`${summary.subject} ${summary.snippet}`, verdict, summary.labels);
}

/**
 * A verdict for a message that was never scored.
 *
 * Not "we looked and found nothing" — nothing was looked at. It is the same shape
 * a rule that threw returns, for the same reason: an empty symbol list is the
 * honest report when no rule ran, and the message stays visible.
 */
const UNSCORED: SpamVerdict = {
  classification: 'legitimate',
  score: 0,
  phishingScore: 0,
  symbols: [],
  bayesApplied: false,
  bayesProbability: null,
  overridden: false,
};

/**
 * The full verdict for one inbox row.
 *
 * Exported because the message view shows *why* something was flagged, and
 * recomputing it there from a different input would risk the banner disagreeing
 * with the bucket.
 *
 * Encrypted mail is not scored at all — no content rules, no header rules, no
 * Bayes. Header evidence *is* readable on an encrypted message and the engine
 * could act on it, but a phishing banner is a verdict about a message, and this
 * app does not reach verdicts about mail it was trusted to keep sealed. An
 * explicit user mark still short-circuits to an override, which is the user's own
 * decision rather than the engine's.
 */
export function verdictFor(
  summary: MailSummary,
  encrypted: boolean,
  index: SearchIndex,
  context: SpamContext = {},
): SpamVerdict {
  const mark = context.marks?.[summary.id] ?? null;
  if (encrypted && mark === null) return UNSCORED;
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
