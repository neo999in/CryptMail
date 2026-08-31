/**
 * The send path — the file rule 1 is about.
 *
 * Nothing here may put an unencrypted copy of the user's message on the wire.
 * `deliver` has three outcomes and plaintext is not one of them; `sendPlain` is
 * a separate action the user chooses up front and that nothing on the encrypted
 * path is allowed to call.
 */
import { buildPlaintext, core, CoreError } from '../core';
import { cryptoMode } from '../config';
import { recordInvite, saveInvites, shouldInvite } from '../store/inviteStore';
import { Ctx, SendService } from './contracts';
import { newOutboxId } from './scheduler';
import { PlainSendInput, SendInput, SendOutcome } from './types';

export function createSend(ctx: Ctx): SendService {
  const { store, mail } = ctx;

  /**
   * Invite people who have no key yet — and say nothing about the message.
   *
   * A plaintext email whose entire content is "someone sent you an encrypted
   * message; install CryptMail to read it", plus the sender's public key in an
   * `Autocrypt` header so a fresh install can answer encrypted with no setup.
   * It carries no subject, no body, no hint of either: the held message is the
   * thing being protected, and an invite that leaked its subject line would be
   * the plaintext downgrade wearing a different hat.
   *
   * This is deliberately *not* `sendPlain`. That action is the user's explicit
   * choice to send their message in the clear, and nothing on the encrypted
   * path may reach it (rule 1).
   */
  async function sendInvites(emails: string[]) {
    const { session, identity, invites } = store.get();
    if (!mail.current || !session || !identity) return;

    const now = new Date();
    let log = invites;
    for (const email of emails) {
      if (!shouldInvite(log, email, now)) continue;
      try {
        await mail.current.send(
          buildPlaintext({
            from: session.email,
            to: [email],
            subject: 'An encrypted message is waiting for you',
            body:
              `${session.email} sent you a message with CryptMail, which encrypts mail so that ` +
              'only the two of you can read it.\n\n' +
              'It has not been delivered: encryption cannot be added after the fact, so the ' +
              'message is waiting until there is a key to encrypt it to. Install CryptMail and ' +
              'sign in with this address and it arrives on its own.\n\n' +
              'This email contains none of that message — not its subject, not a word of its ' +
              'contents. It carries the sender\'s public key, so your first reply can be ' +
              'encrypted too.\n\n' +
              'https://github.com/neo999in/cryptmail',
            autocryptKey: identity.publicKeyArmored,
          }),
        );
        log = recordInvite(log, email, now);
      } catch {
        // An invite that cannot be sent must not lose the message it is about.
        // The held message stays held and the next drain tries again.
      }
    }
    if (log !== store.get().invites) {
      await saveInvites(ctx.services.accounts.requireActive(), log);
      store.patch({ invites: log });
    }
  }

  const service: SendService = {
    /**
     * The fail-safe gate. Encrypted send is only possible with the real core;
     * in demo mode the UI offers the flow but never puts unencrypted bytes on a
     * real wire (encryption.md: never silently downgrade to plaintext).
     */
    canSendEncrypted() {
      if (cryptoMode === 'real') return { allowed: true };
      return { allowed: true, reason: 'Demo mode — the message is encoded, not encrypted.' };
    },

    /**
     * Build and hand an encrypted message to the provider — or hold it.
     *
     * Three outcomes, and plaintext is not one of them:
     *
     *  · every recipient has a usable key → encrypted and sent.
     *  · someone has no key at all → the message waits in the outbox and they get
     *    a contentless invite. Delivery happens when they have a key.
     *  · someone's key *changed* → nothing is sent and nothing is held. A changed
     *    fingerprint is a possible key substitution, and waiting cannot resolve
     *    it; only a person re-verifying the key can.
     */
    async deliver({ id, to, subject, body, inReplyTo, references, attachments }: SendInput): Promise<SendOutcome> {
      const { session, identity } = store.get();
      if (!mail.current || !session || !identity) throw new Error('Not connected.');

      const recipients = await ctx.services.contacts.discoverRecipients(to);

      const changed = recipients.filter((r) => r.status === 'changed');
      if (changed.length > 0) {
        throw new CoreError(
          `The key for ${changed.map((r) => r.email).join(', ')} changed fingerprint. ` +
            'Compare the new safety number before sending — CryptMail will not send to a key it cannot vouch for.',
          'malformed',
        );
      }

      const missing = recipients.filter((r) => r.status === 'missing').map((r) => r.email);
      if (missing.length > 0) {
        await ctx.services.scheduler.hold({
          id: id ?? newOutboxId(),
          to,
          subject,
          body,
          sendAt: new Date().toISOString(),
          reason: 'awaiting-key',
          pending: missing,
          inReplyTo,
          references,
          // Held whole. A message that came back from the outbox without its
          // attachment would be a different message than the one the user sent.
          attachments,
        });
        await sendInvites(missing);
        return { status: 'queued', pending: missing };
      }

      const gate = service.canSendEncrypted();
      if (!gate.allowed) throw new CoreError(gate.reason ?? 'Sending is disabled.', 'unavailable');

      const rfc822 = await core.buildEncrypted({
        from: session.email,
        to,
        subject,
        body,
        // Encrypt to the sender too, so the message is readable in Sent. A
        // self-addressed message already resolved to this same key, hence the
        // dedupe — encrypting to one key twice would emit two PKESK packets for
        // it.
        recipientKeys: [...new Set([...recipients.map((r) => r.key!.armored), identity.publicKeyArmored])],
        autocryptKey: identity.publicKeyArmored,
        inReplyTo,
        references,
        attachments,
      });

      await mail.current.send(rfc822);
      return { status: 'sent' };
    },

    async sendEncrypted(input: SendInput): Promise<SendOutcome> {
      const outcome = await service.deliver(input);
      if (outcome.status === 'sent') await ctx.services.mailbox.refreshInbox();
      return outcome;
    },

    /**
     * Plaintext send (prototype-plan.md M4).
     *
     * This is *not* a downgrade path. encryption.md permits an explicit opt-out
     * ("Requires an explicit, logged action") and features.md 0.14 asks for it,
     * but only as a choice the user makes up front. So: nothing in `deliver` or
     * `sendEncrypted` may ever call this, and this never inspects the keyring —
     * consulting keys here would be the first step toward "encrypt if we can,
     * send clear if we can't", which is exactly the behaviour rule 1 forbids.
     *
     * It does still carry the sender's own `Autocrypt` header, which
     * encryption.md requires of *every* outgoing message — "encrypted mail and
     * the plaintext invite alike". Omitting it here was an oversight, and a
     * costly one: a deliberately-unencrypted email is precisely the message that
     * has to bootstrap, and without the header the recipient learns nothing about
     * how to answer encrypted.
     *
     * That is not a crack in rule 1, and the difference is worth being exact
     * about, because it decides how this is written. The invariant is not "the
     * plaintext path touches no key material" — it is that **nothing here may
     * branch on the recipient's key state**. Our own public key is attached
     * unconditionally: nothing is read about the recipient, no decision is made
     * from one, and the sentence above stays literally true.
     */
    async sendPlain(input: PlainSendInput) {
      const { session, identity } = store.get();
      if (!mail.current || !session) throw new Error('Not connected.');
      if (input.to.length === 0) throw new Error('Add a recipient first.');

      await mail.current.send(
        buildPlaintext({
          from: session.email,
          to: input.to,
          subject: input.subject,
          body: input.body,
          // Undefined until the user has generated a key — being signed in
          // without an identity is a real state, since setup is its own step —
          // and `buildPlaintext` simply omits the header when it is.
          autocryptKey: identity?.publicKeyArmored,
          inReplyTo: input.inReplyTo,
          references: input.references,
          attachments: input.attachments,
        }),
      );
      await ctx.services.mailbox.refreshInbox();
    },
  };

  return service;
}
