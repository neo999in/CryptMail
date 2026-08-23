/**
 * Trust state, derived rather than stored.
 *
 * Both functions are pure and synchronous, which is what lets the inbox call one
 * of them per row during render. They stay out of the service modules because
 * the provider has to re-create their bound form whenever the keyring changes —
 * screens hold them in `useMemo` dependency arrays, and a badge that never
 * refreshes after a key is verified is worse than no badge.
 */
import { DecryptedMessage, PLACEHOLDER_SUBJECT } from '../core';
import { MailSummary } from '../mail/types';
import { ContactKey, findKey, Keyring } from '../store/keyring';
import { EncryptionState } from './types';

/** Inbox-row state, from headers only — no decryption, no network. */
export function encryptionFor(
  keyring: Keyring,
  selfEmail: string | undefined,
  summary: MailSummary,
): EncryptionState {
  if (summary.subject.trim() !== PLACEHOLDER_SUBJECT) return { kind: 'plain' };
  // Our own copy: encrypted to our key, so it is readable and trusted here.
  if (summary.from.address === selfEmail) {
    return { kind: 'encrypted', trust: 'verified', own: true };
  }
  const key = findKey(keyring, summary.from.address);
  if (!key) return { kind: 'encrypted', trust: 'unknown' };
  return { kind: 'encrypted', trust: key.trust === 'verified' ? 'verified' : key.trust };
}

/**
 * The upgrade an opened message earns over its inbox row: a signature this
 * device checked against the key it holds for the sender.
 *
 * `verified` needs both — a valid signature from the stored key *and* a key the
 * user compared out of band. Everything short of that is `seen`.
 */
export function trustForOpened(
  key: ContactKey | undefined,
  decrypted: DecryptedMessage,
): 'verified' | 'seen' | 'changed' | 'unknown' {
  if (!key) return 'unknown';
  if (key.trust === 'changed') return 'changed';
  const signedByKnownKey =
    decrypted.signature === 'valid' &&
    (!decrypted.signerFingerprint || decrypted.signerFingerprint === key.fingerprint);
  return signedByKnownKey && key.trust === 'verified' ? 'verified' : 'seen';
}
