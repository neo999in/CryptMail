/**
 * This device's own key: minting it, backing it up, restoring it.
 */
import { core, CoreError, Identity, RecoveryBackup } from '../core';
import { isTransferFile } from '../core/transferFile';
import { exportArchive, importArchive } from '../store/archiveStore';
import {
  clearBackupRecord,
  drillOutstanding,
  markDrillPending,
  recordBackup,
  recordDrill,
  waiveDrill,
} from '../store/recoveryStore';
import { Ctx, IdentityService } from './contracts';
import { TransferMade } from './types';

export function createIdentityService(ctx: Ctx): IdentityService {
  const { store } = ctx;

  /**
   * The blob from the latest backup this run, and the key it was taken of.
   *
   * Held so the recovery drill unlocks *this* backup rather than one the user
   * pastes. Only the blob — never the code, which is the one half that must
   * not outlive the screen that showed it — and only in memory: the blob is
   * useless without the code, but nothing here needs it to survive a restart,
   * since a relaunch mid-setup takes a fresh backup anyway.
   */
  let lastBackup: { fingerprint: string; blob: string } | null = null;

  return {
    /**
     * Mint this device's identity.
     *
     * Only ever called from the setup screen, and only after the user has been
     * offered a restore — see `attach` in `session.ts`. The new key owes its
     * recovery drill, recorded before this returns, so there is no moment at
     * which a key exists and setup could be walked away from without it.
     */
    async createIdentity(): Promise<Identity> {
      const { session } = store.get();
      if (!session) throw new Error('Not connected.');
      const identity = await core.generateIdentity(session.email);
      const recovery = await markDrillPending(ctx.services.accounts.requireActive(), identity.fingerprint);
      // Nothing found for the old key says anything about this one.
      store.patch({ identity, recovery, verifyLink: null });
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
      const { identity, recovery } = store.get();
      if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');

      const backup = await core.exportRecoveryBackup(identity.email);
      lastBackup = { fingerprint: identity.fingerprint, blob: backup.blob };
      store.patch({
        recovery: await recordBackup(
          ctx.services.accounts.requireActive(),
          identity.fingerprint,
          new Date(),
          // Taking the backup is not the drill; a drill still owed stays owed.
          recovery.drillPending ?? null,
        ),
      });
      return backup;
    },

    /**
     * The drill: unlock the backup just taken with the code the user types.
     *
     * A real unlock through the core, not a string comparison against the code
     * on screen — that would prove the user can copy, where this proves the
     * code and the blob actually open the key. Importing re-adopts the key it
     * already holds; the fingerprint check is what says it was the same one.
     *
     * The blob is the one `exportRecovery` produced this run, never a pasted
     * one: an older backup of the same address would unlock fine and silently
     * put a different key on the device.
     */
    async completeRecoveryDrill(code: string): Promise<void> {
      const { identity } = store.get();
      if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');
      if (!lastBackup || lastBackup.fingerprint !== identity.fingerprint) {
        throw new CoreError('Create your recovery code first — there is no backup to check it against.', 'no-key');
      }

      let unlocked: Identity;
      try {
        unlocked = await core.importRecoveryBackup(lastBackup.blob, code);
      } catch (e) {
        if (e instanceof CoreError && e.code === 'decrypt-failed') {
          throw new CoreError(
            'That code does not unlock your backup. Check what you wrote down against the code — go back to see it again.',
            'decrypt-failed',
          );
        }
        throw e;
      }
      if (unlocked.fingerprint !== identity.fingerprint) {
        throw new CoreError('The backup unlocked a different key. Take a new backup and try again.', 'malformed');
      }

      store.patch({ recovery: await recordDrill(ctx.services.accounts.requireActive(), identity.fingerprint) });
    },

    /**
     * Let setup finish on a core that cannot make backups at all.
     *
     * An older native core has no recovery methods, and holding setup open for
     * a drill that can never run would lock the user out of their mail. The
     * waiver is decided here rather than by the screen: the core is asked, and
     * only its own "unavailable" answer releases the gate. Anything that *can*
     * back up is refused, so this is not a skip button by another name.
     */
    async waiveRecoveryDrill(): Promise<void> {
      const { identity, recovery } = store.get();
      if (!identity || !drillOutstanding(recovery, identity.fingerprint)) return;
      try {
        await core.exportRecoveryBackup(identity.email);
      } catch (e) {
        if (e instanceof CoreError && e.code === 'unavailable') {
          store.patch({ recovery: await waiveDrill(ctx.services.accounts.requireActive(), recovery) });
          return;
        }
        throw e;
      }
      throw new Error('This device can make a backup, so setup needs your recovery code once.');
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
     * false reassurance that costs a user their mail. No drill is owed either:
     * restoring *was* a successful code entry.
     */
    async restoreFromRecovery(blob: string, code: string): Promise<Identity> {
      // A transfer file is restored the same way, with more in it: the
      // conversations and the archive come along with the key.
      if (isTransferFile(blob)) return receiveTransfer(blob, code);

      const identity = await core.importRecoveryBackup(blob, code);

      // A backup carries the address it was taken for, and the core files the
      // key under *that* address — while boot loads the key for the address
      // that signed in. Restoring someone else's backup (or your own, into the
      // wrong mailbox) therefore looks like it worked and is simply gone at the
      // next launch, which is the worst way for this to fail: the user believes
      // their key is back. Refusing here leaves this account's key untouched.
      const { session } = store.get();
      if (session && identity.email.toLowerCase() !== session.email.toLowerCase()) {
        throw new CoreError(
          `That backup holds the key for ${identity.email}, but this mailbox is ${session.email}. Sign in to ${identity.email} to restore it.`,
          'malformed',
        );
      }

      lastBackup = null;
      store.patch({
        identity,
        recovery: await clearBackupRecord(ctx.services.accounts.requireActive()),
        verifyLink: null,
      });

      // The key is back with its old fingerprint, so any listing it had is
      // still its listing. Ask before the setup screen offers to publish it.
      await ctx.services.publish.reconcilePublish();

      return identity;
    },

    /**
     * Seal this phone for a replacement: its key, its per-email-key
     * conversations and its archive of forward-secret mail, under a code shown
     * once. The core hands the conversations over as it does, so from here
     * this phone sends with long-term keys — see `DeviceTransfer`.
     */
    async exportTransfer(): Promise<TransferMade> {
      const { identity } = store.get();
      if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');
      const { archive, count, unreadable } = await exportArchive(ctx.services.accounts.requireActive());
      const transfer = await core.exportTransfer(identity.email, archive);
      return { ...transfer, archived: count, unreadable };
    },

    async transferStatus(): Promise<Date | null> {
      return (await core.transferStatus()).handedOverAt;
    },

    async resumeSessions(): Promise<void> {
      await core.resumeSessions();
    },
  };

  /**
   * The new phone's side. The core refuses a transfer for another mailbox
   * before it changes anything, which is the same guard a backup gets below —
   * but here it has to come first, since adopting also replaces conversations.
   */
  async function receiveTransfer(blob: string, code: string): Promise<Identity> {
    const { session } = store.get();
    const { identity, archive } = await core.importTransfer(blob, code, session?.email ?? '');

    lastBackup = null;
    const account = ctx.services.accounts.requireActive();
    store.patch({ identity, recovery: await clearBackupRecord(account), verifyLink: null });
    await ctx.services.publish.reconcilePublish();

    try {
      await importArchive(account, archive);
    } catch (e) {
      // The key and conversations are here; only the archive is not. The file
      // still holds it, and loading it again is safe until this phone sends.
      throw new Error(
        `Your key and conversations moved, but mail read with per-email keys couldn’t be saved on this phone (${
          e instanceof Error ? e.message : String(e)
        }). Load the transfer file again before sending anything.`,
      );
    }
    return identity;
  }
}
