/**
 * The keyring: learning contact keys, discovering them, and verifying them.
 */
import { core, CoreError } from '../core';
import { directory, harvestAutocrypt } from '../keys';
import { addressesInKey, userIdDisplayName } from '../pgp/parseArmoredKey';
import { normaliseFingerprint, safetyNumber } from '../pgp/safetyNumber';
import { chooseKey, ContactKey, findKey, Keyring, removeKey, saveKeyring, upsertKey } from '../store/keyring';
import { ContactsService, Ctx } from './contracts';
import { resolveRecipientStates } from './recipients';

/** How many of a sender's most recent messages, per mailbox, are searched for a key. */
const SENDER_SEARCH_LIMIT = 5;

/**
 * Where a sender's key is looked for: the inbox, then archived mail. Never
 * junk — a key is a lasting statement about who someone is, and the inbox sync
 * refuses plaintext junk for the same reason (`state/mailbox.ts`).
 */
const SENDER_SEARCH_BOXES = ['inbox', 'archive'] as const;

export function createContacts(ctx: Ctx): ContactsService {
  const { store, mail } = ctx;

  /**
   * Learn `email`'s key from the `Autocrypt` header of mail they sent us.
   *
   * The same harvest as the sync, on the same terms: the header must name the
   * sender it arrived from, and only a message whose `From` is exactly this
   * address counts — a provider's sender search can match more loosely. It
   * lands as `autocrypt`, i.e. `seen`, never `verified`. `failed` says the
   * mailbox could not be searched, which is not evidence of anything.
   */
  async function harvestFromSender(keyring: Keyring, email: string): Promise<{ keyring: Keyring; failed: boolean }> {
    const client = mail.current;
    if (!client) return { keyring, failed: false };
    let failed = false;
    for (const box of SENDER_SEARCH_BOXES) {
      try {
        const page = await client.list(box, { from: email, limit: SENDER_SEARCH_LIMIT });
        for (const summary of page.messages) {
          if (!summary.autocrypt || summary.from.address.trim().toLowerCase() !== email) continue;
          keyring = await harvestAutocrypt(keyring, summary.from.address, summary.autocrypt, summary.from.name);
          if (findKey(keyring, email)) return { keyring, failed: false };
        }
      } catch {
        failed = true;
      }
    }
    return { keyring, failed };
  }

  const service: ContactsService = {
    /** Persist a new keyring and make it visible to concurrent async work at once. */
    async commitKeyring(next: Keyring) {
      if (next === store.get().keyring) return next;
      await saveKeyring(ctx.services.accounts.requireActive(), next);
      store.patch({ keyring: next });
      return next;
    },

    /**
     * Fetch keys for addresses we do not already hold one for.
     *
     * Two sources, in order: the `Autocrypt` headers on mail they already sent
     * us (searched in the mailbox, newest first), then the key directory.
     *
     * This is the step that makes the first message to a stranger encrypt. It runs
     * *before* `resolveRecipientStates` rather than inside it, because that
     * function decides whether a send is allowed and is worth keeping pure,
     * synchronous and free of anything that can fail.
     *
     * A directory key lands as `seen`, never `verified`: a keyserver is a party
     * that can hand out the wrong key, and only an out-of-band safety-number
     * comparison says otherwise. If the address already has a key with a different
     * fingerprint, `upsertKey` marks it `changed` and the send stops — which is
     * exactly what stops a keyserver from swapping a key you already trust.
     */
    async discover(emails: string[]): Promise<Keyring> {
      const self = store.get().identity?.email.trim().toLowerCase();
      const unknown = emails
        .map((e) => e.trim().toLowerCase())
        .filter((e, i, all) => e.length > 0 && all.indexOf(e) === i)
        .filter((e) => e !== self && !findKey(store.get().keyring, e));
      if (unknown.length === 0) return store.get().keyring;

      store.patch({ discovering: unknown });
      let keyring = store.get().keyring;
      // Rebuilt from this round rather than accumulated: an address that
      // resolves on a retry must stop being reported as unresolved.
      const unresolved: string[] = [];
      try {
        for (const email of unknown) {
          // Their own mail first. Autocrypt is harvested as the inbox syncs,
          // but only from what that sync lists — someone who last wrote before
          // it would read as having no key and be sent an invite. So ask the
          // mailbox for their mail directly, before the directory.
          const fromMail = await harvestFromSender(keyring, email);
          keyring = fromMail.keyring;
          if (findKey(keyring, email)) continue;
          try {
            const found = await directory.lookup(email);
            if (!found && fromMail.failed) {
              // Not "they have no key": their mail could not be searched.
              unresolved.push(email);
              continue;
            }
            if (!found) continue;
            const info = await core.importPublicKey(found.armored);
            // The directory answering an address with a key that does not claim
            // that address is either a bug or an attempt to get a key into the
            // ring under someone else's name. Either way it is not an answer.
            //
            // "Claims it" means *any* of the key's User IDs, not just the
            // primary one the core reports: one key commonly carries several
            // addresses, and a keyserver serves it for each. Comparing against
            // the primary alone rejects a perfectly good key and reports the
            // recipient as having none — which holds their message forever.
            // (`addressesInKey` reads real OpenPGP packets, which demo armor is
            // not — so the core's own answer is checked first and demo mode
            // keeps working exactly as before.)
            const claims =
              info.email.trim().toLowerCase() === email || addressesInKey(found.armored).includes(email);
            if (!claims) continue;
            // Filed under the address we asked about, which is what every
            // keyring lookup uses. The same key legitimately appears under each
            // of its addresses; `fingerprint` still identifies the one key.
            keyring = upsertKey(keyring, { ...info, email }, 'directory');
          } catch {
            // Reaching here means we did *not* establish that the address has no
            // key: a definite "nothing published" leaves via `continue` above,
            // never by throwing. What throws is a directory we could not reach,
            // or a key that came back and would not import — and neither is
            // evidence about whether this person uses encryption.
            //
            // The send path treats all of it as "not yet", never as "send it in
            // the clear". But the *user* is owed the difference, because "they
            // have no key" invites them and waits, while "we could not find out"
            // is a fault on our side that may clear on the next attempt.
            unresolved.push(email);
          }
        }
        return await service.commitKeyring(keyring);
      } finally {
        store.patch({ discovering: [], undiscoverable: unresolved });
      }
    },

    async discoverRecipients(emails: string[]) {
      return resolveRecipientStates(await service.discover(emails), store.get().identity, emails);
    },

    async importKey(armored: string, name?: string) {
      const info = await core.importPublicKey(armored);
      // A real key carries a User ID ("Ada Lovelace <ada@…>"); use its name so
      // the contact isn't shown as just an address. An explicit name still wins.
      const displayName = name ?? (info.userId ? userIdDisplayName(info.userId) : undefined);
      const keyring = await service.commitKeyring(upsertKey(store.get().keyring, info, 'manual', displayName));
      return keyring[info.email];
    },

    async forgetKey(email: string) {
      await service.commitKeyring(removeKey(store.get().keyring, email));
    },

    /**
     * Record that the user compared this contact's key out of band.
     *
     * Takes the fingerprint they actually verified rather than trusting the call
     * site. Two things follow:
     *
     *  · A stale screen cannot certify the wrong key. If the contact's key
     *    changed after the safety number was rendered, `confirmedFingerprint` no
     *    longer matches what is stored, and verification fails instead of
     *    marking the *new* key verified on the strength of the old one's check.
     *  · `verified` always means a specific key was checked, not an address.
     *
     * When the address has more than one key, the fingerprint may name any of
     * them: the one compared becomes the one in use, and the rest are set aside
     * (`chooseKey` in `store/keyring.ts`).
     */
    async markVerified(email: string, confirmedFingerprint: string) {
      const existing = findKey(store.get().keyring, email);
      if (!existing) {
        throw new CoreError(`No key stored for ${email}.`, 'no-key');
      }

      const next = chooseKey(store.get().keyring, email, knownFingerprint(existing, confirmedFingerprint) ?? '');
      if (!next) {
        throw new CoreError(
          `${email}'s key changed while you were verifying it. Compare the new safety number before trusting it.`,
          'malformed',
        );
      }
      await service.commitKeyring(next);
    },

    /**
     * The digits both people compare. Needs our identity, so it lives here rather
     * than in the screen.
     */
    async safetyNumberFor(email: string, fingerprint?: string) {
      const { keyring, identity } = store.get();
      const contact = findKey(keyring, email);
      if (!contact) throw new CoreError(`No key stored for ${email}.`, 'no-key');
      if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');
      // Any key the address has, not only the one in use — comparing each is
      // how the user tells which of several keys is really theirs.
      const which = fingerprint === undefined ? contact.fingerprint : knownFingerprint(contact, fingerprint);
      if (!which) throw new CoreError(`That key is no longer on file for ${email}.`, 'no-key');
      return safetyNumber(identity.fingerprint, which);
    },
  };

  return service;
}

/** The stored spelling of `fingerprint` if it is one of this contact's keys, else null. */
function knownFingerprint(contact: ContactKey, fingerprint: string): string | null {
  const want = normaliseFingerprint(fingerprint);
  const all = [contact.fingerprint, ...(contact.otherKeys ?? []).map((k) => k.fingerprint)];
  return all.find((fp) => normaliseFingerprint(fp) === want) ?? null;
}
