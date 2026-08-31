/**
 * Snooze service — hide a message until a chosen time.
 *
 * Manages the `snoozed` slice of app state, its persistence, and the
 * periodic wake pass that returns due messages to the inbox.
 */
import { dueSnoozed, removeSnooze, SnoozeMap, upsertSnooze } from '../snooze/snooze';
import { loadSnoozes, saveSnoozes } from '../store/snoozeStore';
import { Ctx, SnoozeService } from './contracts';

export function createSnooze(ctx: Ctx): SnoozeService {
  const { store } = ctx;

  async function persist(snoozes: SnoozeMap) {
    await saveSnoozes(snoozes);
    store.patch({ snoozed: snoozes });
  }

  const service: SnoozeService = {
    async loadSnoozes() {
      const snoozes = await loadSnoozes();
      store.patch({ snoozed: snoozes });
    },

    async snoozeMessage(id: string, until: string) {
      const snoozes = upsertSnooze(store.get().snoozed, {
        id,
        until,
        snoozedAt: new Date().toISOString(),
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
