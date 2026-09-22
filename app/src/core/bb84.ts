/**
 * The three emails a quantum link is made of.
 *
 * `core/src/bb84.rs` runs the protocol; this file is only the envelope. Each
 * leg is an ordinary `text/plain` message: a sentence saying what it is, then
 * an armored block. Any mail system carries it and any client shows something
 * readable, which is the point — the "quantum channel" here *is* the email
 * infrastructure.
 *
 * The legs are told apart by their subject, so a sync can route a message
 * before fetching it. That is a hint, not a claim: what a message really is,
 * the core decides from the block inside it (`core.bb84Leg`). A forged subject
 * costs one fetch and nothing else.
 *
 * Nothing a user wrote is ever an argument to any of these — the text is
 * fixed here so the promise is something a test can read.
 */

export type Bb84Leg = 'photons' | 'measurement' | 'verdict';

const SUBJECTS: Record<Bb84Leg, string> = {
  photons: 'Setting up a quantum link (1 of 3)',
  measurement: 'Setting up a quantum link (2 of 3)',
  verdict: 'Setting up a quantum link (3 of 3)',
};

export function linkSubject(leg: Bb84Leg): string {
  return SUBJECTS[leg];
}

/** Does this outer subject look like a leg of a key exchange? */
export function isLinkSubject(subject: string): boolean {
  return Object.values(SUBJECTS).includes(subject.trim());
}

const EXPLAINED: Record<Bb84Leg, string> = {
  photons:
    'is setting up a quantum link with you, so the two of you can send email encrypted with keys that ' +
    'exist at both ends and nowhere else.\n\nThis message carries the states to measure. It says nothing ' +
    'else: no subject, no words, nothing either of you has written.',
  measurement:
    'measured the states your phone sent, and this is the answer: the bases it measured in, and its ' +
    'result at a random sample of positions.\n\nThe sample is spent proving nobody listened in, and is ' +
    'thrown away afterwards. Nothing here is the key.',
  verdict:
    'checked the sample against what it sent. This message says which positions the two phones agreed ' +
    'on and how many of the checked bits disagreed.\n\nIf that error rate is low, both phones build the ' +
    'same keys from what is left. If it is not, neither builds anything.',
};

/** The whole message: the fixed sentence, then the block. */
export function linkBody(leg: Bb84Leg, from: string, armored: string): string {
  return `${from}’s CryptMail ${EXPLAINED[leg]}\n\n${armored.trim()}\n`;
}
