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
import { AccountId, accountIdFor } from '../store/accountScope';
import { loadAccounts, NO_ACCOUNTS, saveAccounts } from '../store/accountsStore';
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
  // Named, so `signIn` and `boot` can reuse `attach` without the object literal
  // having to refer to itself.
  let service: SessionService;

  /**
   * Connect the provider and load everything this account owns on this device.
   *
   * It deliberately does **not** generate an identity. A fresh device that mints
   * a throwaway key before the user has been offered "restore from your recovery
   * code" leaves them restoring over a key their correspondents may already have
   * seen — a fingerprint change for everyone, caused by the app, for nothing.
   * Generation is a decision the user makes on the setup screen.
   */
  /**
   * The provider for one account, built once and kept.
   *
   * Cached per account so switching back and forth does not rebuild a Gmail
   * client — and so a merged inbox can list every mailbox without one.
   */
  function clientFor(session: Session, account: AccountId) {
    const existing = mail.clients.get(account);
    if (existing) return existing;

    const client = createGmailClient(session.email, () => auth.freshAccessToken(session.email));
    mail.clients.set(account, client);
    return client;
  }

  async function load(session: Session, account: AccountId): Promise<Attached> {
    mail.current = clientFor(session, account);

    const identity = await core.loadIdentity(session.email);

    // The keyring starts empty and fills from what the mailbox actually
    // carries — Autocrypt headers on inbound mail, directory lookups, and keys
    // the user pastes in. It used to be seeded with three fabricated contacts
    // so the demo inbox could display every trust state at once; with the
    // fixture mailbox gone there is nothing for those keys to be attached to,
    // and inventing a "verified" contact the user never verified was always
    // the wrong thing to put in a keyring.
    const keyring = await loadKeyring(account);

    return {
      identity,
      recovery: await loadRecoveryState(account),
      publish: await loadPublishState(account),
      invites: await loadInvites(account),
      keyring,
      searchIndex: await loadSearchIndex(account),
      drafts: await loadDrafts(account),
      scheduled: await loadOutbox(account),
      spam: await loadSpamState(account),
      verifyLink: null,
    };
  }

  service = {
    /**
     * Everything this account owns, in front.
     *
     * Registering first is what makes the rest safe: `register` writes
     * `activeAccount`, and every scoped store read below is keyed on it — so a
     * switch cannot load one account's keyring under another's id.
     */
    async attach(session) {
      const account = await ctx.services.accounts.register(session);
      store.patch({ session, ...(await load(session, account)) });
    },

    async boot(isCancelled) {
      try {
        // Before anything reads a store. Every local store is encrypted at rest
        // and none of them can be decrypted until the device key is loaded.
        await initStorage();

        const sessions = await auth.restoreAll();
        if (sessions.length === 0) {
          if (!isCancelled()) store.patch({ booting: false });
          return;
        }

        // Which mailbox was in front when the app was last closed. Read
        // *before* registering anything: `register` marks each account active
        // as it goes, so asking afterwards would only ever name whichever
        // session happened to be restored last.
        const stored = await loadAccounts();
        const wanted =
          sessions.find((s) => accountIdFor(s.provider, s.email) === stored.active) ?? sessions[0];

        // Register every session, so the switcher and the merged inbox know
        // about all of them even though only one is loaded — and build each
        // provider up front for the same reason. `wanted` goes last, which is
        // what leaves it active.
        for (const session of sessions) {
          const id = accountIdFor(session.provider, session.email);
          await clientFor(session, id);
          if (session !== wanted) await ctx.services.accounts.register(session);
        }

        const account = await ctx.services.accounts.register(wanted);
        const attached = await load(wanted, account);
        if (!isCancelled()) store.patch({ booting: false, session: wanted, ...attached });
      } catch (e) {
        // A grant revoked while the app was closed shows up here. Land on the
        // sign-in screen with the reason, not on a broken inbox.
        if (!isCancelled()) store.patch({ booting: false, session: null, error: message(e) });
      }
    },

    /**
     * Connect a mailbox — the first one, or one more.
     *
     * `auth.signIn` adds a session rather than replacing one, so this is also
     * "add account": the new mailbox becomes active and the previous one stays
     * connected behind it.
     */
    async signIn() {
      store.patch({ error: null });
      const session = await auth.signIn();
      // The patch lands in the store synchronously, so the refresh below — and
      // the Autocrypt harvest it triggers — already knows whose mailbox this is.
      await service.attach(session);
      await ctx.services.mailbox.refreshInbox();
    },

    /** Disconnect every account. Removing just one is `accounts.removeAccount`. */
    async signOut() {
      await auth.signOut();
      mail.current = null;
      mail.clients.clear();
      await saveAccounts(NO_ACCOUNTS);
      store.patch({
        session: null,
        accounts: [],
        activeAccount: null,
        unified: false,
        identity: null,
        messages: [],
        verifyLink: null,
      });
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
      mail.clients.clear();
      store.patch({
        session: null,
        // The account list goes too: leaving `activeAccount` set would let a
        // later write land in the store of a mailbox this device can no longer
        // reach, under a session that is gone.
        accounts: [],
        activeAccount: null,
        unified: false,
        identity: null,
        messages: [],
        verifyLink: null,
        loadingInbox: false,
        loadingMore: false,
        canLoadMore: false,
        error: message(e),
      });
      return true;
    },
  };

  return service;
}
