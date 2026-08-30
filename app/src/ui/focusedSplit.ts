/**
 * The Focused / Other split behind the inbox's top tabs.
 *
 * A pure mapping from the on-device categorizer's verdict onto the two tabs, so
 * the tab logic is testable without rendering a screen — which is why it is here
 * rather than inline in `InboxScreen`.
 *
 * Two things it deliberately does *not* do:
 *
 *  - It never reads a message. The categorizer already honours the encryption
 *    boundary (unopened encrypted mail classifies as `primary` from headers
 *    alone, never from its ciphertext), and this only re-buckets that verdict.
 *  - It does not hide spam in `Other`. Junk is its own destination in the
 *    drawer; a tab that quietly mixed suspected phishing into a list people
 *    skim would undo the point of detecting it.
 */
import { Category } from '../categorizer/categorizer';

export type InboxTab = 'focused' | 'other';

export const INBOX_TABS: { key: InboxTab; label: string }[] = [
  { key: 'focused', label: 'Focused' },
  { key: 'other', label: 'Other' },
];

/**
 * Which tab a category belongs to, or `null` for mail that belongs to neither
 * and is reachable only from its own destination.
 *
 * Mail you are expected to *act* on is Focused: correspondence and bills. Mail
 * that is merely addressed to you is Other: receipts and marketing.
 */
export function tabForCategory(category: Category): InboxTab | null {
  switch (category) {
    case 'primary':
    case 'bills':
      return 'focused';
    case 'purchases':
    case 'promotions':
      return 'other';
    case 'spam':
      return null;
  }
}

/** Whether a message of this category shows under the given tab. */
export function showsUnderTab(category: Category, tab: InboxTab): boolean {
  return tabForCategory(category) === tab;
}
