/**
 * Message assembly, against docs/message-format.md.
 *
 * The Autocrypt header on a plaintext message is what makes the invite worth
 * sending: it is the only thing in that email, and a fresh install answering it
 * can encrypt straight away because of it.
 */
import { decodeUtf8Base64 } from '../../lib/base64';
import { autocryptKeydata, buildPlaintext, parseRfc822 } from '../mime';

const KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc\n-----END PGP PUBLIC KEY BLOCK-----';

const base = { from: 'me@example.com', to: ['you@example.com'], subject: 'Hello', body: 'Hi.' };

describe('buildPlaintext', () => {
  it('is unchanged when no key is supplied', () => {
    const lines = buildPlaintext(base).split('\n');
    const date = lines[2];
    expect(date).toMatch(/^Date: /);
    expect(lines).toEqual([
      'From: me@example.com',
      'To: you@example.com',
      date,
      'Subject: Hello',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hi.',
      '',
    ]);
  });

  it('emits exactly one Autocrypt header when a key is supplied', () => {
    const raw = buildPlaintext({ ...base, autocryptKey: KEY });
    expect(raw.split('\n').filter((l) => l.startsWith('Autocrypt:'))).toHaveLength(1);
  });

  it('carries the key back out again, unchanged', () => {
    const { headers } = parseRfc822(buildPlaintext({ ...base, autocryptKey: KEY }));
    const keydata = headers['autocrypt']?.match(/keydata=(.+)$/)?.[1];
    expect(headers['autocrypt']).toContain('addr=me@example.com');
    expect(headers['autocrypt']).toContain('prefer-encrypt=mutual');
    expect(keydata).toBe(autocryptKeydata(KEY));
    expect(decodeUtf8Base64(keydata!)).toBe(KEY);
  });

  it('keeps the header in the header block, before the body', () => {
    const raw = buildPlaintext({ ...base, autocryptKey: KEY });
    expect(raw.indexOf('Autocrypt:')).toBeLessThan(raw.indexOf('MIME-Version'));
    expect(parseRfc822(raw).body.trim()).toBe('Hi.');
  });
});
