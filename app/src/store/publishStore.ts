/**
 * Whether this device's public key has been listed in the key directory.
 *
 * Persisted for two reasons. The obvious one: without it the app would re-upload
 * on every launch. The one that matters: publishing is a **consent decision**
 * — the listing is public, and anyone can learn from it that this address has a
 * key — so a user who declined must stay declined rather than be asked again on
 * every start until they give in.
 *
 * The fingerprint is stored alongside because a restored or rotated identity is
 * a different key, and a stale "published" mark against it would leave senders
 * fetching a key this device can no longer read.
 */
import { loadJson, saveJson } from './secureJson';

export const PUBLISH_STORE_KEY = 'cryptmail.publish.v1';

export type PublishStatus =
  /** Never offered, or offered and not yet answered. */
  | 'unpublished'
  /** Uploaded; the keyserver is waiting for the address owner to confirm. */
  | 'pending'
  /** Served by address — a stranger can now find this key. */
  | 'published'
  /** The user said no. Not asked again unless they ask for it. */
  | 'declined';

export type PublishState = {
  status: PublishStatus;
  /** The key the status describes. */
  fingerprint: string | null;
  updatedAt: string | null;
};

const UNPUBLISHED: PublishState = { status: 'unpublished', fingerprint: null, updatedAt: null };

export async function loadPublishState(): Promise<PublishState> {
  return loadJson<PublishState>(PUBLISH_STORE_KEY, UNPUBLISHED);
}

export async function savePublishState(
  status: PublishStatus,
  fingerprint: string | null,
  at: Date = new Date(),
): Promise<PublishState> {
  const state: PublishState = { status, fingerprint, updatedAt: at.toISOString() };
  await saveJson(PUBLISH_STORE_KEY, state);
  return state;
}

/**
 * The state as it applies to the key this device currently holds.
 *
 * A record about some other fingerprint says nothing about this one, so it reads
 * as `unpublished` rather than being trusted — including the `declined` mark,
 * since declining to list one key is not a decision about a different one.
 */
export function publishStatusFor(state: PublishState, fingerprint: string | null): PublishStatus {
  if (!fingerprint || state.fingerprint !== fingerprint) return 'unpublished';
  return state.status;
}
