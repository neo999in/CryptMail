/**
 * Canned replies: short pieces of text the user saved to drop into a message.
 *
 * Global rather than per-account, like `mailPrefsStore`: "Thanks, I'll get
 * back to you this week" is the writer's, not a mailbox's, and a set that
 * vanished when the From account changed would be a set nobody trusts. So this
 * key is deliberately **not** in `PER_ACCOUNT_STORE_KEYS`, and removing an
 * account leaves it alone. The signature is the per-mailbox half, and lives on
 * the account ref (`accountScope.ts`).
 *
 * These are text the user wrote and will send, so they are sealed through
 * `secureJson` and listed in `SEALED_STORE_KEYS`. Inserted into a message they
 * are body text, encrypted with the rest of it.
 */
import { loadJson, saveJson } from './secureJson';

export const CANNED_REPLIES_STORE_KEY = 'cryptmail.cannedreplies.v1';

export type CannedReply = {
  id: string;
  /** What the picker calls it. Never inserted. */
  title: string;
  /** What is inserted. */
  body: string;
  updatedAt: string;
};

/** A small set: this is a picker in a sheet, not a template library. */
export const MAX_CANNED_REPLIES = 50;
export const MAX_CANNED_TITLE_LENGTH = 80;
export const MAX_CANNED_BODY_LENGTH = 5000;

/**
 * Coerce anything read off disk into a valid list.
 *
 * A malformed entry is dropped on its own rather than taking the rest with it,
 * a duplicate id keeps its first occurrence, and lengths are clamped — the same
 * one-place-decides reasoning as `normaliseMailPrefs`.
 */
export function normaliseCannedReplies(value: unknown): CannedReply[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CannedReply[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, body, updatedAt } = item as Partial<CannedReply>;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    if (typeof body !== 'string' || body.trim() === '') continue;
    seen.add(id);
    out.push({
      id,
      title: (typeof title === 'string' ? title : '').slice(0, MAX_CANNED_TITLE_LENGTH),
      body: body.slice(0, MAX_CANNED_BODY_LENGTH),
      updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date(0).toISOString(),
    });
    if (out.length === MAX_CANNED_REPLIES) break;
  }
  return out;
}

/**
 * Add or replace one reply by id (pure). A new one goes to the end, so the
 * picker keeps the order the user built it in.
 *
 * Throws with a sentence when it cannot be saved, for the editor to show.
 */
export function upsertCannedReply(replies: CannedReply[], reply: CannedReply): CannedReply[] {
  if (reply.body.trim() === '') throw new Error('A canned reply needs some text to insert.');
  if (reply.body.length > MAX_CANNED_BODY_LENGTH) {
    throw new Error(`Keep a canned reply under ${MAX_CANNED_BODY_LENGTH} characters.`);
  }
  const clean = { ...reply, title: reply.title.trim().slice(0, MAX_CANNED_TITLE_LENGTH) };
  const at = replies.findIndex((r) => r.id === reply.id);
  if (at >= 0) return replies.map((r, i) => (i === at ? clean : r));
  if (replies.length >= MAX_CANNED_REPLIES) {
    throw new Error(`You can keep up to ${MAX_CANNED_REPLIES} canned replies. Delete one to add another.`);
  }
  return [...replies, clean];
}

/** Remove one by id; a missing id is a no-op (pure). */
export function removeCannedReply(replies: CannedReply[], id: string): CannedReply[] {
  return replies.filter((r) => r.id !== id);
}

/** What a reply is called in a list: its title, else the start of its text. */
export function cannedReplyLabel(reply: Pick<CannedReply, 'title' | 'body'>): string {
  const title = reply.title.trim();
  if (title) return title;
  const first = reply.body.trim().split('\n')[0];
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

export async function loadCannedReplies(): Promise<CannedReply[]> {
  return normaliseCannedReplies(await loadJson<unknown>(CANNED_REPLIES_STORE_KEY, []));
}

export async function saveCannedReplies(replies: CannedReply[]): Promise<CannedReply[]> {
  const next = normaliseCannedReplies(replies);
  await saveJson(CANNED_REPLIES_STORE_KEY, next);
  return next;
}
