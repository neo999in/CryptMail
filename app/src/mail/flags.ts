/**
 * Optimistic flag updates over a message list (pure).
 *
 * The UI applies these immediately for a responsive feel, then the connector
 * persists the same change against the provider. Read/starred are patched in
 * place; the two moves — archiving and deleting — drop the message from the list
 * instead. Junk is a move on the server but a relabel here: see `refiled`. No
 * storage, no React.
 */
import { FlagPatch, MailSummary } from './types';

/** What a provider calls its inbox and its junk folder, in either connector. */
const FILING = ['INBOX', 'SPAM', 'JUNK'];

/**
 * A row's labels after a junk move: the junk label on and the inbox off, or the
 * reverse. Everything else it carried is kept.
 *
 * Relabelled rather than dropped because the inbox and the provider's junk
 * folder are one list in this app (`state/mailbox.ts`, `collectInbox`) — Spam is
 * a category over it, and the label is what files the row there.
 */
function refiled(labels: string[] | undefined, junk: boolean): string[] {
  const kept = (labels ?? []).filter((label) => !FILING.includes(label.toUpperCase()));
  return [...kept, junk ? 'SPAM' : 'INBOX'];
}

/**
 * Generic over the row type so a list carrying extra fields — the merged
 * inbox's `InboxItem`, which remembers which account each row came from —
 * keeps them instead of being widened back to a bare `MailSummary`.
 */
export function applyFlagPatch<T extends MailSummary>(messages: T[], id: string, patch: FlagPatch): T[] {
  // A move leaves whichever list is being patched, in all four directions:
  // archiving takes the row out of the inbox and un-archiving takes it out of
  // Archive; deleting takes it out of wherever it was and restoring takes it out
  // of Trash. Which list gains it is not this function's business — that list
  // refetches.
  if (patch.archived !== undefined || patch.trashed !== undefined) {
    return messages.filter((m) => m.id !== id);
  }
  return messages.map((m) => {
    if (m.id !== id) return m;
    const next: T = { ...m };
    if (patch.unread !== undefined) next.unread = patch.unread;
    if (patch.starred !== undefined) next.starred = patch.starred;
    if (patch.junk !== undefined) next.labels = refiled(m.labels, patch.junk);
    return next;
  });
}
