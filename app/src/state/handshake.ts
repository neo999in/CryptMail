/**
 * First contact with per-email keys only.
 *
 * `core/src/forward.rs` seals nothing to a long-term key, so before the first
 * message to someone can go, both devices need a session. This module is the
 * two halves of setting one up, and neither carries anything the user wrote:
 *
 *  · `send` — a handshake to each address that has no session: this device's
 *    signed offer around the fixed text in `core/handshake.ts`, sealed to their
 *    long-term key. The message that prompted it waits in the outbox
 *    (`awaiting-session`).
 *  · `answer` — during a sync, for each handshake that arrived: open it, which
 *    files the sender's offer, and reply with an acknowledgement sealed with a
 *    per-email key. When that acknowledgement is opened on the other side (by
 *    this same function there), both directions have a session and the held
 *    message drains.
 *
 * Handshakes are found by their outer subject (`HANDSHAKE_SUBJECT`), which
 * anyone can forge. That only costs a fetch: the core files an offer only when
 * it is signed by the key that signed the message, under that key's own
 * fingerprint, and an answer goes only to a contact whose keyring key made that
 * signature.
 */
import { core } from '../core';
import { ackContent, isHandshakeSubject } from '../core/handshake';
import { archive, readArchived } from '../store/archiveStore';
import { userMessage } from '../lib/errors';
import {
  clearHandshake,
  handshakeEntry,
  HandshakeEntry,
  loadHandshakes,
  recordHandshake,
  recordHandshakeFailure,
  saveHandshakes,
  shouldHandshake,
} from '../store/handshakeStore';
import { Ctx, HandshakeService } from './contracts';
import { InboxItem } from './types';

export function createHandshake(ctx: Ctx): HandshakeService {
  const { store, mail } = ctx;

  /** Handshakes looked at this run. A failure is not retried until the next launch. */
  const seen = new Set<string>();

  /**
   * A handshake to each address that is due one — or to all of them when
   * `force`, which is the user asking. Every attempt is recorded, a failure
   * with its reason, so the outbox can say what happened rather than "queued".
   */
  async function sendTo(emails: string[], force: boolean): Promise<Record<string, HandshakeEntry | null>> {
    const { session, identity } = store.get();
    if (!mail.current || !session || !identity || emails.length === 0) return {};

    const account = ctx.services.accounts.requireActive();
    const now = new Date();
    let log = await loadHandshakes(account);
    if (force) for (const e of emails) log = clearHandshake(log, e);
    const recipients = await ctx.services.contacts.discoverRecipients(emails);
    for (const r of recipients) {
      if (!shouldHandshake(log, r.email, now)) continue;
      if (!r.key) {
        log = recordHandshakeFailure(log, r.email, 'CryptMail has no key for this address to send a handshake to.', now);
        continue;
      }
      try {
        await mail.current.send(
          await core.buildHandshake({
            from: session.email,
            to: r.email,
            recipientKey: r.key.armored,
            autocryptKey: identity.publicKeyArmored,
          }),
        );
        log = recordHandshake(log, r.email, now);
      } catch (e) {
        // The held message stays held; a drain tries again after a pause.
        log = recordHandshakeFailure(log, r.email, userMessage(e), now);
      }
    }
    await saveHandshakes(account, log);
    return Object.fromEntries(recipients.map((r) => [r.email, handshakeEntry(log, r.email)]));
  }

  return {
    async send(emails: string[]) {
      await sendTo(emails, false);
    },

    async status(emails: string[]) {
      if (!store.get().session || emails.length === 0) return {};
      const log = await loadHandshakes(ctx.services.accounts.requireActive());
      return Object.fromEntries(emails.map((e) => [e, handshakeEntry(log, e)]));
    },

    async resend(email: string) {
      const entries = await sendTo([email], true);
      return entries[email] ?? null;
    },

    async answer(messages: InboxItem[]) {
      const { session, identity } = store.get();
      if (!mail.current || !session || !identity) return;
      const account = ctx.services.accounts.requireActive();
      const me = session.email.toLowerCase();

      for (const m of messages) {
        if (m.account !== account || !isHandshakeSubject(m.subject)) continue;
        if (m.from.address.toLowerCase() === me || seen.has(m.id)) continue;
        seen.add(m.id);

        try {
          const raw = await mail.current.getRaw(m.id);
          // An acknowledgement opened on an earlier sync: already done, and it
          // could not be opened a second time anyway.
          if (await readArchived(account, raw)) continue;

          const opened = await core.parseEncrypted(raw);
          if (opened.forwardSecret) {
            // Their answer to our handshake. Opening it made the session; keep
            // what it said, since it opens only once.
            await archive(account, raw, opened);
            continue;
          }

          // A first-contact handshake. Answer it once, and only to the key that
          // signed it — the offer it carried was filed under that key.
          if (opened.signature !== 'valid') continue;
          const [contact] = await ctx.services.contacts.discoverRecipients([m.from.address]);
          if (!contact?.key || (contact.status !== 'ok' && contact.status !== 'verified')) continue;
          if (contact.key.fingerprint !== opened.signerFingerprint) continue;
          const [status] = await core.sessionStatus(identity.email, [contact.key.armored]);
          if (status !== 'offer') continue;

          const content = ackContent(session.email);
          const rfc822 = await core.buildEncrypted({
            from: session.email,
            to: [contact.email],
            ...content,
            recipientKeys: [contact.key.armored, identity.publicKeyArmored],
            autocryptKey: identity.publicKeyArmored,
            handshake: true,
          });
          // Sealed with a per-email key like any other message, so it is kept
          // before it leaves (see `deliver`).
          await archive(account, rfc822, {
            ...content,
            attachments: [],
            signature: 'valid',
            signerFingerprint: identity.fingerprint,
            forwardSecret: true,
          });
          await mail.current.send(rfc822);
        } catch {
          // A handshake that cannot be opened here — sealed to an older key, or
          // not a handshake at all — is left alone.
        }
      }
    },
  };
}
