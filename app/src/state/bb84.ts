/**
 * Building a quantum link with another phone, over email.
 *
 * The alternative is *Link another phone* on the Key Manager screen, which
 * seals this bank and copies it to the other end. It works, it needs both
 * phones in one room, and it is plainly a copy. This is the protocol instead
 * (`core/src/bb84.rs`): three messages, each an armored block in an ordinary
 * email body, after which both phones hold the same bank and neither ever sent
 * it.
 *
 *  · `begin` — leg 1, the states, to one address.
 *  · `answer` — during a sync, whatever leg arrived: measure it and reply,
 *    judge a reply and send the verdict, or take a verdict and finish. Each
 *    step is one email, so a link takes three syncs on each side's part.
 *
 * Legs are recognised by their outer subject (`core/bb84.ts`), which anyone can
 * forge. That costs one fetch: the core decides what a message really is from
 * the block inside it, and refuses a leg that belongs to no exchange it
 * started. A verdict is re-checked against this phone's own measurements
 * rather than believed, so a forged "the channel was clean" builds nothing.
 *
 * **The legs travel sealed and signed.** Real BB84 needs an authenticated
 * classical channel, and here the "quantum" channel is email too, so a reader
 * of plain legs would learn the states and leave no trace. Each leg is
 * therefore sent at Level 1 — OpenPGP to the recipient's ML-KEM-768 + X25519
 * key, signed with ours — and a leg that arrives unencrypted, unsigned, or
 * signed by anyone but the contact's known key is refused. So the bank that
 * Levels 2 and 3 draw on is only as exposed as a post-quantum-sealed message.
 * Both ends need each other's key first, which a handshake already arranges.
 *
 * An exchange replaces whatever bank this mailbox held. That is the same
 * bargain as *Link another phone*, and the screen says so before it starts.
 */
import { core } from '../core';
import { Bb84Leg, isLinkSubject, linkBody, linkSubject } from '../core/bb84';
import { userMessage } from '../lib/errors';
import { loadLinks, recordLink, saveLinks, shouldLink } from '../store/linkStore';
import { Bb84Service, Ctx } from './contracts';
import { InboxItem } from './types';

export function createBb84(ctx: Ctx): Bb84Service {
  const { store, mail } = ctx;

  /** Legs looked at this run, so a failure is not retried until the next launch. */
  const seen = new Set<string>();
  /**
   * What became of each leg looked at this run, for `check` to report. A
   * failure here is otherwise silent, which left a stalled exchange with
   * nothing to say why.
   */
  const outcomes = new Map<string, { ok: boolean; text: string }>();

  /**
   * The other end's key, which every leg is sealed to and must be signed by.
   * A changed or missing key refuses: a link is worth nothing if the states
   * could have gone to, or come from, someone else.
   */
  async function keyOf(email: string) {
    const [contact] = await ctx.services.contacts.discoverRecipients([email]);
    if (!contact?.key || (contact.status !== 'ok' && contact.status !== 'verified')) {
      throw new Error(
        `A quantum link with ${email} needs their key on this phone first, so the exchange can be sealed. ` +
          'Send them an encrypted message to set one up, then try again.',
      );
    }
    return contact.key;
  }

  /** One leg out: sealed to their ML-KEM + X25519 key and signed (Level 1). */
  async function sendLeg(leg: Bb84Leg, to: string, armored: string, key: { armored: string }) {
    const { session, identity } = store.get();
    if (!mail.current || !session || !identity) return;
    await mail.current.send(
      await core.buildEncrypted({
        from: session.email,
        to: [to],
        subject: linkSubject(leg),
        body: linkBody(leg, session.email, armored),
        recipientKeys: [key.armored],
        autocryptKey: identity.publicKeyArmored,
        level: 1,
        linkLeg: leg,
      }),
    );
  }

  return {
    async begin(email: string) {
      const { session } = store.get();
      if (!mail.current || !session) throw new Error('Not connected.');
      const account = ctx.services.accounts.requireActive();

      const log = await loadLinks(account);
      if (!shouldLink(log, email)) {
        // A second transmission would strand the first: only one exchange is
        // kept, so a reply to the earlier one would then match nothing.
        throw new Error('A quantum link with this address is already being set up. Give it a few minutes.');
      }
      // Before anything is generated: no key, no exchange.
      const key = await keyOf(email);
      const armored = await core.bb84Begin(session.email);
      await sendLeg('photons', email, armored, key);
      await saveLinks(account, recordLink(log, email));
    },

    async answer(messages: InboxItem[]) {
      const { session } = store.get();
      if (!mail.current || !session) return;
      const account = ctx.services.accounts.requireActive();
      const me = session.email.toLowerCase();

      for (const m of messages) {
        if (m.account !== account || !isLinkSubject(m.subject)) continue;
        if (m.from.address.toLowerCase() === me || seen.has(m.id)) continue;
        seen.add(m.id);

        try {
          const from = m.from.address;
          const fetched = await mail.current.getRaw(m.id);
          // A plain leg is refused rather than read: its states were readable
          // on the way, so a bank built from them would be known to whoever
          // read them.
          if (!core.looksEncrypted(fetched)) {
            throw new Error('It was not encrypted, so anyone could have read it. Start the link again from both phones on this version.');
          }
          const key = await keyOf(from);
          const opened = await core.parseEncrypted(fetched, session.email);
          if (opened.signature !== 'valid' || opened.signerFingerprint !== key.fingerprint) {
            throw new Error(`It was not signed with ${from}’s key, so it could have come from anyone.`);
          }
          const raw = opened.body;
          const leg = await core.bb84Leg(raw);
          if (!leg) {
            outcomes.set(m.id, { ok: false, text: `A message from ${from} is titled as a link message but carries no link block.` });
            continue;
          }

          if (leg === 'photons') {
            await sendLeg('measurement', from, await core.bb84Measure(session.email, raw), key);
            outcomes.set(m.id, { ok: true, text: `Measured the states from ${from} and replied (2 of 3).` });
          } else if (leg === 'measurement') {
            // Judging is what decides whether anyone was listening. It either
            // builds this end's half of the bank or refuses outright, and the
            // refusal is worth surfacing — it is the whole point of BB84.
            await sendLeg('verdict', from, await core.bb84Judge(session.email, raw), key);
            await saveLinks(account, recordLink(await loadLinks(account), from, 'linked'));
            outcomes.set(m.id, { ok: true, text: `Checked the sample from ${from} and sent the verdict (3 of 3). Linked.` });
          } else {
            await core.bb84Accept(session.email, raw);
            await saveLinks(account, recordLink(await loadLinks(account), from, 'linked'));
            outcomes.set(m.id, { ok: true, text: `Took the verdict from ${from}. Linked.` });
          }
        } catch (e) {
          // Anything else — a leg for an exchange this phone never started, a
          // damaged block, a forged subject — is left alone. A channel that
          // looked watched is not: the user asked for a link and did not get
          // one, and silence would read as it having worked.
          const text = userMessage(e);
          outcomes.set(m.id, { ok: false, text: `A link message from ${m.from.address} could not be used: ${text}` });
          if (text.includes('disagreed')) {
            await saveLinks(account, recordLink(await loadLinks(account), m.from.address, 'refused'));
            store.patch({ error: text });
          }
        }
      }
    },

    async check() {
      // A failure is otherwise not retried until the next launch; asked by
      // hand, it is.
      for (const [id, o] of outcomes) {
        if (!o.ok) {
          seen.delete(id);
          outcomes.delete(id);
        }
      }
      await ctx.services.mailbox.refreshInbox({ manual: true });

      const { session, messages } = store.get();
      if (!session) throw new Error('Not connected.');
      const account = ctx.services.accounts.requireActive();
      const me = session.email.toLowerCase();
      const legs = messages.filter(
        (m) => m.account === account && isLinkSubject(m.subject) && m.from.address.toLowerCase() !== me,
      );
      if (legs.length === 0) {
        return 'No link messages in this inbox. Check the other phone sent one to this address, and that it did not land in spam.';
      }
      // Newest first, as the inbox is.
      const reported = legs.map((m) => outcomes.get(m.id)?.text).filter((t): t is string => !!t);
      return reported.length > 0
        ? reported.join('\n')
        : 'Link messages are here but were already handled earlier in this run.';
    },
  };
}
