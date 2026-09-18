import { addressesIn, decodeAddress, decodeEncodedWords, parseHeaderBlock, splitAddressList } from '../headers';

describe('decodeEncodedWords', () => {
  it('decodes B and Q words, and joins adjacent ones without the space between', () => {
    expect(decodeEncodedWords('=?UTF-8?B?w5xiZXI=?=')).toBe('Über');
    expect(decodeEncodedWords('=?utf-8?q?Caf=C3=A9_au_lait?=')).toBe('Café au lait');
    expect(decodeEncodedWords('=?UTF-8?Q?Hello?=\r\n =?UTF-8?Q?_world?=')).toBe('Hello world');
    expect(decodeEncodedWords('Re: =?ISO-8859-1?Q?caf=E9?= today')).toBe('Re: café today');
  });

  it('leaves plain text and undecodable words alone', () => {
    expect(decodeEncodedWords('Plain subject')).toBe('Plain subject');
    expect(decodeEncodedWords('=?x-unknown-charset?B?AAAA?=')).toBe('=?x-unknown-charset?B?AAAA?=');
  });
});

describe('addresses', () => {
  it('splits on the commas between addresses only', () => {
    expect(splitAddressList('"Doe, Jane" <jane@x.org>, bob@x.org, (a, comment) carol@x.org')).toEqual([
      '"Doe, Jane" <jane@x.org>',
      'bob@x.org',
      '(a, comment) carol@x.org',
    ]);
  });

  it('decodes a display name and lowercases the address', () => {
    expect(decodeAddress('=?UTF-8?Q?J=C3=B6rg?= <Joerg@Example.COM>')).toEqual({ address: 'joerg@example.com', name: 'Jörg' });
  });

  it('reads group syntax and skips anything that is not an address', () => {
    expect(addressesIn('team: a@x.org, b@x.org;, undisclosed-recipients:;')).toEqual(['a@x.org', 'b@x.org']);
  });
});

it('unfolds a header block and keeps the first of a repeated header', () => {
  expect(parseHeaderBlock('Subject: one\r\n two\r\nReceived: a\r\nReceived: b\r\n')).toEqual({
    subject: 'one two',
    received: 'a',
  });
});
