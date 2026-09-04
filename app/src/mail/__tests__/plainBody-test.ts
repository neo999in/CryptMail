/**
 * Reading the human-readable body out of third-party mail.
 *
 * Every case here comes from mail that a real Gmail account actually receives.
 * The demo fixtures are single-part US-ASCII, so none of this was reachable
 * until the app first opened a real message on 2026-08-08 and rendered the
 * multipart boundary, the part headers and the raw `=E2=80=87` escapes at the
 * user.
 */
import { attachmentsOf, htmlOf, plainBodyOf } from '../plainBody';

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

describe('single-part messages', () => {
  it('returns the body of a bare text/plain message', () => {
    const raw = 'From: a@b.c\nSubject: Hi\nContent-Type: text/plain\n\nHello there.\n';
    expect(plainBodyOf(raw)).toBe('Hello there.');
  });

  it('reads a message with no Content-Type at all', () => {
    expect(plainBodyOf('From: a@b.c\n\nJust text.')).toBe('Just text.');
  });

  it('survives CRLF line endings, which is what the wire actually carries', () => {
    expect(plainBodyOf(crlf('Content-Type: text/plain\n\nHello there.\n'))).toBe('Hello there.');
  });
});

describe('quoted-printable', () => {
  it('decodes multi-byte UTF-8 escapes rather than showing =E2=80=87', () => {
    const raw =
      'Content-Type: text/plain; charset="utf-8"\n' +
      'Content-Transfer-Encoding: quoted-printable\n\n' +
      'Ship your first commit=E2=80=87now.';
    // U+2007 FIGURE SPACE — the exact sequence that leaked into the UI.
    expect(plainBodyOf(raw)).toBe('Ship your first commit now.');
  });

  it('joins soft line breaks', () => {
    const raw =
      'Content-Type: text/plain\n' +
      'Content-Transfer-Encoding: quoted-printable\n\n' +
      'one two=\nthree';
    expect(plainBodyOf(raw)).toBe('one twothree');
  });

  it('decodes an escaped equals sign', () => {
    const raw =
      'Content-Type: text/plain\nContent-Transfer-Encoding: quoted-printable\n\n1 =3D 1';
    expect(plainBodyOf(raw)).toBe('1 = 1');
  });
});

describe('the charset a part declares', () => {
  it('reads a Windows-1252 part as one byte per character', () => {
    // `=B7` is a middle dot in Windows-1252 and the *first byte of a pair* in
    // UTF-8, so the UTF-8 reader ate the space after it as well: a footer
    // reading `Help · Privacy` came back as one wrong glyph and no space.
    const raw =
      'Content-Type: text/html; charset=iso-8859-1\n' +
      'Content-Transfer-Encoding: quoted-printable\n\n' +
      'Help =B7 Privacy';
    expect(htmlOf(raw)).toBe('Help · Privacy');
  });

  it('reads the range Windows-1252 fills and ISO-8859-1 leaves as controls', () => {
    // The curly quotes, dashes and bullets a Windows editor puts in a
    // template. Strict Latin-1 would make each of them a control character.
    const raw =
      'Content-Type: text/plain; charset="windows-1252"\n' +
      'Content-Transfer-Encoding: quoted-printable\n\n' +
      '=91quoted=92 =96 dash =85 =95';
    expect(plainBodyOf(raw)).toBe('‘quoted’ – dash … •');
  });

  it('still reads an unlabelled or UTF-8 part as UTF-8', () => {
    const utf8 =
      'Content-Type: text/plain; charset=utf-8\n' +
      'Content-Transfer-Encoding: quoted-printable\n\nCaf=C3=A9';
    const unlabelled =
      'Content-Type: text/plain\nContent-Transfer-Encoding: quoted-printable\n\nCaf=C3=A9';

    expect(plainBodyOf(utf8)).toBe('Café');
    expect(plainBodyOf(unlabelled)).toBe('Café');
  });

  it('reads a base64 part in its declared charset too', () => {
    // `Help · Privacy` with a Windows-1252 middle dot, in literal base64: the
    // test must not depend on a Node global the React Native runtime lacks.
    const raw =
      'Content-Type: text/plain; charset=iso-8859-1\n' +
      'Content-Transfer-Encoding: base64\n\nSGVscCC3IFByaXZhY3k=';
    expect(plainBodyOf(raw)).toBe('Help · Privacy');
  });
});

describe('multipart', () => {
  const alternative = crlf(
    'Content-Type: multipart/alternative; boundary="b1"\n' +
      '\n' +
      '--b1\n' +
      'Content-Type: text/plain; charset="utf-8"\n' +
      '\n' +
      'The plain part.\n' +
      '--b1\n' +
      'Content-Type: text/html; charset="utf-8"\n' +
      '\n' +
      '<p>The HTML part.</p>\n' +
      '--b1--\n',
  );

  it('picks the text/plain part and never shows the boundary', () => {
    const body = plainBodyOf(alternative);
    expect(body).toBe('The plain part.');
    expect(body).not.toMatch(/--b1/);
    expect(body).not.toMatch(/Content-Type/i);
  });

  it('decodes a base64 part', () => {
    const raw = crlf(
      'Content-Type: multipart/alternative; boundary="x"\n\n' +
        '--x\n' +
        'Content-Type: text/plain\n' +
        'Content-Transfer-Encoding: base64\n\n' +
        'SGVsbG8sIHdvcmxkLg==\n' +
        '--x--\n',
    );
    expect(plainBodyOf(raw)).toBe('Hello, world.');
  });

  it('descends into a nested multipart, as mail with attachments carries', () => {
    const raw = crlf(
      'Content-Type: multipart/mixed; boundary="outer"\n\n' +
        '--outer\n' +
        'Content-Type: multipart/alternative; boundary="inner"\n\n' +
        '--inner\n' +
        'Content-Type: text/plain\n\n' +
        'Buried but readable.\n' +
        '--inner--\n' +
        '--outer\n' +
        'Content-Type: application/pdf\n' +
        'Content-Transfer-Encoding: base64\n\n' +
        'JVBERi0=\n' +
        '--outer--\n',
    );
    expect(plainBodyOf(raw)).toBe('Buried but readable.');
  });

  it('falls back to the HTML part as text when there is no plain alternative', () => {
    const raw = crlf(
      'Content-Type: multipart/alternative; boundary="h"\n\n' +
        '--h\n' +
        'Content-Type: text/html\n\n' +
        '<p>Hello <b>there</b>.</p>\n' +
        '--h--\n',
    );
    expect(plainBodyOf(raw)).toBe('Hello there.');
  });

  it('quotes a boundary that appears with no quotes in the header', () => {
    const raw = crlf(
      'Content-Type: multipart/alternative; boundary=nq123\n\n' +
        '--nq123\n' +
        'Content-Type: text/plain\n\n' +
        'Unquoted boundary.\n' +
        '--nq123--\n',
    );
    expect(plainBodyOf(raw)).toBe('Unquoted boundary.');
  });
});

describe('degrading rather than throwing', () => {
  it('returns the raw body when a multipart declares a boundary it never uses', () => {
    // Truncated or malformed mail must still show *something*, not an error.
    const raw = 'Content-Type: multipart/alternative; boundary="missing"\n\norphan text';
    expect(plainBodyOf(raw)).toBe('orphan text');
  });

  it('returns an empty string for an empty body', () => {
    expect(plainBodyOf('Content-Type: text/plain\n\n')).toBe('');
  });
});

describe('attachmentsOf', () => {
  const RAW = [
    'From: ada@example.com',
    'To: me@example.com',
    'Subject: Menu',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Menu attached.',
    '',
    '--b1',
    'Content-Type: application/pdf; name="menu.pdf"',
    'Content-Disposition: attachment; filename="menu.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '',
    '--b1--',
    '',
  ].join('\n');

  it('finds a file on an ordinary email', () => {
    const [file] = attachmentsOf(RAW);
    expect(file).toMatchObject({ name: 'menu.pdf', mimeType: 'application/pdf', data: 'JVBERi0xLjQK' });
    expect(file.size).toBe(9);
  });

  it('leaves the body out of it', () => {
    expect(attachmentsOf(RAW)).toHaveLength(1);
    expect(plainBodyOf(RAW)).toBe('Menu attached.');
  });

  it('finds nothing on a single-part message', () => {
    expect(attachmentsOf(['Subject: Hi', 'Content-Type: text/plain', '', 'Hello.'].join('\n'))).toEqual([]);
  });

  it('skips a part it cannot decode rather than handing over half a file', () => {
    const raw = RAW.replace('Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: 7bit');
    expect(attachmentsOf(raw)).toEqual([]);
  });

  it('descends into a nested multipart', () => {
    const nested = [
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain',
      '',
      'Hi.',
      '--inner--',
      '',
      '--outer',
      'Content-Type: image/png; name="shot.png"',
      'Content-Disposition: inline; filename="shot.png"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <shot@example.com>',
      '',
      'AQID',
      '',
      '--outer--',
      '',
    ].join('\n');

    const [image] = attachmentsOf(nested);
    expect(image).toMatchObject({ name: 'shot.png', mimeType: 'image/png', inline: true, contentId: 'shot@example.com' });
  });
});

/**
 * `htmlOf` exists for one reason: `plainBodyOf` flattens markup to text, and that
 * destroys the pairing of visible label and destination that an anchor *is*. That
 * pairing is the evidence behind the strongest phishing signal the filter has, so
 * the markup has to reach `spam/urls.ts` intact — read there, never rendered.
 */
describe('htmlOf', () => {
  it('returns the HTML part of a multipart/alternative, as markup', () => {
    const raw = crlf(
      'Content-Type: multipart/alternative; boundary="b1"\n\n' +
        '--b1\n' +
        'Content-Type: text/plain\n\n' +
        'Sign in at bank.example.\n' +
        '--b1\n' +
        'Content-Type: text/html\n\n' +
        '<p><a href="https://evil.example/login">https://bank.example</a></p>\n' +
        '--b1--\n',
    );
    const html = htmlOf(raw);
    // Both halves of the anchor survive, which is the whole point.
    expect(html).toContain('href="https://evil.example/login"');
    expect(html).toContain('https://bank.example</a>');
  });

  it('returns a bare text/html message', () => {
    const raw = 'Content-Type: text/html\n\n<a href="https://a.example/x">here</a>';
    expect(htmlOf(raw)).toContain('href="https://a.example/x"');
  });

  it('descends into a nested multipart, as mail with attachments carries', () => {
    const raw = crlf(
      'Content-Type: multipart/mixed; boundary="outer"\n\n' +
        '--outer\n' +
        'Content-Type: multipart/alternative; boundary="inner"\n\n' +
        '--inner\n' +
        'Content-Type: text/plain\n\n' +
        'plain\n' +
        '--inner\n' +
        'Content-Type: text/html\n\n' +
        '<a href="https://buried.example/x">buried</a>\n' +
        '--inner--\n' +
        '--outer\n' +
        'Content-Type: application/pdf\n' +
        'Content-Transfer-Encoding: base64\n\n' +
        'JVBERi0=\n' +
        '--outer--\n',
    );
    expect(htmlOf(raw)).toContain('https://buried.example/x');
  });

  it('decodes quoted-printable before returning it', () => {
    // Without decoding, `=3D` and a soft break would split the href in half and
    // hide exactly the link worth reading.
    const raw =
      'Content-Type: text/html\n' +
      'Content-Transfer-Encoding: quoted-printable\n\n' +
      '<a href=3D"https://evil.example/log=\nin">Sign in</a>';
    expect(htmlOf(raw)).toContain('href="https://evil.example/login"');
  });

  it('decodes a base64 HTML part', () => {
    // Literal base64 rather than an encoder call: the test must not depend on a
    // Node global that the React Native runtime does not have.
    const raw =
      'Content-Type: text/html\n' +
      'Content-Transfer-Encoding: base64\n\n' +
      'PGEgaHJlZj0iaHR0cHM6Ly9hLmV4YW1wbGUveCI+eDwvYT4=';
    expect(htmlOf(raw)).toContain('https://a.example/x');
  });

  it('returns an empty string when the message has no HTML part', () => {
    expect(htmlOf('Content-Type: text/plain\n\nJust words.')).toBe('');
    expect(htmlOf('From: a@b.c\n\nNo content type.')).toBe('');
  });

  it('returns an empty string rather than throwing on malformed markup', () => {
    const raw = 'Content-Type: multipart/alternative; boundary="missing"\n\norphan text';
    expect(htmlOf(raw)).toBe('');
    expect(() => htmlOf('')).not.toThrow();
  });
});
