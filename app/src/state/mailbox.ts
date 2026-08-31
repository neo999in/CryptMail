/**
 * Reading the mailbox: syncing it, opening a message, and flag changes.
 */
import { core } from '../core';
import { harvestAutocrypt } from '../keys';
import { applyFlagPatch } from '../mail/flags';
import { attachmentsOf, plainBodyOf } from '../mail/plainBody';
import { MailSummary } from '../mail/types';
import { indexContent } from '../search/search';
import { AccountId } from '../store/accountScope';
import { findKey } from '../store/keyring';
import { saveSearchIndex } from '../store/searchIndex';
import { Ctx, MailboxService, message } from './contracts';
import { trustForOpened } from './derive';
import { InboxItem, OpenedMessage } from './types';

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
   * The rows to show: one mailbox, or all of them merged.
   *
   * A merged list is newest-first across accounts and tolerant of one provider
   * failing — a Gmail account that is offline must not blank out the demo
   * account's inbox sitting beside it, so a failed client contributes nothing
   * and the rest still render. The active account is the exception: if *it*
   * fails the error is worth showing, and it is re-thrown.
   */
  async function collect(): Promise<InboxItem[]> {
    const { unified, activeAccount } = store.get();
    if (!unified || !activeAccount) {
      if (!mail.current || !activeAccount) return [];
      return tag(await mail.current.listInbox(20), activeAccount);
    }

    const lists = await Promise.all(
      [...mail.clients.entries()].map(async ([account, client]) => {
        try {
          return tag(await client.listInbox(20), account);
        } catch (e) {
          if (account === activeAccount) throw e;
          return [];
        }
      }),
    );
    return lists.flat().sort((a, b) => b.date.localeCompare(a.date));
  }

  const service: MailboxService = {
    async refreshInbox() {
      if (!mail.current) return;
      store.patch({ loadingInbox: true, error: null });
      try {
        const messages = await collect();
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
  };

  return service;
}
