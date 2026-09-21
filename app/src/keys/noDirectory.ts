/**
 * The directory that answers nothing — what a build with key lookup turned off
 * talks to instead of `keys.openpgp.org`.
 *
 * `config.KEY_DIRECTORY_ENABLED` says why it is the default. In short: a
 * directory can serve a key the address owner no longer holds, and at the point
 * of use a stale answer looks exactly like a current one. Everything that key
 * then seals — a first message, a handshake — is unopenable by the person it
 * was addressed to.
 *
 * ## Why `null` rather than an error
 *
 * `discovery.ts` draws a line the whole send path depends on: `null` means *no
 * key is published for this address*, a `DiscoveryError` means *the lookup could
 * not be completed*. The first is a normal outcome and sends an invite; the
 * second is a fault and must not be mistaken for the first, or a message queues
 * forever behind a question nobody asked.
 *
 * With no directory configured there is no lookup to fail. Nothing is published
 * anywhere this build can see, which is precisely `null` — so first contact
 * takes the `awaiting-key` path, an invite goes out, and the key arrives by
 * Autocrypt when they answer. That path is exercised either way and puts
 * nothing on the wire in the clear.
 *
 * ## Publishing
 *
 * `publish` throws rather than quietly succeeding. Nothing should call it — the
 * Keys screen hides the whole block when lookup is off — and a stub that
 * returned `pending-verification` would record a listing that does not exist,
 * leaving the user believing strangers can write to them encrypted.
 */
import type { KeyDirectory } from './index';

export const noDirectory: KeyDirectory = {
  kind: 'none',

  /**
   * Named for the consent copy that no longer runs. Kept honest in case it
   * reaches a screen: it says there is nowhere, not the name of a server this
   * build never contacts.
   */
  listedAt: 'no key directory',

  async lookup() {
    return null;
  },

  async publish() {
    throw new Error('Key directory publishing is turned off in this build.');
  },
};
