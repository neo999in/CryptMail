/**
 * Reading the mailbox: syncing it, opening a message, and flag changes.
 */
import { needsReauth } from '../auth/types';
import { providerFiledAsJunk, spamInputFor } from '../categorizer/categorizer';
import { core, PLACEHOLDER_SUBJECT } from '../core';
import { harvestAutocrypt } from '../keys';
import { applyFlagPatch } from '../mail/flags';
import { attachmentsOf, htmlOf, plainBodyOf } from '../mail/plainBody';
import { FlagPatch, MailClient, Mailbox, MailSummary } from '../mail/types';
import { indexContent } from '../search/search';
import { extractLinks, learn, unlearn } from '../spam/spam';
import type { SpamMark } from '../spam/spam';
import { AccountId } from '../store/accountScope';
import { findKey } from '../store/keyring';
import { saveSearchIndex } from '../store/searchIndex';
import { saveSpamState, setMark } from '../store/spamModelStore';
import { Ctx, MailboxService, message } from './contracts';
import { trustForOpened } from './derive';
import { BoxState, InboxItem, OpenedMessage, SECONDARY_BOXES, SecondaryBox, State } from './types';

/**
 * Messages fetched per mailbox, per page.
 *
 * Deliberately modest: every id in a page costs the connector its own metadata
 * request, so this is the fan-out of one "load older" tap, not a display cap.
 */
const PAGE_SIZE = 20;

/**
 * The junk folder is paged like the inbox, but a page of it is smaller.
 *
 * Every sync now lists two mailboxes, and each id in each page is its own
 * metadata request — so a full-size junk page would double the burst of parallel
 * requests a refresh makes, on the path the Gmail notes already call the most
 * likely cause of a failed sync (docs/gmail-api-adoption.md, quota). Spam is a
 * list people check rather than read, so ten rows is the right first page and
 * "load older mail" reaches the rest.
 */
const JUNK_PAGE_SIZE = 10;

export function createMailbox(ctx: Ctx): MailboxService {
  const { store, mail } = ctx;

  /**
   * Learn every key the mailbox just handed us.
   *
   * `Autocrypt` is a cleartext header, so this costs one metadata field per
   * message and no decryption at all. Before this existed a key was only learned
   * if the user happened to *open* that message — which meant the common case,
   * "they wrote to me first", still ended in "no key for them" at compose time.
   *
   * Plaintext mail the provider filed as junk is skipped. A key is a lasting
   * statement about who a contact is, and a sync that harvested from the junk
   * folder would let anyone who can put mail in it seed this device's keyring.
   * Encrypted junk is still harvested: the provider's verdict on ciphertext is
   * not evidence (`categorizer.ts`), and a message that arrived encrypted is
   * precisely the case this exists for.
   */
  async function harvestFrom(messages: MailSummary[]) {
    let keyring = store.get().keyring;
    for (const summary of messages) {
      if (!summary.autocrypt) continue;
      if (summary.from.address === store.get().session?.email) continue;
      if (providerFiledAsJunk(summary.labels) && !isEncrypted(summary)) continue;
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

  /**
   * Which mailboxes a merged inbox merges.
   *
   * The inbox and the junk folder, because both feed the one list the inbox
   * screen renders: a Spam view holding every account's local verdicts but only
   * one account's provider-flagged mail would be a merged list with a hole in it.
   * Sent and Archive stay the active account's own — see `moreAvailable`.
   */
  const mergesAccounts = (box: Mailbox): boolean => box === 'inbox' || box === 'spam';

  /** True while any *listed* mailbox still has older mail to fetch. */
  function moreAvailable(box: Mailbox): boolean {
    const { unified, activeAccount } = store.get();
    if (!activeAccount) return false;
    // Only the inbox and its junk folder merge. Sent and Archive are the active
    // account's own, so a second mailbox's sent mail is never silently mixed into
    // what you sent from this one.
    const listed = unified && mergesAccounts(box) ? [...mail.clients.keys()] : [activeAccount];
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
      const result = await client.list(box, { limit: box === 'spam' ? JUNK_PAGE_SIZE : PAGE_SIZE, pageToken });
      cursors.set(cursorKey(box, account), result.nextPageToken ?? null);
      return tag(result.messages, account);
    }

    if (!unified || !mergesAccounts(box)) {
      if (!mail.current) return [];
      return page(activeAccount, mail.current);
    }

    const lists = await Promise.all(
      [...mail.clients.entries()].map(async ([account, client]) => {
        try {
          return await page(account, client);
        } catch (e) {
          if (account === activeAccount) throw e;
          // A mailbox that is merely offline contributes nothing and will be
          // back on the next refresh. One whose grant is gone will not, and
          // used to sit in the switcher silently adding no mail — so it is
          // flagged here, which is the only place the failure is seen.
          if (needsReauth(e)) ctx.services.session.handleAuthLoss(e, account);
          return [];
        }
      }),
    );
    return lists.flat();
  }

  /**
   * Everything the inbox screen lists: the inbox, plus the provider's junk folder.
   *
   * Spam is fetched here rather than being its own screen because in this app junk
   * is a *category*, not a place — the drawer's Spam destination filters the same
   * list the inbox does (`ui/inboxTabs.ts` keeps that category out of the Primary
   * and Encrypted tabs). Fetching it into the same list is what puts a message the
   * provider flagged and a message this device flagged side by side, counted by
   * one badge, and reversible with the one "Not spam" button that already exists.
   *
   * A junk fetch that fails is **not** a failed sync. The inbox is what the user
   * asked for; a connector with no junk folder, or one that refuses to list it, is
   * a legitimate connector and must not blank the mail behind an error.
   */
  async function collectInbox(mode: 'refresh' | 'more'): Promise<InboxItem[]> {
    const inbox = await collect('inbox', mode);
    let junk: InboxItem[] = [];
    try {
      junk = await collect('spam', mode);
    } catch {
      // Deliberately swallowed — see above. The junk cursor is left wherever it
      // was, so the next sync tries again from the same place.
    }
    return [...inbox, ...junk];
  }

  /** True while the inbox or its junk folder has older mail to fetch. */
  const moreInboxAvailable = (): boolean => moreAvailable('inbox') || moreAvailable('spam');

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
        // Sorted here rather than trusted from the connector: this is two
        // mailboxes' pages concatenated — and, while merged, several accounts' —
        // so newest-first is this function's job, not the provider's.
        const messages = (await collectInbox('refresh')).sort(byDateDesc);
        store.patch({ messages, loadingInbox: false, canLoadMore: moreInboxAvailable() });
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
        const older = await collectInbox('more');
        store.patch({
          messages: merge(store.get().messages, older),
          loadingMore: false,
          canLoadMore: moreInboxAvailable(),
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
        // One scan of the MIME tree, two consumers: the spam engine reads the
        // anchor pairs out of this markup, and the reader renders it (sanitised
        // at that point, never here).
        const html = htmlOf(raw);
        return {
          summary,
          encryption: { kind: 'plain' },
          subject: summary.subject,
          body: plainBodyOf(raw),
          decrypted: null,
          // An ordinary email's files are right there in the MIME, in the clear.
          attachments: attachmentsOf(raw),
          raw,
          // The message as its sender wrote it. Held as the untrusted string it
          // is — `ui/HtmlReader` sanitises before anything is rendered, so this
          // field is not a promise that the markup is safe.
          html: html || undefined,
          // Anchor pairs from the HTML part, if any. Read, never rendered: the
          // scan in `spam/urls.ts` extracts `href`/label pairs and drops
          // anything that is not http(s), so nothing executable is recorded.
          links: linksIn(html),
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
            // The sender's markup, still unsanitised — see `OpenedMessage.html`.
            // Encrypted mail earns the same reader as everything else; being
            // sealed is a fact about who sent it, not about what it contains.
            html: decrypted.html,
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
          html: decrypted.html,
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
     * Optimistic flag update, sent to the provider the row actually came from,
     * and applied to the list that row is actually in.
     *
     * Both halves of that are about lists that are not the inbox. In a merged
     * inbox `mail.current` is only one of several mailboxes, so starring a row
     * from another account through it would 404 — or, worse, change a different
     * message that happens to share an id. And a row opened from Sent, Archive or
     * Trash is not in `messages` at all, so patching that list alone left the
     * message the reader had just deleted sitting in the list they deleted it
     * from until the next fetch.
     *
     * If the provider rejects the change, the list it came from is refetched, so
     * what is on screen is what the server says again.
     */
    async setFlags(id, change) {
      const found = locate(id);
      const client = (found && mail.clients.get(found.row.account)) ?? mail.current;
      if (!client) return;
      patchRow(found, id, change);
      try {
        await client.updateFlags(id, change);
      } catch {
        if (found?.box) void service.loadBox(found.box);
        else void service.refreshInbox();
      }
    },

    async toggleStar(id) {
      const starred = store.get().messages.find((m) => m.id === id)?.starred ?? false;
      await service.setFlags(id, { starred: !starred });
    },

    setUnread: (id, unread) => service.setFlags(id, { unread }),

    archiveMessage: (id) => service.setFlags(id, { archived: true }),

    // A move to the provider's trash and back out of it — never an erasure. The
    // message stays on the server either way, which is why the pair is
    // symmetrical and why neither of them has to ask before acting.
    trashMessage: (id) => service.setFlags(id, { trashed: true }),

    restoreMessage: (id) => service.setFlags(id, { trashed: false }),

    markSpam: (id) => applyMark(id, 'spam'),

    markNotSpam: (id) => applyMark(id, 'ham'),
  };

  /**
   * The row, and which list is currently showing it.
   *
   * `box: null` means the inbox. Searched in that order because it is the common
   * case, and because a row can only be in one of these lists at a time — each
   * box is fetched by its own query, and none of those queries overlaps the
   * inbox.
   */
  function locate(id: string): { row: InboxItem; box: SecondaryBox | null } | null {
    const state = store.get();
    const inInbox = state.messages.find((m) => m.id === id);
    if (inInbox) return { row: inInbox, box: null };
    for (const box of SECONDARY_BOXES) {
      const row = state.boxes[box].items.find((m) => m.id === id);
      if (row) return { row, box };
    }
    return null;
  }

  /**
   * Apply a patch to the one list holding the row, and to no other.
   *
   * Deliberately not "every list": `applyFlagPatch` drops the row on a move, and
   * a sent message that is archived keeps its `SENT` label — so patching Sent
   * with a change made from the inbox would take away a message that is still
   * there. The list the row is in is the list that changed.
   */
  function patchRow(
    found: { row: InboxItem; box: SecondaryBox | null } | null,
    id: string,
    change: FlagPatch,
  ): void {
    if (!found) return;
    if (!found.box) {
      store.patch({ messages: applyFlagPatch(store.get().messages, id, change) });
      return;
    }
    const items = applyFlagPatch(store.get().boxes[found.box].items, id, change);
    store.patch({ boxes: patchBox(found.box, { items }) });
  }

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
