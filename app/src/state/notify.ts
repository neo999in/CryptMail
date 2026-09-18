/**
 * New-mail notifications: noticing new mail, and deciding whether to post.
 *
 * Two ways in, one path:
 *
 * - **`observe(rows)`** is called by every inbox sync with what it just listed
 *   — the mailbox in front, or all of them while merged.
 * - **`checkAll()`** is the background pass's own look: the newest page of
 *   every connected mailbox's inbox, whether or not it is on screen.
 *
 * Both fold rows into the mailbox's ledger (`notifications/newMail.ts`) and,
 * if there is news, ask `notifications/policy.ts` what may be said and hand
 * that to the OS (`notifications/os.ts`). Nothing here chooses words.
 *
 * Mail the user can already see posts nothing: while CryptMail is in the
 * foreground, a mailbox on screen has its count cleared instead. That is also
 * what happens when the app comes back to the front (`clear`).
 */
import { MailSummary } from '../mail/types';
import { NotifyLedger, clearPending, EMPTY_LEDGER, ledgerChanged, observe, toNewMail } from '../notifications/newMail';
import { NotificationTap, OsNotifier } from '../notifications/os';
import { planFor } from '../notifications/policy';
import { AccountId, settingsOf } from '../store/accountScope';
import {
  loadLedger,
  loadNotificationPrefs,
  NotificationPrefs,
  saveLedger,
  saveNotificationPrefs,
} from '../store/notifyStore';
import { Ctx, NotifyService } from './contracts';
import { InboxItem } from './types';

/** The background look is the newest page of each inbox, and no further back than news can be. */
const CHECK_LIMIT = 10;
const CHECK_WINDOW_DAYS = 2;

export function createNotify(ctx: Ctx, os: OsNotifier): NotifyService {
  const { store, mail } = ctx;

  /** Read once per mailbox per run, then kept here: every sync consults it. */
  const ledgers = new Map<AccountId, NotifyLedger>();
  /** One fold at a time per mailbox, so a sync and a background check cannot both write back. */
  const queues = new Map<AccountId, Promise<void>>();

  function serially(account: AccountId, work: () => Promise<void>): Promise<void> {
    const previous = queues.get(account) ?? Promise.resolve();
    const next = previous.then(work, work).catch((e) => console.warn('Notification bookkeeping failed', e));
    queues.set(account, next);
    return next;
  }

  async function ledgerFor(account: AccountId): Promise<NotifyLedger> {
    const cached = ledgers.get(account);
    if (cached) return cached;
    const loaded = await loadLedger(account).catch(() => EMPTY_LEDGER);
    ledgers.set(account, loaded);
    return loaded;
  }

  async function commit(account: AccountId, before: NotifyLedger, after: NotifyLedger): Promise<void> {
    ledgers.set(account, after);
    if (ledgerChanged(before, after)) await saveLedger(account, after);
  }

  /** Whether this mailbox posts at all, by the user's say. */
  function enabledFor(account: AccountId): boolean {
    const { notificationPrefs, accounts } = store.get();
    if (!os.supported || notificationPrefs.preview === 'off') return false;
    const ref = accounts.find((a) => a.id === account);
    if (!ref) return false;
    const settings = settingsOf(ref);
    return settings.notify && !settings.paused;
  }

  /** On screen right now — so the user sees new mail arrive without being told. */
  function inView(account: AccountId): boolean {
    if (!os.foreground()) return false;
    const { unified, activeAccount } = store.get();
    return unified ? mail.clients.has(account) : account === activeAccount;
  }

  /**
   * What this device has read of an encrypted row, if anything.
   *
   * Only the mailbox in front has its search index loaded, so another
   * mailbox's encrypted mail counts as unread-by-us — generic, which is the
   * policy's answer for anything it cannot vouch for.
   */
  function readableOf(account: AccountId, row: MailSummary) {
    const { activeAccount, searchIndex } = store.get();
    return account === activeAccount ? searchIndex[row.id] : undefined;
  }

  function fold(account: AccountId, rows: MailSummary[]): Promise<void> {
    return serially(account, async () => {
      const self = store.get().accounts.find((a) => a.id === account)?.email ?? '';
      const before = await ledgerFor(account);
      const result = observe(before, rows, { self, scope: store.get().notificationPrefs.scope, now: new Date() });
      let after = result.ledger;

      if (!enabledFor(account) || inView(account)) {
        if (before.pending.length > 0) await os.dismiss(account);
        after = clearPending(after);
      } else if (result.fresh.length > 0) {
        const plan = planFor(
          result.pending.map((row) => toNewMail(row, readableOf(account, row))),
          store.get().notificationPrefs.preview,
          { locked: os.deviceLocked() },
        );
        if (plan.post) {
          const detailed = plan.content !== plan.lockScreen;
          const messageIds = result.pending.map((row) => row.id);
          const messageId = messageIds.length === 1 ? messageIds[0] : undefined;
          await os.post(account, plan.content, detailed, { account, messageId, messageIds });
        }
      } else if (after.pending.length === 0 && before.pending.length > 0) {
        // Everything it counted was read somewhere else.
        await os.dismiss(account);
      }

      await commit(account, before, after);
    });
  }

  const service: NotifyService = {
    async loadPrefs() {
      store.patch({ notificationPrefs: await loadNotificationPrefs() });
    },

    async setPrefs(patch) {
      const next: NotificationPrefs = { ...store.get().notificationPrefs, ...patch };
      store.patch({ notificationPrefs: next });
      store.patch({ notificationPrefs: await saveNotificationPrefs(next) });
      if (next.preview === 'off') await service.clear([...store.get().accounts.map((a) => a.id)]);
    },

    async observe(rows: InboxItem[]) {
      const byAccount = new Map<AccountId, MailSummary[]>();
      for (const row of rows) {
        const list = byAccount.get(row.account) ?? [];
        list.push(row);
        byAccount.set(row.account, list);
      }
      await Promise.all([...byAccount].map(([account, list]) => fold(account, list)));
    },

    async checkAll() {
      await Promise.all(
        [...mail.clients].map(async ([account, client]) => {
          if (!enabledFor(account)) return;
          try {
            const page = await client.list('inbox', { limit: CHECK_LIMIT, newerThanDays: CHECK_WINDOW_DAYS });
            await fold(account, page.messages);
          } catch {
            // Offline, or a grant that needs a sign-in: the next check, or
            // opening the app, is where that surfaces. A background look must
            // not flag an account on one failed request.
          }
        }),
      );
    },

    async clear(accounts) {
      const targets = accounts ?? [...mail.clients.keys()];
      await Promise.all(
        targets.map((account) =>
          serially(account, async () => {
            const before = await ledgerFor(account);
            if (before.pending.length === 0) return;
            await os.dismiss(account);
            await commit(account, before, clearPending(before));
          }),
        ),
      );
    },

    async forget(account) {
      ledgers.delete(account);
      await os.dismiss(account);
    },

    wanted() {
      const { notificationPrefs, accounts } = store.get();
      if (!os.supported || notificationPrefs.preview === 'off') return false;
      return accounts.some((ref) => {
        const settings = settingsOf(ref);
        return settings.notify && !settings.paused;
      });
    },

    async markRead(account, ids) {
      if (ids.length === 0) return;
      // Headless, only the mailbox that was in front was booted. The button
      // belongs to whichever mailbox posted it.
      if (!mail.clients.has(account)) await ctx.services.session.restoreOthers().catch(() => undefined);
      const client = mail.clients.get(account);
      if (!client) return;

      const listed = new Set(store.get().messages.filter((m) => m.account === account).map((m) => m.id));
      const done: string[] = [];
      for (const id of ids) {
        try {
          // A row on screen goes through the tap's own path, so the list
          // updates with it; anything else straight to its own provider.
          if (listed.has(id)) await ctx.services.mailbox.setFlags(id, { unread: false });
          else await client.updateFlags(id, { unread: false });
          done.push(id);
        } catch {
          // Left unread, and left counted — the notification stays so the
          // button can be pressed again.
        }
      }

      await serially(account, async () => {
        const before = await ledgerFor(account);
        const gone = new Set(done);
        const after = { ...before, pending: before.pending.filter((id) => !gone.has(id)) };
        if (after.pending.length === 0 && done.length === ids.length) await os.dismiss(account);
        await commit(account, before, after);
      });
    },

    tapped(tap: NotificationTap) {
      store.patch({ notificationTap: tap });
    },

    consumeTap() {
      store.patch({ notificationTap: null });
    },
  };

  return service;
}
