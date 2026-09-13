/**
 * Local labels — the `labels` slice of state, and its persistence.
 *
 * Every write patches the store **before** it awaits storage. Bulk labelling
 * fires several of these in the same tick, and a write that read the map, waited
 * on the disk, then patched would drop whichever change landed first.
 *
 * Nothing here reaches the provider. See `labels/labels.ts` for why that is the
 * design rather than a missing connector call.
 */
import {
  applyLabels,
  createLabel as addLabel,
  deleteLabel as removeLabel,
  LabelState,
  renameLabel as relabel,
} from '../labels/labels';
import { saveLabels } from '../store/labelsStore';
import { saveRules } from '../store/rulesStore';
import { dropLabelFromRules } from '../rules/rules';
import { Ctx, LabelsService } from './contracts';

const newLabelId = () => `lbl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createLabels(ctx: Ctx): LabelsService {
  const { store } = ctx;

  async function commit(next: LabelState): Promise<void> {
    const account = ctx.services.accounts.requireActive();
    store.patch({ labels: next });
    await saveLabels(account, next);
  }

  return {
    async createLabel(name) {
      const id = newLabelId();
      const next = addLabel(store.get().labels, name, id, new Date().toISOString());
      await commit(next);
      return next.labels[id];
    },

    async renameLabel(id, name) {
      await commit(relabel(store.get().labels, id, name));
    },

    async deleteLabel(id) {
      const account = ctx.services.accounts.requireActive();
      // The rules that filed under it lose that action in the same breath, so
      // no rule is left pointing at a label that no longer exists.
      const rules = dropLabelFromRules(store.get().rules, id);
      const labels = removeLabel(store.get().labels, id);
      store.patch({ labels, rules });
      await Promise.all([saveLabels(account, labels), saveRules(account, rules)]);
    },

    async setLabels(messageIds, change) {
      if (messageIds.length === 0) return;
      await commit(applyLabels(store.get().labels, messageIds, change));
    },
  };
}
