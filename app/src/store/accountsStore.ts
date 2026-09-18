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
import {
  AccountId,
  AccountRef,
  AccountSettings,
  AVATAR_MODES,
  AvatarMode,
  DEFAULT_ACCOUNT_SETTINGS,
  SYNC_WINDOWS,
} from './accountScope';
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
    ? // `settings` is merged rather than overwritten, and the spread would
      // overwrite it: a ref built from a sign-in carries none, and every boot
      // re-registers every account. Without this, launching the app would reset
      // the name, avatar mode, image policy and sync window the user chose.
      state.accounts.map((a) =>
        a.id === ref.id ? { ...a, ...ref, settings: { ...settingsFrom(a), ...(ref.settings ?? {}) } } : a,
      )
    : [...state.accounts, ref];
  return normalise({ ...state, accounts, active: activate ? ref.id : state.active });
}

/**
 * Change what the user has decided about one mailbox (pure).
 *
 * A patch, not a replacement, so a screen that owns one control does not have
 * to know the whole shape to write its field.
 */
export function setAccountSettings(
  state: AccountsState,
  id: AccountId,
  patch: Partial<AccountSettings>,
): AccountsState {
  return normalise({
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === id ? { ...a, settings: { ...settingsFrom(a), ...patch } } : a,
    ),
  });
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
 * `active` always names a listed account, every account carries a complete
 * `settings`, and `unified` is off when there is nothing to unify. Applied on
 * read as well as write so a hand-edited or half-written blob cannot put the
 * app in a state no screen can render.
 */
function normalise(state: AccountsState): AccountsState {
  const accounts = (state.accounts ?? []).map((a) => ({ ...a, settings: settingsFrom(a) }));
  const active = accounts.some((a) => a.id === state.active) ? state.active : (accounts[0]?.id ?? null);
  return { accounts, active, unified: accounts.length > 1 && state.unified === true };
}

/**
 * Coerce whatever is on a ref into a settings object every screen can render.
 *
 * A value from a future build, an older one, or a half-written blob must not be
 * able to hand a screen a sync window with no meaning behind it — the same
 * reasoning as `normalisePrefs`, and for the same reason it is done on read.
 */
/** Generous for a sign-off, and a bound on what a hand-edited blob can inflate. */
export const MAX_SIGNATURE_LENGTH = 2000;

function settingsFrom(ref: Pick<AccountRef, 'settings'>): AccountSettings {
  const stored = (ref.settings ?? {}) as Partial<AccountSettings>;
  const avatar: AvatarMode =
    stored.avatar && AVATAR_MODES.includes(stored.avatar) ? stored.avatar : DEFAULT_ACCOUNT_SETTINGS.avatar;
  return {
    displayName: typeof stored.displayName === 'string' ? stored.displayName : '',
    avatar,
    blockRemoteImages: stored.blockRemoteImages === true,
    paused: stored.paused === true,
    // On unless it was switched off: a ref written before the setting existed
    // keeps notifying, which is what a fresh install does.
    notify: stored.notify !== false,
    signature: typeof stored.signature === 'string' ? stored.signature.slice(0, MAX_SIGNATURE_LENGTH) : '',
    syncWindow:
      stored.syncWindow && SYNC_WINDOWS.includes(stored.syncWindow)
        ? stored.syncWindow
        : DEFAULT_ACCOUNT_SETTINGS.syncWindow,
  };
}
