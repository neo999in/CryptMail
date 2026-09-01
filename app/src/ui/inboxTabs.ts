/**
 * The `Primary | Encrypted` split behind the inbox's top tabs.
 *
 * A pure predicate, so the tab logic is testable without rendering a screen —
 * which is why it is here rather than inline in `InboxScreen`.
 *
 * **These two tabs are a lens, not a partition**, and that is the difference
 * from the `Focused | Other` pair they replace. Focused and Other divided the
 * mail between them; Primary is the whole list and Encrypted is a subset of it,
 * so a protected message appears under both. That is the honest shape for this
 * product: encryption is a property of a message, not a folder it lives in, and
 * a tab that *moved* encrypted mail out of the main list would hide it from the
 * list people actually read.
 *
 * Two things it deliberately does not do:
 *
 *  - It never reads a message. `encrypted` comes from `encryptionFor()`, which
 *    is headers-only — no network, no decryption — and the categorizer already
 *    honours the same boundary (unopened encrypted mail classifies as `primary`
 *    from headers alone, never from its ciphertext).
 *  - It does not hide spam under either tab. Junk is its own destination in the
 *    drawer; a tab that quietly mixed suspected phishing into a list people skim
 *    would undo the point of detecting it.
 */
import { Category } from '../categorizer/categorizer';

export type InboxTab = 'primary' | 'encrypted';

export const INBOX_TABS: { key: InboxTab; label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'encrypted', label: 'Encrypted' },
];

/**
 * Whether a message shows under the given tab.
 *
 * `Primary` is everything the mailbox holds except junk — nothing is stranded
 * behind a tab the user has to guess at. `Encrypted` narrows that to mail that
 * arrived protected, whatever the categorizer made of it.
 */
export function showsUnderTab(category: Category, encrypted: boolean, tab: InboxTab): boolean {
  if (category === 'spam') return false;
  return tab === 'encrypted' ? encrypted : true;
}
