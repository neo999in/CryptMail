/**
 * Which account a stored value belongs to.
 *
 * Every local store used to be a single global blob — one keyring, one drafts
 * map, one search index — which quietly assumed the app would only ever hold
 * one mailbox. `docs/data-model.md` has keyed these records on `account_id`
 * from the start, so the assumption was always the prototype's, not the
 * design's. Scoping the storage keys is what lets two mailboxes coexist on a
 * device without either one able to see the other's data.
 *
 * The id pairs the provider with the address rather than being the address
 * alone: the same mailbox reached through the demo fixtures and through Gmail
 * is two different sets of local data, and merging them would put demo
 * ciphertext in a real account's search index.
 */
import { Provider } from '../auth/types';

/** `gmail:you@gmail.com` — opaque to everything but this file. */
export type AccountId = string;

/** How far back a mailbox is listed. `all` is the provider's own default. */
export type SyncWindow = 'all' | '7' | '30' | '90';

export const SYNC_WINDOWS: SyncWindow[] = ['7', '30', '90', 'all'];

/** Whether an account's avatar shows the provider's photo or its initials. */
export type AvatarMode = 'photo' | 'initials';

/**
 * What the user has decided about one mailbox.
 *
 * These live on the registry ref rather than in a per-account store, and that
 * is deliberate: every consumer needs *all* of them at once and synchronously —
 * the account list draws N rows, the drawer rail draws N avatars, and a merged
 * inbox lists N mailboxes in one pass, each with its own sync window. A scoped
 * store only ever holds the active account. Nothing here is a token, a key or
 * message text, which is the line `accountsStore` actually draws.
 *
 * Every default reproduces the behaviour of an install that never opens the
 * accounts screen, so adding the screen changed nothing on its own.
 */
export type AccountSettings = {
  /** Overrides the provider's name in the switcher. Empty means "use theirs". */
  displayName: string;
  avatar: AvatarMode;
  /**
   * Whether opening this account's mail may fetch remote images.
   *
   * Off by default, which is the app's standing decision (features.md 0.8) —
   * this is the per-account opt *in* to blocking, not a reversal of it.
   */
  blockRemoteImages: boolean;
  syncWindow: SyncWindow;
  /**
   * Whether this mailbox is connected but deliberately not being synced.
   *
   * The rung between "the grant died" and "remove it". Until this existed the
   * only way to stop a mailbox fetching was to remove it, which erases its
   * keyring and decrypted mail — so "I don't want work mail this week" and "I
   * am done with this address" had one button between them.
   *
   * A paused account keeps everything: its place in the switcher, its keys, its
   * drafts, its indexed mail. What it loses is a `MailClient`, so a merged sync
   * steps over it and nothing refreshes it. Boot does not even ask the provider
   * for a token for it.
   */
  paused: boolean;
  /**
   * Appended to a new message written from this mailbox. Empty means none.
   *
   * Per mailbox because a work address and a personal one sign differently,
   * and on the ref rather than in a scoped store because Compose can switch
   * the From account mid-message and needs the other mailbox's signature
   * synchronously to swap it. It is text the user wrote *about themselves*, not
   * message content, and it travels inside the encrypted body like the rest of
   * what they type — see `signature/signature.ts`.
   */
  signature: string;
};

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  displayName: '',
  avatar: 'photo',
  blockRemoteImages: false,
  syncWindow: 'all',
  paused: false,
  signature: '',
};

/** An account the app knows about locally. Tokens live with the auth provider. */
export type AccountRef = {
  id: AccountId;
  provider: Provider;
  email: string;
  /** What to call it in the switcher. Falls back to the address. */
  name?: string;
  /**
   * The provider's avatar URL, when it has one.
   *
   * Stored rather than re-fetched so the switcher can draw a face on the first
   * frame after launch, before any account has been restored. It is a URL, not
   * image bytes: this store is read on every boot and is not a place to put a
   * blob. A row whose photo fails to load falls back to initials.
   */
  photo?: string;
  /**
   * The user's own choices for this mailbox.
   *
   * Optional on the type because a ref built from a sign-in has none yet, and
   * because a blob written by a build that predates the accounts screen has
   * none either. `accountsStore.normalise` fills it in on the way out, so every
   * *reader* gets a complete object — see `settingsOf` for the one-liner that
   * says so at a call site holding a bare ref.
   */
  settings?: AccountSettings;
};

/** The settings on a ref, defaults included. Safe on a ref straight from a sign-in. */
export function settingsOf(ref?: Pick<AccountRef, 'settings'>): AccountSettings {
  return { ...DEFAULT_ACCOUNT_SETTINGS, ...(ref?.settings ?? {}) };
}

/**
 * What to call this mailbox on screen.
 *
 * One function because four places used to spell out the same fallback chain,
 * and a fifth (the user's own name for the account) had to reach all of them.
 */
export function accountLabel(ref: Pick<AccountRef, 'email' | 'name' | 'settings'>): string {
  return settingsOf(ref).displayName.trim() || ref.name?.trim() || ref.email;
}

export function accountIdFor(provider: Provider, email: string): AccountId {
  return `${provider}:${email.trim().toLowerCase()}`;
}

export function accountRefFor(
  provider: Provider,
  email: string,
  profile?: { name?: string; photo?: string },
): AccountRef {
  return {
    id: accountIdFor(provider, email),
    provider,
    email: email.trim().toLowerCase(),
    name: profile?.name,
    photo: profile?.photo,
  };
}

/**
 * `cryptmail.keyring.v1` + `gmail:you@gmail.com` → `cryptmail.keyring.v1@gmail:you@gmail.com`.
 *
 * The unscoped key stays meaningful: it is what a pre-multi-account install
 * wrote, and `loadScopedJson` still reads it once so that data lands under the
 * first account signed in rather than being silently abandoned.
 */
export function scopedKey(base: string, account: AccountId): string {
  return `${base}@${account}`;
}
