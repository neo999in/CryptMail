import { MailSummary } from '../../mail/types';
import { SearchIndex } from '../../search/search';
import {
  categorize,
  categorizeMessage,
  checkIsSpam,
  providerFiledAsJunk,
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

  test('an opened encrypted message is still not categorized from its content', () => {
    // The plaintext is right here in the index and it reads exactly like a bill.
    // Encrypted mail is not sorted on its contents anyway — decrypting something
    // to read it is not permission to file it.
    const index: SearchIndex = { m1: { subject: 'Your invoice', body: 'amount due $40' } };
    expect(categorizeMessage(summary(), true, index)).toBe('primary');
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

  test("Gmail's Promotions label files a message with no promotional wording", () => {
    // The value of deferring: reputation and bulk-send patterns are visible to
    // the provider and to no client, so this is a promo our keywords would miss.
    const plain = summary({ subject: 'Your weekly digest', snippet: 'Here is what happened.' });
    expect(categorizeMessage({ ...plain, labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }, false, emptyIndex))
      .toBe('promotions');
  });

  test('a message Gmail tabbed elsewhere is not re-filed as a promo by keywords', () => {
    // "deal" in a mail from a colleague. Google classified it and said Personal;
    // our keyword list does not get to overrule that.
    const plain = summary({ subject: 'the deal is closed', snippet: 'Great news on the sale.' });
    expect(categorizeMessage({ ...plain, labels: ['INBOX', 'CATEGORY_PERSONAL'] }, false, emptyIndex))
      .toBe('primary');
  });

  test('bills and purchases stay ours — Gmail has no tab for either', () => {
    const bill = summary({ subject: 'Your December statement', snippet: 'Balance due soon' });
    expect(categorizeMessage({ ...bill, labels: ['INBOX', 'CATEGORY_UPDATES'] }, false, emptyIndex))
      .toBe('bills');
  });

  test('no labels at all falls through to our keywords', () => {
    // A connector that supplies none, or mail predating the tabs. Absence is not
    // a verdict of "not promotional".
    const plain = summary({ subject: 'Weekend', snippet: 'Grab this coupon before the deal ends' });
    expect(categorizeMessage(plain, false, emptyIndex)).toBe('promotions');
  });

  test('a provider category label never reaches encrypted mail', () => {
    // Google labelled it, because Google labels everything. It saw ciphertext.
    const encrypted = summary({ labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
    expect(categorizeMessage(encrypted, true, emptyIndex)).toBe('primary');
  });

  test('an explicit mark wins over the score, either way', () => {
    const plain = summary({ id: 'm1', subject: 'Your December statement', snippet: 'Balance due soon' });
    expect(categorizeMessage(plain, false, emptyIndex, { marks: { m1: 'spam' } })).toBe('spam');
    expect(categorizeMessage(plain, false, emptyIndex, { marks: { m1: 'ham' } })).toBe('bills');
  });

  test('header evidence does not file encrypted mail as spam', () => {
    // The headers here are damning — failed DMARC, a lookalike domain, an
    // off-domain reply-to — and the engine would call it phishing on plaintext.
    // Encrypted mail is not scored at all, so it stays visible in primary.
    const encrypted = summary({
      from: { address: 'security@paypa1-verify.example', name: 'PayPal Service' },
      replyTo: 'paypal.recovery@gmail.com',
      authenticationResults: 'mx.google.com; spf=fail; dkim=none; dmarc=fail header.from=paypa1-verify.example',
    });
    expect(categorizeMessage(encrypted, true, emptyIndex)).toBe('primary');
  });

  test("a user's own spam mark still files an encrypted message", () => {
    // The one thing that moves encrypted mail: the human said so. Without this,
    // "mark as spam" would appear to do nothing on encrypted mail.
    const encrypted = summary({ id: 'm1' });
    expect(categorizeMessage(encrypted, true, emptyIndex, { marks: { m1: 'spam' } })).toBe('spam');
    expect(categorizeMessage(encrypted, true, emptyIndex, { marks: { m1: 'ham' } })).toBe('primary');
  });
});

describe("the provider's own junk verdict", () => {
  const emptyIndex: SearchIndex = {};

  test('a plaintext message the provider filed as junk is filed as junk here', () => {
    // The case that was reported: Gmail had two of these in Spam and CryptMail's
    // Spam view was empty, because the app never asked for the folder and would
    // not have read the label if it had.
    const plain = summary({
      subject: 'Refund on order 408-6419373-4985156',
      snippet: 'Amazon Amazon Dear Customer, Greetings from Amazon.',
      labels: ['SPAM'],
    });
    expect(categorizeMessage(plain, false, emptyIndex)).toBe('spam');
  });

  test('the junk label beats the commercial keywords, which would hide the warning', () => {
    const text = 'Refund on order 408-1550855-4537969 — tracking number attached';
    // On its wording alone this is an order update, and Spam is full of mail
    // written to read exactly like one.
    expect(categorize(text)).toBe('purchases');
    expect(categorizeMessage(summary({ subject: text, labels: ['SPAM'] }), false, emptyIndex)).toBe('spam');
  });

  test('matched by name and case-insensitively, so another connector can use its own', () => {
    // `JUNK` is what the IMAP and Outlook worlds call the same folder.
    expect(providerFiledAsJunk(['SPAM'])).toBe(true);
    expect(providerFiledAsJunk(['Spam'])).toBe(true);
    expect(providerFiledAsJunk(['INBOX', 'CATEGORY_PERSONAL'])).toBe(false);
    expect(providerFiledAsJunk(undefined)).toBe(false);
    expect(providerFiledAsJunk([])).toBe(false);
  });

  test("a user's own 'not spam' outranks the provider", () => {
    // Otherwise the correction would appear to do nothing on exactly the mail a
    // provider filter gets wrong, and the row could never be rescued.
    const plain = summary({ id: 'm1', subject: 'Lunch Friday?', snippet: 'Still on?', labels: ['SPAM'] });
    expect(categorizeMessage(plain, false, emptyIndex)).toBe('spam');
    expect(categorizeMessage(plain, false, emptyIndex, { marks: { m1: 'ham' } })).toBe('primary');
  });

  test('encrypted mail the provider filed as junk stays visible in Primary', () => {
    // The provider saw `multipart/encrypted`: a placeholder subject, an opaque
    // body, no readable text — mild spam signals, every one of them an artefact of
    // the encryption. A junk verdict on that is a verdict about ciphertext, and
    // hiding a message the user needed is the expensive way to be wrong.
    expect(categorizeMessage(summary({ labels: ['SPAM'] }), true, emptyIndex)).toBe('primary');
  });

  test('no labels at all is not a junk verdict', () => {
    // A connector that supplies none, and every message that predates the folder.
    expect(categorizeMessage(summary({ subject: 'Lunch Friday?', snippet: 'Still on?' }), false, emptyIndex))
      .toBe('primary');
  });

  test("the provider's own junk counts under Spam in the drawer badge", () => {
    const items = [{ summary: summary({ id: 'j', subject: 'Hello', unread: true, labels: ['SPAM'] }), encrypted: false }];
    expect(unreadCountsByCategory(items, emptyIndex).spam).toBe(1);
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
