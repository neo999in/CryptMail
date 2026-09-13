/**
 * The export format, pinned.
 *
 * An mbox that another client cannot parse is not a backup, and the two ways
 * this goes wrong are both silent: a `From ` line inside a body splitting one
 * message into two, and a timestamp written in the device's locale that no
 * reader recognises. Both are asserted here rather than discovered in
 * Thunderbird.
 */
import { emlFilename, entryToMbox, mboxFilename, toMbox } from '../mbox';

const raw = (subject: string, body = 'Body text.') =>
  ['From: someone@example.com', 'To: you@gmail.com', `Subject: ${subject}`, '', body].join('\r\n');

describe('writing an mbox', () => {
  it('opens each message with a From line carrying the sender and a C-locale date', () => {
    const out = toMbox([
      { from: 'someone@example.com', date: '2026-08-30T10:00:00.000Z', raw: raw('Hello') },
    ]);

    expect(out.startsWith('From someone@example.com Sun Aug 30 10:00:00 2026\n')).toBe(true);
  });

  it('separates messages with a blank line', () => {
    const out = toMbox([{ raw: raw('One') }, { raw: raw('Two') }]);

    // Two envelope lines, and the second one starts a line of its own.
    expect(out.match(/^From /gm)).toHaveLength(2);
    expect(out).toContain('\n\nFrom ');
  });

  it('translates the wire’s CRLF to the file’s LF', () => {
    const out = toMbox([{ raw: raw('Hello') }]);

    expect(out).not.toContain('\r');
    expect(out).toContain('Subject: Hello\n');
  });

  /**
   * The bug this format exists to avoid: a body line beginning `From ` would
   * otherwise be read as the start of the next message, splitting one email
   * into two on import.
   */
  it('quotes a From line inside the body', () => {
    const out = toMbox([{ raw: raw('Quoted', 'From here on it gets worse.') }]);

    expect(out).toContain('>From here on it gets worse.');
    expect(out.match(/^From /gm)).toHaveLength(1);
  });

  /** mboxrd, so unquoting on import is unambiguous rather than a guess. */
  it('adds a level to an already-quoted From line', () => {
    const out = toMbox([{ raw: raw('Quoted', '>From earlier.\n>>From earlier still.') }]);

    expect(out).toContain('>>From earlier.');
    expect(out).toContain('>>>From earlier still.');
  });

  it('names an unknown sender rather than writing an empty From line', () => {
    const out = toMbox([{ date: '2026-08-30T10:00:00.000Z', raw: raw('Hello') }]);

    expect(out.startsWith('From MAILER-DAEMON ')).toBe(true);
  });

  it('falls back to a valid date when the message carries a broken one', () => {
    const out = toMbox([{ from: 'a@example.com', date: 'not a date', raw: raw('Hello') }]);

    expect(out).toMatch(/^From a@example\.com \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\n/);
  });

  it('exports the ciphertext of an encrypted message, unchanged', () => {
    const sealed = [
      'From: someone@example.com',
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary=b',
      'Subject: [Encrypted message]',
      '',
      '--b',
      '-----BEGIN PGP MESSAGE-----',
      'hQIMA0abc',
      '-----END PGP MESSAGE-----',
      '--b--',
    ].join('\r\n');

    const out = toMbox([{ raw: sealed }]);

    expect(out).toContain('-----BEGIN PGP MESSAGE-----');
    expect(out).toContain('Subject: [Encrypted message]');
  });

  it('writes nothing at all for no messages', () => {
    expect(toMbox([])).toBe('');
  });
});

describe('the file it is written to', () => {
  it('is named for the mailbox and the day', () => {
    expect(mboxFilename('You@Gmail.com', new Date('2026-09-06T12:00:00Z'))).toBe(
      'you-gmail-com-2026-09-06.mbox',
    );
  });
});

describe('writing one message at a time', () => {
  it('produces exactly what toMbox does for the same messages', () => {
    const entries = [{ from: 'a@example.com', date: '2026-08-30T10:00:00.000Z', raw: raw('One') }, { raw: raw('Two') }];

    expect(entries.map(entryToMbox).join('')).toBe(toMbox(entries));
  });
});

describe('an .eml filename', () => {
  it('leads with the day so a folder of them sorts by date', () => {
    expect(emlFilename({ id: '18c2f0a9b7d3e1f4', date: '2026-08-30T10:00:00.000Z', subject: 'Quarterly numbers!' })).toBe(
      '2026-08-30-quarterly-numbers-b7d3e1f4.eml',
    );
  });

  /**
   * The caller passes the header subject, so an encrypted message is named for
   * its placeholder — the real subject is ciphertext, and a filename is not.
   */
  it('names an encrypted message by its placeholder subject', () => {
    expect(emlFilename({ id: 'abc', date: '2026-08-30T10:00:00.000Z', subject: '[Encrypted message]' })).toBe(
      '2026-08-30-encrypted-message-abc.eml',
    );
  });

  it('still makes a usable name from a message with no subject or date', () => {
    expect(emlFilename({ id: 'x1', date: 'garbage', subject: '' })).toBe('undated-message-x1.eml');
  });
});
