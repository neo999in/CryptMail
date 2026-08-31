import { MailSummary } from '../../mail/types';
import { SearchIndex } from '../../search/search';
import {
  categorize,
  categorizeMessage,
  checkIsSpam,
  spamInputFor,
  unreadCountsByCategory,
} from '../categorizer';

function summary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    id: 'm1',
    from: { address: 'store@shop.example', name: 'The Shop' },
    to: ['you@gmail.com'],
    date: '2026-08-25T10:00:00.000Z',
    subject: '[Encrypted message]',
    snippet: 'Encrypted — open to decrypt on this device.',
    unread: false,
    starred: false,
    ...overrides,
  };
}

describe('categorize', () => {
  test('routes bills by keyword', () => {
    expect(categorize('Your invoice is ready')).toBe('bills');
    expect(categorize('Payment due on your account')).toBe('bills');
  });

  test('routes purchases by keyword', () => {
    expect(categorize('Your order has shipped')).toBe('purchases');
    expect(categorize('Here is your receipt')).toBe('purchases');
  });

  test('routes promotions by keyword', () => {
    expect(categorize('Flash sale — 50% off everything')).toBe('promotions');
    expect(categorize('Unsubscribe from this newsletter')).toBe('promotions');
  });

  test('is case-insensitive', () => {
    expect(categorize('YOUR INVOICE IS ATTACHED')).toBe('bills');
  });

  test('falls back to primary when nothing matches', () => {
    expect(categorize('Are we still on for lunch on Friday?')).toBe('primary');
  });

  test('precedence: a bill that also advertises a sale is a bill', () => {
    expect(categorize('Your invoice — plus a sale on your next order')).toBe('bills');
  });

  test('precedence: an order that mentions a discount is a purchase, not a promotion', () => {
    expect(categorize('Your order shipped — enjoy this discount next time')).toBe('purchases');
  });
});

describe('checkIsSpam', () => {
  test('shouting and a keyword are not a classification on their own', () => {
    // The engine's central constraint: no single rule reaches the threshold, so a
    // loud line of text with none of the structural evidence stays legitimate.
    expect(checkIsSpam('WIN A FREE PRIZE NOW!!! CLICK HERE')).toBe(false);
  });

  test('empty text is never spam', () => {
    expect(checkIsSpam('')).toBe(false);
    expect(checkIsSpam('   ')).toBe(false);
  });

  test('legitimate mail using the words a naive filter watches for stays legitimate', () => {
    expect(
      checkIsSpam(
        'The password for your account was changed on Tuesday. If this was you, no ' +
          'action is needed. You can review recent sign-in activity at any time. We will ' +
          'never ask you for your password or payment details by email.',
      ),
    ).toBe(false);
  });

  test('a combination of pretexts does classify', () => {
    expect(
      checkIsSpam(
        'URGENT: your account will be suspended within 24 hours. Verify your account ' +
          'immediately and pay the outstanding balance of $240 by wire transfer to avoid ' +
          'permanent suspension. Click here to verify and confirm your password now.',
      ),
    ).toBe(true);
  });

  test('urgency, a threat and a credential request together are not enough without headers', () => {
    // The same three intent families, and nothing else — which is also how a bank
    // writes its own fraud alert and how an IT department writes a password-expiry
    // notice. On text alone, with no sender, no authentication and no links, that
    // wording must not be a verdict: the structural evidence that separates the
    // warning from the attack is in the headers, and here there are none.
    expect(
      checkIsSpam(
        'URGENT: unusual activity was detected and your account will be suspended ' +
          'within 24 hours. Verify your account immediately to avoid permanent ' +
          'suspension. Click here to verify and confirm your password now.',
      ),
    ).toBe(false);
  });

  test('a verdict the caller already computed decides it', () => {
    const verdict = (classification: 'legitimate' | 'spam' | 'phishing-suspicious') => ({
      classification,
      score: 0,
      phishingScore: 0,
      symbols: [],
      bayesApplied: false,
      bayesProbability: null,
      overridden: false,
    });
    expect(checkIsSpam('anything at all', verdict('spam'))).toBe(true);
    expect(checkIsSpam('anything at all', verdict('phishing-suspicious'))).toBe(true);
    expect(checkIsSpam('URGENT!!! verify your account immediately', verdict('legitimate'))).toBe(false);
  });
});

describe('categorizeMessage', () => {
  const emptyIndex: SearchIndex = {};

  test('a plaintext message is categorized by its header subject and snippet', () => {
    const plain = summary({ subject: 'Your December statement', snippet: 'Balance due soon' });
    expect(categorizeMessage(plain, false, emptyIndex)).toBe('bills');
  });

  test('a plaintext promo is categorized by its snippet', () => {
    const plain = summary({ subject: 'Weekend', snippet: 'Grab this coupon before the deal ends' });
    expect(categorizeMessage(plain, false, emptyIndex)).toBe('promotions');
  });

  test('an opened encrypted message is categorized from its decrypted content', () => {
    const index: SearchIndex = { m1: { subject: 'Your invoice', body: 'amount due $40' } };
    expect(categorizeMessage(summary(), true, index)).toBe('bills');
  });

  test('an unopened encrypted message stays in primary — its ciphertext is never read', () => {
    // Even a snippet full of keywords must not classify encrypted mail: the real
    // content lives in ciphertext until the message is opened on this device.
    const encrypted = summary({ snippet: 'sale 50% off — use this coupon' });
    expect(categorizeMessage(encrypted, true, emptyIndex)).toBe('primary');
  });

  test('the placeholder subject of an encrypted message is never inspected', () => {
    expect(categorizeMessage(summary({ subject: 'invoice past due' }), true, emptyIndex)).toBe('primary');
  });

  test('an explicit mark wins over the score, either way', () => {
    const plain = summary({ id: 'm1', subject: 'Your December statement', snippet: 'Balance due soon' });
    expect(categorizeMessage(plain, false, emptyIndex, { marks: { m1: 'spam' } })).toBe('spam');
    expect(categorizeMessage(plain, false, emptyIndex, { marks: { m1: 'ham' } })).toBe('bills');
  });

  test('header evidence still files unopened encrypted mail as spam', () => {
    // Headers are cleartext, so a message failing DMARC while claiming a brand it
    // does not own is suspicious whether or not its body has been read. Nothing
    // about its ciphertext is inspected to reach that.
    const encrypted = summary({
      from: { address: 'security@paypa1-verify.example', name: 'PayPal Service' },
      replyTo: 'paypal.recovery@gmail.com',
      authenticationResults: 'mx.google.com; spf=fail; dkim=none; dmarc=fail header.from=paypa1-verify.example',
    });
    expect(categorizeMessage(encrypted, true, emptyIndex)).toBe('spam');
  });
});

describe('spamInputFor', () => {
  const emptyIndex: SearchIndex = {};

  test('plaintext mail contributes its subject and snippet', () => {
    const input = spamInputFor(summary({ subject: 'Hello', snippet: 'Body text' }), false, emptyIndex);
    expect(input.subject).toBe('Hello');
    expect(input.body).toBe('Body text');
  });

  test('unopened encrypted mail contributes headers only', () => {
    const input = spamInputFor(
      summary({ subject: '[Encrypted message]', snippet: 'Encrypted — open to decrypt on this device.' }),
      true,
      emptyIndex,
    );
    expect(input.subject).toBeUndefined();
    expect(input.body).toBeUndefined();
    expect(input.from?.address).toBe('store@shop.example');
  });

  test('opened encrypted mail contributes the decrypted content, never the snippet', () => {
    const index: SearchIndex = { m1: { subject: 'Real subject', body: 'Real body' } };
    const input = spamInputFor(summary({ snippet: 'ciphertext artefact' }), true, index);
    expect(input.subject).toBe('Real subject');
    expect(input.body).toBe('Real body');
  });

  test('URLs written in prose are paired with themselves, so a URL cannot misrepresent itself', () => {
    const input = spamInputFor(
      summary({ subject: 'Look', snippet: 'See https://example.com/a for details' }),
      false,
      emptyIndex,
    );
    expect(input.links).toEqual([{ href: 'https://example.com/a', text: 'https://example.com/a' }]);
  });

  test('anchor pairs from an opened message take precedence over prose URLs', () => {
    const links = [{ href: 'https://evil.example/login', text: 'https://bank.example' }];
    const input = spamInputFor(
      summary({ subject: 'Look', snippet: 'See https://example.com/a' }),
      false,
      emptyIndex,
      { links },
    );
    expect(input.links).toBe(links);
  });

  test('text with no URLs yields no links at all, rather than an empty list', () => {
    // An empty array would suppress the URL-in-prose fallback while carrying no
    // information of its own.
    expect(spamInputFor(summary({ subject: 'Hi', snippet: 'no links here' }), false, emptyIndex).links)
      .toBeUndefined();
  });

  test('the four cleartext headers are passed through as given', () => {
    const input = spamInputFor(
      summary({
        replyTo: 'someone@else.example',
        authenticationResults: 'mx.google.com; spf=pass',
        listUnsubscribe: '<mailto:stop@list.example>',
        returnPath: '<bounce@list.example>',
        messageId: '<abc@shop.example>',
      }),
      false,
      emptyIndex,
    );
    expect(input.headers).toEqual({
      replyTo: 'someone@else.example',
      authenticationResults: 'mx.google.com; spf=pass',
      listUnsubscribe: '<mailto:stop@list.example>',
      returnPath: '<bounce@list.example>',
      messageId: '<abc@shop.example>',
    });
  });
});

describe('unreadCountsByCategory', () => {
  const emptyIndex: SearchIndex = {};

  test('tallies unread messages into their categories', () => {
    const items = [
      { summary: summary({ id: 'a', subject: 'Your invoice', unread: true }), encrypted: false },
      { summary: summary({ id: 'b', subject: 'Order shipped', unread: true }), encrypted: false },
      { summary: summary({ id: 'c', subject: 'Lunch Friday?', unread: true }), encrypted: false },
    ];
    expect(unreadCountsByCategory(items, emptyIndex)).toEqual({
      primary: 1,
      purchases: 1,
      bills: 1,
      promotions: 0,
      spam: 0,
    });
  });

  test('ignores messages that are already read', () => {
    const items = [
      { summary: summary({ id: 'a', subject: 'Your invoice', unread: false }), encrypted: false },
      { summary: summary({ id: 'b', subject: 'Your invoice', unread: true }), encrypted: false },
    ];
    expect(unreadCountsByCategory(items, emptyIndex).bills).toBe(1);
  });

  test('a shouted subject alone does not reach the spam bucket', () => {
    const items = [{ summary: summary({ subject: 'WIN A FREE PRIZE', unread: true }), encrypted: false }];
    expect(unreadCountsByCategory(items, emptyIndex).spam).toBe(0);
  });

  test('an explicit user mark counts under spam', () => {
    const items = [{ summary: summary({ id: 'x', subject: 'Lunch Friday?', unread: true }), encrypted: false }];
    expect(unreadCountsByCategory(items, emptyIndex, { marks: { x: 'spam' } }).spam).toBe(1);
  });
});
