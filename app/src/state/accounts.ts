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
import { auth, Session } from '../auth';
import { AccountId, accountRefFor } from '../store/accountScope';
import {
  loadAccounts,
  removeAccount as withoutAccount,
  saveAccounts,
  upsertAccount,
} from '../store/accountsStore';
import { PER_ACCOUNT_STORE_KEYS } from '../store';
import { removeScoped } from '../store/secureJson';
import { AccountsService, Ctx, message } from './contracts';

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
      const next = accounts.find((a) => a.id !== id && sessions.has(a.id));
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
    async addAccount() {
      await ctx.services.session.signIn();
    },

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
      const email = sessions.get(id)?.email ?? store.get().accounts.find((a) => a.id === id)?.email;
      if (email) await auth.signOut(email);
      sessions.delete(id);
      mail.clients.delete(id);
      await removeScoped(PER_ACCOUNT_STORE_KEYS, id);
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

    async setUnified(on) {
      await persist({ ...(await loadAccounts()), unified: on });
      await ctx.services.mailbox.refreshInbox();
    },
  };

  return service;
}
