/**
 * The "needs attention" filter, shared by every mail list.
 *
 * Behind the bar's Filter control rather than across the top as pills, which is
 * where the reference puts a filter and where it stops competing with the tabs
 * for the same strip of screen.
 *
 * "Encrypted" is deliberately *not* an option here — it is a tab. Two controls
 * that narrow to the same set read as one setting the app half-ignores, and they
 * can be pointed at each other (an Encrypted filter under a Primary tab, or the
 * reverse) with nothing on screen explaining which won.
 *
 * It lives in `ui/` because the bar that owns the control and the bodies that
 * apply it are different components now — `screens/HomeScreen.tsx` holds the
 * state, and a second copy of `needsAttention` is how Sent would quietly
 * disagree with the inbox about what needs a decision.
 */
import { EncryptionState } from '../state/types';

export type Filter = 'all' | 'attention';

export const FILTERS: { key: Filter; label: string; hint: string }[] = [
  { key: 'all', label: 'All mail', hint: 'Everything in this mailbox' },
  { key: 'attention', label: 'Needs attention', hint: 'A key changed, or a sender has no key on file' },
];

/** A message the reader has to decide something about, not merely read. */
export function needsAttention(encryption: EncryptionState): boolean {
  return encryption.kind === 'encrypted' && (encryption.trust === 'changed' || encryption.trust === 'unknown');
}
