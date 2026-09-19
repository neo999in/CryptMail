/**
 * What a handshake says — fixed text, and nothing the user wrote.
 *
 * With per-email keys only (`core/src/forward.rs`), nobody can be written to
 * until both sides hold a session, and a session needs the other device's
 * offer. A handshake is how the first offer travels: a message whose whole
 * content is the text below, sealed to the contact's long-term key, carrying
 * this device's signed offer in its armor. The contact's CryptMail answers it
 * with an acknowledgement sealed with a per-email key, and the message that
 * was waiting goes out.
 *
 * Both texts are fixed here, in one place, so the "contentless" promise is
 * something a test can read rather than a convention: nothing a user typed —
 * not a subject, not a word of the body — is ever an argument to either.
 */
export { HANDSHAKE_SUBJECT, isHandshakeSubject } from './mime';

/** A first-contact handshake: sealed to long-term keys, so it must say nothing. */
export function helloContent(from: string): { subject: string; body: string } {
  return {
    subject: 'Setting up per-email keys',
    body:
      `${from} wants to write to you with CryptMail, which gives every email its own key and destroys it ` +
      'once the email is read.\n\n' +
      'This message carries none of what they want to say — only what CryptMail needs to set that up. ' +
      'If you use CryptMail, it answers this by itself and their message follows. If you do not, their ' +
      'message waits until you do.',
  };
}

/** The answer: sealed with a per-email key, so it opens the session both ways. */
export function ackContent(from: string): { subject: string; body: string } {
  return {
    subject: 'Per-email keys are set up',
    body: `CryptMail set up per-email keys with ${from}. Every email between you now has its own key.`,
  };
}
