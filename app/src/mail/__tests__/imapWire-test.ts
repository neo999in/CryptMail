import { utf8ToBytes } from '../../lib/base64';
import {
  astring,
  fetchAttributes,
  imapDate,
  parseInternalDate,
  ResponseReader,
  tokenize,
  uidSet,
} from '../imapWire';
import { bytesToUtf8 } from '../../lib/base64';

const bytes = (text: string) => utf8ToBytes(text);

describe('ResponseReader', () => {
  it('frames status, data and continuation responses', () => {
    const reader = new ResponseReader();
    const out = reader.push(bytes('* OK [UIDVALIDITY 3857529045] UIDs valid\r\n* 12 EXISTS\r\n+ go ahead\r\nC1 NO [AUTHENTICATIONFAILED] nope\r\n'));
    expect(out.map((r) => [r.tag, r.kind, r.num, r.code])).toEqual([
      ['*', 'OK', undefined, 'UIDVALIDITY 3857529045'],
      ['*', 'EXISTS', 12, undefined],
      ['+', 'CONTINUE', undefined, undefined],
      ['C1', 'NO', undefined, 'AUTHENTICATIONFAILED'],
    ]);
    expect(out[3].text).toBe('nope');
  });

  it('waits for a literal split across many chunks, counting bytes rather than characters', () => {
    const body = 'Grüße 👋\r\n)\r\nC9 OK not really the end\r\n';
    const size = utf8ToBytes(body).length;
    const wire = utf8ToBytes(`* 1 FETCH (UID 7 BODY[] {${size}}\r\n${body})\r\nC2 OK done\r\n`);
    const reader = new ResponseReader();
    const seen = [];
    for (let i = 0; i < wire.length; i += 3) seen.push(...reader.push(wire.subarray(i, i + 3)));

    expect(seen.map((r) => r.kind)).toEqual(['FETCH', 'OK']);
    const attrs = fetchAttributes(seen[0].values);
    expect(bytesToUtf8(attrs['BODY[]'] as Uint8Array)).toBe(body);
    expect(attrs['UID']).toBe('7');
  });
});

describe('tokenize', () => {
  it('reads lists, NIL, quoted strings with escapes, and bracketed atoms', () => {
    expect(tokenize(['(\\HasNoChildren \\Sent) "/" "Sent \\"Items\\""'])).toEqual([
      ['\\HasNoChildren', '\\Sent'],
      '/',
      'Sent "Items"',
    ]);
    expect(tokenize(['() NIL INBOX'])).toEqual([[], null, 'INBOX']);
    expect(tokenize(['(UID 3 BODY[HEADER.FIELDS (FROM TO)] NIL)'])).toEqual([
      ['UID', '3', 'BODY[HEADER.FIELDS (FROM TO)]', null],
    ]);
  });

  it('decodes a quoted string as UTF-8', () => {
    const latin1 = String.fromCharCode(...Array.from(utf8ToBytes('"Entwürfe"')));
    expect(tokenize([latin1])).toEqual(['Entwürfe']);
  });
});

describe('writing', () => {
  it('quotes printable ASCII and escapes quote and backslash', () => {
    expect(astring('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
  });

  it('sends anything that could end the line, or is not ASCII, as a literal', () => {
    expect(astring('pass\r\nC2 LOGOUT')).toEqual({ literal: utf8ToBytes('pass\r\nC2 LOGOUT') });
    expect(astring('pässword')).toEqual({ literal: utf8ToBytes('pässword') });
  });

  it('compresses UID sets', () => {
    expect(uidSet([5, 4, 3, 1, 9, 10])).toBe('1,3:5,9:10');
    expect(uidSet([7])).toBe('7');
  });

  it('formats and parses dates', () => {
    expect(imapDate(new Date(Date.UTC(2026, 8, 3)))).toBe('3-Sep-2026');
    expect(parseInternalDate('17-Jul-1996 02:44:25 -0700')).toBe('1996-07-17T09:44:25.000Z');
    expect(parseInternalDate(' 7-Jul-1996 02:44:25 +0000')).toBe('1996-07-07T02:44:25.000Z');
    expect(parseInternalDate('garbage')).toBeNull();
  });
});
