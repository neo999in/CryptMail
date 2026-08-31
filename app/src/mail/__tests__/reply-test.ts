/**
 * The pure reply/forward derivation.
 *
 * No React, no storage, no network — every function here reshapes fields the
 * caller already holds, so this covers the whole of feature 0.7's logic without
 * a harness. The security-sensitive parts (who a Reply-All addresses, that a
 * forward starts a fresh thread) are asserted here; that these lists then go
 * through the fail-safe send path unchanged is covered in state/send-test.
 */
import {
  buildReferences,
  buildReplyDraft,
  forwardedBody,
  forwardSubject,
  quotedReplyBody,
  replyAllRecipients,
  replyRecipients,
  replySubject,
  ReplySource,
} from '../reply';

const SELF = 'me@example.com';

const source = (over: Partial<ReplySource> = {}): ReplySource => ({
  from: { address: 'anya@partner.com', name: 'Anya Kessler' },
  to: ['me@example.com', 'jordan@lee.legal'],
  date: '2026-02-03T10:00:00.000Z',
  subject: 'Q3 board deck',
  body: 'Numbers are locked.\n\nDeck attached.',
  messageId: '<orig-1@partner.com>',
  ...over,
});

describe('replySubject', () => {
  it('prefixes a bare subject once', () => {
    expect(replySubject('Q3 board deck')).toBe('Re: Q3 board deck');
  });

  it('does not stack onto an existing Re:', () => {
    expect(replySubject('Re: Q3 board deck')).toBe('Re: Q3 board deck');
  });

  it('collapses a run of Re: prefixes into one', () => {
    expect(replySubject('Re: Re:  RE: Q3 board deck')).toBe('Re: Q3 board deck');
  });

  it('is case-insensitive but normalises the prefix casing', () => {
    expect(replySubject('RE: hello')).toBe('Re: hello');
  });

  it('does not mistake a word beginning "Re" for the prefix', () => {
    expect(replySubject('Related work')).toBe('Re: Related work');
  });

  it('degrades to a bare Re: for an empty subject', () => {
    expect(replySubject('')).toBe('Re:');
    expect(replySubject('   ')).toBe('Re:');
  });
});

describe('forwardSubject', () => {
  it('prefixes with Fwd:', () => {
    expect(forwardSubject('Q3 board deck')).toBe('Fwd: Q3 board deck');
  });

  it('collapses stacked Fwd:/Fw: prefixes', () => {
    expect(forwardSubject('Fwd: Fw: Q3 board deck')).toBe('Fwd: Q3 board deck');
  });

  it('normalises a lone Fw: to Fwd:', () => {
    expect(forwardSubject('Fw: hello')).toBe('Fwd: hello');
  });

  it('degrades to a bare Fwd: for an empty subject', () => {
    expect(forwardSubject('')).toBe('Fwd:');
  });
});

describe('replyRecipients', () => {
  it('is the original sender, and only them', () => {
    expect(replyRecipients(source(), SELF)).toEqual(['anya@partner.com']);
  });

  it('canonicalises the sender address', () => {
    expect(replyRecipients(source({ from: { address: 'Anya@Partner.com' } }), SELF)).toEqual([
      'anya@partner.com',
    ]);
  });

  it('never addresses yourself', () => {
    expect(replyRecipients(source(), 'anya@partner.com')).not.toContain('anya@partner.com');
  });

  it('replying to your own sent message goes to its recipients instead', () => {
    // The sender is you; fall back to whoever you originally wrote to, minus you.
    const own = source({ from: { address: SELF, name: 'Me' } });
    expect(replyRecipients(own, SELF)).toEqual(['jordan@lee.legal']);
  });
});

describe('replyAllRecipients', () => {
  it('is the sender plus every other recipient, sender first, minus you', () => {
    expect(replyAllRecipients(source(), SELF)).toEqual(['anya@partner.com', 'jordan@lee.legal']);
  });

  it('dedupes when the sender is also in the To line', () => {
    const src = source({ to: ['anya@partner.com', 'jordan@lee.legal', 'me@example.com'] });
    expect(replyAllRecipients(src, SELF)).toEqual(['anya@partner.com', 'jordan@lee.legal']);
  });

  it('excludes you case-insensitively', () => {
    expect(replyAllRecipients(source(), 'ME@Example.com')).toEqual([
      'anya@partner.com',
      'jordan@lee.legal',
    ]);
  });
});

describe('buildReferences', () => {
  it('is just the Message-ID when there is no prior chain', () => {
    expect(buildReferences(source())).toEqual(['<orig-1@partner.com>']);
  });

  it('appends the Message-ID to the existing chain', () => {
    const src = source({ references: '<root@x> <mid@x>', messageId: '<orig-1@partner.com>' });
    expect(buildReferences(src)).toEqual(['<root@x>', '<mid@x>', '<orig-1@partner.com>']);
  });

  it('does not duplicate a Message-ID already present in the chain', () => {
    const src = source({ references: '<root@x> <orig-1@partner.com>', messageId: '<orig-1@partner.com>' });
    expect(buildReferences(src)).toEqual(['<root@x>', '<orig-1@partner.com>']);
  });

  it('is empty when there is neither a chain nor a Message-ID', () => {
    expect(buildReferences(source({ messageId: undefined }))).toEqual([]);
  });
});

describe('quotedReplyBody', () => {
  const stamp = new Date(source().date).toUTCString();

  it('opens with blank lines so the cursor sits above the quote', () => {
    expect(quotedReplyBody(source())).toMatch(/^\n\nOn /);
  });

  it('attributes the quote to the sender, in GMT', () => {
    expect(quotedReplyBody(source())).toContain(
      `On ${stamp}, Anya Kessler <anya@partner.com> wrote:`,
    );
  });

  it('prefixes every original line with "> "', () => {
    const quoted = quotedReplyBody(source());
    expect(quoted).toContain('> Numbers are locked.');
    expect(quoted).toContain('> Deck attached.');
  });

  it('quotes a blank line as a bare ">"', () => {
    expect(quotedReplyBody(source())).toContain('\n>\n');
  });

  it('falls back to the raw date string when it cannot be parsed', () => {
    expect(quotedReplyBody(source({ date: 'not a date' }))).toContain('On not a date,');
  });
});

describe('forwardedBody', () => {
  it('carries the Gmail forward header block', () => {
    const fwd = forwardedBody(source());
    expect(fwd).toContain('---------- Forwarded message ---------');
    expect(fwd).toContain('From: Anya Kessler <anya@partner.com>');
    expect(fwd).toContain('Subject: Q3 board deck');
    expect(fwd).toContain('To: me@example.com, jordan@lee.legal');
  });

  it('includes the original body verbatim, not quoted', () => {
    const fwd = forwardedBody(source());
    expect(fwd).toContain('\n\nNumbers are locked.\n\nDeck attached.');
    expect(fwd).not.toContain('> Numbers are locked.');
  });
});

describe('buildReplyDraft', () => {
  it('reply: sender in To, Re: subject, and threads onto the conversation', () => {
    const draft = buildReplyDraft('reply', source(), SELF);
    expect(draft.to).toEqual(['anya@partner.com']);
    expect(draft.subject).toBe('Re: Q3 board deck');
    expect(draft.inReplyTo).toBe('<orig-1@partner.com>');
    expect(draft.references).toEqual(['<orig-1@partner.com>']);
    expect(draft.quotedBody).toMatch(/^\n\nOn /);
  });

  it('replyAll: everyone but you, still threaded', () => {
    const draft = buildReplyDraft('replyAll', source(), SELF);
    expect(draft.to).toEqual(['anya@partner.com', 'jordan@lee.legal']);
    expect(draft.subject).toBe('Re: Q3 board deck');
    expect(draft.inReplyTo).toBe('<orig-1@partner.com>');
  });

  it('forward: empty To, Fwd: subject, and deliberately starts a NEW thread', () => {
    const draft = buildReplyDraft('forward', source(), SELF);
    expect(draft.to).toEqual([]);
    expect(draft.subject).toBe('Fwd: Q3 board deck');
    // Matches Gmail: a forward is not a reply, so it carries no threading.
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
    expect(draft.quotedBody).toContain('---------- Forwarded message ---------');
  });

  it('reply: omits threading entirely when the source had no Message-ID', () => {
    const draft = buildReplyDraft('reply', source({ messageId: undefined }), SELF);
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.references).toBeUndefined();
  });
});

describe('attachments on a forward', () => {
  const FILE = { id: 'a1', name: 'menu.pdf', mimeType: 'application/pdf', size: 3, data: 'AQID' };

  it('carries the files into the forwarded draft', () => {
    const draft = buildReplyDraft('forward', source({ attachments: [FILE] }), SELF);
    expect(draft.attachments).toEqual([FILE]);
  });

  it('carries none on a reply — quoting text back is not mailing their file back', () => {
    expect(buildReplyDraft('reply', source({ attachments: [FILE] }), SELF).attachments).toBeUndefined();
    expect(buildReplyDraft('replyAll', source({ attachments: [FILE] }), SELF).attachments).toBeUndefined();
  });

  it('omits the field entirely when the original had no files', () => {
    expect(buildReplyDraft('forward', source(), SELF).attachments).toBeUndefined();
  });
});
