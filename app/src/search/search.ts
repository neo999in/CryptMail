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
import { utf8ByteLength } from '../lib/base64';
import { MailSummary } from '../mail/types';

/** Decrypted content the app has seen locally, for one message. */
export type DecryptedContent = { subject: string; body: string };

/**
 * One indexed message: its content, and when this device indexed it.
 *
 * `indexedAt` is what the size bound evicts by. It is optional because an index
 * written before the bound existed has no timestamps; those entries count as
 * the oldest, which is the honest reading of "we do not know when".
 */
export type IndexEntry = DecryptedContent & { indexedAt?: number };

/**
 * A local index of decrypted message content, keyed by message id.
 *
 * Prototype storage is AsyncStorage-backed JSON — the same "known debt"
 * plaintext-cache tradeoff called out for the keyring in prototype-plan.md.
 */
export type SearchIndex = Record<string, IndexEntry>;

/**
 * The most the index may hold, measured as its JSON in UTF-8.
 *
 * The number is set by where it is stored, not by taste. The index is one
 * AsyncStorage value, sealed — base64 grows it by a third — and on Android a
 * single value much past 2 MB fails to read back through SQLite's cursor
 * window. A megabyte of JSON seals to roughly 1.35 MB, which leaves room.
 * It is also a few thousand opened messages, which is what search over
 * encrypted mail is actually used for: finding something read recently.
 */
export const SEARCH_INDEX_MAX_BYTES = 1024 * 1024;

/**
 * How much of one body is indexed.
 *
 * Without it a single long message could be most of the budget and evict
 * hundreds of others. A search for a word past this point in a very long
 * message misses it; that is the trade.
 */
export const MAX_INDEXED_BODY_CHARS = 16_000;

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

/**
 * Add or replace the decrypted content for a message id (pure), keeping the
 * index inside `maxBytes`.
 *
 * The bound is applied here, on the one path that grows the index, so no caller
 * can add an entry and forget to trim — an unbounded plaintext store is exactly
 * what features.md 0.12 set out to stop.
 */
export function indexContent(
  index: SearchIndex,
  id: string,
  content: DecryptedContent,
  at: number = Date.now(),
  maxBytes: number = SEARCH_INDEX_MAX_BYTES,
): SearchIndex {
  const entry: IndexEntry = {
    subject: content.subject,
    body: content.body.slice(0, MAX_INDEXED_BODY_CHARS),
    indexedAt: at,
  };
  return boundIndex({ ...index, [id]: entry }, maxBytes);
}

/** The index's size as stored: its JSON, in UTF-8 bytes. */
export function indexBytes(index: SearchIndex): number {
  return utf8ByteLength(JSON.stringify(index));
}

/**
 * Drop the least recently indexed entries until the index fits (pure).
 *
 * Oldest first, because the index exists for finding mail read recently; an
 * entry dropped here is not lost mail, only mail that has to be opened again to
 * be searchable. Returns the same object when nothing needs to go, so a caller
 * comparing identities sees no change.
 */
export function boundIndex(index: SearchIndex, maxBytes: number = SEARCH_INDEX_MAX_BYTES): SearchIndex {
  const ids = Object.keys(index);
  // Each entry's share of the JSON: `"id":{…}` plus its comma. Measured per
  // entry so eviction can subtract, rather than re-serialising after each drop.
  const sizes = new Map(ids.map((id) => [id, utf8ByteLength(JSON.stringify(id) + JSON.stringify(index[id])) + 2]));
  let total = 2;
  for (const size of sizes.values()) total += size;
  if (total <= maxBytes) return index;

  const oldestFirst = [...ids].sort((a, b) => (index[a].indexedAt ?? 0) - (index[b].indexedAt ?? 0));
  const next = { ...index };
  for (const id of oldestFirst) {
    if (total <= maxBytes) break;
    delete next[id];
    total -= sizes.get(id) ?? 0;
  }
  return next;
}
