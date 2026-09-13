/**
 * Client-side filters & rules (pure).
 *
 * *If the sender is X, or the subject contains Y → star, mark read, archive,
 * label.* The provider cannot run these for encrypted mail — it cannot read the
 * subject or the body — so server-side filtering is structurally impossible for
 * exactly the messages that matter most (docs/features.md 0.1). They run here,
 * on this device, after decryption.
 *
 * The boundary is the same one search keeps (`search/search.ts`):
 *
 * - the **sender** is a cleartext envelope header, so a sender condition can
 *   match any message, opened or not;
 * - the **subject and body** of an encrypted message exist on this device only
 *   once it has been decrypted here and indexed. Until then a condition on them
 *   *cannot match* — not "matches nothing in particular", but "does not fire" —
 *   so no rule ever acts on content this device has not read. Opening the
 *   message indexes it, and the rules are run again at that moment.
 *
 * Each rule fires **once per message**. `fired` remembers which rules already
 * acted on which message, so a user who un-stars something a rule starred, or
 * moves an archived message back, is not overruled on the next sync. That is
 * the difference between a filter and a fight.
 *
 * No storage, no React: persistence is `store/rulesStore.ts`, wiring is
 * `state/rules.ts`.
 */
import { FlagPatch, MailSummary } from '../mail/types';
import { SearchIndex } from '../search/search';

/** Which part of a message a condition reads. */
export type RuleField = 'from' | 'subject' | 'content';

export const RULE_FIELDS: { key: RuleField; label: string }[] = [
  { key: 'from', label: 'Sender' },
  { key: 'subject', label: 'Subject' },
  // Short enough to sit in an equal third of the editor's segmented control —
  // the editor's placeholder spells out that it means the subject or the body.
  { key: 'content', label: 'Message' },
];

/** Case-insensitive "contains". Every condition on a rule must hold. */
export type RuleCondition = { field: RuleField; contains: string };

export type RuleActions = {
  star: boolean;
  markRead: boolean;
  archive: boolean;
  /** A local label (`labels/labels.ts`) to file the message under. */
  labelId: string | null;
};

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleActions;
  createdAt: string;
};

export type RulesState = {
  /** In the order they were created, which is the order they run. */
  rules: Rule[];
  /** Which rules have already acted on each message, by message id. */
  fired: Record<string, string[]>;
};

export const emptyRulesState = (): RulesState => ({ rules: [], fired: {} });

export const NO_ACTIONS: RuleActions = { star: false, markRead: false, archive: false, labelId: null };

/** What a rule is evaluated against: the row, and whether it is ciphertext. */
export type RuleInput = { summary: MailSummary; encrypted: boolean };

/** Why a rule cannot be saved, or `null` when it can. */
export function ruleProblem(rule: Pick<Rule, 'conditions' | 'actions'>): string | null {
  if (rule.conditions.length === 0) return 'Add at least one condition.';
  // An empty needle is contained in every string, so a rule holding one would
  // act on the whole mailbox. Refused rather than quietly dropped.
  if (rule.conditions.some((c) => !c.contains.trim())) return 'Every condition needs some text to match.';
  if (!hasAnyAction(rule.actions)) return 'Choose at least one thing the rule does.';
  return null;
}

export function hasAnyAction(actions: RuleActions): boolean {
  return actions.star || actions.markRead || actions.archive || !!actions.labelId;
}

/**
 * The text a condition may read on this message — or `null` when this device
 * cannot read that part of it.
 *
 * `null` is the whole security property of this module. An encrypted message
 * whose content has not been decrypted here has no subject and no body as far
 * as a rule is concerned; its placeholder subject and its ciphertext snippet
 * are never offered as stand-ins.
 */
export function readableField(
  field: RuleField,
  { summary, encrypted }: RuleInput,
  index: SearchIndex,
): string | null {
  if (field === 'from') return `${summary.from.name ?? ''} ${summary.from.address}`;
  if (encrypted) {
    const content = index[summary.id];
    if (!content) return null;
    return field === 'subject' ? content.subject : `${content.subject} ${content.body}`;
  }
  return field === 'subject' ? summary.subject : `${summary.subject} ${summary.snippet}`;
}

/** Whether every condition on the rule holds for this message. */
export function matchRule(rule: Pick<Rule, 'conditions'>, input: RuleInput, index: SearchIndex): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((condition) => {
    const needle = condition.contains.trim().toLowerCase();
    if (!needle) return false;
    const text = readableField(condition.field, input, index);
    return text !== null && text.toLowerCase().includes(needle);
  });
}

/** What the rules decided for one message. */
export type RuleOutcome = {
  id: string;
  /** Only the changes that change something — a star on a starred row is left out. */
  flags: FlagPatch;
  addLabels: string[];
  /** The rules that fired, by id. */
  rules: string[];
};

/**
 * Run every enabled rule over a set of messages, once each.
 *
 * `labelIds` is the labels that still exist: a rule whose label was deleted
 * keeps its other actions and loses that one, rather than filing mail under a
 * label nobody can see. `canArchive` says whether a row is in a list archiving
 * means anything for — the inbox, not Archive or Trash.
 *
 * A rule that matched is recorded as fired even when nothing it would do was
 * needed (the message was already starred): the rule has had its say on that
 * message, and a later un-star is the user's answer to it.
 */
export function applyRules(
  inputs: RuleInput[],
  index: SearchIndex,
  state: RulesState,
  options: { labelIds: Set<string>; canArchive?: (summary: MailSummary) => boolean },
): { outcomes: RuleOutcome[]; fired: Record<string, string[]> } {
  const active = state.rules.filter((rule) => rule.enabled && !ruleProblem(rule));
  const fired = { ...state.fired };
  const outcomes: RuleOutcome[] = [];
  if (active.length === 0) return { outcomes, fired };

  for (const input of inputs) {
    const { summary } = input;
    const already = new Set(fired[summary.id] ?? []);
    const flags: FlagPatch = {};
    const addLabels: string[] = [];
    const ran: string[] = [];

    for (const rule of active) {
      if (already.has(rule.id) || !matchRule(rule, input, index)) continue;
      ran.push(rule.id);
      const { actions } = rule;
      if (actions.star && !summary.starred) flags.starred = true;
      if (actions.markRead && summary.unread) flags.unread = false;
      if (actions.archive && (options.canArchive?.(summary) ?? true)) flags.archived = true;
      if (actions.labelId && options.labelIds.has(actions.labelId) && !addLabels.includes(actions.labelId)) {
        addLabels.push(actions.labelId);
      }
    }

    if (ran.length === 0) continue;
    fired[summary.id] = [...already, ...ran];
    outcomes.push({ id: summary.id, flags, addLabels, rules: ran });
  }

  return { outcomes, fired };
}

/**
 * How many messages `fired` remembers before it is trimmed.
 *
 * It grows with every message a rule has touched and nothing else shrinks it,
 * so it is bounded: past the cap, only the messages still on screen are kept.
 * Forgetting an old message costs at most one re-application if it is ever
 * listed again, which a message that old almost never is.
 */
export const FIRED_CAP = 4000;

export function pruneFired(
  fired: Record<string, string[]>,
  keep: Set<string>,
  cap = FIRED_CAP,
): Record<string, string[]> {
  if (Object.keys(fired).length <= cap) return fired;
  return Object.fromEntries(Object.entries(fired).filter(([id]) => keep.has(id)));
}

/** Forget a rule, and every record of it having fired. */
export function removeRule(state: RulesState, id: string): RulesState {
  const fired: Record<string, string[]> = {};
  for (const [messageId, ids] of Object.entries(state.fired)) {
    const kept = ids.filter((ruleId) => ruleId !== id);
    if (kept.length > 0) fired[messageId] = kept;
  }
  return { rules: state.rules.filter((rule) => rule.id !== id), fired };
}

/** Add a rule, or replace the one with the same id in place. */
export function upsertRule(state: RulesState, rule: Rule): RulesState {
  const at = state.rules.findIndex((r) => r.id === rule.id);
  const rules = at === -1 ? [...state.rules, rule] : state.rules.map((r, i) => (i === at ? rule : r));
  return { ...state, rules };
}

/** Take a deleted label off every rule that filed under it. */
export function dropLabelFromRules(state: RulesState, labelId: string): RulesState {
  if (!state.rules.some((rule) => rule.actions.labelId === labelId)) return state;
  return {
    ...state,
    rules: state.rules.map((rule) =>
      rule.actions.labelId === labelId ? { ...rule, actions: { ...rule.actions, labelId: null } } : rule,
    ),
  };
}

/**
 * The starting point for "create a rule from this message".
 *
 * The sender, because it is the one field that is always readable and the one
 * people almost always mean. The subject is offered too when this device can
 * read it, but left off the conditions — "from this person *and* with exactly
 * this subject" matches one message, which is not a rule.
 */
export function draftRuleFrom(input: RuleInput, index: SearchIndex): { from: string; subject: string | null } {
  return {
    from: input.summary.from.address,
    subject: readableField('subject', input, index)?.trim() || null,
  };
}

/** A rule's conditions, in words — the value line under it in the list. */
export function describeConditions(conditions: RuleCondition[]): string {
  const label = (field: RuleField) => RULE_FIELDS.find((f) => f.key === field)?.label ?? field;
  return conditions.map((c) => `${label(c.field)} contains “${c.contains.trim()}”`).join(' and ');
}

/** A rule's actions, in words. `labelName` resolves the label, if any. */
export function describeActions(actions: RuleActions, labelName?: (id: string) => string | undefined): string {
  const parts: string[] = [];
  if (actions.star) parts.push('star');
  if (actions.markRead) parts.push('mark read');
  if (actions.archive) parts.push('archive');
  if (actions.labelId) {
    const name = labelName?.(actions.labelId);
    if (name) parts.push(`label “${name}”`);
  }
  if (parts.length === 0) return 'Does nothing';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Tolerate a stored blob from an older or damaged write. */
export function normaliseRulesState(raw: Partial<RulesState> | null | undefined): RulesState {
  const rules = Array.isArray(raw?.rules)
    ? raw.rules.filter(
        (rule): rule is Rule =>
          !!rule && typeof rule.id === 'string' && Array.isArray(rule.conditions) && !!rule.actions,
      )
    : [];
  const fired: Record<string, string[]> = {};
  for (const [id, ids] of Object.entries(raw?.fired ?? {})) {
    if (Array.isArray(ids)) fired[id] = ids.filter((x) => typeof x === 'string');
  }
  return { rules: rules.map((rule) => ({ ...rule, actions: { ...NO_ACTIONS, ...rule.actions } })), fired };
}
