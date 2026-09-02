import { MailSummary } from '../../mail/types';
import { indexContent, messageMatchesQuery, SearchIndex, textMatchesQuery } from '../search';

function summary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'm1',
    from: { address: 'anya@partner.com', name: 'Anya Kessler' },
    to: ['you@gmail.com'],
    date: '2026-07-23T10:00:00.000Z',
    subject: '[Encrypted message]',
    snippet: 'Encrypted — open to decrypt on this device.',
    unread: false,
    starred: false,
    ...overrides,
  };
}

describe('messageMatchesQuery', () => {
  const emptyIndex: SearchIndex = {};

  test('an empty or whitespace query matches every message', () => {
    expect(messageMatchesQuery(summary(), true, emptyIndex, '   ')).toBe(true);
  });

  test('matches by sender name, case-insensitively', () => {
    expect(messageMatchesQuery(summary(), true, emptyIndex, 'anya')).toBe(true);
    expect(messageMatchesQuery(summary(), true, emptyIndex, 'KESSLER')).toBe(true);
  });

  test('matches by sender address', () => {
    expect(messageMatchesQuery(summary(), true, emptyIndex, 'partner.com')).toBe(true);
  });

  test('a plaintext message is searched by its header subject and snippet', () => {
    const plain = summary({ subject: 'Your weekly digest', snippet: 'This week in review' });
    expect(messageMatchesQuery(plain, false, emptyIndex, 'weekly')).toBe(true);
    expect(messageMatchesQuery(plain, false, emptyIndex, 'review')).toBe(true);
  });

  test('an encrypted message is searched by its decrypted subject from the index', () => {
    const index: SearchIndex = { m1: { subject: 'Q3 board deck — final numbers', body: '' } };
    expect(messageMatchesQuery(summary(), true, index, 'board deck')).toBe(true);
  });

  test('an encrypted message is searched by its decrypted body from the index', () => {
    const index: SearchIndex = { m1: { subject: 'Lunch', body: 'are we still on for Friday at noon' } };
    expect(messageMatchesQuery(summary(), true, index, 'friday')).toBe(true);
  });

  test('an encrypted message with no index entry is not matched on content, only sender', () => {
    // The real subject lives in ciphertext; with no local decryption it stays unsearchable.
    expect(messageMatchesQuery(summary(), true, emptyIndex, 'board deck')).toBe(false);
    expect(messageMatchesQuery(summary(), true, emptyIndex, 'anya')).toBe(true);
  });

  test('the placeholder subject of an encrypted message is never searched', () => {
    // Guard against regressing to searching the ciphertext placeholder as a haystack.
    expect(messageMatchesQuery(summary({ subject: '[Encrypted message]' }), true, emptyIndex, 'encrypted message')).toBe(
      false,
    );
  });
});

describe('indexContent', () => {
  test('adds decrypted content for a message id', () => {
    const next = indexContent({}, 'm1', { subject: 'Hi', body: 'there' });
    expect(next.m1).toEqual({ subject: 'Hi', body: 'there' });
  });

  test('overwrites an existing entry without mutating the input', () => {
    const before: SearchIndex = { m1: { subject: 'old', body: 'old' } };
    const next = indexContent(before, 'm1', { subject: 'new', body: 'new' });
    expect(next.m1).toEqual({ subject: 'new', body: 'new' });
    expect(before.m1).toEqual({ subject: 'old', body: 'old' });
  });
});

describe('textMatchesQuery', () => {
  const draft = ['Invoice for August', 'anya@partner.com', 'Attached is the invoice.'];

  test('an empty or whitespace query matches everything', () => {
    expect(textMatchesQuery(draft, '')).toBe(true);
    expect(textMatchesQuery(draft, '   ')).toBe(true);
  });

  test('matches any field, case-insensitively', () => {
    expect(textMatchesQuery(draft, 'INVOICE')).toBe(true);
    expect(textMatchesQuery(draft, 'partner.com')).toBe(true);
    expect(textMatchesQuery(draft, 'attached')).toBe(true);
  });

  test('does not match text that is in none of the fields', () => {
    expect(textMatchesQuery(draft, 'receipt')).toBe(false);
  });

  test('missing fields are skipped rather than matched as empty', () => {
    expect(textMatchesQuery(['Subject', undefined], 'subject')).toBe(true);
    expect(textMatchesQuery([undefined, undefined], 'anything')).toBe(false);
  });
});
