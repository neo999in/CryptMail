/**
 * This device's own key: minting it, backing it up, restoring it.
 */
import { core, CoreError, Identity, RecoveryBackup } from '../core';
import { clearBackupRecord, recordBackup } from '../store/recoveryStore';
import { Ctx, IdentityService } from './contracts';

export function createIdentityService(ctx: Ctx): IdentityService {
  const { store } = ctx;

  return {
    /**
     * Mint this device's identity.
     *
     * Only ever called from the setup screen, and only after the user has been
     * offered a restore — see `attach` in `session.ts`.
     */
    async createIdentity(): Promise<Identity> {
      const { session } = store.get();
      if (!session) throw new Error('Not connected.');
      const identity = await core.generateIdentity(session.email);
      // Nothing found for the old key says anything about this one.
      store.patch({ identity, verifyLink: null });
      return identity;
    },

    /**
     * Wrap this device's key under a fresh recovery code.
     *
     * The code is returned to the caller and deliberately goes no further — only
     * the *fact* of a backup is recorded. A recovery code stored on the device it
     * recovers protects nothing, since whatever can read the store can already
     * read the key.
     *
     * Each call issues a new code and supersedes the last blob, so a user who
     * loses the paper can simply take another backup.
     */
    async exportRecovery(): Promise<RecoveryBackup> {
      const { identity } = store.get();
      if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');

      const backup = await core.exportRecoveryBackup(identity.email);
      store.patch({ recovery: await recordBackup(identity.fingerprint) });
      return backup;
    },

    /**
     * Adopt an identity from a backup, replacing whatever key this device holds.
     *
     * The keyring, drafts and search index are left alone — they are this
     * device's, not the backup's, and the restored identity can read everything
     * that was encrypted to it regardless.
     *
     * The backup mark is cleared rather than kept: it described the key this
     * device used to hold. Whether the *restored* key has a backup elsewhere is
     * not something this device can know, and claiming it does would be the one
     * false reassurance that costs a user their mail.
     */
    async restoreFromRecovery(blob: string, code: string): Promise<Identity> {
      const identity = await core.importRecoveryBackup(blob, code);
      store.patch({ identity, recovery: await clearBackupRecord(), verifyLink: null });
      return identity;
    },
  };
}
