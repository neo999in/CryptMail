/**
 * What to tell someone who just asked whether a held message can go yet.
 *
 * A message held `awaiting-key` waits on an external event with no notification
 * attached — somebody else installing CryptMail and publishing a key. The outbox
 * therefore offers a manual "check for a key", and the whole value of that
 * button is the answer it gives back. A check that silently changes nothing is
 * indistinguishable from a button that does nothing.
 *
 * The split this module exists for: **"nobody has published a key yet" and "we
 * could not reach the directory" are different answers.** Only the first is a
 * fact about the recipient. Telling someone their correspondent does not use
 * encryption, on the strength of a request that timed out, is how a user
 * concludes the queue is broken and goes looking for a way to send in the clear.
 * Same distinction `discovery.ts` draws between a definite 404 and a failure,
 * carried through to the sentence the user reads.
 *
 * Pure: it is handed two lists of addresses and returns words. The third
 * possible outcome of a check — `deliver` throwing because a recipient's key
 * *changed fingerprint* — never reaches here. That is not a report about
 * waiting; it is a refusal to send, and the caller surfaces the error itself.
 */

/** The outcome of a manual check, and why it is worth wording carefully. */
export type CheckResult = {
  /**
   * `no-key` — the directory answered, and there is nothing published.
   * `unreachable` — at least one lookup could not be completed, so nothing at
   * all was established about that address.
   */
  kind: 'no-key' | 'unreachable';
  text: string;
};

const canonical = (email: string) => email.trim().toLowerCase();

/**
 * Describe a check that left the message queued.
 *
 * `pending` is the addresses still without a usable key; `undiscoverable` is
 * every address whose last lookup settled nothing (`AppState.undiscoverable`).
 * An address in both was not answered about — it is reported as our failure, not
 * as their absence.
 */
export function describeCheck(pending: string[], undiscoverable: string[]): CheckResult {
  const failed = new Set(undiscoverable.map(canonical));
  const unreachable = pending.filter((email) => failed.has(canonical(email)));
  const withoutKey = pending.filter((email) => !failed.has(canonical(email)));

  if (unreachable.length === 0) {
    return {
      kind: 'no-key',
      text: withoutKey.length === 0
        // No addresses at all: the message is held, but not on anyone's account
        // that this check could name. Saying nothing is worse than saying so.
        ? 'Still waiting. Nothing has changed since the message was queued.'
        : `${list(withoutKey)} ${verb(withoutKey)} not published a key yet. The message stays queued and ` +
          'goes out by itself once they do.',
    };
  }

  const failure =
    `Couldn't reach the key directory for ${list(unreachable)}. That is a fault on this side, not an ` +
    'answer about them — the message stays queued and CryptMail keeps trying.';

  return {
    kind: 'unreachable',
    text:
      withoutKey.length === 0
        ? failure
        : `${failure} ${list(withoutKey)} ${verb(withoutKey)} not published a key yet either.`,
  };
}

/** `a`, `a and b`, `a, b and c` — read aloud, not comma-separated. */
function list(emails: string[]): string {
  if (emails.length <= 1) return emails[0] ?? '';
  return `${emails.slice(0, -1).join(', ')} and ${emails[emails.length - 1]}`;
}

const verb = (emails: string[]) => (emails.length > 1 ? 'have' : 'has');
