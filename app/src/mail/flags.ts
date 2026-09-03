/**
 * Optimistic flag updates over a message list (pure).
 *
 * The UI applies these immediately for a responsive feel, then the connector
 * persists the same change against the provider. Read/starred are patched in
 * place; the two moves — archiving and deleting — drop the message from the list
 * instead. No storage, no React.
 */
import { FlagPatch, MailSummary } from './types';

/**
 * Generic over the row type so a list carrying extra fields — the merged
 * inbox's `InboxItem`, which remembers which account each row came from —
 * keeps them instead of being widened back to a bare `MailSummary`.
 */
export function applyFlagPatch<T extends MailSummary>(messages: T[], id: string, patch: FlagPatch): T[] {
  // A move leaves whichever list is being patched, in both directions: deleting
  // takes the row out of the inbox, and restoring takes it out of Trash. Which
  // list gains it is not this function's business — that list refetches.
  if (patch.archived || patch.trashed !== undefined) return messages.filter((m) => m.id !== id);
  return messages.map((m) => {
    if (m.id !== id) return m;
    const next: T = { ...m };
    if (patch.unread !== undefined) next.unread = patch.unread;
    if (patch.starred !== undefined) next.starred = patch.starred;
    return next;
  });
}
