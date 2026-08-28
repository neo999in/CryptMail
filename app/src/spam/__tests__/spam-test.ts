/**
 * The engine end to end: four evidence sources in, one of three answers out.
 *
 * The suites below are the specification's acceptance criteria read literally.
 *
 * - **Legitimate mail that talks like phishing must survive.** Every message in
 *   the first suite contains at least one of the words the specification forbids
 *   classifying on — *account*, *verify*, *payment*, *login*, *password*,
 *   *security* — and every one of them must come out `legitimate`.
 * - **Spam and phishing are different answers, not one answer with two labels.**
 *   A loud prize mail must never become a phishing warning however many points it
 *   accumulates, and a quiet impersonation must be flagged as phishing even when
 *   its total score sits below the spam threshold.
 * - **A human decision outranks the engine**, and a correction must actually move
 *   the model.
 * - **Nothing throws.** `classifyMessage` runs while an inbox row renders.
 */
import {
  classifyMessage,
  emptyModel,
  isUnwanted,
  learn,
  reasons,
  topReason,
  unlearn,
  type SpamModel,
} from '../spam';
import { PHISHING_THRESHOLD, SPAM_THRESHOLD, type SpamInput } from '../types';

/** Enough body text that `URL_ONLY_MESSAGE` stays out of the way. */
const filler = 'Everything below is ordinary correspondence about ordinary work. '.repeat(4);

/** A clean Gmail-style Authentication-Results line for a domain that passes. */
const authPass = (domain: string): string =>
  `mx.google.com; dkim=pass header.i=@${domain}; spf=pass smtp.mailfrom=${domain}; dmarc=pass header.from=${domain}`;

const names = (input: SpamInput, model?: SpamModel): string[] =>
  classifyMessage(input, { model }).symbols.map((s) => s.name);

/** Six spam and six ham examples: just past `MIN_TRAINED_MESSAGES` on both sides. */
function trainedModel(): SpamModel {
  let model = emptyModel();
  for (let i = 0; i < 6; i += 1) {
    model = learn(
      model,
      {
        from: { address: `promo${i}@coin-blast.example` },
        subject: 'Bitcoin doubling event',
        body: `Send bitcoin to our wallet and receive double back. Slot ${i} of the doubling round is open.`,
      },
      'spam',
    );
    model = learn(
      model,
      {
        from: { address: 'priya@northgate-eng.example' },
        subject: 'Sprint planning notes',
        body: `Notes from planning session ${i}: the migration moves to next week and Priya owns the rollout checklist.`,
      },
      'ham',
    );
  }
  return model;
}

describe('legitimate mail, including the mail that talks like phishing', () => {
  it('passes a real password-reset notice', () => {
    const verdict = classifyMessage({
      from: { address: 'no-reply@northgate-bank.example', name: 'Northgate Bank' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'Your password was changed',
      body:
        'The password for your account was changed today. If this was not you, sign in from ' +
        'the app and review your recent activity. We will never ask for your password by email.',
      links: [{ href: 'https://www.northgate-bank.example/security/activity', text: 'Review activity' }],
      headers: {
        authenticationResults: authPass('northgate-bank.example'),
        messageId: '<a1@northgate-bank.example>',
        returnPath: '<bounce@northgate-bank.example>',
      },
    });
    expect(verdict.classification).toBe('legitimate');
    expect(isUnwanted(verdict)).toBe(false);
  });

  it('passes an invoice with a payment link', () => {
    const verdict = classifyMessage({
      from: { address: 'billing@northgate-eng.example', name: 'Northgate Billing' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'Invoice 2291 — payment due Friday',
      body: `Attached is invoice 2291. Payment is due Friday. ${filler}`,
      links: [{ href: 'https://northgate-eng.example/invoices/2291/pay', text: 'Pay invoice' }],
      attachments: [{ filename: 'invoice-2291.pdf', contentType: 'application/pdf', size: 84_000 }],
      headers: { authenticationResults: authPass('northgate-eng.example') },
    });
    expect(verdict.classification).toBe('legitimate');
  });

  it('passes a genuine "verify your account" onboarding mail', () => {
    const verdict = classifyMessage({
      from: { address: 'hello@northgate-eng.example', name: 'Northgate' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'One last step: verify your account',
      body: `Welcome aboard. Verify your account from your dashboard the next time you sign in. ${filler}`,
      links: [{ href: 'https://northgate-eng.example/onboarding', text: 'Open your dashboard' }],
      headers: { authenticationResults: authPass('northgate-eng.example') },
    });
    expect(verdict.classification).toBe('legitimate');
  });

  it('passes a loud but honest marketing newsletter', () => {
    const verdict = classifyMessage({
      from: { address: 'news@shopmail.example', name: 'Shop Weekly' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'SUMMER SALE — 50% off everything!!!',
      body: `Our biggest sale of the year is on. Free delivery this week only. ${filler}`,
      links: [
        { href: 'https://bit.ly/shopweekly1', text: 'Shop now' },
        { href: 'https://shopmail.example/unsubscribe', text: 'Unsubscribe' },
      ],
      headers: {
        authenticationResults: authPass('shopmail.example'),
        listUnsubscribe: '<https://shopmail.example/unsubscribe>',
      },
    });
    // Several small spam symbols fire; the ham credits and the absence of any
    // combination keep it out of the spam bucket, which is the point.
    expect(verdict.classification).toBe('legitimate');
    expect(verdict.score).toBeLessThan(SPAM_THRESHOLD);
  });

  it('passes an ordinary note from a colleague, with no symbols at all', () => {
    const verdict = classifyMessage({
      from: { address: 'priya@northgate-eng.example', name: 'Priya Raman' },
      to: ['you@northgate-eng.example'],
      selfAddress: 'you@northgate-eng.example',
      subject: 'Lunch?',
      body: 'Are we still on for Friday? I can book the place near the station.',
      headers: { authenticationResults: authPass('northgate-eng.example'), messageId: '<b2@northgate-eng.example>' },
    });
    expect(verdict.classification).toBe('legitimate');
    // Only the authentication credits and the absent To/Cc note may appear, and
    // nothing that pushes towards a verdict.
    expect(verdict.symbols.filter((s) => s.kind === 'phishing')).toEqual([]);
    expect(verdict.score).toBeLessThan(1);
  });

  it('passes a security alert about unusual activity, which is the costliest false positive', () => {
    const verdict = classifyMessage({
      from: { address: 'security@northgate-bank.example', name: 'Northgate Security' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'We noticed a new sign-in to your account',
      body:
        'We saw unusual activity on your account from a new device. If that was you there is ' +
        `nothing to do. No payment was taken and your card has not been blocked. ${filler}`,
      links: [{ href: 'https://www.northgate-bank.example/security/devices', text: 'Review devices' }],
      headers: { authenticationResults: authPass('northgate-bank.example') },
    });
    expect(verdict.classification).toBe('legitimate');
  });

  // ---------------------------------------------------------------------------
  // Four messages that the engine misfiled until the "one fact, one charge"
  // round of fixes. Each was flagged not because any new evidence appeared but
  // because one piece of evidence was counted two or three times over, and each
  // is a shape that arrives in a real inbox constantly. They are the regression
  // guard for that class of defect.
  // ---------------------------------------------------------------------------

  it('passes ordinary mailing-list traffic, which breaks all three authentication checks', () => {
    // A list relays from its own servers and appends a footer, so SPF fails, the
    // signature breaks, and DMARC therefore fails too. That is one fact about how
    // lists work, not three about this message: charging it three times summed to
    // 6.5 phishing points and ate the user's list traffic — the exact outcome
    // `headers.ts` is written to avoid.
    const verdict = classifyMessage({
      from: { address: 'dev@lists.northgate-eng.example', name: 'Northgate Dev List' },
      to: ['dev@lists.northgate-eng.example'],
      selfAddress: 'you@northgate-eng.example',
      subject: '[dev] Re: build failure on main',
      body: `The failure is in the migration step, not the test runner. Patch attached below. ${filler}`,
      headers: {
        authenticationResults: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail header.from=northgate-eng.example',
        listUnsubscribe: '<mailto:dev-unsubscribe@lists.northgate-eng.example>',
        returnPath: '<dev-bounces@lists.northgate-eng.example>',
        messageId: '<20260825.1@lists.northgate-eng.example>',
      },
    });
    expect(verdict.classification).toBe('legitimate');
    expect(verdict.phishingScore).toBeLessThan(PHISHING_THRESHOLD);
  });

  it('passes forwarded mail, where SPF fails while DMARC aligns through DKIM', () => {
    const verdict = classifyMessage({
      from: { address: 'priya@northgate-eng.example', name: 'Priya Raman' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'Sprint notes',
      body: `Notes from planning are in the doc. The migration moves to next week. ${filler}`,
      headers: {
        authenticationResults:
          'mx.google.com; spf=fail smtp.mailfrom=forwarder.example; dkim=pass header.i=@northgate-eng.example; dmarc=pass header.from=northgate-eng.example',
      },
    });
    expect(verdict.classification).toBe('legitimate');
    expect(verdict.symbols.filter((s) => s.kind === 'phishing')).toEqual([]);
  });

  it('passes a bank’s own fraud alert, written in the language of the attack it warns about', () => {
    // Urgency, a consequence and a request to confirm something — the three
    // families a phishing mail uses, because the phishing mail is imitating this.
    // Nothing in the wording can separate them; the authentication can, which is
    // why a passing DMARC has to count against the phishing score and not only
    // against the total.
    const verdict = classifyMessage({
      from: { address: 'alerts@northgate-bank.example', name: 'Northgate Bank' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'Urgent: unusual activity on your account',
      body:
        'We detected unusual activity and have temporarily restricted your account. To avoid ' +
        'suspension, verify your recent transactions in the app and confirm the payment you ' +
        `made on Tuesday. Do not share your password with anyone, including us. ${filler}`,
      links: [{ href: 'https://www.northgate-bank.example/security/review', text: 'Review activity' }],
      headers: {
        authenticationResults: authPass('northgate-bank.example'),
        returnPath: '<bounce@esp-mailer.example>',
        messageId: '<c3.1@esp-mailer.example>',
      },
    });
    expect(verdict.classification).toBe('legitimate');
    expect(verdict.phishingScore).toBeLessThan(PHISHING_THRESHOLD);
    expect(verdict.score).toBeLessThan(SPAM_THRESHOLD);
  });

  it('passes an authenticated notice sent through an ESP, which is most transactional mail', () => {
    // The envelope bounces to the ESP and the Message-ID is stamped there, while
    // the signature aligns for the sender's own domain. Both mismatches are weak
    // proxies for the question DMARC has already answered.
    const verdict = classifyMessage({
      from: { address: 'no-reply@northgate-saas.example', name: 'Northgate SaaS' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'Your password will expire in 7 days',
      body:
        'Your password expires in seven days. Sign in to your account and update it from the ' +
        `security settings page whenever it suits you. ${filler}`,
      links: [{ href: 'https://northgate-saas.example/settings/security', text: 'Security settings' }],
      headers: {
        authenticationResults: authPass('northgate-saas.example'),
        returnPath: '<bounce-9931@esp-mailer.example>',
        messageId: '<9931.abc@esp-mailer.example>',
        listUnsubscribe: '<https://northgate-saas.example/prefs>',
      },
    });
    expect(verdict.classification).toBe('legitimate');
    expect(verdict.phishingScore).toBeLessThan(PHISHING_THRESHOLD);
  });
});

describe('spam', () => {
  it('classifies an advance-fee mail as spam', () => {
    const verdict = classifyMessage({
      from: { address: 'barrister.k@legal-trust-office.example', name: 'Barrister K' },
      to: [],
      subject: 'CONFIDENTIAL BUSINESS PROPOSAL!!!',
      body:
        'I write regarding unclaimed funds of ten million dollars left by a late beneficiary ' +
        'whose next of kin cannot be traced. A clearance fee and a transfer fee are required ' +
        'before the bank transfer can be released to you. Keep this strictly confidential.',
    });
    expect(verdict.classification).toBe('spam');
    expect(verdict.score).toBeGreaterThanOrEqual(SPAM_THRESHOLD);
  });

  it('classifies a prize mail as spam and never as phishing', () => {
    const verdict = classifyMessage({
      from: { address: 'winners@prize-claim-centre-now.example', name: 'Prize Team' },
      to: [],
      subject: '🎉🎁🏆 CONGRATULATIONS YOU HAVE WON!!!',
      body:
        'Dear Valued Customer, you have been selected as our lucky winner of a free iphone. ' +
        'Claim your prize today only — this offer expires today. A processing fee of $25 is ' +
        'required to release your reward. Act now!!!!',
      links: [{ href: 'https://bit.ly/claim-now', text: 'Claim here' }],
    });
    expect(verdict.classification).toBe('spam');
    // Bulk-mail loudness must not accumulate into a phishing warning.
    expect(verdict.phishingScore).toBeLessThan(PHISHING_THRESHOLD);
  });

  it('reports why, in words a reader can act on', () => {
    const verdict = classifyMessage({
      from: { address: 'winners@prize-claim-centre-now.example', name: 'Prize Team' },
      subject: 'YOU HAVE WON!!!',
      body: 'Claim your prize today. A processing fee is required to release your reward.',
      links: [{ href: 'https://bit.ly/claim', text: 'Claim' }],
    });
    expect(topReason(verdict)).toEqual(expect.any(String));
    const list = reasons(verdict);
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(4);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('phishing, which is a different answer', () => {
  it('classifies a bank impersonation as phishing-suspicious', () => {
    const verdict = classifyMessage({
      from: { address: 'security@paypa1.com', name: 'PayPal Security' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'Urgent: your account will be suspended',
      body:
        'Your account will be locked within 24 hours. Verify your identity and confirm your ' +
        'password now to restore access.',
      links: [{ href: 'http://198.51.100.24/paypal/login/verify?s=1', text: 'https://www.paypal.com' }],
      headers: {
        replyTo: 'paypal.recovery@gmail.com',
        authenticationResults: 'mx.google.com; dkim=fail; spf=fail smtp.mailfrom=paypa1.com; dmarc=fail header.from=paypa1.com',
      },
    });
    expect(verdict.classification).toBe('phishing-suspicious');
    expect(verdict.phishingScore).toBeGreaterThanOrEqual(PHISHING_THRESHOLD);
    expect(isUnwanted(verdict)).toBe(true);
  });

  it('classifies a quiet invoice-fraud mail as phishing even below the spam threshold', () => {
    // Nothing loud here: no capitals, no emoji, no prize. This is the shape a
    // bulk-mail score cannot see, which is why the phishing bar is its own number.
    const verdict = classifyMessage({
      from: { address: 'a.mcbride@northgate-enq.example', name: 'Alan McBride' },
      to: ['you@northgate-eng.example'],
      selfAddress: 'you@northgate-eng.example',
      subject: 'Supplier bank details',
      body:
        'Please keep this between us for now. Our supplier has changed banks, so today’s wire ' +
        'transfer needs to go to the new account below rather than the usual one.',
      headers: { replyTo: 'a.mcbride.finance@gmail.com' },
    });
    expect(verdict.classification).toBe('phishing-suspicious');
    expect(verdict.phishingScore).toBeGreaterThanOrEqual(PHISHING_THRESHOLD);
  });

  it('classifies a credential-harvesting page behind an honest-looking link as phishing', () => {
    const verdict = classifyMessage({
      from: { address: 'no-reply@microsoft-secure-login-team.example', name: 'Microsoft Account Team' },
      to: ['you@gmail.com'],
      selfAddress: 'you@gmail.com',
      subject: 'Action required: password expires today',
      body: `Your password will expire today. Confirm your identity to keep access. ${filler}`,
      links: [{ href: 'https://microsoft-secure-login-team.example/account/verify/password', text: 'Sign in to Microsoft' }],
    });
    expect(verdict.classification).toBe('phishing-suspicious');
  });

  it('takes precedence over spam when a message is both', () => {
    const verdict = classifyMessage({
      from: { address: 'security@paypa1.com', name: 'PayPal Security' },
      subject: 'URGENT!!! ACCOUNT SUSPENDED',
      body:
        'Your account will be deleted within 24 hours. Verify your identity immediately and pay ' +
        'the outstanding balance of $240 by wire transfer to avoid legal action.',
      links: [{ href: 'https://paypal.com@evil.example/signin', text: 'https://www.paypal.com' }],
      headers: { authenticationResults: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail' },
    });
    expect(verdict.score).toBeGreaterThanOrEqual(SPAM_THRESHOLD);
    expect(verdict.phishingScore).toBeGreaterThanOrEqual(PHISHING_THRESHOLD);
    // The more specific warning is the useful one.
    expect(verdict.classification).toBe('phishing-suspicious');
  });

  it('never lets a single symbol reach either threshold', () => {
    const verdict = classifyMessage({
      from: { address: 'security@paypa1.com', name: 'PayPal Security' },
      selfAddress: 'you@gmail.com',
      subject: 'URGENT!!! VERIFY YOUR ACCOUNT NOW',
      body: 'Your account will be locked within 24 hours. Confirm your password immediately.',
      links: [{ href: 'http://0x7f000001/paypal/login/verify', text: 'https://www.paypal.com' }],
      attachments: [{ filename: 'invoice.pdf.exe' }],
      headers: { replyTo: 'x@gmail.com', authenticationResults: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail' },
    });
    expect(verdict.symbols.length).toBeGreaterThan(8);
    for (const symbol of verdict.symbols) {
      expect(Math.abs(symbol.weight)).toBeLessThan(SPAM_THRESHOLD);
      expect(Math.abs(symbol.weight)).toBeLessThan(PHISHING_THRESHOLD + 0.1);
    }
    expect(verdict.classification).toBe('phishing-suspicious');
  });

  it('sorts symbols heaviest first, so the reason shown is the reason that decided it', () => {
    const verdict = classifyMessage({
      from: { address: 'security@paypa1.com', name: 'PayPal Security' },
      subject: 'Urgent: verify your account',
      body: 'Your account will be locked. Confirm your password within 24 hours.',
      links: [{ href: 'https://paypal.com@evil.example/signin', text: 'https://www.paypal.com' }],
      headers: { authenticationResults: 'mx.google.com; dmarc=fail' },
    });
    const magnitudes = verdict.symbols.map((s) => Math.abs(s.weight));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
  });
});

describe('the user’s decision outranks the engine', () => {
  const obviousSpam: SpamInput = {
    from: { address: 'winners@prize-claim-centre-now.example' },
    subject: 'YOU HAVE WON!!!',
    body: 'Claim your prize today. A processing fee is required to release your reward.',
  };

  it('reports legitimate for a message the user marked not spam, however it scores', () => {
    const verdict = classifyMessage(obviousSpam, { mark: 'ham' });
    expect(verdict.classification).toBe('legitimate');
    expect(verdict.overridden).toBe(true);
    expect(verdict.score).toBe(0);
    expect(verdict.symbols.map((s) => s.name)).toEqual(['USER_MARKED_HAM']);
  });

  it('reports spam for a message the user marked spam, however it scores', () => {
    const verdict = classifyMessage(
      { from: { address: 'priya@northgate-eng.example' }, subject: 'Lunch?', body: 'Friday still good?' },
      { mark: 'spam' },
    );
    expect(verdict.classification).toBe('spam');
    expect(verdict.overridden).toBe(true);
    expect(verdict.symbols.map((s) => s.name)).toEqual(['USER_MARKED_SPAM']);
  });

  it('does not consult the model at all when a mark is present', () => {
    const verdict = classifyMessage(obviousSpam, { mark: 'ham', model: trainedModel() });
    expect(verdict.bayesApplied).toBe(false);
    expect(verdict.bayesProbability).toBeNull();
  });

  it('scores normally when the mark is absent or null', () => {
    expect(classifyMessage(obviousSpam, { mark: null }).overridden).toBe(false);
    expect(classifyMessage(obviousSpam).overridden).toBe(false);
  });
});

describe('learning from corrections', () => {
  it('does not consult an untrained model, so a fresh install is rules-only', () => {
    const verdict = classifyMessage(
      { from: { address: 'promo@coin-blast.example' }, subject: 'Bitcoin doubling event', body: 'Send bitcoin, receive double.' },
      { model: emptyModel() },
    );
    expect(verdict.bayesApplied).toBe(false);
    expect(verdict.bayesProbability).toBeNull();
    expect(names({ from: { address: 'promo@coin-blast.example' }, subject: 'x', body: 'y' }, emptyModel()))
      .not.toContain('BAYES_SPAM');
  });

  it('recognises a message like the ones the user marked spam', () => {
    const model = trainedModel();
    const verdict = classifyMessage(
      {
        from: { address: 'promo9@coin-blast.example' },
        subject: 'Bitcoin doubling event',
        body: 'Send bitcoin to our wallet and receive double back. The doubling round is open.',
      },
      { model },
    );
    expect(verdict.bayesApplied).toBe(true);
    expect(verdict.bayesProbability).toBeGreaterThan(0.5);
    expect(verdict.symbols.map((s) => s.name)).toContain('BAYES_SPAM');
  });

  it('recognises a message like the ones the user marked not spam', () => {
    const model = trainedModel();
    const verdict = classifyMessage(
      {
        from: { address: 'priya@northgate-eng.example' },
        subject: 'Sprint planning notes',
        body: 'Notes from planning: the migration moves to next week and Priya owns the rollout checklist.',
      },
      { model },
    );
    expect(verdict.bayesApplied).toBe(true);
    expect(verdict.bayesProbability).toBeLessThan(0.5);
    expect(verdict.symbols.map((s) => s.name)).toContain('BAYES_HAM');
  });

  it('never votes for phishing, whatever it has learned', () => {
    const model = trainedModel();
    const verdict = classifyMessage(
      { from: { address: 'promo9@coin-blast.example' }, subject: 'Bitcoin doubling event', body: 'Send bitcoin, receive double back from our wallet.' },
      { model },
    );
    for (const symbol of verdict.symbols.filter((s) => s.name.startsWith('BAYES_'))) {
      expect(symbol.kind).not.toBe('phishing');
    }
  });

  it('stays modest: a trained model cannot reach the threshold by itself', () => {
    const model = trainedModel();
    const verdict = classifyMessage(
      {
        from: { address: 'promo9@coin-blast.example' },
        subject: 'Bitcoin doubling event',
        body: 'Send bitcoin to our wallet and receive double back. The doubling round is open.',
      },
      { model },
    );
    const bayes = verdict.symbols.find((s) => s.name === 'BAYES_SPAM')!;
    expect(bayes.weight).toBeLessThan(SPAM_THRESHOLD);
    // Twelve examples must not buy near-certainty. `verdictCap` starts at 0.9 and
    // only approaches 0.999 as the corpus grows, so a barely-trained model can
    // suspect a message but never settle it.
    expect(verdict.bayesProbability!).toBeLessThan(0.95);
  });

  it('reverses a mark exactly, so a re-correction leaves nothing behind', () => {
    const input: SpamInput = {
      from: { address: 'digest@birdwatch-weekly.example' },
      subject: 'Weekly bird digest',
      body: 'Two nightjars on the heath this week, plus a late swift over the reservoir.',
    };
    const base = trainedModel();
    const after = unlearn(learn(base, input, 'spam'), input, 'spam');
    expect(after.spamMessages).toBe(base.spamMessages);
    expect(after.hamMessages).toBe(base.hamMessages);
    expect(after.spam).toEqual(base.spam);
    expect(after.ham).toEqual(base.ham);
  });

  it('learns nothing from a message with no readable content — an unopened encrypted mail', () => {
    const model = trainedModel();
    // No subject and no body is exactly what an encrypted message looks like before
    // this device decrypts it. Training on it would teach the model nothing but
    // noise, so `tokenizeInputFor` yields no tokens and the model is returned as-is.
    expect(learn(model, {}, 'spam')).toBe(model);
  });
});

describe('never throws, whatever arrives', () => {
  it('survives an entirely empty input', () => {
    const verdict = classifyMessage({});
    expect(verdict.classification).toBe('legitimate');
    // Nothing can be said about a message with no fields, so nothing is: an
    // absent field is missing information, never evidence.
    expect(verdict.score).toBe(0);
    expect(verdict.symbols).toEqual([]);
    expect(verdict.phishingScore).toBe(0);
    expect(verdict.bayesApplied).toBe(false);
  });

  it('survives fields of the wrong type throughout', () => {
    const hostile = {
      from: 'not an object',
      to: 'not an array',
      subject: 42,
      body: { toString: () => 'x' },
      links: 'none',
      headers: 7,
      attachments: { filename: 'x.exe' },
      selfAddress: null,
    } as unknown as SpamInput;
    expect(() => classifyMessage(hostile)).not.toThrow();
    expect(classifyMessage(hostile).classification).toBe('legitimate');
  });

  it('survives a corrupted model', () => {
    const broken = { version: 1, spam: null, ham: undefined, spamMessages: NaN, hamMessages: -1, updatedAt: 'x' } as unknown as SpamModel;
    expect(() => classifyMessage({ subject: 'hello', body: 'world' }, { model: broken })).not.toThrow();
  });

  it('survives a message built entirely out of hostile content', () => {
    const verdict = classifyMessage({
      from: { address: '‮@‮.‮', name: '🎉'.repeat(200) },
      to: ['', '   '],
      subject: '!!!???***'.repeat(50),
      body: '🎉'.repeat(2000),
      links: [{ href: 'javascript:alert(1)', text: '<script>' }, { href: 'not a url', text: '' }],
      attachments: [{ filename: '.'.repeat(500) }],
      headers: { authenticationResults: '((((', replyTo: ';;;', messageId: '<<<>>>' },
      selfAddress: 'you@gmail.com',
    });
    expect(['legitimate', 'spam', 'phishing-suspicious']).toContain(verdict.classification);
  });

  it('rounds the scores it reports', () => {
    const verdict = classifyMessage({
      from: { address: 'winners@prize-claim-centre-now.example' },
      subject: 'YOU HAVE WON!!!',
      body: 'Claim your prize today. A processing fee is required to release your reward.',
    });
    expect(verdict.score).toBe(Math.round(verdict.score * 100) / 100);
    expect(verdict.phishingScore).toBe(Math.round(verdict.phishingScore * 100) / 100);
  });
});

describe('reasons shown to the reader', () => {
  it('says nothing about a clean message', () => {
    const verdict = classifyMessage({
      from: { address: 'priya@northgate-eng.example', name: 'Priya Raman' },
      to: ['you@northgate-eng.example'],
      selfAddress: 'you@northgate-eng.example',
      subject: 'Lunch?',
      body: 'Friday still good?',
      headers: { authenticationResults: authPass('northgate-eng.example') },
    });
    expect(topReason(verdict)).toBeNull();
    expect(reasons(verdict)).toEqual([]);
  });

  it('never quotes the message back', () => {
    // A reason is shown in the UI, so it must be the app's own words about the
    // message — never a fragment of sender-supplied HTML or body text.
    const verdict = classifyMessage({
      from: { address: 'security@paypa1.com', name: 'PayPal Security' },
      subject: 'Urgent: verify your account',
      body: 'Your account will be locked. <script>alert(1)</script> Confirm your password now.',
      links: [{ href: 'https://paypal.com@evil.example/signin', text: '<b>https://www.paypal.com</b>' }],
      headers: { authenticationResults: 'mx.google.com; dmarc=fail' },
    });
    for (const reason of reasons(verdict, 10)) {
      expect(reason).not.toContain('<script');
      expect(reason).not.toContain('<b>');
    }
  });

  it('honours the limit', () => {
    const verdict = classifyMessage({
      from: { address: 'security@paypa1.com', name: 'PayPal Security' },
      subject: 'URGENT!!! VERIFY YOUR ACCOUNT',
      body: 'Your account will be locked within 24 hours. Confirm your password and pay by wire transfer.',
      links: [{ href: 'http://198.51.100.24/paypal/login/verify', text: 'https://www.paypal.com' }],
      attachments: [{ filename: 'invoice.pdf.exe' }],
      headers: { authenticationResults: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail' },
    });
    expect(reasons(verdict, 2)).toHaveLength(2);
  });
});
