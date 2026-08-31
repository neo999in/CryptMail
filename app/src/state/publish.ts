/**
 * Listing this device's public key in the directory, and noticing when the
 * directory has confirmed it.
 */
import { core, CoreError, Identity } from '../core';
import { directory } from '../keys';
import { isKeyserverSender, verifyLinkFrom } from '../keys/verifyLink';
import { plainBodyOf } from '../mail/plainBody';
import { normaliseFingerprint } from '../pgp/safetyNumber';
import { publishStatusFor, PublishState, savePublishState } from '../store/publishStore';
import { Ctx, PublishService } from './contracts';

export function createPublish(ctx: Ctx): PublishService {
  const { store, mail } = ctx;

  /**
   * Find the directory's confirmation link in the mailbox it was sent to.
   *
   * The link is what turns a stored key into a *findable* one, and it arrives as
   * an ordinary email in the account CryptMail is already syncing. Sending the
   * user off to another mail client to finish something they started here is
   * where this flow loses people.
   *
   * Deliberately no new `MailClient` method: the seam is provider-agnostic, and
   * adding a search primitive to it for one feature is not a trade worth making.
   * This reads the messages the last sync already returned, which is also the
   * honest limitation — see `verifyLink` in the Keys screen copy.
   *
   * Costs one `getRaw` per keyserver message in the synced window, which in
   * practice is zero or one, and only while publication is pending.
   */
  async function findVerifyLink(identity: Identity) {
    if (!mail.current || store.get().verifyLink) return;

    // Newest first: publishing twice means two confirmation mails, and only
    // the most recent one names the key this device now holds.
    const candidates = store
      .get()
      .messages.filter((m) => isKeyserverSender(m.from.address))
      .sort((a, b) => b.date.localeCompare(a.date));

    for (const summary of candidates) {
      try {
        const raw = await mail.current.getRaw(summary.id);
        const link = verifyLinkFrom({
          from: summary.from.address,
          body: plainBodyOf(raw),
          fingerprint: identity.fingerprint,
        });
        if (link) {
          store.patch({ verifyLink: link });
          return;
        }
      } catch {
        // A message that will not fetch is not a reason to stop looking, and
        // not a reason to say anything: the pending copy already stands on
        // its own without this button.
      }
    }
  }

  return {
    /**
     * List this device's public key in the directory.
     *
     * Only ever called from an explicit user action. The listing is public —
     * anyone can learn from it that this address has a key — so it is a consent
     * decision, and one the app states plainly rather than making quietly.
     */
    async publishOwnKey(): Promise<PublishState> {
      const { identity } = store.get();
      if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');

      const { status } = await directory.publish(identity.publicKeyArmored, identity.email);
      const publish = await savePublishState(
        ctx.services.accounts.requireActive(),
        status === 'published' ? 'published' : 'pending',
        identity.fingerprint,
      );
      // A fresh upload means a fresh confirmation mail. Any link found before this
      // belongs to the previous attempt, and offering it would send the user to a
      // token the keyserver has already superseded.
      store.patch({ publish, verifyLink: null });
      return publish;
    },

    async declinePublish(): Promise<PublishState> {
      const publish = await savePublishState(
        ctx.services.accounts.requireActive(),
        'declined',
        store.get().identity?.fingerprint ?? null,
      );
      store.patch({ publish, verifyLink: null });
      return publish;
    },

    /**
     * Notice that a pending publication has been confirmed.
     *
     * `keys.openpgp.org` will not serve a key by address until the address owner
     * clicks the link it emails. Rather than parse that mail *for the answer*, the
     * app asks the directory the same question a stranger would: is this key
     * served for this address yet? A yes is the confirmation, whichever device
     * clicked the link.
     *
     * Only if the answer is still no does it look for the link itself — an offer
     * to finish the job, never the thing that decides the state.
     */
    async refreshPublish() {
      const { identity, publish } = store.get();
      if (!identity) return;
      if (publishStatusFor(publish, identity.fingerprint) !== 'pending') return;

      try {
        const found = await directory.lookup(identity.email);
        const info = found ? await core.importPublicKey(found.armored) : null;
        if (info && normaliseFingerprint(info.fingerprint) === normaliseFingerprint(identity.fingerprint)) {
          store.patch({
            publish: await savePublishState(
              ctx.services.accounts.requireActive(),
              'published',
              identity.fingerprint,
            ),
            verifyLink: null,
          });
          return;
        }
      } catch {
        // The directory being unreachable says nothing about the key's state.
      }

      await findVerifyLink(identity);
    },
  };
}
