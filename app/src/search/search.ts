/**
 * Client-side search over mail — including encrypted mail.
 *
 * The inbox provider only ever hands us ciphertext for encrypted messages, so
 * their real subject and body cannot be searched from headers. Instead we keep a
 * local index of content the app has already decrypted on this device, and
 * search that. Encrypted mail the user has never opened has no searchable
 * content — only its sender.
 *
 * This module is deliberately pure (no storage, no React): persistence lives in
 * store/searchIndex.ts, wiring lives in state/AppState.tsx.
 */
import { MailSummary } from '../mail/types';

/** Decrypted content the app has seen locally, for one message. */
export type DecryptedContent = { subject: string; body: string };

/**
 * A local index of decrypted message content, keyed by message id.
 *
 * Prototype storage is AsyncStorage-backed JSON — the same "known debt"
 * plaintext-cache tradeoff called out for the keyring in prototype-plan.md.
 */
export type SearchIndex = Record<string, DecryptedContent>;

/**
 * Does an inbox row match the search query?
 *
 * Sender name and address are always searchable. Plaintext mail is additionally
 * matched on its header subject and provider snippet. Encrypted mail is matched
 * on the decrypted subject/body from `index` when the message has been opened —
 * never on the ciphertext placeholder subject.
 */
export function messageMatchesQuery(
  summary: MailSummary,
  encrypted: boolean,
  index: SearchIndex,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const parts: string[] = [summary.from.name ?? '', summary.from.address];
  if (encrypted) {
    const content = index[summary.id];
    if (content) parts.push(content.subject, content.body);
  } else {
    parts.push(summary.subject, summary.snippet);
  }

  return parts.join(' ').toLowerCase().includes(needle);
}

/**
 * Does a piece of local, already-plaintext content match the query?
 *
 * For the lists that are not provider mail — drafts and the outbox. They hold
 * what the user typed, so there is no index to consult and no ciphertext to
 * avoid: the fields are simply searched. Same trimmed, case-insensitive,
 * substring rule as `messageMatchesQuery`, so one search box behaves the same
 * whichever destination it is over.
 */
export function textMatchesQuery(fields: (string | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.filter(Boolean).join(' ').toLowerCase().includes(needle);
}

/** Add or replace the decrypted content for a message id (pure). */
export function indexContent(index: SearchIndex, id: string, content: DecryptedContent): SearchIndex {
  return { ...index, [id]: content };
}
