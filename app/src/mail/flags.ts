/**
 * Optimistic flag updates over a message list (pure).
 *
 * The UI applies these immediately for a responsive feel, then the connector
 * persists the same change against the provider. Archiving drops the message
 * from the list; read/starred are patched in place. No storage, no React.
 */
import { FlagPatch, MailSummary } from './types';

export function applyFlagPatch(messages: MailSummary[], id: string, patch: FlagPatch): MailSummary[] {
  if (patch.archived) return messages.filter((m) => m.id !== id);
  return messages.map((m) => {
    if (m.id !== id) return m;
    const next: MailSummary = { ...m };
    if (patch.unread !== undefined) next.unread = patch.unread;
    if (patch.starred !== undefined) next.starred = patch.starred;
    return next;
  });
}
