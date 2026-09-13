/**
 * Snooze service — hide a message until a chosen time.
 *
 * Manages the `snoozed` slice of app state, its persistence, and the
 * periodic wake pass that returns due messages to the inbox.
 */
import { dueSnoozed, removeSnooze, SnoozeMap, upsertSnooze } from '../snooze/snooze';
import { loadSnoozes, saveSnoozes } from '../store/snoozeStore';
import { AccountId } from '../store/accountScope';
import { Ctx, SnoozeService } from './contracts';

export function createSnooze(ctx: Ctx): SnoozeService {
  const { store } = ctx;

  async function persist(snoozes: SnoozeMap) {
    await saveSnoozes(ctx.services.accounts.requireActive(), snoozes);
    store.patch({ snoozed: snoozes });
  }

  const service: SnoozeService = {
    async loadSnoozes(account: AccountId) {
      const snoozes = await loadSnoozes(account);
      store.patch({ snoozed: snoozes });
    },

    async snoozeMessage(id: string, until: string) {
      // Snapshot the row so the Snoozed folder can still draw it once it has
      // scrolled out of the loaded inbox (`snooze/snooze.ts`). Re-snoozing a
      // message the inbox no longer holds keeps the snapshot it already had.
      const summary = store.get().messages.find((m) => m.id === id) ?? store.get().snoozed[id]?.summary;
      const snoozes = upsertSnooze(store.get().snoozed, {
        id,
        until,
        snoozedAt: new Date().toISOString(),
        ...(summary ? { summary } : {}),
      });
      await persist(snoozes);
    },

    async unsnoozeMessage(id: string) {
      const snoozes = removeSnooze(store.get().snoozed, id);
      await persist(snoozes);
    },

    async wakedue() {
      const now = new Date().toISOString();
      const due = dueSnoozed(store.get().snoozed, now);
      if (due.length === 0) return;

      let snoozes = store.get().snoozed;
      for (const item of due) {
        snoozes = removeSnooze(snoozes, item.id);
      }
      await persist(snoozes);
    },
  };

  return service;
}
