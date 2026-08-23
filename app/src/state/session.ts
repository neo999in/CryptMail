/**
 * Signing in, signing out, and everything this account owns on this device.
 */
import { auth, Session } from '../auth';
import { needsReauth } from '../auth/types';
import { core, Identity } from '../core';
import { Drafts } from '../drafts/drafts';
import { createDemoMailClient, demoContactKeys, demoContacts } from '../mail/demoMail';
import { createGmailClient } from '../mail/gmail';
import { ScheduledOutbox } from '../outbox/outbox';
import { SearchIndex } from '../search/search';
import { initStorage } from '../store';
import { loadDrafts } from '../store/draftsStore';
import { InviteLog, loadInvites } from '../store/inviteStore';
import { Keyring, loadKeyring, saveKeyring, upsertKey } from '../store/keyring';
import { loadOutbox } from '../store/outboxStore';
import { loadPublishState, PublishState } from '../store/publishStore';
import { loadRecoveryState, RecoveryState } from '../store/recoveryStore';
import { loadSearchIndex } from '../store/searchIndex';
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
  /** Nothing found for a previous account belongs to this one. */
  verifyLink: null;
};

export function createSession(ctx: Ctx): SessionService {
  const { store, mail } = ctx;

  /**
   * Connect the provider and load everything this account owns on this device.
   *
   * It deliberately does **not** generate an identity. A fresh device that mints
   * a throwaway key before the user has been offered "restore from your recovery
   * code" leaves them restoring over a key their correspondents may already have
   * seen — a fingerprint change for everyone, caused by the app, for nothing.
   * Generation is a decision the user makes on the setup screen.
   */
  async function attach(session: Session): Promise<Attached> {
    mail.current =
      session.provider === 'demo'
        ? await createDemoMailClient(session.email)
        : createGmailClient(session.email, auth.freshAccessToken);

    const identity = await core.loadIdentity(session.email);

    let keyring = await loadKeyring();
    // Seeded only for the demo core. `demoContactKeys` are `fakePublicKey()`
    // armor, which a real OpenPGP parser rejects — feeding them to a native
    // core throws, leaving an error banner and an *empty* keyring, so
    // encrypted send would be blocked for every recipient. Demo mail with a
    // real core is handled in `demoMail.ts`; see the note there.
    if (session.provider === 'demo' && core.kind === 'demo' && Object.keys(keyring).length === 0) {
      // Seed the demo keyring so the inbox shows every trust state in the design:
      // Anya verified, Jordan trusted-on-first-use, the newsletter sender unknown.
      keyring = upsertKey(keyring, await core.importPublicKey(demoContactKeys.anya), 'manual', demoContacts.anya.name);
      keyring = upsertKey(keyring, await core.importPublicKey(demoContactKeys.jordan), 'autocrypt', demoContacts.jordan.name);
      keyring[demoContacts.anya.email] = { ...keyring[demoContacts.anya.email], trust: 'verified' };
      await saveKeyring(keyring);
    }

    return {
      identity,
      recovery: await loadRecoveryState(),
      publish: await loadPublishState(),
      invites: await loadInvites(),
      keyring,
      searchIndex: await loadSearchIndex(),
      drafts: await loadDrafts(),
      scheduled: await loadOutbox(),
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
