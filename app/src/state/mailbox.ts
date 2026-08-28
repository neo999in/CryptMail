/**
 * Reading the mailbox: syncing it, opening a message, and flag changes.
 */
import { spamInputFor } from '../categorizer/categorizer';
import { core, PLACEHOLDER_SUBJECT } from '../core';
import { harvestAutocrypt } from '../keys';
import { applyFlagPatch } from '../mail/flags';
import { htmlOf, plainBodyOf } from '../mail/plainBody';
import { MailSummary } from '../mail/types';
import { indexContent } from '../search/search';
import { extractLinks, learn, unlearn } from '../spam/spam';
import type { SpamMark } from '../spam/spam';
import { findKey } from '../store/keyring';
import { saveSearchIndex } from '../store/searchIndex';
import { saveSpamState, setMark } from '../store/spamModelStore';
import { Ctx, MailboxService, message } from './contracts';
import { trustForOpened } from './derive';
import { OpenedMessage } from './types';

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
        const messages = await mail.current.listInbox(20);
        store.patch({ messages, loadingInbox: false });
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

    async openMessage(summary): Promise<OpenedMessage> {
      if (!mail.current) throw new Error('Not connected.');
      const raw = await mail.current.getRaw(summary.id);

      if (!core.looksEncrypted(raw)) {
        return {
          summary,
          encryption: { kind: 'plain' },
          subject: summary.subject,
          body: plainBodyOf(raw),
          decrypted: null,
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
        await saveSearchIndex(searchIndex);
        store.patch({ searchIndex });

        if (summary.from.address === store.get().session?.email) {
          return {
            summary,
            encryption: { kind: 'encrypted', trust: 'verified', own: true },
            subject: decrypted.subject,
            body: decrypted.body,
            decrypted,
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
          raw,
        };
      } catch (e) {
        return {
          summary,
          encryption: { kind: 'encrypted', trust: 'unknown' },
          subject: summary.subject,
          body: '',
          decrypted: null,
          raw,
          error: message(e),
        };
      }
    },

    /**
     * Optimistic flag update: apply locally at once for a responsive feel, then
     * persist to the provider. If the provider rejects it, resync from the inbox.
     */
    async setFlags(id, change) {
      if (!mail.current) return;
      store.patch({ messages: applyFlagPatch(store.get().messages, id, change) });
      try {
        await mail.current.updateFlags(id, change);
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
    await saveSpamState(spam);
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
