/**
 * Signing in, signing out, and everything this account owns on this device.
 */
import { auth, Session } from '../auth';
import { needsReauth } from '../auth/types';
import { core, Identity } from '../core';
import { Drafts } from '../drafts/drafts';
import { imapAuth } from '../auth/imapAuth';
import { createGmailClient } from '../mail/gmail';
import { createGraphClient } from '../mail/graph';
import { createImapClient } from '../mail/imap';
import { openTcpSocket } from '../mail/tcpSocket';
import { MailClient } from '../mail/types';
import { ScheduledOutbox } from '../outbox/outbox';
import { SearchIndex } from '../search/search';
import { initStorage } from '../store';
import { AccountId, AccountRef, settingsOf } from '../store/accountScope';
import { loadAccounts, NO_ACCOUNTS, saveAccounts } from '../store/accountsStore';
import { loadDrafts } from '../store/draftsStore';
import { InviteLog, loadInvites } from '../store/inviteStore';
import { Keyring, loadKeyring } from '../store/keyring';
import { loadMailCache } from '../store/mailCacheStore';
import { loadOutbox } from '../store/outboxStore';
import { loadPublishState, PublishState } from '../store/publishStore';
import { loadRecoveryState, RecoveryState } from '../store/recoveryStore';
import { loadSearchIndex } from '../store/searchIndex';
import { loadSpamState, SpamState } from '../store/spamModelStore';
import { SnoozeMap } from '../snooze/snooze';
import { loadSnoozes } from '../store/snoozeStore';
import { LabelState } from '../labels/labels';
import { loadLabels } from '../store/labelsStore';
import { RulesState } from '../rules/rules';
import { loadRules } from '../store/rulesStore';
import { Ctx, message, SessionService } from './contracts';
import { emptyBox } from './store';
import { InboxItem, SECONDARY_BOXES, State } from './types';

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
  /** This mailbox's local labels, and its filters & rules. */
  labels: LabelState;
  rules: RulesState;
  /**
   * The mail this device listed last time, so the list has rows before the
   * network answers.
   *
   * A cache, not a sync: the refresh that follows every attach replaces both of
   * these outright (`mailbox.refreshInbox`, `mailbox.loadBox`), so nothing
   * downstream has to tell a cached row from a fetched one — a moment later
   * there are only fetched ones. Its whole job is the first frame.
   */
  messages: InboxItem[];
  boxes: State['boxes'];
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

    const client = buildClient(session);
    mail.clients.set(account, client);
    return client;
  }

  function buildClient(session: Session): MailClient {
    if (session.provider === 'imap') {
      // No token: the connector reads its servers and password from the
      // keystore each time it connects. `imapAuth` only restores a session on a
      // build with a socket module, so the null here is unreachable in practice
      // — and says why rather than crashing if it ever is reached.
      const open =
        openTcpSocket ??
        (() => Promise.reject(new Error('This build cannot open a connection to a mail server.')));
      return createImapClient(session.email, () => imapAuth.credentialFor(session.email), { open });
    }
    const token = () => auth.freshAccessToken(session.email, session.provider);
    return session.provider === 'outlook'
      ? createGraphClient(session.email, token)
      : createGmailClient(session.email, token);
  }

  async function load(session: Session, account: AccountId): Promise<Attached> {
    mail.current = clientFor(session, account);

    // The keyring starts empty and fills from what the mailbox actually
    // carries — Autocrypt headers on inbound mail, directory lookups, and keys
    // the user pastes in. It used to be seeded with three fabricated contacts
    // so the demo inbox could display every trust state at once; with the
    // fixture mailbox gone there is nothing for those keys to be attached to,
    // and inventing a "verified" contact the user never verified was always
    // the wrong thing to put in a keyring.
    //
    // All at once, not one after another: this stands between launch and the
    // first sync, and each read is its own key under this account, so none of
    // them waits on another. Awaited in sequence it was ten storage round trips
    // — plus a decrypt each — before the inbox was even asked for.
    const [
      identity,
      keyring,
      recovery,
      publish,
      invites,
      searchIndex,
      drafts,
      scheduled,
      spam,
      snoozed,
      labels,
      rules,
      cached,
    ] = await Promise.all([
      core.loadIdentity(session.email),
      loadKeyring(account),
      loadRecoveryState(account),
      loadPublishState(account),
      loadInvites(account),
      loadSearchIndex(account),
      loadDrafts(account),
      loadOutbox(account),
      loadSpamState(account),
      loadSnoozes(account),
      loadLabels(account),
      loadRules(account),
      loadMailCache<InboxItem>(account),
    ]);

    return {
      identity,
      recovery,
      publish,
      invites,
      keyring,
      searchIndex,
      drafts,
      scheduled,
      spam,
      snoozed,
      labels,
      rules,
      messages: cached.messages,
      // Rebuilt whole rather than patched, because this is an account *arriving*:
      // the box state of the mailbox being left — its cursors' `canLoadMore`, a
      // half-finished load, an error about its provider — describes a different
      // mailbox and must not be inherited. `canLoadMore` stays false until a real
      // fetch sets it, since the cursors these rows were paged with are gone.
      boxes: Object.fromEntries(
        SECONDARY_BOXES.map((box) => [box, { ...emptyBox(), items: cached.boxes[box] ?? [] }]),
      ) as State['boxes'],
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
    refs: AccountRef[],
  ): Promise<{ session: Session | null; error: unknown }> {
    let error: unknown = null;
    for (const ref of refs) {
      try {
        const [session] = await auth.restoreAll([ref.email], ref.provider);
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
  async function restoreRest(refs: AccountRef[], isCancelled: () => boolean) {
    let arrived = false;

    for (const ref of refs) {
      if (isCancelled()) return;
      const id = ref.id;
      try {
        const [session] = await auth.restoreAll([ref.email], ref.provider);
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
    async boot(isCancelled, opts) {
      try {
        // Before anything reads a store. Every local store is encrypted at rest
        // and none of them can be decrypted until the device key is loaded.
        await initStorage();
        // Local and quick, and wanted before the first sync can notice new mail.
        await ctx.services.notify.loadPrefs().catch(() => undefined);

        // Which mailboxes this device has, and which was in front. Read first
        // now, not last: the provider cannot enumerate the grants it holds, so
        // this registry is what tells it which addresses to ask for.
        const stored = await loadAccounts();
        // A paused mailbox is listed but not asked for. Restoring it would cost
        // a Play-services round trip per launch for mail the user has said they
        // do not want fetched — and would hand it a client, which is the only
        // thing a merged sync looks at. It comes back through
        // `accounts.resumeAccount`, which restores it on demand.
        const syncing = stored.accounts.filter((a) => !settingsOf(a).paused);
        const ordered = [
          ...syncing.filter((a) => a.id === stored.active),
          ...syncing.filter((a) => a.id !== stored.active),
        ];

        // Nothing stored means a first launch, or an install from before the
        // registry existed — both of which want whoever Play services has.
        const { session: wanted, error } = ordered.length
          ? await firstRestorable(ordered)
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

        if (opts?.restoreOthers === false) return;
        void restoreRest(
          ordered.filter((a) => a.id !== account),
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
    async signIn(provider, imap) {
      // Held from the picker opening until the new mailbox is attached, so the
      // app shows a loader rather than the previous mailbox's inbox meanwhile —
      // and cleared either way, since a cancelled picker must not leave it up.
      store.patch({ error: null, addingAccount: true });
      try {
        const session = await auth.signIn(provider, imap);
        // The patch lands in the store synchronously, so the refresh below — and
        // the Autocrypt harvest it triggers — already knows whose mailbox this is.
        await service.attach(session);
      } finally {
        store.patch({ addingAccount: false });
      }
      await ctx.services.mailbox.refreshInbox();
    },

    /**
     * Bring back every syncing mailbox a `restoreOthers: false` boot left out.
     *
     * The background pass calls it when notifications want every mailbox
     * looked at, not only the one whose outbox it drains. Resolves once each
     * has been tried; one that will not restore is flagged, as at boot.
     */
    async restoreOthers() {
      const missing = store
        .get()
        .accounts.filter((ref) => !settingsOf(ref).paused && !mail.clients.has(ref.id));
      if (missing.length > 0) await restoreRest(missing, () => false);
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
        refreshingInbox: false,
        loadingMore: false,
        canLoadMore: false,
        error: message(e),
      });
      return true;
    },
  };

  return service;
}
