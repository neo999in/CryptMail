/**
 * Reading the mailbox: syncing it, opening a message, and flag changes.
 */
import { spamInputFor } from '../categorizer/categorizer';
import { core, PLACEHOLDER_SUBJECT } from '../core';
import { harvestAutocrypt } from '../keys';
import { applyFlagPatch } from '../mail/flags';
import { attachmentsOf, htmlOf, plainBodyOf } from '../mail/plainBody';
import { MailClient, Mailbox, MailSummary } from '../mail/types';
import { indexContent } from '../search/search';
import { extractLinks, learn, unlearn } from '../spam/spam';
import type { SpamMark } from '../spam/spam';
import { AccountId } from '../store/accountScope';
import { findKey } from '../store/keyring';
import { saveSearchIndex } from '../store/searchIndex';
import { saveSpamState, setMark } from '../store/spamModelStore';
import { Ctx, MailboxService, message } from './contracts';
import { trustForOpened } from './derive';
import { BoxState, InboxItem, OpenedMessage, SecondaryBox, State } from './types';

/**
 * Messages fetched per mailbox, per page.
 *
 * Deliberately modest: every id in a page costs the connector its own metadata
 * request, so this is the fan-out of one "load older" tap, not a display cap.
 */
const PAGE_SIZE = 20;

export function createMailbox(ctx: Ctx): MailboxService {
  const { store, mail } = ctx;

  /**
   * Learn every key the mailbox just handed us.
   *
   * `Autocrypt` is a cleartext header, so this costs one metadata field per
   * message and no decryption at all. Before this existed a key was only learned
   * if the user happened to *open* that message — which meant the common case,
   * "they wrote to me first", still ended in "no key for them" at compose time.
   */
  async function harvestFrom(messages: MailSummary[]) {
    let keyring = store.get().keyring;
    for (const summary of messages) {
      if (!summary.autocrypt) continue;
      if (summary.from.address === store.get().session?.email) continue;
      keyring = await harvestAutocrypt(keyring, summary.from.address, summary.autocrypt, summary.from.name);
    }
    await ctx.services.contacts.commitKeyring(keyring);
  }

  const tag = (messages: MailSummary[], account: AccountId): InboxItem[] =>
    messages.map((m) => ({ ...m, account }));

  /**
   * How far back each mailbox has been paged, by account.
   *
   * A missing entry means "not paged yet"; `null` means that account has handed
   * over its oldest message and has nothing further to give. Kept here rather
   * than in the store because it is provider bookkeeping, not something a screen
   * renders — screens read `canLoadMore`, which is derived from it below.
   */
  const cursors = new Map<string, string | null>();

  /** One cursor per mailbox *per account* — Sent pages independently of Inbox. */
  const cursorKey = (box: Mailbox, account: AccountId) => `${box}@${account}`;

  const exhausted = (box: Mailbox, account: AccountId) => cursors.get(cursorKey(box, account)) === null;

  /** True while any *listed* mailbox still has older mail to fetch. */
  function moreAvailable(box: Mailbox): boolean {
    const { unified, activeAccount } = store.get();
    if (!activeAccount) return false;
    // Only the inbox merges. Sent and Archive are the active account's own, so a
    // second mailbox's sent mail is never silently mixed into what you sent from
    // this one.
    const listed = unified && box === 'inbox' ? [...mail.clients.keys()] : [activeAccount];
    return listed.some((account) => !exhausted(box, account));
  }

  /**
   * The rows to show: one mailbox, or all of them merged.
   *
   * A merged list is newest-first across accounts and tolerant of one provider
   * failing — a Gmail account that is offline must not blank out the demo
   * account's inbox sitting beside it, so a failed client contributes nothing
   * and the rest still render. The active account is the exception: if *it*
   * fails the error is worth showing, and it is re-thrown.
   *
   * `mode: 'more'` asks each mailbox for the page behind the one it last
   * returned; `'refresh'` forgets every cursor and starts from the newest again.
   */
  async function collect(box: Mailbox, mode: 'refresh' | 'more'): Promise<InboxItem[]> {
    const { unified, activeAccount } = store.get();
    if (!activeAccount) return [];
    if (mode === 'refresh') {
      for (const key of [...cursors.keys()]) if (key.startsWith(`${box}@`)) cursors.delete(key);
    }

    async function page(account: AccountId, client: MailClient): Promise<InboxItem[]> {
      // An account that has already reached its oldest message is skipped rather
      // than re-fetching its newest page, which is what a `undefined` token means
      // to the provider.
      if (mode === 'more' && exhausted(box, account)) return [];
      const pageToken = mode === 'more' ? (cursors.get(cursorKey(box, account)) ?? undefined) : undefined;
      const result = await client.list(box, { limit: PAGE_SIZE, pageToken });
      cursors.set(cursorKey(box, account), result.nextPageToken ?? null);
      return tag(result.messages, account);
    }

    if (!unified || box !== 'inbox') {
      if (!mail.current) return [];
      return page(activeAccount, mail.current);
    }

    const lists = await Promise.all(
      [...mail.clients.entries()].map(async ([account, client]) => {
        try {
          return await page(account, client);
        } catch (e) {
          if (account === activeAccount) throw e;
          return [];
        }
      }),
    );
    return lists.flat();
  }

  const byDateDesc = (a: InboxItem, b: InboxItem) => b.date.localeCompare(a.date);

  /**
   * One box updated, the others untouched.
   *
   * `store.patch` is a shallow merge, so `boxes` has to be rebuilt whole or the
   * sibling box would be dropped.
   */
  function patchBox(box: SecondaryBox, change: Partial<BoxState>): State['boxes'] {
    const boxes = store.get().boxes;
    return { ...boxes, [box]: { ...boxes[box], ...change } };
  }

  /**
   * Newest first, and never the same message twice.
   *
   * Paging a live mailbox can hand back a row that is already on screen — mail
   * arriving between two pages shifts everything down by one — so an older page
   * is merged by id rather than appended.
   */
  function merge(existing: InboxItem[], older: InboxItem[]): InboxItem[] {
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const item of older) if (!byId.has(item.id)) byId.set(item.id, item);
    return [...byId.values()].sort(byDateDesc);
  }

  /**
   * Anchor pairs in a piece of readable markup, or `undefined` when there are
   * none.
   *
   * The distinction matters downstream: the categoriser falls back to the URLs
   * written in prose when it is given no pairs, and an empty array would suppress
   * that fallback while carrying no information of its own.
   */
  function linksIn(html: string): OpenedMessage['links'] {
    const found = extractLinks(html);
    return found.length > 0 ? found : undefined;
  }

  const service: MailboxService = {
    async refreshInbox() {
      if (!mail.current) return;
      store.patch({ loadingInbox: true, error: null });
      try {
        const messages = await collect('inbox', 'refresh');
        store.patch({ messages, loadingInbox: false, canLoadMore: moreAvailable('inbox') });
        await harvestFrom(messages);
        // Someone installing CryptMail is an external event with no notification
        // attached, so every sync is also a chance to notice that a held message
        // can finally go. Cheap: it only touches the network if something is held.
        await ctx.services.scheduler.drainHeld();
        await ctx.services.publish.refreshPublish();
      } catch (e) {
        if (ctx.services.session.handleAuthLoss(e)) return;
        store.patch({ loadingInbox: false, error: message(e) });
      }
    },

    /**
     * Fetch the page of older mail behind what is on screen and append it.
     *
     * Additive, unlike a sync: a refresh replaces the list from the newest
     * message down, so anything already paged in would be dropped if this went
     * through the same path. Held sends and key harvesting stay on the refresh
     * path — this is a read of old mail, not a reason to touch the network again.
     */
    async loadMoreInbox() {
      if (!mail.current) return;
      const { loadingInbox, loadingMore, canLoadMore } = store.get();
      if (loadingInbox || loadingMore || !canLoadMore) return;
      store.patch({ loadingMore: true, error: null });
      try {
        const older = await collect('inbox', 'more');
        store.patch({
          messages: merge(store.get().messages, older),
          loadingMore: false,
          canLoadMore: moreAvailable('inbox'),
        });
        await harvestFrom(older);
      } catch (e) {
        store.patch({ loadingMore: false });
        if (ctx.services.session.handleAuthLoss(e)) return;
        store.patch({ error: message(e) });
      }
    },

    /**
     * Load the newest page of Sent or Archive.
     *
     * These are their own lists rather than a filter over `messages`: the inbox
     * holds inbox mail, and a screen that showed sent mail by filtering it would
     * only ever show what happened to have been synced. Each keeps its own
     * cursor, so paging one does not disturb the other.
     *
     * The active account only, even when the inbox is merged — see
     * `moreAvailable`. No Autocrypt harvest either: our own sent mail carries our
     * own key, and archived mail was harvested when it arrived.
     */
    async loadBox(box) {
      if (!mail.current) return;
      store.patch({ boxes: patchBox(box, { loading: true, error: null }) });
      try {
        const items = await collect(box, 'refresh');
        store.patch({
          boxes: patchBox(box, {
            items: items.sort(byDateDesc),
            loading: false,
            canLoadMore: moreAvailable(box),
          }),
        });
      } catch (e) {
        store.patch({ boxes: patchBox(box, { loading: false }) });
        if (ctx.services.session.handleAuthLoss(e)) return;
        store.patch({ boxes: patchBox(box, { error: message(e) }) });
      }
    },

    async loadMoreBox(box) {
      if (!mail.current) return;
      const state = store.get().boxes[box];
      if (state.loading || state.loadingMore || !state.canLoadMore) return;
      store.patch({ boxes: patchBox(box, { loadingMore: true, error: null }) });
      try {
        const older = await collect(box, 'more');
        store.patch({
          boxes: patchBox(box, {
            items: merge(store.get().boxes[box].items, older),
            loadingMore: false,
            canLoadMore: moreAvailable(box),
          }),
        });
      } catch (e) {
        store.patch({ boxes: patchBox(box, { loadingMore: false }) });
        if (ctx.services.session.handleAuthLoss(e)) return;
        store.patch({ boxes: patchBox(box, { error: message(e) }) });
      }
    },

    /**
     * Open a message, from whichever mailbox it belongs to.
     *
     * A row from a *different* account switches to that account first rather
     * than reaching for its provider directly. Decryption needs that account's
     * identity, the sender's trust comes from its keyring, and the decrypted
     * text is indexed into its search index — reading one mailbox's mail while
     * another is loaded is exactly the leak this feature has to avoid.
     */
    async openMessage(summary): Promise<OpenedMessage> {
      const from = (summary as Partial<InboxItem>).account;
      if (from && from !== store.get().activeAccount) {
        await ctx.services.accounts.switchAccount(from);
      }

      if (!mail.current) throw new Error('Not connected.');
      const raw = await mail.current.getRaw(summary.id);

      if (!core.looksEncrypted(raw)) {
        return {
          summary,
          encryption: { kind: 'plain' },
          subject: summary.subject,
          body: plainBodyOf(raw),
          decrypted: null,
          // An ordinary email's files are right there in the MIME, in the clear.
          attachments: attachmentsOf(raw),
          raw,
          // Anchor pairs from the HTML part, if any. Read, never rendered: the
          // scan in `spam/urls.ts` extracts `href`/label pairs and drops
          // anything that is not http(s), so nothing executable is recorded.
          links: linksIn(htmlOf(raw)),
        };
      }

      try {
        const decrypted = await core.parseEncrypted(raw);

        // Autocrypt: cache the sender's key so replies encrypt without a paste
        // step. Same helper the inbox sync uses, and it swallows a malformed
        // header rather than letting it break reading the message.
        const keyring = await ctx.services.contacts.commitKeyring(
          await harvestAutocrypt(
            store.get().keyring,
            summary.from.address,
            decrypted.autocryptKey,
            summary.from.name,
          ),
        );

        // Index the decrypted subject/body so the inbox can search encrypted mail
        // by its real content — not just its sender. Only content decrypted on
        // this device is stored; unopened ciphertext stays unsearchable.
        const searchIndex = indexContent(store.get().searchIndex, summary.id, {
          subject: decrypted.subject,
          body: decrypted.body,
        });
        await saveSearchIndex(ctx.services.accounts.requireActive(), searchIndex);
        store.patch({ searchIndex });

        if (summary.from.address === store.get().session?.email) {
          return {
            summary,
            encryption: { kind: 'encrypted', trust: 'verified', own: true },
            subject: decrypted.subject,
            body: decrypted.body,
            decrypted,
            attachments: decrypted.attachments,
            raw,
          };
        }

        return {
          summary,
          encryption: {
            kind: 'encrypted',
            trust: trustForOpened(findKey(keyring, summary.from.address), decrypted),
          },
          subject: decrypted.subject,
          body: decrypted.body,
          decrypted,
          attachments: decrypted.attachments,
          raw,
        };
      } catch (e) {
        return {
          summary,
          encryption: { kind: 'encrypted', trust: 'unknown' },
          subject: summary.subject,
          body: '',
          decrypted: null,
          // Nothing was decrypted, so there is nothing to offer — an undecrypted
          // message has no readable files, only ciphertext.
          attachments: [],
          raw,
          error: message(e),
        };
      }
    },

    /**
     * Optimistic flag update: apply locally at once for a responsive feel, then
     * persist to the provider. If the provider rejects it, resync from the inbox.
     */
    /**
     * Optimistic flag update, sent to the provider the row actually came from.
     *
     * In a merged inbox `mail.current` is only one of several mailboxes, so
     * starring a row from another account through it would 404 — or, worse,
     * change a different message that happens to share an id.
     */
    async setFlags(id, change) {
      const row = store.get().messages.find((m) => m.id === id);
      const client = (row && mail.clients.get(row.account)) ?? mail.current;
      if (!client) return;
      store.patch({ messages: applyFlagPatch(store.get().messages, id, change) });
      try {
        await client.updateFlags(id, change);
      } catch {
        void service.refreshInbox();
      }
    },

    async toggleStar(id) {
      const starred = store.get().messages.find((m) => m.id === id)?.starred ?? false;
      await service.setFlags(id, { starred: !starred });
    },

    setUnread: (id, unread) => service.setFlags(id, { unread }),

    archiveMessage: (id) => service.setFlags(id, { archived: true }),

    markSpam: (id) => applyMark(id, 'spam'),

    markNotSpam: (id) => applyMark(id, 'ham'),
  };

  /**
   * Record the user's verdict for one message and train the filter from it.
   *
   * Three things happen together, and the order is the point:
   *
   * 1. the previous mark, if any, is **untrained** — otherwise a user who
   *    corrects themselves leaves both verdicts in the counts, and the filter
   *    learns that the message's tokens mean nothing in particular;
   * 2. the new mark is trained, from exactly the content this device can read
   *    (`spamInputFor` — an unopened encrypted message contributes its cleartext
   *    headers and nothing else);
   * 3. mark and model are persisted in one record, so a restart cannot restore a
   *    mark whose training was lost or vice versa.
   *
   * Marking spam does *not* archive or delete the message. The mark moves it to
   * the Spam category, which is a filing decision the user can reverse; removing
   * it from the mailbox is a different action with a different button.
   */
  async function applyMark(id: string, mark: SpamMark): Promise<void> {
    const state = store.get();
    const summary = state.messages.find((m) => m.id === id);
    if (!summary) return;

    // `state.spam` is the *active* account's model, so a row belonging to another
    // mailbox must not train it. In practice this cannot fire — opening a merged
    // row switches to its account first, and marking happens from the reader —
    // but the guard is what keeps that an invariant rather than an assumption.
    const account = ctx.services.accounts.requireActive();
    if (summary.account !== account) return;

    const encrypted = isEncrypted(summary);
    const input = spamInputFor(summary, encrypted, state.searchIndex, {
      selfAddress: state.session?.email,
    });

    const previous = state.spam.marks[id];
    let model = state.spam.model;
    if (previous === mark) return;
    if (previous) model = unlearn(model, input, previous);
    model = learn(model, input, mark);

    const spam = { model, marks: setMark(state.spam.marks, id, mark) };
    store.patch({ spam });
    await saveSpamState(account, spam);
  }

  return service;
}

/**
 * Whether a row is encrypted, from its headers alone.
 *
 * The same test `derive.ts` applies for the inbox badge, and it is the test that
 * decides whether the body may be read: a placeholder subject means the provider
 * is holding ciphertext, so only content in the local index is readable.
 */
const isEncrypted = (summary: MailSummary): boolean => summary.subject.trim() === PLACEHOLDER_SUBJECT;
