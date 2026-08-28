/**
 * Signing in, signing out, and everything this account owns on this device.
 */
import { auth, Session } from '../auth';
import { needsReauth } from '../auth/types';
import { core, Identity } from '../core';
import { Drafts } from '../drafts/drafts';
import { createGmailClient } from '../mail/gmail';
import { ScheduledOutbox } from '../outbox/outbox';
import { SearchIndex } from '../search/search';
import { initStorage } from '../store';
import { loadDrafts } from '../store/draftsStore';
import { InviteLog, loadInvites } from '../store/inviteStore';
import { Keyring, loadKeyring } from '../store/keyring';
import { loadOutbox } from '../store/outboxStore';
import { loadPublishState, PublishState } from '../store/publishStore';
import { loadRecoveryState, RecoveryState } from '../store/recoveryStore';
import { loadSearchIndex } from '../store/searchIndex';
import { loadSpamState, SpamState } from '../store/spamModelStore';
import { Ctx, message, SessionService } from './contracts';

type Attached = {
  identity: Identity | null;
  recovery: RecoveryState;
  publish: PublishState;
  invites: InviteLog;
  keyring: Keyring;
  searchIndex: SearchIndex;
  drafts: Drafts;
  scheduled: ScheduledOutbox;
  /** What this device has learned about spam, and the marks it learned from. */
  spam: SpamState;
  /** Nothing found for a previous account belongs to this one. */
  verifyLink: null;
};

export function createSession(ctx: Ctx): SessionService {
  const { store, mail } = ctx;

  /**
   * Connect the provider and load everything this account owns on this device.
   *
   * The mailbox is Gmail, unconditionally. It used to branch on
   * `session.provider === 'demo'` and build a fixture client, and it also seeded
   * two fabricated contacts into an empty keyring so the inbox would show every
   * trust state in the design. Both are gone: a keyring the user did not build is
   * indistinguishable from one they did, which for a key-trust UI is the worst
   * possible kind of fiction. A fresh account now starts with an empty keyring and
   * fills it from Autocrypt headers and the directory, as it does in use.
   *
   * It deliberately does **not** generate an identity. A fresh device that mints
   * a throwaway key before the user has been offered "restore from your recovery
   * code" leaves them restoring over a key their correspondents may already have
   * seen — a fingerprint change for everyone, caused by the app, for nothing.
   * Generation is a decision the user makes on the setup screen.
   */
  async function attach(session: Session): Promise<Attached> {
    mail.current = createGmailClient(session.email, auth.freshAccessToken);

    const identity = await core.loadIdentity(session.email);
    const keyring: Keyring = await loadKeyring();

    return {
      identity,
      recovery: await loadRecoveryState(),
      publish: await loadPublishState(),
      invites: await loadInvites(),
      keyring,
      searchIndex: await loadSearchIndex(),
      drafts: await loadDrafts(),
      scheduled: await loadOutbox(),
      spam: await loadSpamState(),
      verifyLink: null,
    };
  }

  return {
    async boot(isCancelled) {
      try {
        // Before anything reads a store. Every local store is encrypted at rest
        // and none of them can be decrypted until the device key is loaded.
        await initStorage();

        const session = await auth.restore();
        if (!session) {
          if (!isCancelled()) store.patch({ booting: false });
          return;
        }
        const attached = await attach(session);
        if (!isCancelled()) store.patch({ booting: false, session, ...attached });
      } catch (e) {
        // A grant revoked while the app was closed shows up here. Land on the
        // sign-in screen with the reason, not on a broken inbox.
        if (!isCancelled()) store.patch({ booting: false, session: null, error: message(e) });
      }
    },

    async signIn() {
      store.patch({ error: null });
      const session = await auth.signIn();
      // The patch lands in the store synchronously, so the refresh below — and
      // the Autocrypt harvest it triggers — already knows whose mailbox this is.
      store.patch({ session, ...(await attach(session)) });
      await ctx.services.mailbox.refreshInbox();
    },

    async signOut() {
      await auth.signOut();
      mail.current = null;
      store.patch({ session: null, identity: null, messages: [], verifyLink: null });
    },

    /**
     * Drop a session Google will no longer honour.
     *
     * Returning to signed-out is the point: leaving a dead session in place shows
     * an inbox that cannot refresh and a compose screen that cannot send, with an
     * error the user has no way to act on. `signOut` has already cleared the
     * stored tokens by the time this runs.
     */
    handleAuthLoss(e) {
      if (!needsReauth(e)) return false;
      mail.current = null;
      store.patch({
        session: null,
        identity: null,
        messages: [],
        verifyLink: null,
        loadingInbox: false,
        error: message(e),
      });
      return true;
    },
  };
}
