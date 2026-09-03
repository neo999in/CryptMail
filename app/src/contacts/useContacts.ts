/**
 * The address book, wired to app state — the one place the two halves are
 * assembled, so the Contacts screen and Compose's autocomplete cannot disagree
 * about who exists or how far they are trusted.
 *
 * The merging itself is in `contacts.ts`, which is pure and tested. This is only
 * the wiring: which lists count as "seen", which addresses are the user's own,
 * and which messages are junk.
 */
import { useMemo } from 'react';

import { providerFiledAsJunk } from '../categorizer/categorizer';
import { useApp } from '../state/AppState';
import { SECONDARY_BOXES } from '../state/types';
import { buildContacts, Contact } from './contacts';

export function useContacts(): Contact[] {
  const { keyring, messages, boxes, accounts, spam, encryptionFor } = useApp();

  return useMemo(() => {
    // Every list the device holds. Sent is what makes this an address book
    // rather than a list of people who wrote first — and it is also why the
    // book grows as mail is loaded: a mailbox whose Sent has never been opened
    // genuinely has not been seen, and pretending otherwise would overstate how
    // complete this is.
    const seen = [...messages, ...SECONDARY_BOXES.flatMap((box) => boxes[box].items)];

    return buildContacts({
      keyring,
      messages: seen,
      // Every connected mailbox, not only the one in front: an account's own
      // address is on nearly every message it holds, and is not a contact.
      self: accounts.map((account) => account.email),
      isJunk: (message) =>
        // The user's own mark files a message as junk whatever it is. The
        // provider's label counts for plaintext mail only — a junk verdict on
        // ciphertext is a verdict about structure the filter could not read,
        // and this refuses to act on it exactly as the categoriser refuses to
        // in the inbox.
        spam.marks[message.id] === 'spam' ||
        (providerFiledAsJunk(message.labels) && encryptionFor(message).kind === 'plain'),
    });
  }, [accounts, boxes, encryptionFor, keyring, messages, spam.marks]);
}
