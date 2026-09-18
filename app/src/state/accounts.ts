/**
 * Which mailbox is in front, and what else is connected.
 *
 * The prototype held one session, and every local store was a single global
 * blob — so a second mailbox would have read the first one's keyring and
 * written its drafts. This module is the answer: it owns the account registry,
 * and every scoped store read or write in the app is keyed on the id it
 * returns from `requireActive()`.
 *
 * The rule that keeps two accounts from bleeding into one another is that
 * **exactly one is active at a time**, even when the inbox is merged. Reading
 * can be pooled; identity cannot. Deciding per message which key to decrypt
 * with, or which keyring a recipient's trust comes from, is precisely how state
 * leaks — so opening a merged-inbox row belonging to another account switches
 * to that account first (`mailbox.ts`), and composing always uses the active
 * one.
 */
import { auth, AuthError, Session } from '../auth';
import { imapAuth } from '../auth/imapAuth';
import { discoverSettings } from '../mail/autoconfig';
import { AccountId, accountRefFor, settingsOf } from '../store/accountScope';
import {
  loadAccounts,
  removeAccount as withoutAccount,
  saveAccounts,
  setAccountSettings,
  upsertAccount,
} from '../store/accountsStore';
import { PER_ACCOUNT_STORE_KEYS } from '../store';
import { MAIL_CACHE_STORE_KEY } from '../store/mailCacheStore';
import { SEARCH_STORE_KEY } from '../store/searchIndex';
import { SNOOZE_STORE_KEY } from '../store/snoozeStore';
import { emptySpamState, SPAM_STORE_KEY } from '../store/spamModelStore';
import { removeScoped } from '../store/secureJson';
import { clearRawCache, RAW_CACHE_STORE_KEY, rawCacheBytes } from '../store/rawCache';
import { measureAccountStorage } from '../store/storageUsage';
import { openTextFileWriter, saveTextFile } from '../lib/files';
import { emlFilename, entryToMbox, mboxFilename } from '../mail/mbox';
import { withRateLimitRetry } from '../mail/rateLimit';
import { Mailbox, MailSummary } from '../mail/types';
import { AccountsService, Ctx, message } from './contracts';

/**
 * What a whole-mailbox export pages through.
 *
 * Inbox, Sent and Archive are the mail the account keeps — `archive` is already
 * "everything not in the inbox, not sent, not a draft". Spam and Trash are
 * left out on purpose: one is mail the user did not want and the other mail
 * they deleted, and a backup that restores both into Thunderbird's inbox is
 * not what anyone asked for. The row says which folders it takes.
 */
const EXPORT_BOXES: Mailbox[] = ['inbox', 'sent', 'archive'];

/**
 * Rows per listing page. Gmail spends one metadata request per row, fired
 * together, so this is also how many run at once while listing — kept small,
 * because a burst of them is what exhausted the per-minute quota on a device.
 */
const EXPORT_PAGE_SIZE = 25;

/** Raw messages fetched at a time — well inside the provider's per-second quota. */
const EXPORT_CONCURRENCY = 5;

export function createAccounts(ctx: Ctx): AccountsService {
  const { store, mail } = ctx;

  /** Sessions for connected accounts, kept out of `State` for the same reason `mail` is. */
  const sessions = new Map<AccountId, Session>();

  async function persist(next: Awaited<ReturnType<typeof loadAccounts>>) {
    const saved = await saveAccounts(next);
    store.patch({ accounts: saved.accounts, activeAccount: saved.active, unified: saved.unified });
    return saved;
  }

  // Named ahead of the literal so `markReauth` can reuse `switchAccount`
  // rather than duplicating what a switch has to do.
  const service: AccountsService = {
    requireActive() {
      const id = store.get().activeAccount;
      if (!id) throw new Error('No account is connected.');
      return id;
    },

    sessionFor: (id) => sessions.get(id),

    async register(session, options) {
      const ref = accountRefFor(session.provider, session.email, {
        name: session.name,
        photo: session.photo,
      });
      sessions.set(ref.id, session);
      // A session in hand is proof the mailbox is reachable again, so whatever
      // marked it unreachable is stale. Clearing it here covers every route
      // back — a fresh sign-in, a background restore, a retried boot — rather
      // than asking each of them to remember.
      const stale = store.get().needsReauth;
      if (stale.includes(ref.id)) {
        store.patch({ needsReauth: stale.filter((id) => id !== ref.id) });
      }
      const saved = await persist(
        upsertAccount(await loadAccounts(), ref, options?.activate ?? true),
      );
      return options?.activate === false ? ref.id : (saved.active ?? ref.id);
    },

    /**
     * This mailbox needs a new sign-in.
     *
     * Nothing is erased and nothing is unlisted — the account keeps its place
     * in the switcher, wearing the reason. What goes is only what has actually
     * stopped working: the session and the provider built on it, so no later
     * sync can quietly retry with a token that cannot work.
     *
     * If it was the mailbox in front, another one takes over. Staying on an
     * account that cannot load is an inbox that shows an error forever while a
     * working mailbox sits one tap away in the drawer.
     */
    async markReauth(id, reason) {
      sessions.delete(id);
      mail.clients.delete(id);

      const { needsReauth, activeAccount, accounts } = store.get();
      store.patch({
        needsReauth: needsReauth.includes(id) ? needsReauth : [...needsReauth, id],
        ...(reason ? { error: reason } : {}),
      });

      if (id !== activeAccount) return;

      // Re-read rather than trusting the list captured above: when two mailboxes
      // lose their grant together — one merged refresh, both providers 401 —
      // these calls interleave, and the survivor this one picked may have had
      // its session dropped by the other in between. Choosing from the live map
      // at the moment of the switch is what keeps "step onto a working account"
      // from stepping onto one that just stopped working.
      // A paused mailbox is skipped as firmly as a disconnected one: stepping
      // onto it would resume syncing an account the user deliberately stopped,
      // as a side effect of a *different* account's token dying.
      const next = accounts.find((a) => a.id !== id && sessions.has(a.id) && !settingsOf(a).paused);
      if (!next || !sessions.has(next.id)) return;
      // Straight through `switchAccount`, so the arriving account loads its own
      // stores exactly as it would have on a tap. Reproducing that here is how
      // one account ends up rendering under another's id.
      await service.switchAccount(next.id);
    },

    /**
     * Put another connected mailbox in front.
     *
     * The in-flight state of the account being left — a half-finished inbox
     * load, an error banner about *its* provider — is cleared rather than
     * carried, because none of it describes the account arriving.
     */
    async switchAccount(id, options) {
      const { activeAccount, unified } = store.get();
      const nextUnified = options?.unified ?? unified;
      const moving = id !== activeAccount;
      if (!moving && nextUnified === unified) return;

      // Both changes land in one write and one refresh. Doing them as separate
      // `switchAccount` + `setUnified` calls would sync the mailbox twice — a
      // full merged page and then a full unmerged one — for a single tap.
      if (!moving) {
        await persist({ ...(await loadAccounts()), unified: nextUnified });
        await ctx.services.mailbox.refreshInbox();
        return;
      }

      // A paused mailbox has one door, and this is it: every way of choosing an
      // account — the rail, the account screen, a merged row being opened —
      // means "show me this mail", and refusing here would leave the rail with
      // an avatar that does nothing on tap.
      if (settingsOf(store.get().accounts.find((a) => a.id === id)).paused) {
        await service.resumeAccount(id);
        return;
      }

      const session = sessions.get(id);
      if (!session) {
        // Reported, not thrown. Every caller is a fire-and-forget `void` — a
        // drawer tap, and `markReauth` stepping off a dead mailbox — so a throw
        // here surfaced as an unhandled rejection rather than as anything the
        // user could read. Observed on a device when both accounts lost their
        // grant at once (2026-09-05).
        //
        // It deliberately does **not** start a sign-in on its own: opening
        // Google's picker as a side effect of a background auth failure is a
        // prompt the user did not ask for. The drawer offers that explicitly
        // for a mailbox it has already marked as needing one.
        store.patch({
          error: store.get().needsReauth.includes(id)
            ? 'That mailbox needs you to sign in again.'
            : 'That account is not connected.',
        });
        return;
      }

      store.patch({
        switchingAccount: true,
        error: null,
        loadingInbox: false,
        refreshingInbox: false,
        loadingMore: false,
        canLoadMore: false,
      });
      try {
        await persist({ ...(await loadAccounts()), active: id, unified: nextUnified });
        await ctx.services.session.attach(session);
      } catch (e) {
        store.patch({ error: message(e) });
      } finally {
        store.patch({ switchingAccount: false });
      }
      await ctx.services.mailbox.refreshInbox();
    },

    /** Connect one more mailbox. `auth.signIn` adds a session rather than replacing one. */
    async addAccount(provider, imap) {
      await ctx.services.session.signIn(provider, imap);
    },

    discoverImapSettings: (email) => discoverSettings(email),

    savedImapSettings: (email) => imapAuth.savedAccount(email),

    /**
     * Disconnect a mailbox and erase everything it owns on this device.
     *
     * The stores go with it deliberately: leaving a removed account's keyring
     * and search index — a plaintext copy of its mail — on disk would make
     * "remove account" a lie, and re-adding the address would silently adopt
     * data the user thought was gone.
     */
    async removeAccount(id) {
      // The address comes from the registry rather than from the live session,
      // because an account flagged `needsReauth` has no session left — and
      // `auth.signOut()` with no address means *every* account, which would
      // sign the user out of the mailboxes they are keeping.
      const ref = store.get().accounts.find((a) => a.id === id);
      const email = sessions.get(id)?.email ?? ref?.email;
      if (email) await auth.signOut(email, sessions.get(id)?.provider ?? ref?.provider);
      sessions.delete(id);
      mail.clients.delete(id);
      await removeScoped(PER_ACCOUNT_STORE_KEYS, id);
      // Files, not an AsyncStorage key, so not in that list — but just as much
      // this account's, and re-adding the address must not find them.
      await clearRawCache(id);
      await ctx.services.notify.forget(id);
      store.patch({ needsReauth: store.get().needsReauth.filter((flagged) => flagged !== id) });

      const saved = await persist(withoutAccount(await loadAccounts(), id));
      const next = saved.active ? sessions.get(saved.active) : undefined;
      if (next) {
        await ctx.services.session.attach(next);
        await ctx.services.mailbox.refreshInbox();
      } else {
        await ctx.services.session.signOut();
      }
    },

    /**
     * Write one mailbox's own settings.
     *
     * Any account, not only the one in front: the accounts screen can be opened
     * on a mailbox that is not active, and renaming it should not require
     * switching to it first (which would re-sync a mailbox the user is not
     * reading).
     *
     * Only a changed sync window re-lists anything. The other three are read at
     * render time from `state.accounts`, so `persist` alone is the whole update.
     */
    async updateAccount(id, patch) {
      const before = store.get().accounts.find((a) => a.id === id);
      await persist(setAccountSettings(await loadAccounts(), id, patch));

      const windowChanged =
        patch.syncWindow !== undefined && patch.syncWindow !== before?.settings?.syncWindow;
      if (windowChanged && (id === store.get().activeAccount || store.get().unified)) {
        await ctx.services.mailbox.refreshInbox();
      }
    },

    /**
     * Drop this device's cache of one mailbox and fetch it again.
     *
     * The in-memory copies are cleared alongside the stores, but only when the
     * account being reset is the one whose data is loaded — `state.searchIndex`
     * and friends belong to the active account, and blanking them while another
     * mailbox is in front would show that mailbox as empty until the next
     * switch.
     */
    async resetAccount(id, scope = 'all') {
      // The listed mail goes with the decrypted content in both scopes: the
      // cache holds subjects, snippets and addresses, so a reset that left it
      // behind would keep showing this mailbox's mail after the user asked for
      // this device's copy of it to be dropped.
      const bases =
        scope === 'content'
          ? [SEARCH_STORE_KEY, MAIL_CACHE_STORE_KEY]
          : [SEARCH_STORE_KEY, SPAM_STORE_KEY, SNOOZE_STORE_KEY, MAIL_CACHE_STORE_KEY];
      await removeScoped(bases, id);
      // The fetched messages go in both scopes too. They are still encrypted,
      // but they are this device's copy of the mailbox all the same.
      await clearRawCache(id);

      if (id === store.get().activeAccount) {
        store.patch({
          searchIndex: {},
          ...(scope === 'all' ? { spam: emptySpamState(), snoozed: {} } : {}),
        });
        await ctx.services.mailbox.refreshInbox();
      }
    },

    /**
     * Write one mailbox out as an mbox file — all of it, not the pages loaded.
     *
     * The mailbox is paged from the provider rather than read from `State`, so
     * the export is the same whatever the user happened to scroll through, and
     * it ignores the sync window: that setting filters what is listed, and a
     * backup that silently kept only the last 30 days would be a trap. Paging
     * from the provider also means a mailbox need not be in front — `State`
     * holds one account's lists, the provider holds every account's mail.
     *
     * The raw source is fetched per message rather than reconstructed from the
     * summaries: an export is a copy of the mail, and a copy assembled from the
     * fields this app happens to display is not one. Encrypted mail therefore
     * exports as the sealed message it is — see `mail/mbox.ts` for why that is
     * the right answer rather than a limitation.
     *
     * Each message is appended to the file as it arrives, so the mailbox is
     * never one string in memory. A listing failure ends the export, because
     * an export that silently stopped paging is not "the whole mailbox"; a
     * single message the provider refuses is skipped and counted instead —
     * forty-nine messages out is worth more than an error.
     */
    async exportMailbox(id, options) {
      const client = mail.clients.get(id);
      if (!client) throw new Error('That mailbox is not syncing, so there is nothing to export.');
      const onProgress = options?.onProgress;

      // Every folder, de-duplicated: a message can be listed in more than one,
      // and an mbox with it twice is a mailbox with it twice once imported.
      const seen = new Set<string>();
      const rows: MailSummary[] = [];
      for (const box of EXPORT_BOXES) {
        let pageToken: string | undefined;
        do {
          const page = await withRateLimitRetry(() => client.list(box, { limit: EXPORT_PAGE_SIZE, pageToken }));
          for (const row of page.messages) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            rows.push(row);
          }
          onProgress?.({ phase: 'listing', done: rows.length });
          pageToken = page.nextPageToken;
        } while (pageToken);
      }

      if (rows.length === 0) return { written: 0, skipped: 0 };

      // The registered type for an mbox. `text/plain` would open it in a text
      // viewer on the share sheet rather than offering a mail client.
      const file = openTextFileWriter(mboxFilename(client.address), 'application/mbox');
      let written = 0;
      let skipped = 0;
      for (let at = 0; at < rows.length; at += EXPORT_CONCURRENCY) {
        const batch = rows.slice(at, at + EXPORT_CONCURRENCY);
        const raws = await Promise.all(
          batch.map((row) =>
            // A rate limit is waited out first (`mail/rateLimit.ts`); only what
            // is still refused after that lands in the catch below.
            withRateLimitRetry(() => client.getRaw(row.id)).catch((e: unknown) => {
              // A dead grant is not one message's problem: every fetch after it
              // fails the same way, and "exported 0, skipped 4,000" would bury
              // the one sentence the user can act on.
              if (e instanceof AuthError) throw e;              // Deleted server-side since it was listed, or a transient failure.
              return null;
            }),
          ),
        );
        // In listing order, so the file reads newest-first per folder like the
        // provider served it.
        raws.forEach((raw, i) => {
          if (raw === null) {
            skipped += 1;
            return;
          }
          file.append(entryToMbox({ from: batch[i].from.address, date: batch[i].date, raw }));
          written += 1;
        });
        onProgress?.({ phase: 'fetching', done: at + batch.length, total: rows.length });
      }

      if (written > 0) await file.finish();
      return { written, skipped };
    },

    /**
     * Write one message out as an `.eml` file.
     *
     * The same rule as the mbox: the provider's bytes, verbatim, so an encrypted
     * message is saved sealed. Fetched again rather than taken from the reader,
     * which holds the *decrypted* message alongside it — keeping this path
     * unable to reach the plaintext is simpler than trusting every caller to
     * pass the right field.
     *
     * The active mailbox's provider, because a message is only ever open in the
     * mailbox in front: opening a merged-inbox row switches to its account first.
     */
    async exportMessage(summary) {
      const client = mail.clients.get(service.requireActive());
      if (!client) throw new Error('This mailbox is not syncing, so the message cannot be fetched.');
      const raw = await client.getRaw(summary.id);
      await saveTextFile(emlFilename(summary), raw, 'message/rfc822');
    },

    /**
     * Bytes this mailbox's stores occupy, for any connected mailbox.
     *
     * Read from the sealed values, never unsealed — which is what makes it
     * fair to ask about a mailbox that is not in front. See `storageUsage.ts`.
     */
    async storageUsage(id) {
      const [usage, raw] = await Promise.all([
        measureAccountStorage(id, PER_ACCOUNT_STORE_KEYS),
        rawCacheBytes(id),
      ]);
      return {
        total: usage.total + raw,
        byStore: { ...usage.byStore, [RAW_CACHE_STORE_KEY]: raw },
      };
    },

    /**
     * Stop syncing a mailbox, keeping everything it owns.
     *
     * The session is deliberately **kept** in memory while the app runs, so
     * resuming in the same session costs nothing. Only the client goes, and
     * that is what every sync path keys on: `mailbox.collect` iterates
     * `mail.clients`, so a paused mailbox contributes nothing to a merged inbox
     * without anything having to ask whether it is paused.
     */
    async pauseAccount(id) {
      const { accounts, activeAccount } = store.get();
      // "Still syncing" and not merely "listed": a paused mailbox and one whose
      // grant died are both unreadable, and stepping onto either would leave
      // the app showing an inbox that cannot load.
      const others = accounts.filter(
        (a) => a.id !== id && !settingsOf(a).paused && sessions.has(a.id),
      );
      if (others.length === 0) {
        store.patch({
          error: 'This is the only mailbox still syncing. Sign out instead of pausing it.',
        });
        return;
      }

      mail.clients.delete(id);
      await persist(setAccountSettings(await loadAccounts(), id, { paused: true }));

      if (id !== activeAccount) return;
      // Straight through `switchAccount`, for the same reason `markReauth`
      // does: the arriving mailbox must load its own stores exactly as it
      // would on a tap.
      await service.switchAccount(others[0].id);
    },

    /**
     * Sync it again, and put it in front.
     *
     * Unpausing without switching would leave the mailbox syncing into a merged
     * list the user may not be looking at, with nothing on screen to show the
     * tap did anything — so resuming means "bring it back", which is what
     * `attach` does.
     */
    async resumeAccount(id) {
      const ref = store.get().accounts.find((a) => a.id === id);
      if (!ref) return;
      await persist(setAccountSettings(await loadAccounts(), id, { paused: false }));

      // Held from before it was paused, or gone because this is a fresh launch
      // and boot skipped it. Only the second case costs a round trip.
      let session = sessions.get(id);
      if (!session) {
        try {
          [session] = await auth.restoreAll([ref.email], ref.provider);
        } catch {
          session = undefined;
        }
      }
      if (!session) {
        // Flagged rather than reported as a resume failure: the mailbox is
        // un-paused and simply needs a new sign-in, which the rail and its own
        // screen already offer.
        await service.markReauth(id, 'That mailbox needs you to sign in again.');
        return;
      }

      store.patch({ switchingAccount: true, error: null });
      try {
        await ctx.services.session.attach(session);
      } catch (e) {
        store.patch({ error: message(e) });
      } finally {
        store.patch({ switchingAccount: false });
      }
      await ctx.services.mailbox.refreshInbox();
    },

    async setUnified(on) {
      await persist({ ...(await loadAccounts()), unified: on });
      await ctx.services.mailbox.refreshInbox();
    },
  };

  return service;
}
