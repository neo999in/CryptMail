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

/** An account the app knows about locally. Tokens live with the auth provider. */
export type AccountRef = {
  id: AccountId;
  provider: Provider;
  email: string;
  /** What to call it in the switcher. Falls back to the address. */
  name?: string;
};

export function accountIdFor(provider: Provider, email: string): AccountId {
  return `${provider}:${email.trim().toLowerCase()}`;
}

export function accountRefFor(provider: Provider, email: string, name?: string): AccountRef {
  return { id: accountIdFor(provider, email), provider, email: email.trim().toLowerCase(), name };
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
