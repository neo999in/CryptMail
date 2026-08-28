/**
 * Compose drafts.
 *
 * A draft is an in-progress message the user hasn't sent yet. This module is the
 * pure core — types + reducers, no storage, no React. Persistence lives in
 * store/draftsStore.ts and the lifecycle (autosave, resume, delete-on-send) is
 * driven from state/AppState.tsx and the compose screen.
 *
 * Prototype storage is AsyncStorage-backed JSON, so drafts sit as plaintext at
 * rest — the same "known debt" as the keyring and search index (prototype-plan.md).
 * A real client would encrypt drafts to the user's own key / SQLCipher.
 */

/** The editable content of a draft. */
export type DraftFields = {
  to: string[];
  subject: string;
  body: string;
  /** Threading for a reply draft, so resuming it still lands in the conversation. */
  inReplyTo?: string;
  references?: string[];
};

/** A stored draft: content plus identity and last-edited time. */
export type Draft = DraftFields & { id: string; updatedAt: string };

/** All drafts, keyed by id. */
export type Drafts = Record<string, Draft>;

/** A draft with no recipients and no subject or body is not worth keeping. */
export function isDraftEmpty(fields: DraftFields): boolean {
  return fields.to.length === 0 && fields.subject.trim() === '' && fields.body.trim() === '';
}

/** Add or replace a draft by id (pure). */
export function upsertDraft(drafts: Drafts, draft: Draft): Drafts {
  return { ...drafts, [draft.id]: draft };
}

/** Remove a draft by id; a missing id is a no-op (pure). */
export function removeDraft(drafts: Drafts, id: string): Drafts {
  const next = { ...drafts };
  delete next[id];
  return next;
}

/** Drafts newest-edited first, for the drafts list. */
export function listDrafts(drafts: Drafts): Draft[] {
  return Object.values(drafts).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
