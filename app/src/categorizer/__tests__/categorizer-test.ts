import { MailSummary } from '../../mail/types';
import { SearchIndex } from '../../search/search';
import {
  categorize,
  categorizeMessage,
  checkIsSpam,
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
  test('is a stub that classifies nothing as spam yet', () => {
    expect(checkIsSpam('WIN A FREE PRIZE NOW!!! CLICK HERE')).toBe(false);
    expect(checkIsSpam('')).toBe(false);
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

  test('spam stays zero while checkIsSpam is a stub', () => {
    const items = [{ summary: summary({ subject: 'WIN A FREE PRIZE', unread: true }), encrypted: false }];
    expect(unreadCountsByCategory(items, emptyIndex).spam).toBe(0);
  });
});
