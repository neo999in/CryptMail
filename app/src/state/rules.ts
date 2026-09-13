/**
 * Filters & rules — the `rules` slice of state, and running them.
 *
 * Rules act on **the inbox of the account in front**. They are that account's
 * store, their `fired` record is that account's message ids, and a merged
 * inbox's rows from another mailbox wait until it is the one in front — the
 * same line snoozes and spam marks draw.
 *
 * They run at two moments, which between them cover every way content becomes
 * readable on this device:
 *
 * - after an inbox sync (and a page of older mail), over every row — the
 *   sender of any message, and the subject of any plaintext one, is readable
 *   from the list alone;
 * - after `openMessage` decrypts and indexes a message — the first moment a
 *   rule on an encrypted message's subject or body *can* match.
 *
 * Every flag change goes through `mailbox.setFlags`, the path a tap takes, so a
 * rule's archive is the reader's archive: optimistic, sent to the provider the
 * row came from, and re-fetched if the provider refuses.
 */
import { providerFiledAsJunk } from '../categorizer/categorizer';
import { PLACEHOLDER_SUBJECT } from '../core';
import { applyLabels } from '../labels/labels';
import { MailSummary } from '../mail/types';
import {
  applyRules,
  pruneFired,
  removeRule,
  Rule,
  ruleProblem,
  RulesState,
  upsertRule,
} from '../rules/rules';
import { saveLabels } from '../store/labelsStore';
import { saveRules } from '../store/rulesStore';
import { Ctx, RulesService } from './contracts';
import { InboxItem } from './types';

const newRuleId = () => `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createRules(ctx: Ctx): RulesService {
  const { store } = ctx;

  async function commit(next: RulesState): Promise<void> {
    const account = ctx.services.accounts.requireActive();
    store.patch({ rules: next });
    await saveRules(account, next);
  }

  const service: RulesService = {
    async saveRule(draft) {
      const problem = ruleProblem(draft);
      if (problem) throw new Error(problem);
      const existing = draft.id ? store.get().rules.rules.find((r) => r.id === draft.id) : undefined;
      const rule: Rule = {
        ...draft,
        id: existing?.id ?? newRuleId(),
        name: draft.name.trim(),
        conditions: draft.conditions.map((c) => ({ field: c.field, contains: c.contains.trim() })),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await commit(upsertRule(store.get().rules, rule));
      // A rule the user just wrote should not wait for the next sync to prove
      // it works. It runs over what is already on screen, once.
      await service.runRules();
      return rule;
    },

    async deleteRule(id) {
      await commit(removeRule(store.get().rules, id));
    },

    async runRules(rows) {
      try {
        await run(rows);
      } catch {
        // Only storage can throw here — every flag change is `setFlags`, which
        // handles its own failures. The store was patched before the write, so
        // this session will not fire the rules again; a restart may, once.
      }
    },
  };

  async function run(rows?: MailSummary[]): Promise<void> {
    const state = store.get();
    const account = state.activeAccount;
    if (!account || state.rules.rules.length === 0) return;

    const inbox = new Map(state.messages.map((m) => [m.id, m]));
    // Always the row as the inbox holds it: the caller's copy may be one a
    // flag change has already replaced, and only an inbox row is in scope.
    const candidates = (rows ? rows.map((r) => inbox.get(r.id)) : state.messages).filter(
      (row): row is InboxItem => !!row && row.account === account,
    );
    if (candidates.length === 0) return;

    const { outcomes, fired } = applyRules(
      candidates.map((summary) => ({ summary, encrypted: isEncrypted(summary) })),
      state.searchIndex,
      state.rules,
      {
        labelIds: new Set(Object.keys(state.labels.labels)),
        // Archiving takes a row out of the inbox. A row the provider filed as
        // junk is not in its inbox to begin with, and "archiving" it would only
        // hide it from Spam here until the next sync put it back.
        canArchive: (summary) => !providerFiledAsJunk(summary.labels),
      },
    );
    if (outcomes.length === 0) return;

    // Everything is decided and patched before the first await, so a second
    // pass that starts while this one is writing sees these rules as fired and
    // cannot apply them twice.
    const rules: RulesState = {
      ...state.rules,
      fired: pruneFired(fired, new Set(state.messages.map((m) => m.id))),
    };
    let labels = state.labels;
    for (const outcome of outcomes) {
      if (outcome.addLabels.length > 0) labels = applyLabels(labels, [outcome.id], { add: outcome.addLabels });
    }
    store.patch(labels === state.labels ? { rules } : { rules, labels });

    await Promise.all([
      saveRules(account, rules),
      labels === state.labels ? undefined : saveLabels(account, labels),
      ...outcomes
        .filter((outcome) => Object.keys(outcome.flags).length > 0)
        .map((outcome) => ctx.services.mailbox.setFlags(outcome.id, outcome.flags)),
    ]);
  }

  return service;
}

/** Headers alone, as everywhere else: a placeholder subject is ciphertext. */
const isEncrypted = (summary: MailSummary): boolean => summary.subject.trim() === PLACEHOLDER_SUBJECT;
