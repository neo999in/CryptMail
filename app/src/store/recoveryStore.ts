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
  /**
   * Fingerprint of a key setup minted whose owner has not yet typed its
   * recovery code back (features.md 0.15), or null.
   *
   * Persisted, not screen state, because setup is only as strict as its
   * weakest exit: a flag held in memory would be skipped by closing the app
   * between generating the key and entering the code, and the next launch
   * would find a key and go straight to the inbox. Keyed on the fingerprint
   * so a later restore — a different key, with its own story — cannot inherit
   * it. Optional because a state written before the drill existed has none,
   * and a key that finished setup back then is not asked again.
   */
  drillPending?: string | null;
};

/** No backup and no drill owed — an absent `drillPending` reads as none. */
const NEVER: RecoveryState = { backedUpAt: null, fingerprint: null };

export async function loadRecoveryState(account: AccountId): Promise<RecoveryState> {
  return loadScopedJson<RecoveryState>(RECOVERY_STORE_KEY, account, NEVER);
}

/**
 * Record a backup. `drillPending` is carried through rather than cleared: taking
 * a backup is the step *before* the drill, and it is not the drill.
 */
export async function recordBackup(
  account: AccountId,
  fingerprint: string,
  at: Date = new Date(),
  drillPending: string | null = null,
): Promise<RecoveryState> {
  const state: RecoveryState = { backedUpAt: at.toISOString(), fingerprint, drillPending };
  await saveScopedJson(RECOVERY_STORE_KEY, account, state);
  return state;
}

/** A key setup has just made: no backup yet, and a drill owed. */
export async function markDrillPending(account: AccountId, fingerprint: string): Promise<RecoveryState> {
  const state: RecoveryState = { backedUpAt: null, fingerprint: null, drillPending: fingerprint };
  await saveScopedJson(RECOVERY_STORE_KEY, account, state);
  return state;
}

/**
 * The code unlocked the backup. That is the strongest "backed up" this device
 * can know, so it is recorded as the backup time too.
 */
export async function recordDrill(
  account: AccountId,
  fingerprint: string,
  at: Date = new Date(),
): Promise<RecoveryState> {
  const state: RecoveryState = { backedUpAt: at.toISOString(), fingerprint, drillPending: null };
  await saveScopedJson(RECOVERY_STORE_KEY, account, state);
  return state;
}

/** Waive a drill that cannot be run, keeping whatever backup mark there is. */
export async function waiveDrill(account: AccountId, state: RecoveryState): Promise<RecoveryState> {
  const next: RecoveryState = { ...state, drillPending: null };
  await saveScopedJson(RECOVERY_STORE_KEY, account, next);
  return next;
}

/** Whether the key this device holds still owes its recovery drill. Gates setup. */
export function drillOutstanding(state: RecoveryState, fingerprint: string | null | undefined): boolean {
  return !!fingerprint && state.drillPending === fingerprint;
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
