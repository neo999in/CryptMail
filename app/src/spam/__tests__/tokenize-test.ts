/**
 * The tokenizer, which is most of what makes a Bayesian filter work.
 *
 * Two properties are worth pinning down beyond "it splits words": tokens are
 * namespaced by where they came from, so a subject word is never confused for a
 * body word, and the things that would poison a model — whole URLs with tracking
 * ids, per-message header values — are deliberately absent.
 */
import { countTokens, tokenize, words } from '../tokenize';

describe('words', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(words('Hello, World! Again')).toEqual(['hello', 'world', 'again']);
  });

  it('drops stop words and very short words', () => {
    expect(words('the a of your invoice')).toEqual(['of', 'invoice']);
  });

  it('drops bare numbers but keeps amounts', () => {
    expect(words('pay 4500 or $4500 or 50%')).toEqual(['pay', 'or', '$4500', 'or', '50%']);
  });

  it('drops absurdly long runs, which are never words', () => {
    expect(words(`short ${'a'.repeat(80)} end`)).toEqual(['short', 'end']);
  });

  it('strips surrounding apostrophes but keeps internal ones', () => {
    expect(words("'quoted' don't")).toEqual(['quoted', "don't"]);
  });

  it('handles text with nothing in it', () => {
    expect(words('')).toEqual([]);
    expect(words('   \n\t  ')).toEqual([]);
    expect(words('!!! ??? ...')).toEqual([]);
  });
});

describe('tokenize', () => {
  it('namespaces subject and body words separately', () => {
    const tokens = tokenize({ subject: 'invoice', body: 'invoice' });
    expect(tokens).toContain('s:invoice');
    expect(tokens).toContain('b:invoice');
  });

  it('emits phrase tokens, so a single word cannot carry a verdict alone', () => {
    const tokens = tokenize({ body: 'please click here to continue' });
    expect(tokens).toContain('bp:click_here');
  });

  it('emits the sender address and both forms of its domain', () => {
    const tokens = tokenize({ from: { address: 'Billing@mail.Shop.co.uk' } });
    expect(tokens).toContain('f:billing@mail.shop.co.uk');
    expect(tokens).toContain('d:mail.shop.co.uk');
    expect(tokens).toContain('d:shop.co.uk');
  });

  it('gives the display name its own namespace', () => {
    // "PayPal" as a display name is different evidence from the word in a body.
    const tokens = tokenize({ from: { address: 'x@y.example', name: 'PayPal Security' } });
    expect(tokens).toContain('n:paypal');
    expect(tokens).toContain('n:security');
    expect(tokens).not.toContain('b:paypal');
  });

  it('records link hosts, never whole URLs', () => {
    const tokens = tokenize({
      links: [{ href: 'https://track.mailer.example/click?id=per-recipient-9f21a', text: 'here' }],
    });
    expect(tokens).toContain('u:track.mailer.example');
    expect(tokens).toContain('u:mailer.example');
    expect(tokens.some((t) => t.includes('per-recipient'))).toBe(false);
  });

  it('records each link host once, however many links share it', () => {
    const tokens = tokenize({
      links: [
        { href: 'https://a.example/1', text: '1' },
        { href: 'https://a.example/2', text: '2' },
      ],
    });
    expect(tokens.filter((t) => t === 'u:a.example')).toHaveLength(1);
  });

  it('records header facts rather than header values', () => {
    const tokens = tokenize({
      headers: {
        listUnsubscribe: '<mailto:stop@list.example?subject=unsub-9f21>',
        replyTo: 'someone@else.example',
        authenticationResults: 'mx.google.com; spf=pass; dkim=fail; dmarc=pass',
      },
    });
    expect(tokens).toContain('h:has_list_unsubscribe');
    expect(tokens).toContain('h:has_reply_to');
    expect(tokens).toContain('h:spf_pass');
    expect(tokens).toContain('h:dkim_fail');
    expect(tokens).toContain('h:dmarc_pass');
    expect(tokens.some((t) => t.includes('unsub-9f21'))).toBe(false);
    expect(tokens.some((t) => t.includes('else.example'))).toBe(false);
  });

  it('emits no authentication token when the header says nothing', () => {
    expect(tokenize({ headers: {} }).some((t) => t.startsWith('h:'))).toBe(false);
  });

  it('keeps duplicates, because repetition is evidence at scoring time', () => {
    const tokens = tokenize({ body: 'bitcoin bitcoin bitcoin' });
    expect(tokens.filter((t) => t === 'b:bitcoin')).toHaveLength(3);
  });

  it('caps how much body it reads, so a huge message cannot slow a render', () => {
    const long = `${'filler word '.repeat(4000)}sentinelword`;
    expect(long.length).toBeGreaterThan(20_000);
    expect(tokenize({ body: long })).not.toContain('b:sentinelword');
  });

  it('returns nothing for an empty input rather than throwing', () => {
    expect(tokenize({})).toEqual([]);
    expect(tokenize({ subject: '', body: '', from: { address: '' } })).toEqual([]);
  });

  it('survives malformed input the rules would also see', () => {
    expect(() =>
      tokenize({
        from: { address: 'not-an-address' },
        links: [{ href: 'not a url', text: '' }],
        headers: { authenticationResults: '((((' },
      }),
    ).not.toThrow();
  });
});

describe('countTokens', () => {
  it('folds a multiset into counts', () => {
    expect(countTokens(['a', 'b', 'a'])).toEqual({ a: 2, b: 1 });
  });

  it('is empty for no tokens', () => {
    expect(countTokens([])).toEqual({});
  });
});
