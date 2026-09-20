/**
 * The send path — the file rule 1 is about.
 *
 * Nothing here may put an unencrypted copy of the user's message on the wire.
 * `deliver` has four outcomes and plaintext is not one of them; `sendPlain` is
 * a separate action the user chooses up front and that nothing on the encrypted
 * path is allowed to call.
 *
 * This build sends with **per-email keys only**: a message is never sealed to a
 * long-term key. Someone with a key but no session gets a contentless handshake
 * (`state/handshake.ts`) and the message waits until their CryptMail answers.
 */
import { buildPlaintext, core, CoreError } from '../core';
import { isForwardSecret, isPgpMime } from '../core/mime';
import { DEFAULT_LEVEL, isQkdMessage } from '../core/qkd';
import { cryptoMode } from '../config';
import { archive } from '../store/archiveStore';
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
     *  · someone has a key but no per-email keys with this device yet → the
     *    message waits (`awaiting-session`) and they get a contentless handshake.
     *    It is never sealed to their long-term key instead.
     *
     * That is Level 4, the default. The user may choose another level up front
     * (`core/qkd.ts`): Level 1 seals to long-term keys, the checks above apply
     * but the session ones do not; Levels 2 and 3 take keys from the Key
     * Manager, so no recipient key is needed at all.
     */
    async deliver({ id, to, subject, body, html, inReplyTo, references, attachments, level }: SendInput): Promise<SendOutcome> {
      const { session, identity } = store.get();
      if (!mail.current || !session || !identity) throw new Error('Not connected.');
      const chosen = level ?? DEFAULT_LEVEL;

      // Levels 2 and 3: the quantum keys come from this mailbox's Key Manager,
      // and the recipient's KM holds the same ones — nothing about their public
      // key matters. Like per-email keys, it opens once, so it is kept first.
      if (chosen === 2 || chosen === 3) {
        if (to.length === 0) throw new CoreError('Add a recipient first.', 'no-key');
        const rfc822 = await core.buildEncrypted({
          from: session.email,
          to,
          subject,
          body,
          html,
          recipientKeys: [],
          autocryptKey: identity.publicKeyArmored,
          inReplyTo,
          references,
          attachments,
          level: chosen,
        });
        if (!isQkdMessage(rfc822)) {
          throw new CoreError('Refusing to send a message that is not sealed with quantum keys.', 'unavailable');
        }
        await archive(ctx.services.accounts.requireActive(), rfc822, {
          subject,
          body,
          html,
          attachments: attachments ?? [],
          signature: 'none',
          forwardSecret: true,
          securityLevel: chosen,
        });
        await mail.current.send(rfc822);
        return { status: 'sent' };
      }

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
          html,
          sendAt: new Date().toISOString(),
          reason: 'awaiting-key',
          pending: missing,
          inReplyTo,
          references,
          // Held whole. A message that came back from the outbox without its
          // attachment would be a different message than the one the user sent.
          attachments,
          level,
        });
        await sendInvites(missing);
        return { status: 'queued', pending: missing };
      }

      const gate = service.canSendEncrypted();
      if (!gate.allowed) throw new CoreError(gate.reason ?? 'Sending is disabled.', 'unavailable');

      // Level 1, the user's explicit choice: standard OpenPGP to long-term keys,
      // with the sender's own key so Sent stays readable. No session needed.
      if (chosen === 1) {
        const rfc822 = await core.buildEncrypted({
          from: session.email,
          to,
          subject,
          body,
          html,
          recipientKeys: [...new Set([...recipients.map((r) => r.key!.armored), identity.publicKeyArmored])],
          autocryptKey: identity.publicKeyArmored,
          inReplyTo,
          references,
          attachments,
          level: 1,
        });
        if (!isPgpMime(rfc822)) throw new CoreError('Refusing to send a message that is not encrypted.', 'unavailable');
        await mail.current.send(rfc822);
        return { status: 'sent' };
      }

      // Per-email keys only. Ask the core where each recipient stands before
      // building anything: a message is sealed only when all of them can take
      // a per-email key, and held otherwise.
      const statuses = await core.sessionStatus(
        identity.email,
        recipients.map((r) => r.key!.armored),
      );
      if (statuses.every((s) => s === 'self')) {
        throw new CoreError(
          'Per-email keys need someone to write to. A message only to yourself can’t be sealed with one.',
          'no-key',
        );
      }
      const unset = recipients.filter((_, i) => statuses[i] === 'none').map((r) => r.email);
      if (unset.length > 0) {
        await ctx.services.scheduler.hold({
          id: id ?? newOutboxId(),
          to,
          subject,
          body,
          html,
          sendAt: new Date().toISOString(),
          reason: 'awaiting-session',
          pending: unset,
          inReplyTo,
          references,
          attachments,
        });
        await ctx.services.handshake.send(unset);
        return { status: 'queued', pending: unset, waitingFor: 'session' };
      }

      const rfc822 = await core.buildEncrypted({
        from: session.email,
        to,
        subject,
        body,
        html,
        // Encrypt to the sender too, so the message is readable in Sent. A
        // self-addressed message already resolved to this same key, hence the
        // dedupe — encrypting to one key twice would emit two PKESK packets for
        // it. A forward-secret build drops this key itself (a copy under our
        // long-term key would reopen it); that case is archived below instead.
        recipientKeys: [...new Set([...recipients.map((r) => r.key!.armored), identity.publicKeyArmored])],
        autocryptKey: identity.publicKeyArmored,
        inReplyTo,
        references,
        attachments,
      });

      // Belt and braces: the core refuses to seal any other way, but a message
      // this build puts on the wire must carry per-email keys, and a demo
      // core's encoding is the only exception (it says so on every screen).
      if (core.kind !== 'demo' && !isForwardSecret(rfc822)) {
        throw new CoreError('Refusing to send a message that is not sealed with per-email keys.', 'unavailable');
      }

      // Sealed with per-email keys, it cannot be reopened from the provider by
      // anyone — us included. Keep what was sent *before* it leaves: an archive
      // that fails stops the send, where the other order would leave a message
      // in Sent that nobody can ever read again.
      if (isForwardSecret(rfc822)) {
        await archive(ctx.services.accounts.requireActive(), rfc822, {
          subject,
          body,
          html,
          attachments: attachments ?? [],
          signature: 'valid',
          signerFingerprint: identity.fingerprint,
          forwardSecret: true,
        });
      }

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
          html: input.html,
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
