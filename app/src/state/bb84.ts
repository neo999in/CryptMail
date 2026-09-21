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
 * An exchange replaces whatever bank this mailbox held. That is the same
 * bargain as *Link another phone*, and the screen says so before it starts.
 */
import { core } from '../core';
import { Bb84Leg, isLinkSubject, linkBody, linkSubject } from '../core/bb84';
import { buildPlaintext } from '../core/mime';
import { userMessage } from '../lib/errors';
import { loadLinks, recordLink, saveLinks, shouldLink } from '../store/linkStore';
import { Bb84Service, Ctx } from './contracts';
import { InboxItem } from './types';

export function createBb84(ctx: Ctx): Bb84Service {
  const { store, mail } = ctx;

  /** Legs looked at this run, so a failure is not retried until the next launch. */
  const seen = new Set<string>();

  /** One leg out, as an ordinary message. */
  async function sendLeg(leg: Bb84Leg, to: string, armored: string) {
    const { session, identity } = store.get();
    if (!mail.current || !session || !identity) return;
    await mail.current.send(
      buildPlaintext({
        from: session.email,
        to: [to],
        subject: linkSubject(leg),
        body: linkBody(leg, session.email, armored),
        autocryptKey: identity.publicKeyArmored,
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
      const armored = await core.bb84Begin(session.email);
      await sendLeg('photons', email, armored);
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
          const raw = await mail.current.getRaw(m.id);
          const leg = await core.bb84Leg(raw);
          if (!leg) continue;
          const from = m.from.address;

          if (leg === 'photons') {
            await sendLeg('measurement', from, await core.bb84Measure(session.email, raw));
          } else if (leg === 'measurement') {
            // Judging is what decides whether anyone was listening. It either
            // builds this end's half of the bank or refuses outright, and the
            // refusal is worth surfacing — it is the whole point of BB84.
            await sendLeg('verdict', from, await core.bb84Judge(session.email, raw));
            await saveLinks(account, recordLink(await loadLinks(account), from, 'linked'));
          } else {
            await core.bb84Accept(session.email, raw);
            await saveLinks(account, recordLink(await loadLinks(account), from, 'linked'));
          }
        } catch (e) {
          // Anything else — a leg for an exchange this phone never started, a
          // damaged block, a forged subject — is left alone. A channel that
          // looked watched is not: the user asked for a link and did not get
          // one, and silence would read as it having worked.
          const text = userMessage(e);
          if (text.includes('disagreed')) {
            await saveLinks(account, recordLink(await loadLinks(account), m.from.address, 'refused'));
            store.patch({ error: text });
          }
        }
      }
    },
  };
}
