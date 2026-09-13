/**
 * A message written with formatting, against docs/message-format.md.
 *
 * Two things matter: that the text alternative and the HTML both come back as
 * they went in — through our own reader for sealed mail and through the
 * unencrypted one for plaintext — and that a message written *without*
 * formatting is byte-for-byte the tree it was before rich compose existed.
 */
import { htmlOf, plainBodyOf, attachmentsOf } from '../../mail/plainBody';
import { bytesToBase64 } from '../../lib/base64';
import { Attachment } from '../../mail/attachment';
import { demoCore } from '../demoCore';
import {
  boundaryOf,
  buildPlaintext,
  buildProtectedInner,
  parseProtectedInner,
  parseRfc822,
  PLACEHOLDER_SUBJECT,
  splitMultipart,
} from '../mime';

const HTML = '<p>Hi <strong>Ada</strong>,</p><ul><li><p>one</p></li></ul><p>' + 'long '.repeat(400) + '</p>';
const TEXT = 'Hi Ada,\n- one';
const base = { from: 'me@example.com', to: ['ada@example.com'], subject: 'Plans', body: TEXT };

const PDF: Attachment = {
  id: 'att-1',
  name: 'plan.pdf',
  mimeType: 'application/pdf',
  size: 3,
  data: bytesToBase64(Uint8Array.from([1, 2, 3])),
};

describe('buildProtectedInner with html', () => {
  it('writes the body as multipart/alternative, text first', () => {
    const inner = buildProtectedInner({ ...base, html: HTML });
    const outer = parseRfc822(inner);
    const [body] = splitMultipart(outer.body, boundaryOf(outer.headers['content-type'])!);

    expect(body.headers['content-type']).toMatch(/^multipart\/alternative/);
    const alternatives = splitMultipart(body.body, boundaryOf(body.headers['content-type'])!);
    expect(alternatives.map((p) => p.headers['content-type'])).toEqual([
      'text/plain; charset=utf-8',
      'text/html; charset=utf-8',
    ]);
    expect(alternatives[1].headers['content-transfer-encoding']).toBe('base64');
  });

  it('keeps every line inside RFC 5322’s limit, however long a paragraph is', () => {
    const inner = buildProtectedInner({ ...base, html: HTML });
    expect(Math.max(...inner.split('\n').map((l) => l.length))).toBeLessThanOrEqual(998);
  });

  it('round-trips both bodies and the attachments', () => {
    const parsed = parseProtectedInner(buildProtectedInner({ ...base, html: HTML, attachments: [PDF] }));
    expect(parsed.subject).toBe('Plans');
    expect(parsed.body).toBe(TEXT);
    expect(parsed.html).toBe(HTML);
    expect(parsed.attachments.map((a) => a.name)).toEqual(['plan.pdf']);
  });

  it('is unchanged for a message with no formatting', () => {
    const inner = buildProtectedInner(base);
    expect(inner).not.toContain('multipart/alternative');
    expect(parseProtectedInner(inner)).toEqual({ subject: 'Plans', body: TEXT, html: undefined, attachments: [] });
  });
});

describe('the demo core', () => {
  it('seals the html and gives it back, with nothing of it on the envelope', async () => {
    const rfc822 = await demoCore.buildEncrypted({
      ...base,
      html: '<p>Secret <em>plans</em></p>',
      recipientKeys: ['key'],
    });
    const envelope = parseRfc822(rfc822);

    expect(envelope.headers['subject']).toBe(PLACEHOLDER_SUBJECT);
    expect(rfc822).not.toContain('Secret');
    expect(rfc822).not.toContain('text/html');

    const opened = await demoCore.parseEncrypted(rfc822);
    expect(opened.html).toBe('<p>Secret <em>plans</em></p>');
    expect(opened.body).toBe(TEXT);
  });
});

describe('buildPlaintext with html', () => {
  it('is read back by the unencrypted reader, with and without attachments', () => {
    for (const attachments of [undefined, [PDF]]) {
      const raw = buildPlaintext({ ...base, html: HTML, attachments });
      expect(raw).toContain('multipart/alternative');
      expect(plainBodyOf(raw)).toBe(TEXT);
      expect(htmlOf(raw)).toBe(HTML);
      expect(attachmentsOf(raw).map((a) => a.name)).toEqual(attachments ? ['plan.pdf'] : []);
    }
  });

  it('stays a single text/plain part without it', () => {
    const raw = buildPlaintext(base);
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).not.toContain('multipart');
  });
});
