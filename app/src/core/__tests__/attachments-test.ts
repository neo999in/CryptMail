/**
 * Attachments in the MIME tree, against docs/message-format.md.
 *
 * The point of the whole feature is the second test here: the filename lives
 * inside the encrypted tree, so nothing on the envelope names it. Everything
 * else is round-tripping — a file that comes back with different bytes than it
 * went in with is worse than one that never arrived, because the reader has no
 * way to tell.
 */
import { bytesToBase64 } from '../../lib/base64';
import { Attachment } from '../../mail/attachment';
import { demoCore } from '../demoCore';
import {
  attachmentsFromParts,
  buildPlaintext,
  buildProtectedInner,
  parseProtectedInner,
  parseRfc822,
  splitMultipart,
  boundaryOf,
} from '../mime';

const BYTES = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);

const PDF: Attachment = {
  id: 'att-1',
  name: 'menu.pdf',
  mimeType: 'application/pdf',
  size: BYTES.length,
  data: bytesToBase64(BYTES),
};

const INLINE: Attachment = {
  id: 'att-2',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 3,
  data: bytesToBase64(Uint8Array.from([1, 2, 3])),
  inline: true,
  contentId: 'att-2@cryptmail',
};

const base = { from: 'me@example.com', to: ['you@example.com'], subject: 'Lunch?', body: 'Menu attached.' };

describe('buildProtectedInner', () => {
  it('is unchanged when nothing is attached', () => {
    const inner = buildProtectedInner(base);
    expect(inner).toContain('Content-Type: text/plain; charset=utf-8');
    expect(inner).not.toContain('Content-Disposition');
    expect(parseProtectedInner(inner)).toEqual({
      subject: 'Lunch?',
      body: 'Menu attached.',
      attachments: [],
    });
  });

  it('adds one part per file, after the body, inside multipart/mixed', () => {
    const inner = buildProtectedInner({ ...base, attachments: [PDF, INLINE] });
    const boundary = boundaryOf(parseRfc822(inner).headers['content-type'] ?? '')!;
    const parts = splitMultipart(parseRfc822(inner).body, boundary);

    expect(parts).toHaveLength(3);
    expect(parts[0].headers['content-type']).toMatch(/^text\/plain/);
    expect(parts[1].headers['content-disposition']).toBe('attachment; filename="menu.pdf"');
    expect(parts[2].headers['content-disposition']).toBe('inline; filename="photo.png"');
    expect(parts[2].headers['content-id']).toBe('<att-2@cryptmail>');
  });

  it('wraps the base64 at 76 columns, so no provider has to rewrite the part', () => {
    const inner = buildProtectedInner({ ...base, attachments: [PDF] });
    const boundary = boundaryOf(parseRfc822(inner).headers['content-type'] ?? '')!;
    const payload = splitMultipart(parseRfc822(inner).body, boundary)[1].body;

    expect(payload.split('\n').filter((l) => l !== '').length).toBeGreaterThan(1);
    for (const line of payload.split('\n')) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('round-trips the bytes, the name and the type exactly', () => {
    const { subject, body, attachments } = parseProtectedInner(
      buildProtectedInner({ ...base, attachments: [PDF, INLINE] }),
    );

    expect(subject).toBe('Lunch?');
    expect(body).toBe('Menu attached.');
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      name: 'menu.pdf',
      mimeType: 'application/pdf',
      size: BYTES.length,
      data: PDF.data,
    });
    expect(attachments[1]).toMatchObject({ name: 'photo.png', inline: true, contentId: 'att-2@cryptmail' });
  });

  it('does not mistake the body for a file', () => {
    const { attachments } = parseProtectedInner(buildProtectedInner({ ...base, attachments: [PDF] }));
    expect(attachments.map((a) => a.name)).toEqual(['menu.pdf']);
  });

  it('reads an attached .txt back as a file, not as the body', () => {
    const parts = attachmentsFromParts([
      { headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'the body' },
      {
        headers: {
          'content-type': 'text/plain; name="notes.txt"',
          'content-disposition': 'attachment; filename="notes.txt"',
        },
        body: 'bm90ZXM=',
      },
    ]);
    expect(parts.map((a) => a.name)).toEqual(['notes.txt']);
  });
});

describe('the sealed envelope', () => {
  it('names the file nowhere outside the ciphertext', async () => {
    const rfc822 = await demoCore.buildEncrypted({
      from: base.from,
      to: base.to,
      subject: base.subject,
      body: base.body,
      attachments: [PDF],
      recipientKeys: ['-----BEGIN PGP PUBLIC KEY BLOCK-----\nk\n-----END PGP PUBLIC KEY BLOCK-----'],
    });

    const { headers } = parseRfc822(rfc822);
    expect(Object.values(headers).join(' ')).not.toContain('menu.pdf');
    // `encrypted.asc` is the only filename a provider ever sees.
    expect(rfc822).toContain('filename="encrypted.asc"');
    expect(rfc822).not.toContain('menu.pdf');
  });

  it('comes back out of the demo core intact', async () => {
    const rfc822 = await demoCore.buildEncrypted({
      from: base.from,
      to: base.to,
      subject: base.subject,
      body: base.body,
      attachments: [PDF],
      recipientKeys: ['-----BEGIN PGP PUBLIC KEY BLOCK-----\nk\n-----END PGP PUBLIC KEY BLOCK-----'],
    });

    const decrypted = await demoCore.parseEncrypted(rfc822);
    expect(decrypted.subject).toBe('Lunch?');
    expect(decrypted.attachments).toHaveLength(1);
    expect(decrypted.attachments[0].data).toBe(PDF.data);
    expect(decrypted.attachments[0].name).toBe('menu.pdf');
  });
});

describe('buildPlaintext with attachments', () => {
  it('stays a single text/plain part when there are none', () => {
    expect(buildPlaintext(base)).toContain('Content-Type: text/plain; charset=utf-8');
    expect(buildPlaintext(base)).not.toContain('multipart/mixed');
  });

  it('becomes multipart/mixed, with the filename in the clear', () => {
    const raw = buildPlaintext({ ...base, attachments: [PDF] });
    expect(raw).toContain('multipart/mixed');
    // The whole point of the unencrypted mode: this is visible to every hop,
    // and compose says so before the user picks it.
    expect(raw).toContain('filename="menu.pdf"');
  });
});
