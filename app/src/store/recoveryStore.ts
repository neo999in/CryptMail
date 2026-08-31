/**
 * Whether this device's identity has ever been backed up, and when.
 *
 * A recovery feature nobody finds does not prevent the loss it exists to
 * prevent. The user has no way to know that the key protecting years of mail
 * has no backup path until the phone is gone and it is far too late — so the
 * app has to say so, unprompted, which means remembering whether it happened.
 *
 * This stores a timestamp and nothing else. **Never put the recovery code
 * here**: a code kept on the device it recovers protects nothing, since anything
 * that can read this store can already read the key.
 */
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const RECOVERY_STORE_KEY = 'cryptmail.recovery.v1';

export type RecoveryState = {
  /** ISO timestamp of the last export, or null if the key has never been backed up. */
  backedUpAt: string | null;
  /**
   * Fingerprint the backup was taken of.
   *
   * Without it, restoring onto a device that had already backed up a *different*
   * key would leave a stale "backed up" mark for an identity no backup covers —
   * the one case where a false reassurance costs the user their mail.
   */
  fingerprint: string | null;
};

const NEVER: RecoveryState = { backedUpAt: null, fingerprint: null };

export async function loadRecoveryState(account: AccountId): Promise<RecoveryState> {
  return loadScopedJson<RecoveryState>(RECOVERY_STORE_KEY, account, NEVER);
}

export async function recordBackup(
  account: AccountId,
  fingerprint: string,
  at: Date = new Date(),
): Promise<RecoveryState> {
  const state: RecoveryState = { backedUpAt: at.toISOString(), fingerprint };
  await saveScopedJson(RECOVERY_STORE_KEY, account, state);
  return state;
}

/** Forget the mark — used when restoring, since the new identity has its own backup story. */
export async function clearBackupRecord(account: AccountId): Promise<RecoveryState> {
  await saveScopedJson(RECOVERY_STORE_KEY, account, NEVER);
  return NEVER;
}

/**
 * Whether the user should be warned. True for a key with no backup *and* for a
 * key whose backup was taken of a different identity.
 */
export function needsBackup(state: RecoveryState, fingerprint: string | null): boolean {
  if (!fingerprint) return false;
  return state.backedUpAt === null || state.fingerprint !== fingerprint;
}
