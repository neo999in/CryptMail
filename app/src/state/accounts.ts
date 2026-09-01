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

  const service: AccountsService = {
    requireActive() {
      const id = store.get().activeAccount;
      if (!id) throw new Error('No account is connected.');
      return id;
    },

    sessionFor: (id) => sessions.get(id),

    async register(session) {
      const ref = accountRefFor(session.provider, session.email);
      sessions.set(ref.id, session);
      const saved = await persist(upsertAccount(await loadAccounts(), ref));
      return saved.active ?? ref.id;
    },

    /**
     * Put another connected mailbox in front.
     *
     * The in-flight state of the account being left — a half-finished inbox
     * load, an error banner about *its* provider — is cleared rather than
     * carried, because none of it describes the account arriving.
     */
    async switchAccount(id) {
      if (id === store.get().activeAccount) return;
      const session = sessions.get(id);
      if (!session) throw new Error('That account is not connected.');

      store.patch({
        switchingAccount: true,
        error: null,
        loadingInbox: false,
        loadingMore: false,
        canLoadMore: false,
      });
      try {
        await persist({ ...(await loadAccounts()), active: id });
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
      await auth.signOut(sessions.get(id)?.email);
      sessions.delete(id);
      mail.clients.delete(id);
      await removeScoped(PER_ACCOUNT_STORE_KEYS, id);

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
