/**
 * Reading the mailbox: syncing it, opening a message, and flag changes.
 */
import { core } from '../core';
import { harvestAutocrypt } from '../keys';
import { applyFlagPatch } from '../mail/flags';
import { plainBodyOf } from '../mail/plainBody';
import { MailSummary } from '../mail/types';
import { indexContent } from '../search/search';
import { findKey } from '../store/keyring';
import { saveSearchIndex } from '../store/searchIndex';
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
  };

  return service;
}
