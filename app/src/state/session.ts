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
import { SnoozeMap } from '../snooze/snooze';
import { loadSnoozes } from '../store/snoozeStore';
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
  /** Which of this mailbox's messages are hidden until a later time. */
  snoozed: SnoozeMap;
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
      snoozed: await loadSnoozes(account),
      verifyLink: null,
    };
  }

  /**
   * The first of these mailboxes the provider will actually hand back.
   *
   * Each address is asked for on its own so one dead grant does not decide the
   * launch: the account the user left in front is tried first, and if its grant
   * is gone the next mailbox opens instead of the connect screen. Whatever was
   * skipped is flagged by `restoreRest`, which sees it again.
   */
  async function firstRestorable(
    addresses: string[],
  ): Promise<{ session: Session | null; error: unknown }> {
    let error: unknown = null;
    for (const address of addresses) {
      try {
        const [session] = await auth.restoreAll([address]);
        if (session) return { session, error: null };
      } catch (e) {
        // Kept, not thrown: the next mailbox may open fine, and only if none
        // of them does has the user actually lost the app. Reporting the first
        // failure then is better than the last, which on a mixed launch would
        // describe whichever account happened to be tried last.
        error ??= e;
      }
    }
    return { session: null, error };
  }

  /**
   * Bring back every other connected mailbox, after the first paint.
   *
   * Registered without activating: the user is already reading the mailbox that
   * arrived first, and a background restore must not move it. Each one gets its
   * provider up front so the merged inbox can list it without a sign-in round
   * trip mid-scroll.
   *
   * An address that will not restore is **flagged, not dropped**. Silently
   * omitting it is what made a revoked second mailbox invisible — present in the
   * switcher, contributing nothing to the merged inbox, with nothing on screen
   * saying why.
   */
  async function restoreRest(addresses: string[], isCancelled: () => boolean) {
    let arrived = false;

    for (const address of addresses) {
      if (isCancelled()) return;
      const id = accountIdFor('gmail', address);
      try {
        const [session] = await auth.restoreAll([address]);
        if (!session) {
          await ctx.services.accounts.markReauth(id);
          continue;
        }
        await ctx.services.accounts.register(session, { activate: false });
        clientFor(session, id);
        arrived = true;
      } catch {
        // Transient or permanent, the answer on a background restore is the
        // same: this mailbox is not reachable right now and says so. No error
        // banner — the user asked for the account in front, not this one.
        await ctx.services.accounts.markReauth(id);
      }
    }

    // A merged inbox drawn before these arrived is missing their mail, so it is
    // re-collected now that their providers exist. An unmerged one already
    // shows everything it claims to.
    if (arrived && !isCancelled() && store.get().unified) {
      await ctx.services.mailbox.refreshInbox();
    }
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

    /**
     * Restore the mailbox that was in front, paint it, then bring the rest back
     * behind it.
     *
     * The two phases are the point. Restoring an account is a Play-services
     * round trip that the provider takes one at a time (`auth/googleAuth.ts`),
     * so putting all of them in front of the first paint would make a second
     * mailbox cost every launch — the user waiting on a mailbox they are not
     * looking at. The rest arrive in the switcher and in the merged inbox a
     * moment later.
     */
    async boot(isCancelled) {
      try {
        // Before anything reads a store. Every local store is encrypted at rest
        // and none of them can be decrypted until the device key is loaded.
        await initStorage();

        // Which mailboxes this device has, and which was in front. Read first
        // now, not last: the provider cannot enumerate the grants it holds, so
        // this registry is what tells it which addresses to ask for.
        const stored = await loadAccounts();
        const ordered = [
          ...stored.accounts.filter((a) => a.id === stored.active),
          ...stored.accounts.filter((a) => a.id !== stored.active),
        ];

        // Nothing stored means a first launch, or an install from before the
        // registry existed — both of which want whoever Play services has.
        const { session: wanted, error } = ordered.length
          ? await firstRestorable(ordered.map((a) => a.email))
          : { session: (await auth.restoreAll())[0] ?? null, error: null };

        if (!wanted) {
          // No mailbox opened. Whether that is "signed out" or "something went
          // wrong" is the difference between a connect screen the user
          // understands and one that silently lost their accounts.
          if (!isCancelled()) store.patch({ booting: false, error: error ? message(error) : null });
          return;
        }

        const account = await ctx.services.accounts.register(wanted);
        clientFor(wanted, account);
        const attached = await load(wanted, account);
        if (isCancelled()) return;
        store.patch({ booting: false, session: wanted, ...attached });

        void restoreRest(
          ordered.filter((a) => a.id !== account).map((a) => a.email),
          isCancelled,
        );
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
    handleAuthLoss(e, account) {
      if (!needsReauth(e)) return false;

      // One of several mailboxes: flag it, step off it, and leave the others
      // signed in. Clearing everything here was correct only while there could
      // be just one account — with two it signs the user out of a mailbox that
      // is working because a different one's grant expired.
      const { accounts, activeAccount } = store.get();
      const failed = account ?? activeAccount;
      const survivor = accounts.find((a) => a.id !== failed && ctx.services.accounts.sessionFor(a.id));
      if (failed && survivor) {
        void ctx.services.accounts.markReauth(failed, message(e));
        return true;
      }

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
