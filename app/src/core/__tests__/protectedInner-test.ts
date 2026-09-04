/**
 * Reading a decrypted tree that CryptMail did not write.
 *
 * `buildProtectedInner` emits one flat `multipart/mixed` holding a single
 * `text/plain`, so round-tripping our own envelope never exercises any of this.
 * Every other PGP client nests a `multipart/alternative` inside the mixed part
 * and transfer-encodes the bodies — and against that tree the old flat reader
 * found no body at all, which is what left encrypted mail rendering as
 * flattened text while ordinary mail got the HTML reader (features.md 0.9).
 */
import { bytesToBase64 } from '../../lib/base64';
import { buildProtectedInner, parseProtectedInner } from '../mime';

/** The shape Thunderbird/Enigmail seals: alternative inside mixed. */
function foreignTree(parts: { plain: string; html: string; encoding?: string }): string {
  const inner = 'alt-boundary';
  return [
    'Content-Type: multipart/mixed; boundary="mixed-boundary"; protected-headers="v1"',
    'Subject: Quarterly numbers',
    'From: ada@example.com',
    'To: me@example.com',
    '',
    '--mixed-boundary',
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    `--${inner}`,
    'Content-Type: text/plain; charset=utf-8',
    ...(parts.encoding ? [`Content-Transfer-Encoding: ${parts.encoding}`] : []),
    '',
    parts.plain,
    '',
    `--${inner}`,
    'Content-Type: text/html; charset=utf-8',
    ...(parts.encoding ? [`Content-Transfer-Encoding: ${parts.encoding}`] : []),
    '',
    parts.html,
    '',
    `--${inner}--`,
    '',
    '--mixed-boundary--',
    '',
  ].join('\n');
}

describe('a decrypted tree from another PGP client', () => {
  it('finds both bodies inside a nested multipart/alternative', () => {
    const parsed = parseProtectedInner(
      foreignTree({ plain: 'Attached, as promised.', html: '<p>Attached, as promised.</p>' }),
    );

    expect(parsed.subject).toBe('Quarterly numbers');
    expect(parsed.body).toBe('Attached, as promised.');
    expect(parsed.html).toBe('<p>Attached, as promised.</p>');
  });

  it('decodes a quoted-printable HTML part, so hrefs survive intact', () => {
    // The failure this guards: `=3D` is an escaped `=`, so an undecoded part
    // reads `href=3D"..."` and every link in the message is malformed.
    const parsed = parseProtectedInner(
      foreignTree({
        plain: 'See the report.',
        html: '<a href=3D"https://example.com/q3">Q3</a>',
        encoding: 'quoted-printable',
      }),
    );

    expect(parsed.html).toBe('<a href="https://example.com/q3">Q3</a>');
  });

  it('rejoins a quoted-printable soft line break inside an attribute', () => {
    const parsed = parseProtectedInner(
      foreignTree({
        plain: 'x',
        html: '<a href=3D"https://example.com/very=\nlong">link</a>',
        encoding: 'quoted-printable',
      }),
    );

    expect(parsed.html).toBe('<a href="https://example.com/verylong">link</a>');
  });

  it('decodes a base64 HTML part', () => {
    const html = '<p>Ünicode body</p>';
    const parsed = parseProtectedInner(
      foreignTree({
        plain: bytesToBase64(new TextEncoder().encode('Unicode body')),
        html: bytesToBase64(new TextEncoder().encode(html)),
        encoding: 'base64',
      }),
    );

    expect(parsed.html).toBe(html);
  });

  it('reads a single-part text/html tree as both body and markup', () => {
    const inner = [
      'Content-Type: text/html; charset=utf-8',
      'Subject: No alternative',
      '',
      '<p>Only markup here.</p>',
      '',
    ].join('\n');

    const parsed = parseProtectedInner(inner);
    expect(parsed.html).toBe('<p>Only markup here.</p>');
    expect(parsed.body).toBe('<p>Only markup here.</p>');
  });

  it('does not mistake an attached .html file for the message body', () => {
    const inner = [
      'Content-Type: multipart/mixed; boundary="b"; protected-headers="v1"',
      'Subject: Report',
      '',
      '--b',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'The report is attached.',
      '',
      '--b',
      'Content-Type: text/html; name="report.html"',
      'Content-Disposition: attachment; filename="report.html"',
      'Content-Transfer-Encoding: base64',
      '',
      bytesToBase64(new TextEncoder().encode('<h1>Report</h1>')),
      '',
      '--b--',
      '',
    ].join('\n');

    const parsed = parseProtectedInner(inner);
    expect(parsed.body).toBe('The report is attached.');
    expect(parsed.html).toBeUndefined();
    expect(parsed.attachments.map((a) => a.name)).toEqual(['report.html']);
  });

  it('still finds attachments hanging off the mixed part beside the alternative', () => {
    const inner = [
      'Content-Type: multipart/mixed; boundary="b"; protected-headers="v1"',
      'Subject: Lunch?',
      '',
      '--b',
      'Content-Type: multipart/alternative; boundary="c"',
      '',
      '--c',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Menu attached.',
      '',
      '--c',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Menu attached.</p>',
      '',
      '--c--',
      '',
      '--b',
      'Content-Type: application/pdf; name="menu.pdf"',
      'Content-Disposition: attachment; filename="menu.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      bytesToBase64(Uint8Array.from([1, 2, 3, 4])),
      '',
      '--b--',
      '',
    ].join('\n');

    const parsed = parseProtectedInner(inner);
    expect(parsed.body).toBe('Menu attached.');
    expect(parsed.html).toBe('<p>Menu attached.</p>');
    expect(parsed.attachments.map((a) => a.name)).toEqual(['menu.pdf']);
  });
});

describe("CryptMail's own tree", () => {
  it('carries no html, because buildProtectedInner writes text only', () => {
    const parsed = parseProtectedInner(
      buildProtectedInner({
        from: 'me@example.com',
        to: ['you@example.com'],
        subject: 'Lunch?',
        body: 'Menu attached.',
      }),
    );

    expect(parsed.body).toBe('Menu attached.');
    expect(parsed.html).toBeUndefined();
  });
});
