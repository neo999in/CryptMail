/**
 * Persistence for filters & rules (`rules/rules.ts`).
 *
 * Keyed by account, because a rule acts on one mailbox's mail and its `fired`
 * record is message ids. Sealed: a rule's conditions are words the user expects
 * to find in their mail, and that is content.
 */
import { normaliseRulesState, RulesState } from '../rules/rules';
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const RULES_STORE_KEY = 'cryptmail.rules.v1';

export async function loadRules(account: AccountId): Promise<RulesState> {
  return normaliseRulesState(await loadScopedJson<Partial<RulesState>>(RULES_STORE_KEY, account, {}));
}

export async function saveRules(account: AccountId, state: RulesState): Promise<void> {
  await saveScopedJson(RULES_STORE_KEY, account, state);
}
