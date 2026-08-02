/**
 * Conversation threading.
 *
 * Mail is grouped by the provider's `threadId`, which travels in the clear even
 * for encrypted messages (In-Reply-To / References are metadata the provider
 * needs — see message-format.md). Subjects are *not* used as a grouping key:
 * encrypted mail all shares the placeholder subject, so subject-grouping would
 * collapse unrelated ciphertext into one thread.
 *
 * A message with no `threadId` stands alone. Pure module — no storage, no React.
 */
import { MailSummary } from '../mail/types';

export type Thread = {
  /** The threadId, or the message id for a message that belongs to no thread. */
  id: string;
  /** Messages in the thread, oldest to newest. */
  messages: MailSummary[];
  /** The most recent message — what the inbox row represents. */
  latest: MailSummary;
  count: number;
};

export function groupIntoThreads(messages: MailSummary[]): Thread[] {
  const byKey = new Map<string, MailSummary[]>();
  for (const m of messages) {
    const key = m.threadId ?? m.id;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(m);
    else byKey.set(key, [m]);
  }

  const threads: Thread[] = [];
  for (const [id, msgs] of byKey) {
    const ordered = msgs.slice().sort((a, b) => a.date.localeCompare(b.date));
    threads.push({ id, messages: ordered, latest: ordered[ordered.length - 1], count: ordered.length });
  }

  // Newest conversation first, matching the inbox's ordering.
  return threads.sort((a, b) => b.latest.date.localeCompare(a.latest.date));
}
