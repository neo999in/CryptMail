/**
 * Which mailboxes this device holds, and which one is in front.
 *
 * Deliberately **not** scoped by account — it is the index that names them, so
 * it is the one store that has to be global. It is sealed like the rest: a list
 * of a person's mailboxes is precisely the metadata this product exists to keep
 * off a server, and it should not be the one file left readable on disk.
 *
 * No token, no key and no message text lives here; the auth provider owns
 * credentials and the per-account stores own everything else.
 */
import { AccountId, AccountRef } from './accountScope';
import { loadJson, saveJson } from './secureJson';

export const ACCOUNTS_STORE_KEY = 'cryptmail.accounts.v1';

export type AccountsState = {
  accounts: AccountRef[];
  /** The account whose keyring, identity and drafts are loaded. */
  active: AccountId | null;
  /**
   * Whether the inbox shows every account at once.
   *
   * Reading is merged; nothing else is. Composing, sending and decrypting stay
   * bound to the active account, because those need *its* identity and keyring
   * — see `state/accounts.ts`.
   */
  unified: boolean;
};

export const NO_ACCOUNTS: AccountsState = { accounts: [], active: null, unified: false };

export async function loadAccounts(): Promise<AccountsState> {
  const state = await loadJson<AccountsState>(ACCOUNTS_STORE_KEY, NO_ACCOUNTS);
  return normalise(state);
}

export async function saveAccounts(state: AccountsState): Promise<AccountsState> {
  const next = normalise(state);
  await saveJson(ACCOUNTS_STORE_KEY, next);
  return next;
}

/**
 * Add an account, or refresh what is known about one already listed (pure).
 *
 * `activate` is not a convenience. Boot restores the mailbox the user left in
 * front, paints it, and then registers the rest in the background — and a
 * background restore that marked itself active would yank the front out from
 * under whatever the user is already reading. Adding a mailbox by hand still
 * activates it, which is what the user just asked for.
 */
export function upsertAccount(state: AccountsState, ref: AccountRef, activate = true): AccountsState {
  const accounts = state.accounts.some((a) => a.id === ref.id)
    ? state.accounts.map((a) => (a.id === ref.id ? { ...a, ...ref } : a))
    : [...state.accounts, ref];
  return normalise({ ...state, accounts, active: activate ? ref.id : state.active });
}

/**
 * Forget an account (pure).
 *
 * Choosing the replacement here rather than at the call site is what stops the
 * app landing on `active` pointing at an account that no longer exists — which
 * would leave the stores loaded from it still on screen.
 */
export function removeAccount(state: AccountsState, id: AccountId): AccountsState {
  const accounts = state.accounts.filter((a) => a.id !== id);
  const active = state.active === id ? (accounts[0]?.id ?? null) : state.active;
  return normalise({ ...state, accounts, active });
}

/**
 * `active` always names a listed account, and `unified` is off when there is
 * nothing to unify. Applied on read as well as write so a hand-edited or
 * half-written blob cannot put the app in a state no screen can render.
 */
function normalise(state: AccountsState): AccountsState {
  const accounts = state.accounts ?? [];
  const active = accounts.some((a) => a.id === state.active) ? state.active : (accounts[0]?.id ?? null);
  return { accounts, active, unified: accounts.length > 1 && state.unified === true };
}
