/**
 * Which rows count as encrypted, from their outer subject alone.
 *
 * A quantum-link leg is sealed PGP/MIME, but its subject names the step so a
 * sync can route it. Every leg used to read as "not encrypted" because only
 * the placeholder was recognised.
 */
import { linkSubject } from '../bb84';
import { hasSealedSubject, PLACEHOLDER_SUBJECT } from '../mime';
import { encryptionFor } from '../../state/derive';
import { MailSummary } from '../../mail/types';

const row = (subject: string, from = 'parth@example.com'): MailSummary =>
  ({ id: 'm', threadId: 't', from: { address: from }, to: [], subject, snippet: '', date: '', unread: false, starred: false }) as MailSummary;

it('recognises the placeholder and every link leg as sealed', () => {
  expect(hasSealedSubject(PLACEHOLDER_SUBJECT)).toBe(true);
  for (const leg of ['photons', 'measurement', 'verdict'] as const) {
    expect(hasSealedSubject(linkSubject(leg))).toBe(true);
  }
});

it('does not call ordinary mail sealed, including a lookalike subject', () => {
  expect(hasSealedSubject('Quarterly numbers')).toBe(false);
  expect(hasSealedSubject('Re: Setting up a quantum link (2 of 3)')).toBe(false);
});

it('shows a link leg in the inbox as encrypted, not plain', () => {
  expect(encryptionFor({}, 'me@example.com', row(linkSubject('measurement'))).kind).toBe('encrypted');
  expect(encryptionFor({}, 'me@example.com', row('Hello')).kind).toBe('plain');
});
