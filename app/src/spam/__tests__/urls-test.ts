/**
 * Link analysis, and the promise that it is entirely local.
 *
 * The first test in this file is the important one: it replaces every network
 * primitive in scope with a spy and asserts that classifying a message full of
 * hostile URLs touches none of them. A filter that fetched a link to "just check"
 * where it goes would confirm to a spammer that the message was read, feed a
 * tracking URL its confirmation, and pull attacker-controlled content onto the
 * user's network. That property is easy to lose in a later edit and impossible to
 * notice by reading, so it is pinned here.
 *
 * The rest is the same shape as the header tests: each disguise leaves a mark that
 * can be read from the characters of the URL, no single mark is a verdict, and a
 * shortened link — which every newsletter platform on earth produces — is worth a
 * fraction of a point.
 */
import { SPAM_THRESHOLD, type SpamInput } from '../types';
import { extractLinks, hasDeceptiveLink, isIpHost, isObfuscatedHost, urlSymbols } from '../urls';

const names = (input: SpamInput): string[] => urlSymbols(input).map((s) => s.name);

const weightOf = (input: SpamInput, name: string): number | undefined =>
  urlSymbols(input).find((s) => s.name === name)?.weight;

/** One link, with enough body text that `URL_ONLY_MESSAGE` stays quiet. */
const oneLink = (href: string, text = ''): SpamInput => ({
  from: { address: 'sender@mailer.example' },
  body: 'x'.repeat(250),
  links: [{ href, text }],
});

describe('no network access, ever', () => {
  it('classifies hostile URLs without making a single request', () => {
    const originals = {
      fetch: (globalThis as Record<string, unknown>).fetch,
      XMLHttpRequest: (globalThis as Record<string, unknown>).XMLHttpRequest,
    };
    const fetchSpy = jest.fn(() => {
      throw new Error('the URL analyser must never make a request');
    });
    const xhrSpy = jest.fn(() => {
      throw new Error('the URL analyser must never make a request');
    });
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    (globalThis as Record<string, unknown>).XMLHttpRequest = xhrSpy;

    try {
      urlSymbols({
        from: { address: 'security@paypa1-verify.example' },
        body: 'Verify your account.',
        links: [
          { href: 'http://198.51.100.24/paypal/login/verify?session=8f21', text: 'https://www.paypal.com' },
          { href: 'https://bit.ly/3xqZp1a', text: 'Claim here' },
          { href: 'https://paypal.com@evil.example/signin', text: 'Sign in' },
        ],
      });
      extractLinks('<a href="https://evil.example/login">https://bank.example</a><img src="https://tracker.example/x.gif">');
    } finally {
      (globalThis as Record<string, unknown>).fetch = originals.fetch;
      (globalThis as Record<string, unknown>).XMLHttpRequest = originals.XMLHttpRequest;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });
});

describe('isIpHost', () => {
  it('recognises IPv4 and bracketed IPv6 literals', () => {
    expect(isIpHost('198.51.100.24')).toBe(true);
    expect(isIpHost('127.0.0.1')).toBe(true);
    expect(isIpHost('[2001:db8::1]')).toBe(true);
  });

  it('does not mistake a domain or an out-of-range quad for an address', () => {
    expect(isIpHost('example.com')).toBe(false);
    expect(isIpHost('999.1.1.1')).toBe(false);
    expect(isIpHost('1.2.3')).toBe(false);
    expect(isIpHost('1.2.3.4.5')).toBe(false);
  });
});

describe('isObfuscatedHost', () => {
  it('recognises the numeric spellings of an address', () => {
    expect(isObfuscatedHost('0x7f000001')).toBe(true);
    expect(isObfuscatedHost('2130706433')).toBe(true);
    expect(isObfuscatedHost('017700000001')).toBe(true);
  });

  it('leaves ordinary hosts and dotted quads alone', () => {
    expect(isObfuscatedHost('example.com')).toBe(false);
    expect(isObfuscatedHost('198.51.100.24')).toBe(false);
    expect(isObfuscatedHost('123')).toBe(false);
  });
});

describe('where a link points', () => {
  it('flags a link to a bare IP address', () => {
    expect(names(oneLink('http://198.51.100.24/paypal/login/verify'))).toContain('URL_IP_ADDRESS');
  });

  it('flags the numeric spellings of an address more heavily still', () => {
    const ip = weightOf(oneLink('http://198.51.100.24/x'), 'URL_IP_ADDRESS')!;
    const hex = weightOf(oneLink('http://0x7f000001/x'), 'URL_OBFUSCATED_HOST')!;
    expect(hex).toBeGreaterThan(ip);
    expect(hex).toBeLessThan(SPAM_THRESHOLD);
  });

  it('flags a shortener, but only just — every newsletter uses one', () => {
    const input = oneLink('https://bit.ly/3xqZp1a');
    expect(names(input)).toContain('URL_SHORTENER');
    expect(weightOf(input, 'URL_SHORTENER')).toBeLessThan(1);
  });

  it('flags a punycode host', () => {
    expect(names(oneLink('https://xn--pypal-4ve.com/signin'))).toContain('URL_PUNYCODE_HOST');
  });

  it('flags a host that renders as a brand, and grades the three ways it can', () => {
    const confusable = weightOf(oneLink('https://paypa1.com/x'), 'URL_LOOKALIKE_DOMAIN')!;
    const nearMiss = weightOf(oneLink('https://paypall.com/x'), 'URL_LOOKALIKE_DOMAIN')!;
    const embedded = weightOf(oneLink('https://paypal.account-verify.example/x'), 'URL_LOOKALIKE_DOMAIN')!;
    expect(confusable).toBeGreaterThan(nearMiss);
    expect(nearMiss).toBeGreaterThan(embedded);
    expect(confusable).toBeLessThan(SPAM_THRESHOLD);
  });

  it('says nothing at all about a link to the brand’s own site', () => {
    expect(names(oneLink('https://www.paypal.com/signin'))).toEqual([]);
    expect(names(oneLink('https://s3.amazonaws.com/bucket/report.pdf'))).toEqual([]);
  });

  it('flags userinfo written to make a URL read as another site', () => {
    const input = oneLink('https://paypal.com@evil.example/signin');
    expect(names(input)).toContain('URL_USERINFO');
    expect(hasDeceptiveLink(urlSymbols(input))).toBe(true);
  });

  it('flags hidden characters inside a URL', () => {
    expect(names(oneLink('https://exam​ple.com/login'))).toContain('URL_INVISIBLE_CHARS');
  });

  it('flags a redirector carrying somebody else’s URL', () => {
    expect(names(oneLink('https://mail.shop.example/click?url=https%3A%2F%2Fevil.example%2Flogin')))
      .toContain('URL_EMBEDDED_REDIRECT');
  });

  it('does not flag a same-site ?next=, which is how ordinary sign-in works', () => {
    const input: SpamInput = {
      from: { address: 'a@shop.example' },
      body: 'x'.repeat(250),
      links: [{ href: 'https://shop.example/login?next=https%3A%2F%2Fshop.example%2Faccount', text: 'Sign in' }],
    };
    expect(names(input)).not.toContain('URL_EMBEDDED_REDIRECT');
  });

  it('survives a malformed percent-escape in a redirect parameter', () => {
    expect(() => urlSymbols(oneLink('https://a.example/click?url=%E0%A4%A'))).not.toThrow();
  });

  it('flags a path encoded past the point of readability', () => {
    expect(names(oneLink('https://a.example/%68%74%74%70%73%3a%2f%2f%70%61%79%70%61%6c')))
      .toContain('URL_HEAVILY_ENCODED');
  });

  it('flags a sign-in style path on somebody else’s domain', () => {
    expect(names(oneLink('https://secure-mail.example/account/verify/password'))).toContain('URL_CREDENTIAL_PATH');
  });

  it('does not flag a single /login, which every service has', () => {
    expect(names(oneLink('https://northgate-eng.example/login'))).not.toContain('URL_CREDENTIAL_PATH');
  });

  it('does not flag a sign-in path on the sender’s own domain', () => {
    const input: SpamInput = {
      from: { address: 'no-reply@northgate-bank.example' },
      body: 'x'.repeat(250),
      links: [{ href: 'https://www.northgate-bank.example/security/account/verify', text: 'Review activity' }],
    };
    expect(names(input)).toEqual([]);
  });

  it('flags a host long enough to hide a brand off the end of a phone screen', () => {
    const symbols = names(oneLink('https://secure.paypal.com.verify.example/session'));
    expect(symbols).toContain('URL_DEEP_SUBDOMAIN');
    expect(symbols).toContain('URL_LOOKALIKE_DOMAIN');
  });

  it('flags a brand’s name on a free hosting page', () => {
    expect(names(oneLink('https://paypal-secure.github.io/login'))).toContain('URL_BRAND_ON_FREE_HOST');
  });

  it('does not read the hosting provider’s own name as impersonation', () => {
    // `sites.google.com` is Google's, so its suffix must not count as a brand claim.
    expect(names(oneLink('https://sites.google.com/view/team-notes'))).not.toContain('URL_BRAND_ON_FREE_HOST');
  });
});

describe('what a link claims versus where it goes', () => {
  it('flags anchor text that is a URL somewhere else — the clearest lie there is', () => {
    const input = oneLink('https://evil.example/login', 'https://bank.example');
    expect(names(input)).toContain('URL_TEXT_HOST_MISMATCH');
    expect(hasDeceptiveLink(urlSymbols(input))).toBe(true);
  });

  it('flags anchor text that is a bare domain somewhere else', () => {
    expect(names(oneLink('https://evil.example/login', 'www.paypal.com'))).toContain('URL_TEXT_HOST_MISMATCH');
  });

  it('does not flag anchor text naming the host it actually goes to', () => {
    expect(names(oneLink('https://mail.shop.example/orders', 'shop.example'))).toEqual([]);
  });

  it('flags anchor text naming a brand the destination does not belong to', () => {
    expect(names(oneLink('https://secure-payments.example/x', 'Log in to PayPal')))
      .toContain('URL_TEXT_BRAND_MISMATCH');
  });

  it('does not flag anchor text naming the brand it really links to', () => {
    expect(names(oneLink('https://www.paypal.com/signin', 'Log in to PayPal'))).toEqual([]);
  });

  it('scores the outright lie above the brand mismatch', () => {
    const lie = weightOf(oneLink('https://evil.example/x', 'https://paypal.com'), 'URL_TEXT_HOST_MISMATCH')!;
    const claim = weightOf(oneLink('https://evil.example/x', 'Log in to PayPal'), 'URL_TEXT_BRAND_MISMATCH')!;
    expect(lie).toBeGreaterThan(claim);
  });

  it('ignores empty anchor text rather than treating it as a claim', () => {
    expect(names(oneLink('https://mail.shop.example/orders', '   '))).toEqual([]);
  });
});

describe('aggregates', () => {
  it('fires each finding once however many links share it', () => {
    const input: SpamInput = {
      from: { address: 'a@mailer.example' },
      body: 'x'.repeat(250),
      links: Array.from({ length: 12 }, (_, i) => ({ href: `https://bit.ly/link${i}`, text: `${i}` })),
    };
    expect(names(input).filter((n) => n === 'URL_SHORTENER')).toHaveLength(1);
  });

  it('notes a message that is nothing but one link', () => {
    const input: SpamInput = {
      from: { address: 'a@mailer.example' },
      body: 'Have a look.',
      links: [{ href: 'https://a.example/x', text: 'here' }],
    };
    expect(names(input)).toContain('URL_ONLY_MESSAGE');
  });

  it('does not note a link inside a real message', () => {
    expect(names(oneLink('https://a.example/x', 'here'))).not.toContain('URL_ONLY_MESSAGE');
  });

  it('notes mail scattered across many different hosts', () => {
    const input: SpamInput = {
      from: { address: 'a@mailer.example' },
      body: 'x'.repeat(250),
      links: Array.from({ length: 9 }, (_, i) => ({ href: `https://host${i}.example/x`, text: `${i}` })),
    };
    expect(names(input)).toContain('URL_MANY_HOSTS');
  });

  it('never lets one URL symbol reach the spam threshold on its own', () => {
    const hostile: SpamInput = {
      from: { address: 'security@paypa1-verify.example' },
      body: 'Verify now.',
      links: [
        { href: 'http://198.51.100.24/paypal/login/verify?session=1', text: 'https://www.paypal.com' },
        { href: 'https://bit.ly/x', text: 'Claim' },
        { href: 'https://paypal.com@evil.example/signin', text: 'Sign in' },
      ],
    };
    const symbols = urlSymbols(hostile);
    expect(symbols.length).toBeGreaterThan(3);
    for (const symbol of symbols) expect(Math.abs(symbol.weight)).toBeLessThan(SPAM_THRESHOLD);
    expect(symbols.reduce((sum, s) => sum + s.weight, 0)).toBeGreaterThan(SPAM_THRESHOLD);
  });
});

describe('defensive input handling', () => {
  it('returns nothing when there are no links', () => {
    expect(urlSymbols({})).toEqual([]);
    expect(urlSymbols({ links: [] })).toEqual([]);
  });

  it('skips links it cannot read a host out of, without throwing', () => {
    const input = {
      links: [
        { href: 'not a url', text: 'x' },
        { href: '', text: 'x' },
        { href: '   ', text: 'x' },
        { href: 'mailto:a@b.example', text: 'x' },
        { href: 'javascript:alert(1)', text: 'x' },
      ],
    } as SpamInput;
    expect(urlSymbols(input)).toEqual([]);
  });

  it('survives links whose fields are not strings at all', () => {
    const hostile = {
      links: [null, undefined, {}, { href: 42 }, { href: 'https://a.example/x', text: 99 }],
    } as unknown as SpamInput;
    expect(() => urlSymbols(hostile)).not.toThrow();
  });

  it('survives a links field that is not a list', () => {
    // The field arrives from a provider response, so "not an array" is a shape the
    // analyser has to tolerate rather than iterate.
    expect(urlSymbols({ links: 'none' } as unknown as SpamInput)).toEqual([]);
    expect(urlSymbols({ links: null } as unknown as SpamInput)).toEqual([]);
  });
});

describe('extractLinks', () => {
  it('pairs an href with its visible text', () => {
    expect(extractLinks('<a href="https://a.example/x">Click here</a>')).toEqual([
      { href: 'https://a.example/x', text: 'Click here' },
    ]);
  });

  it('reads single-quoted and unquoted hrefs', () => {
    expect(extractLinks("<a href='https://a.example/1'>one</a>")).toEqual([{ href: 'https://a.example/1', text: 'one' }]);
    expect(extractLinks('<a href=https://a.example/2 class=x>two</a>')).toEqual([
      { href: 'https://a.example/2', text: 'two' },
    ]);
  });

  it('drops every scheme that is not http or https', () => {
    const html =
      '<a href="javascript:alert(1)">a</a>' +
      '<a href="data:text/html;base64,PHNjcmlwdD4=">b</a>' +
      '<a href="file:///etc/passwd">c</a>' +
      '<a href="mailto:a@b.example">d</a>' +
      '<a href="https://ok.example/">e</a>';
    expect(extractLinks(html)).toEqual([{ href: 'https://ok.example/', text: 'e' }]);
  });

  it('strips nested markup out of the anchor text', () => {
    expect(extractLinks('<a href="https://a.example/"><b>Click</b> <i>here</i></a>')[0].text).toBe('Click here');
  });

  it('decodes the entities a real mail sender writes', () => {
    expect(extractLinks('<a href="https://a.example/?x=1&amp;y=2">a&nbsp;b</a>')).toEqual([
      { href: 'https://a.example/?x=1&y=2', text: 'a b' },
    ]);
  });

  it('does not manufacture markup out of a double-escaped entity', () => {
    // `&amp;lt;` must decode to the text `&lt;`, never to `<`.
    expect(extractLinks('<a href="https://a.example/">&amp;lt;b&amp;gt;</a>')[0].text).toBe('&lt;b&gt;');
  });

  it('keeps the href of an unclosed anchor, without its text', () => {
    expect(extractLinks('<a href="https://a.example/x">no closing tag')).toEqual([
      { href: 'https://a.example/x', text: '' },
    ]);
  });

  it('does not record the same href twice from the second pass', () => {
    expect(extractLinks('<a href="https://a.example/x">one</a>')).toHaveLength(1);
  });

  it('caps how many links it will return', () => {
    const html = Array.from({ length: 260 }, (_, i) => `<a href="https://a.example/${i}">${i}</a>`).join('');
    expect(extractLinks(html)).toHaveLength(200);
  });

  it('caps how much markup it will read, so a huge page cannot stall a render', () => {
    const html = `${'<span>filler</span>'.repeat(30_000)}<a href="https://sentinel.example/">end</a>`;
    expect(html.length).toBeGreaterThan(400_000);
    expect(extractLinks(html).some((link) => link.href.includes('sentinel'))).toBe(false);
  });

  it('returns nothing for markup with no anchors, or no markup at all', () => {
    expect(extractLinks('')).toEqual([]);
    expect(extractLinks('<p>Just words.</p>')).toEqual([]);
    expect(extractLinks(undefined as unknown as string)).toEqual([]);
  });

  it('survives markup written to break a parser', () => {
    const hostile =
      '<a href="<a href=">x</a>' +
      `<a ${'href='.repeat(400)}"https://a.example/">y</a>` +
      `<a href="https://a.example/${'?a=b&'.repeat(2000)}">z</a>` +
      `<a href="https://a.example/">${'<b>'.repeat(3000)}</a>`;
    expect(() => extractLinks(hostile)).not.toThrow();
  });
});

describe('hasDeceptiveLink', () => {
  it('is true only for the symbols that mean a link hid its destination', () => {
    expect(hasDeceptiveLink([{ name: 'URL_TEXT_HOST_MISMATCH', weight: 3.2, kind: 'phishing' }])).toBe(true);
    expect(hasDeceptiveLink([{ name: 'URL_USERINFO', weight: 2.8, kind: 'phishing' }])).toBe(true);
    expect(hasDeceptiveLink([{ name: 'URL_SHORTENER', weight: 0.8, kind: 'spam' }])).toBe(false);
    expect(hasDeceptiveLink([])).toBe(false);
  });
});
