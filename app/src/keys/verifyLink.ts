/**
 * Finding the keyserver's own confirmation link in the mailbox it was sent to.
 *
 * `keys.openpgp.org` stores an uploaded key immediately but will not serve it
 * *by address* until the address owner opens a link it emails. Until then the
 * key is published in name only: nobody can find it, so nobody's first message
 * to that address can be encrypted (docs/key-management.md §Publishing).
 *
 * That link lands in the very mailbox CryptMail is already signed into and
 * already syncing. Making the user leave the app, find the mail in a different
 * client and click a link there — to finish an action they started here — is a
 * step that loses people at the exact point the feature starts working.
 *
 * ## Why this is safe to open directly
 *
 * A link found in an email is normally the least trustworthy thing on screen.
 * This one is different because it has to satisfy **all three** of:
 *
 *  1. the sender is exactly `keyserver@keys.openpgp.org`;
 *  2. the body names **our own key's fingerprint**;
 *  3. the URL's host is exactly `keys.openpgp.org` and its path starts
 *     `/verify/`.
 *
 * Check 2 is the one that does the real work. Anyone can forge a `From:` line,
 * but a forger cannot know the fingerprint of a key this device generated
 * locally and has only just uploaded — so a spoofed confirmation cannot name it.
 * Check 3 is not paranoia either: the genuine email also contains
 * `https://keys.openpgp.org/about` and the bare domain, so "the first
 * keys.openpgp.org URL in the body" reliably picks the wrong one.
 *
 * Host parsing goes through `lib/links.ts`, which reads the host as the text
 * after the last `@` — `https://keys.openpgp.org@evil.example/verify/x` is a
 * request to `evil.example` and must not pass check 3.
 *
 * Pure and network-free: it is handed a body, not a mailbox.
 */
import { hostOf, linkify, pathOf } from '../lib/links';
import { normaliseFingerprint } from '../pgp/safetyNumber';

/** The only sender whose confirmation link is ever acted on. */
export const KEYSERVER_SENDER = 'keyserver@keys.openpgp.org';

/** The only host a verification link may point at. */
export const KEYSERVER_HOST = 'keys.openpgp.org';

/** The path prefix that distinguishes the link from `/about` and the bare domain. */
const VERIFY_PATH = '/verify/';

/**
 * Shortest fingerprint accepted, in hex characters — the same floor
 * `safetyNumber` uses, and here for a sharper reason: check 2 is "the body
 * contains our fingerprint", and a short or empty fingerprint is contained in
 * everything. Without a floor, a device with no real identity would accept any
 * `/verify/` link the sender-check let through.
 */
const MIN_FINGERPRINT_HEX = 32;

/** The bare address from a `From` value, whether or not it carries a name. */
function addressOf(from: string): string {
  const angled = /<([^>]*)>/.exec(from);
  return (angled ? angled[1] : from).trim().toLowerCase();
}

/**
 * Whether a message is even worth fetching the body of — check 1 on its own.
 *
 * Split out so the caller can apply it to a message list it already has and
 * spend a network round trip only on the messages that could possibly pass.
 * Passing this proves nothing by itself: a `From` line is forgeable, and it is
 * checks 2 and 3 that make the link safe to open.
 */
export function isKeyserverSender(from: string): boolean {
  return addressOf(from) === KEYSERVER_SENDER;
}

/**
 * The confirmation link in this message, or `null` if it is not one.
 *
 * `null` is the answer for everything that fails any check — a different
 * sender, a different key's confirmation, the `/about` link, a look-alike host.
 * There is no partial success: the caller opens what comes back, so anything
 * short of all three checks passing is not a URL worth returning.
 */
export function verifyLinkFrom({
  from,
  body,
  fingerprint,
}: {
  from: string;
  /** Decoded readable text — `plainBodyOf`, not raw MIME. */
  body: string;
  /** This device's own key fingerprint, in any format. */
  fingerprint: string;
}): string | null {
  if (addressOf(from) !== KEYSERVER_SENDER) return null;

  const ours = normaliseFingerprint(fingerprint);
  if (ours.length < MIN_FINGERPRINT_HEX) return null;
  // Whitespace and hyphens come out of the body so a fingerprint that was
  // soft-wrapped across two lines, or printed in readable groups, still matches
  // the one continuous string. Nothing else is removed: this check is what
  // makes the link safe to open, so it stays as close to "the body says our
  // fingerprint" as the wire format allows.
  if (!flatten(body).includes(ours)) return null;

  for (const segment of linkify(body)) {
    if (!segment.url) continue;
    // https only. The genuine link is https, and a downgraded one would hand
    // the verification token to anyone on the path — the token being the whole
    // secret in this exchange.
    if (!/^https:\/\//i.test(segment.url)) continue;
    if (hostOf(segment.url) !== KEYSERVER_HOST) continue;
    if (!(pathOf(segment.url) ?? '').startsWith(VERIFY_PATH)) continue;
    return segment.url;
  }
  return null;
}

/** The body with the line breaks and grouping a fingerprint may have picked up. */
function flatten(body: string): string {
  return body.replace(/[\s-]+/g, '').toUpperCase();
}
