/**
 * Optimistic flag updates over a message list (pure).
 *
 * The UI applies these immediately for a responsive feel, then the connector
 * persists the same change against the provider. Archiving drops the message
 * from the list; read/starred are patched in place. No storage, no React.
 */
import { FlagPatch, MailSummary } from './types';

/**
 * Generic over the row type so a list carrying extra fields — the merged
 * inbox's `InboxItem`, which remembers which account each row came from —
 * keeps them instead of being widened back to a bare `MailSummary`.
 */
export function applyFlagPatch<T extends MailSummary>(messages: T[], id: string, patch: FlagPatch): T[] {
  if (patch.archived) return messages.filter((m) => m.id !== id);
  return messages.map((m) => {
    if (m.id !== id) return m;
    const next: T = { ...m };
    if (patch.unread !== undefined) next.unread = patch.unread;
    if (patch.starred !== undefined) next.starred = patch.starred;
    return next;
  });
}
