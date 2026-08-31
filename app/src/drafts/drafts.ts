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
import { Attachment } from '../mail/attachment';

/** The editable content of a draft. */
export type DraftFields = {
  to: string[];
  subject: string;
  body: string;
  /**
   * Files picked for this message, base64 in memory and in storage.
   *
   * Held here so leaving compose does not silently drop them — a draft that
   * loses its attachment is worse than one that was never saved, because the
   * user has no way to tell. Capped by `mail/attachment.ts`, which is what
   * keeps a draft from growing past what AsyncStorage will take.
   */
  attachments?: Attachment[];
  /**
   * Names of files that were attached but *not* stored with this draft.
   *
   * A draft is sealed JSON in AsyncStorage and cannot hold tens of megabytes
   * (`MAX_STORED_ATTACHMENT_BYTES`), so a large file lives only in the compose
   * session. Recording the name means resuming the draft can say which file to
   * re-attach, instead of the file simply not being there.
   */
  attachmentsOmitted?: string[];
  /** Threading for a reply draft, so resuming it still lands in the conversation. */
  inReplyTo?: string;
  references?: string[];
};

/** A stored draft: content plus identity and last-edited time. */
export type Draft = DraftFields & { id: string; updatedAt: string };

/** All drafts, keyed by id. */
export type Drafts = Record<string, Draft>;

/** A draft with no recipients, text or files is not worth keeping. */
export function isDraftEmpty(fields: DraftFields): boolean {
  return (
    fields.to.length === 0 &&
    fields.subject.trim() === '' &&
    fields.body.trim() === '' &&
    (fields.attachments ?? []).length === 0
  );
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
