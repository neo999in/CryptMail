import { hostOf, linkify, pathOf } from '../links';

/** The URLs found in a body, in order. */
const urls = (text: string) => linkify(text).flatMap((s) => (s.url ? [s.url] : []));

describe('linkify', () => {
  test('leaves text with no URL as a single segment', () => {
    expect(linkify('nothing to see here')).toEqual([{ text: 'nothing to see here' }]);
  });

  test('returns nothing for empty text', () => {
    expect(linkify('')).toEqual([]);
  });

  test('marks an http and an https URL', () => {
    expect(urls('go to https://example.com and http://other.example/x')).toEqual([
      'https://example.com',
      'http://other.example/x',
    ]);
  });

  test('segments concatenate back to the original text', () => {
    const body = 'see https://example.com/a. Then https://example.com/b, thanks.';
    expect(
      linkify(body)
        .map((s) => s.text)
        .join(''),
    ).toBe(body);
  });

  test('a link segment displays the URL it opens', () => {
    const [, link] = linkify('go to https://example.com/a');
    expect(link).toEqual({ text: 'https://example.com/a', url: 'https://example.com/a' });
  });

  /* ------------------------------------------------------- punctuation ---- */

  test('does not swallow the full stop that ends the sentence', () => {
    expect(urls('…see https://x.example/a.')).toEqual(['https://x.example/a']);
  });

  test('drops a trailing comma, colon, semicolon and quote', () => {
    expect(urls('a https://x.example/a, b https://x.example/b: c https://x.example/c"')).toEqual([
      'https://x.example/a',
      'https://x.example/b',
      'https://x.example/c',
    ]);
  });

  test('drops a bracket the URL did not open', () => {
    expect(urls('(see https://x.example/a)')).toEqual(['https://x.example/a']);
  });

  test('keeps a bracket the URL did open', () => {
    expect(urls('https://en.wikipedia.org/wiki/Ruby_(gem) is the one')).toEqual([
      'https://en.wikipedia.org/wiki/Ruby_(gem)',
    ]);
  });

  test('resumes scanning at the punctuation it trimmed', () => {
    // The `.` between them belongs to the prose, not to either URL.
    expect(urls('https://a.example/x.https://b.example/y')).toEqual(['https://a.example/x.https://b.example/y']);
    expect(urls('https://a.example/x. https://b.example/y')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ]);
  });

  test('ends a URL wrapped in angle brackets at the bracket', () => {
    expect(urls('<https://x.example/a>')).toEqual(['https://x.example/a']);
  });

  /* -------------------------------------------------- rejected schemes ---- */

  test('never linkifies javascript:, data: or file:', () => {
    expect(urls('javascript:alert(1) data:text/html,x file:///etc/passwd')).toEqual([]);
  });

  test('does not invent a scheme for a bare www address', () => {
    expect(urls('visit www.example.com today')).toEqual([]);
  });

  test('does not linkify a mailto: address', () => {
    expect(urls('write to mailto:ada@example.com')).toEqual([]);
  });

  test('requires the scheme to start a word', () => {
    expect(urls('seehttps://x.example/a')).toEqual([]);
  });

  test('a scheme with no host is not a link', () => {
    expect(urls('https:// and https://?x=1')).toEqual([]);
  });

  test('links the https URL inside a hostile-looking string, and only that', () => {
    // The `javascript:` prefix is prose as far as this is concerned; what comes
    // back is a plain https URL, which is the only thing that can be opened.
    expect(urls('javascript:https://x.example/a')).toEqual(['https://x.example/a']);
  });
});

describe('hostOf', () => {
  test('reads the host, lowercased', () => {
    expect(hostOf('https://Keys.OpenPGP.org/verify/abc')).toBe('keys.openpgp.org');
  });

  test('drops the port', () => {
    expect(hostOf('https://example.com:8443/x')).toBe('example.com');
  });

  test('reads the host after userinfo, not before it', () => {
    expect(hostOf('https://keys.openpgp.org@evil.example/verify/x')).toBe('evil.example');
  });

  test('is null for a non-http scheme', () => {
    expect(hostOf('mailto:ada@example.com')).toBeNull();
  });
});

describe('pathOf', () => {
  test('includes the query and fragment', () => {
    expect(pathOf('https://example.com/a/b?x=1#f')).toBe('/a/b?x=1#f');
  });

  test('is empty when the URL is a bare host', () => {
    expect(pathOf('https://example.com')).toBe('');
  });
});
