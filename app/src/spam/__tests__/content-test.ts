/**
 * Content analysis, and the false positive it exists to avoid.
 *
 * The specification is blunt about this: a message must not be classified because
 * it contains *account*, *verify*, *payment*, *login*, *password* or *security*.
 * Those words are in every password-reset mail, every statement and every genuine
 * security notice — the mail where a false positive costs the most. So the first
 * suite here is the silence one: each intent family, on its own, must score
 * exactly nothing. Only combinations earn weight.
 *
 * The attachment suite reads metadata only. No test constructs bytes, and nothing
 * in the module under test decodes, opens or executes anything.
 */
import { attachmentSymbols, contentSymbols } from '../content';
import { SPAM_THRESHOLD, type SpamInput } from '../types';

const names = (input: SpamInput): string[] => contentSymbols(input).map((s) => s.name);

const weightOf = (input: SpamInput, name: string): number | undefined =>
  contentSymbols(input).find((s) => s.name === name)?.weight;

const attachNames = (input: SpamInput): string[] => attachmentSymbols(input).map((s) => s.name);

describe('one intent family alone scores nothing', () => {
  it('says nothing about a real password-reset mail', () => {
    expect(
      names({
        subject: 'Your password was changed',
        body:
          'The password for your account was changed on Tuesday at 14:12. You do not ' +
          'need to do anything if this was you. If it was not, sign in and review your ' +
          'recent activity. We will never ask you for your password, PIN or card details ' +
          'by email.',
      }),
    ).toEqual([]);
  });

  it('says nothing about a real "verify your account" onboarding mail', () => {
    expect(
      names({
        subject: 'Welcome to Northgate',
        body: 'One last step: verify your account from the link on your dashboard whenever you next sign in.',
      }),
    ).toEqual([]);
  });

  it('says nothing about a real invoice', () => {
    expect(
      names({
        subject: 'Invoice 2291 for August',
        body: 'Attached is the unpaid invoice for August. Bank transfer details are unchanged from last month.',
      }),
    ).toEqual([]);
  });

  it('says nothing about a genuine fraud alert that mentions unusual activity', () => {
    expect(
      names({
        subject: 'We noticed a new sign-in',
        body:
          'We saw unusual activity on your account from a new device in Leeds. If that was ' +
          'you there is nothing to do. Your card has not been blocked and no payment was taken.',
      }),
    ).toEqual([]);
  });

  it('says nothing about a deadline reminder', () => {
    expect(
      names({
        subject: 'Timesheets are due',
        body: 'A reminder that the deadline for August timesheets is Friday. Please submit yours as soon as possible.',
      }),
    ).toEqual([]);
  });

  it('says nothing about an ordinary short note', () => {
    expect(names({ subject: 'Lunch?', body: 'Are we still on for Friday?' })).toEqual([]);
  });

  it('says nothing at all when there is no content to read', () => {
    expect(contentSymbols({})).toEqual([]);
    expect(contentSymbols({ subject: '', body: '' })).toEqual([]);
  });
});

describe('combinations, which are the recognisable shapes', () => {
  it('scores urgency plus a credential request as phishing', () => {
    const input: SpamInput = {
      subject: 'Urgent: action required',
      body: 'Please verify your account within 24 hours to keep it active.',
    };
    const symbols = contentSymbols(input);
    expect(symbols.map((s) => s.name)).toContain('CONTENT_URGENT_CREDENTIAL');
    expect(symbols.find((s) => s.name === 'CONTENT_URGENT_CREDENTIAL')?.kind).toBe('phishing');
  });

  it('scores a threat plus a credential request highest of the pairings', () => {
    const threat = weightOf(
      { subject: 'Account suspended', body: 'Your account will be locked. Confirm your password to restore access.' },
      'CONTENT_THREAT_CREDENTIAL',
    )!;
    const urgent = weightOf(
      { subject: 'Urgent', body: 'Verify your account immediately.' },
      'CONTENT_URGENT_CREDENTIAL',
    )!;
    expect(threat).toBeGreaterThan(urgent);
    expect(threat).toBeLessThan(SPAM_THRESHOLD);
  });

  it('scores a prize next to a payment as spam, not phishing', () => {
    const symbol = contentSymbols({
      subject: 'You have won a free iphone',
      body: 'Claim your prize today. A small processing fee is required to release your reward.',
    }).find((s) => s.name === 'CONTENT_PRIZE_MONEY');
    expect(symbol).toBeDefined();
    expect(symbol?.kind).toBe('spam');
  });

  it('scores secrecy next to money as phishing — the invoice-fraud shape', () => {
    expect(
      names({
        subject: 'Confidential',
        body: 'Keep this confidential. I need a wire transfer to a new supplier account today.',
      }),
    ).toContain('CONTENT_SECRET_MONEY');
  });

  it('scores a request to move to another channel next to money', () => {
    expect(
      names({
        subject: 'Quick favour',
        body: 'I am in a meeting so email me back with the gift card codes once you have them.',
      }),
    ).toContain('CONTENT_CHANNEL_MONEY');
  });

  it('scores a request to send account details by reply', () => {
    expect(
      names({
        subject: 'Payroll update',
        body: 'Reply to this email with your account details so payroll can be corrected.',
      }),
    ).toContain('CONTENT_CHANNEL_CREDENTIAL');
  });

  it('finds a pretext split across the subject and the body', () => {
    // Neither half is a combination by itself, which is exactly why they are
    // scanned as one haystack.
    expect(names({ subject: 'Your account will be locked', body: 'Confirm your password below.' }))
      .toContain('CONTENT_THREAT_CREDENTIAL');
  });

  it('notes four or more families as a message that is nothing but pretext', () => {
    expect(
      names({
        subject: 'FINAL WARNING: account suspended',
        body:
          'Your account will be deleted within 24 hours. Verify your identity immediately and ' +
          'pay the outstanding balance of $240 by wire transfer to avoid legal action.',
      }),
    ).toContain('CONTENT_MANY_PRETEXTS');
  });

  // ---------------------------------------------------------------------------
  // One fact, one charge. The pairings are all drawn from the same family hits,
  // so pushing every match makes the score grow quadratically in the evidence:
  // three families produce three pairings, four produce six. "Your access is at
  // risk, act now, confirm your details" is *one* observation, and charging it
  // 3.6 + 3.4 + 2.0 = 9.0 clears the phishing bar on wording alone — landing
  // first on the legitimate mail written in exactly that language.
  // ---------------------------------------------------------------------------

  it('charges one combination — the heaviest — however many pairings match', () => {
    const symbols = contentSymbols({
      subject: 'URGENT: your account will be suspended',
      body: 'Verify your account immediately and confirm your password within 24 hours to avoid suspension.',
    });
    const combinations = symbols.filter((s) => s.name.startsWith('CONTENT_') && s.name !== 'CONTENT_MANY_PRETEXTS');
    expect(combinations).toHaveLength(1);
    // Urgency, threat and credential all hit; the threat pairing is the heaviest.
    expect(combinations[0].name).toBe('CONTENT_THREAT_CREDENTIAL');
  });

  it('keeps a genuine security notice below the spam threshold on wording alone', () => {
    // Word for word the shape of a bank's own fraud alert and of a corporate
    // password-expiry notice: urgency, a consequence, and a request to confirm
    // something. With no sender, no authentication and no links there is nothing
    // to separate it from the attack it resembles, so content alone must not
    // reach a verdict — the structural evidence lives in the headers.
    const symbols = contentSymbols({
      subject: 'URGENT: unusual activity on your account',
      body:
        'Your account will be suspended within 24 hours. Verify your account immediately to ' +
        'avoid permanent suspension and confirm your password now.',
    });
    expect(symbols.reduce((sum, s) => sum + s.weight, 0)).toBeLessThan(SPAM_THRESHOLD);
  });

  it('does not charge breadth for three families, which the pairing already covers', () => {
    // The heaviest pairing accounts for two families by itself, so three families
    // is "that pairing plus one" — and charging 3.6 + 1.6 here would reach the
    // spam threshold with nothing from the headers or links involved at all.
    expect(
      names({
        subject: 'Urgent: account suspended',
        body: 'Verify your account and confirm your password within 24 hours to avoid suspension.',
      }),
    ).not.toContain('CONTENT_MANY_PRETEXTS');
  });

  it('notes saturation inside one family', () => {
    expect(
      names({
        subject: 'Business proposal',
        body:
          'I write regarding unclaimed funds of ten million dollars left by a late ' +
          'beneficiary whose next of kin cannot be traced. An inheritance of this size ' +
          'requires a clearance fee and a transfer fee before the bank transfer can be ' +
          'released to you as beneficiary.',
      }),
    ).toContain('CONTENT_MONEY_HEAVY');
  });

  it('never lets one content symbol reach the spam threshold on its own', () => {
    const symbols = contentSymbols({
      subject: '🎉🎁🏆 CONGRATULATIONS YOU HAVE WON!!!',
      body:
        'Dear Customer, you have been selected as our lucky winner. Claim your prize today ' +
        'only — this offer expires today. A processing fee of $25 is required to release your ' +
        'reward. Act now before it is too late!!!! Confirm your identity and card number now.',
    });
    expect(symbols.length).toBeGreaterThan(4);
    for (const symbol of symbols) expect(symbol.weight).toBeLessThan(SPAM_THRESHOLD);
    expect(symbols.reduce((sum, s) => sum + s.weight, 0)).toBeGreaterThan(SPAM_THRESHOLD);
  });
});

describe('form rather than vocabulary', () => {
  it('flags a shouted subject', () => {
    expect(names({ subject: 'CONGRATULATIONS YOU HAVE BEEN CHOSEN', body: 'x' })).toContain('SUBJECT_ALL_CAPS');
  });

  it('does not flag a short acronym-heavy subject', () => {
    expect(names({ subject: 'RE: FYI', body: 'x' })).not.toContain('SUBJECT_ALL_CAPS');
  });

  it('flags a run of exclamation or question marks', () => {
    expect(names({ subject: 'Are you there???', body: 'x' })).toContain('SUBJECT_PUNCTUATION_RUN');
    expect(names({ subject: 'Open this!!!', body: 'x' })).toContain('SUBJECT_PUNCTUATION_RUN');
  });

  it('flags a decorated subject', () => {
    expect(names({ subject: '[URGENT] read this', body: 'x' })).toContain('SUBJECT_DECORATED');
    expect(names({ subject: '*** ALERT ***', body: 'x' })).toContain('SUBJECT_DECORATED');
  });

  it('flags a subject wearing several emoji, but only weakly', () => {
    const input: SpamInput = { subject: '🎉🎁🏆 a gift for you', body: 'x' };
    expect(names(input)).toContain('SUBJECT_MANY_EMOJI');
    expect(weightOf(input, 'SUBJECT_MANY_EMOJI')).toBeLessThan(1);
  });

  it('does not flag one emoji in a subject', () => {
    expect(names({ subject: 'Sprint notes 🎉', body: 'x' })).not.toContain('SUBJECT_MANY_EMOJI');
  });

  it('flags a large amount of money in a subject', () => {
    expect(names({ subject: 'Your $4,500 payout', body: 'x' })).toContain('SUBJECT_LARGE_AMOUNT');
  });

  it('flags a body written in capitals', () => {
    const shouted = `${'THIS IS ENTIRELY IN CAPITAL LETTERS AND SAYS NOTHING USEFUL. '.repeat(6)}`;
    expect(names({ subject: 'hello', body: shouted })).toContain('BODY_ALL_CAPS');
  });

  it('does not flag an ordinary body with some capitals in it', () => {
    const normal = `${'We agreed to move the migration to next week. Priya owns the rollout. '.repeat(6)}`;
    expect(names({ subject: 'Notes', body: normal })).not.toContain('BODY_ALL_CAPS');
  });

  it('flags a run of exclamation marks in a body', () => {
    expect(names({ subject: 'hi', body: 'Act now!!!!' })).toContain('BODY_PUNCTUATION_RUN');
  });

  it('flags a generic salutation, but only weakly', () => {
    const input: SpamInput = { subject: 'hi', body: 'Dear Valued Customer, please see below.' };
    expect(names(input)).toContain('BODY_GENERIC_SALUTATION');
    expect(weightOf(input, 'BODY_GENERIC_SALUTATION')).toBeLessThan(1);
  });

  it('does not flag a message that greets the reader by name', () => {
    expect(names({ subject: 'hi', body: 'Hello Priya, please see below.' })).not.toContain('BODY_GENERIC_SALUTATION');
  });

  it('flags a body that is mostly one repeated word', () => {
    // Filler used to dilute a Bayes filter, and a shape no human writes.
    const filler = 'offer offer offer deal deal deal now now now '.repeat(20);
    expect(names({ subject: 'hi', body: filler })).toContain('BODY_LOW_VOCABULARY');
  });

  it('does not flag ordinary prose as low vocabulary', () => {
    const prose =
      'Here are the notes from planning. We agreed to move the migration to next week and ' +
      'Priya will own the rollout checklist. The remaining items are the search index, the ' +
      'contact importer, and whether the settings screen should keep its own copy of the ' +
      'keyring or read it from state each time it renders.';
    expect(names({ subject: 'Notes', body: prose })).not.toContain('BODY_LOW_VOCABULARY');
  });
});

describe('unicode disguises', () => {
  it('flags invisible characters hidden inside words', () => {
    expect(names({ subject: 'Your acc​ount', body: 'Please ver​ify it.' })).toContain('CONTENT_INVISIBLE_CHARS');
  });

  it('flags words that mix alphabets to look like other words', () => {
    expect(names({ subject: 'Your аccount', body: 'x' })).toContain('CONTENT_MIXED_SCRIPT'); // Cyrillic а
  });

  it('does not flag genuinely multilingual mail', () => {
    const symbols = names({ subject: 'Привет', body: 'Meeting at three, see you then.' });
    expect(symbols).not.toContain('CONTENT_MIXED_SCRIPT');
    expect(symbols).not.toContain('CONTENT_INVISIBLE_CHARS');
  });

  it('matches a family entry through the zero-width padding meant to hide it', () => {
    // The whole point of skeletonising: splitting a phrase must not buy silence.
    expect(
      names({ subject: 'Urgent', body: 'Please ve​ri​fy your acc​ount within 24 hours.' }),
    ).toContain('CONTENT_URGENT_CREDENTIAL');
  });
});

describe('bounds and defensive handling', () => {
  it('reads only the first 20 000 characters of a body', () => {
    const long = `${'filler word '.repeat(4000)}you have won a free iphone claim your prize wire transfer`;
    expect(long.length).toBeGreaterThan(20_000);
    expect(names({ subject: 'hello', body: long })).not.toContain('CONTENT_PRIZE_MONEY');
  });

  it('survives fields that are not strings', () => {
    const hostile = { subject: 42, body: { toString: () => 'x' }, attachments: 'none' } as unknown as SpamInput;
    expect(() => contentSymbols(hostile)).not.toThrow();
    expect(() => attachmentSymbols(hostile)).not.toThrow();
  });

  it('survives a body of nothing but punctuation and emoji', () => {
    expect(() => contentSymbols({ subject: '!!!???***', body: '🎉'.repeat(500) })).not.toThrow();
  });
});

describe('attachment metadata', () => {
  it('says nothing when there are no attachments', () => {
    expect(attachmentSymbols({})).toEqual([]);
    expect(attachmentSymbols({ attachments: [] })).toEqual([]);
  });

  it('says nothing about the documents people actually send', () => {
    expect(
      attachNames({
        attachments: [
          { filename: 'invoice-2291.pdf', contentType: 'application/pdf', size: 84_000 },
          { filename: 'notes.txt', contentType: 'text/plain', size: 900 },
          { filename: 'deck.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
          { filename: 'photo.jpg', contentType: 'image/jpeg' },
        ],
      }),
    ).toEqual([]);
  });

  it('flags a program', () => {
    expect(attachNames({ attachments: [{ filename: 'setup.exe' }] })).toContain('ATTACH_EXECUTABLE');
    expect(attachNames({ attachments: [{ filename: 'screensaver.scr' }] })).toContain('ATTACH_EXECUTABLE');
  });

  it('flags a program disguised as a document more heavily', () => {
    const disguised = attachmentSymbols({ attachments: [{ filename: 'invoice.pdf.exe' }] });
    const plain = attachmentSymbols({ attachments: [{ filename: 'setup.exe' }] });
    expect(disguised.map((s) => s.name)).toContain('ATTACH_DOUBLE_EXTENSION');
    expect(disguised[0].weight).toBeGreaterThan(plain[0].weight);
  });

  it('flags a filename written to display a false extension', () => {
    // A right-to-left override renders `invoice‮fdp.exe` as `invoiceexe.pdf`.
    expect(attachNames({ attachments: [{ filename: 'invoice‮fdp.exe' }] })).toContain('ATTACH_NAME_REVERSED');
  });

  it('flags a macro document weakly, since business mail is full of them', () => {
    const symbols = attachmentSymbols({ attachments: [{ filename: 'budget.xlsm' }] });
    expect(symbols.map((s) => s.name)).toEqual(['ATTACH_MACRO_DOCUMENT']);
    expect(symbols[0].weight).toBeLessThan(2);
  });

  it('notes an archive, barely', () => {
    const symbols = attachmentSymbols({ attachments: [{ filename: 'files.zip' }] });
    expect(symbols.map((s) => s.name)).toEqual(['ATTACH_ARCHIVE']);
    expect(symbols[0].weight).toBeLessThan(1);
  });

  it('flags a declared type that contradicts the filename', () => {
    expect(attachNames({ attachments: [{ filename: 'invoice.html', contentType: 'application/pdf' }] }))
      .toContain('ATTACH_TYPE_MISMATCH');
  });

  it('flags a web page attachment, which is a sign-in screen with no address bar', () => {
    for (const filename of ['secure-login.html', 'verify.htm', 'page.xhtml']) {
      expect(attachNames({ attachments: [{ filename }] })).toContain('ATTACH_HTML_PAGE');
    }
  });

  it('fires each finding once however many attachments share it', () => {
    const attachments = Array.from({ length: 6 }, (_, i) => ({ filename: `file${i}.exe` }));
    expect(attachNames({ attachments }).filter((n) => n === 'ATTACH_EXECUTABLE')).toHaveLength(1);
  });

  it('ignores attachment entries with no usable filename', () => {
    const attachments = [null, undefined, {}, { filename: '' }, { size: 10 }] as unknown as SpamInput['attachments'];
    expect(attachmentSymbols({ attachments })).toEqual([]);
  });

  it('never lets one attachment symbol reach the spam threshold on its own', () => {
    const symbols = attachmentSymbols({
      attachments: [{ filename: 'invoice‮fdp.exe' }, { filename: 'report.pdf.exe' }, { filename: 'login.html' }],
    });
    for (const symbol of symbols) expect(symbol.weight).toBeLessThan(SPAM_THRESHOLD);
  });
});
