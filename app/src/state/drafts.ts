/**
 * Unsent compose drafts. Autosaved from the compose screen on a debounce.
 */
import { Draft, removeDraft, upsertDraft } from '../drafts/drafts';
import { saveDrafts } from '../store/draftsStore';
import { Ctx, DraftsService } from './contracts';

export function createDrafts(ctx: Ctx): DraftsService {
  const { store } = ctx;

  return {
    async saveDraft(draft: Draft) {
      const drafts = upsertDraft(store.get().drafts, draft);
      await saveDrafts(drafts);
      store.patch({ drafts });
    },

    async deleteDraft(id: string) {
      const drafts = removeDraft(store.get().drafts, id);
      await saveDrafts(drafts);
      store.patch({ drafts });
    },
  };
}
