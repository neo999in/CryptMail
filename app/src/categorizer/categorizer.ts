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
 * heuristic, and `checkIsSpam` is a stub the spam team fills in later.
 */
import { MailSummary } from '../mail/types';
import { SearchIndex } from '../search/search';

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
 */
export function categorize(text: string): Category {
  if (checkIsSpam(text)) return 'spam';

  const t = text.toLowerCase();
  if (includesAny(t, BILL_KEYWORDS)) return 'bills';
  if (includesAny(t, PURCHASE_KEYWORDS)) return 'purchases';
  if (includesAny(t, PROMOTION_KEYWORDS)) return 'promotions';
  return 'primary';
}

export function checkIsSpam(emailText: string): boolean {
  return false; // Stub to be implemented by spam team
}

/**
 * Categorize an inbox row, honouring the encryption boundary.
 *
 * Plaintext mail is read from its header subject + provider snippet. Encrypted
 * mail is read only from content decrypted on this device (`index`); with no such
 * content — an unopened message — there is nothing to inspect, so it stays in
 * `primary` rather than having its ciphertext placeholder classified.
 */
export function categorizeMessage(summary: MailSummary, encrypted: boolean, index: SearchIndex): Category {
  if (encrypted) {
    const content = index[summary.id];
    if (!content) return 'primary';
    return categorize(`${content.subject} ${content.body}`);
  }
  return categorize(`${summary.subject} ${summary.snippet}`);
}

/**
 * Tally unread messages per category — the numbers the drawer badges show.
 * Read messages are ignored; the badge is an "unread here" count.
 */
export function unreadCountsByCategory(
  items: { summary: MailSummary; encrypted: boolean }[],
  index: SearchIndex,
): Record<Category, number> {
  const counts: Record<Category, number> = { primary: 0, purchases: 0, bills: 0, promotions: 0, spam: 0 };
  for (const { summary, encrypted } of items) {
    if (!summary.unread) continue;
    counts[categorizeMessage(summary, encrypted, index)] += 1;
  }
  return counts;
}
