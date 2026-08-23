/**
 * The keyring: learning contact keys, discovering them, and verifying them.
 */
import { core, CoreError } from '../core';
import { directory } from '../keys';
import { addressesInKey, userIdDisplayName } from '../pgp/parseArmoredKey';
import { normaliseFingerprint, safetyNumber } from '../pgp/safetyNumber';
import { findKey, Keyring, removeKey, saveKeyring, upsertKey } from '../store/keyring';
import { ContactsService, Ctx } from './contracts';
import { resolveRecipientStates } from './recipients';

export function createContacts(ctx: Ctx): ContactsService {
  const { store } = ctx;

  const service: ContactsService = {
    /** Persist a new keyring and make it visible to concurrent async work at once. */
    async commitKeyring(next: Keyring) {
      if (next === store.get().keyring) return next;
      await saveKeyring(next);
      store.patch({ keyring: next });
      return next;
    },

    /**
     * Fetch keys for addresses we do not already hold one for.
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
          try {
            const found = await directory.lookup(email);
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
     */
    async markVerified(email: string, confirmedFingerprint: string) {
      const existing = findKey(store.get().keyring, email);
      if (!existing) {
        throw new CoreError(`No key stored for ${email}.`, 'no-key');
      }

      if (normaliseFingerprint(existing.fingerprint) !== normaliseFingerprint(confirmedFingerprint)) {
        throw new CoreError(
          `${email}'s key changed while you were verifying it. Compare the new safety number before trusting it.`,
          'malformed',
        );
      }

      await service.commitKeyring({
        ...store.get().keyring,
        [existing.email]: { ...existing, trust: 'verified' as const, verifiedAt: new Date().toISOString() },
      });
    },

    /**
     * The digits both people compare. Needs our identity, so it lives here rather
     * than in the screen.
     */
    async safetyNumberFor(email: string) {
      const { keyring, identity } = store.get();
      const contact = findKey(keyring, email);
      if (!contact) throw new CoreError(`No key stored for ${email}.`, 'no-key');
      if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');
      return safetyNumber(identity.fingerprint, contact.fingerprint);
    },
  };

  return service;
}
