/**
 * Header and authentication analysis.
 *
 * The rule these tests exist to protect is **missing is not failing**. A message
 * with no `Authentication-Results` is the ordinary case — for mail that arrived by
 * a path that did not stamp one, for providers that do not, and for every message
 * in demo mode — so absence must contribute exactly nothing. An implementation
 * that scored absence would classify a large fraction of real mail as suspicious,
 * and nothing else in the engine would catch that mistake.
 *
 * The second theme is that no header signal is a verdict. Every weight below is
 * checked against `SPAM_THRESHOLD`, because DMARC breaks routinely on legitimate
 * mailing-list traffic and a filter that ate list mail would be worse than none.
 */
import { domainOf, headerSymbols, parseAuthResults } from '../headers';
import { PHISHING_THRESHOLD, SPAM_THRESHOLD, type SpamInput } from '../types';

const names = (input: SpamInput): string[] => headerSymbols(input).map((s) => s.name);

const weightOf = (input: SpamInput, name: string): number | undefined =>
  headerSymbols(input).find((s) => s.name === name)?.weight;

const authNames = (input: SpamInput): string[] => names(input).filter((n) => n.startsWith('AUTH_'));

/** A message with nothing wrong with it, which every case below starts from. */
const plain = (overrides: Partial<SpamInput> = {}): SpamInput => ({
  from: { address: 'orders@northgate-eng.example', name: 'Northgate Engineering' },
  to: ['you@gmail.com'],
  ...overrides,
});

describe('parseAuthResults', () => {
  it('reports nothing at all when the header is absent', () => {
    expect(parseAuthResults(undefined)).toEqual({ spf: null, dkim: null, dmarc: null, malformed: false });
  });

  it('treats an empty or blank header as absent, not as malformed', () => {
    expect(parseAuthResults('')).toEqual({ spf: null, dkim: null, dmarc: null, malformed: false });
    expect(parseAuthResults('   \t ')).toEqual({ spf: null, dkim: null, dmarc: null, malformed: false });
  });

  it('reads all three methods out of a real Gmail header', () => {
    const verdicts = parseAuthResults(
      'mx.google.com; spf=pass (google.com: domain of a@b.example designates 10.0.0.1 as ' +
        'permitted sender) smtp.mailfrom=a@b.example; dkim=pass header.i=@b.example; ' +
        'dmarc=pass header.from=b.example',
    );
    expect(verdicts).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', malformed: false });
  });

  it('reads failures', () => {
    expect(parseAuthResults('mx.example; spf=fail; dkim=fail; dmarc=fail')).toEqual({
      spf: 'fail',
      dkim: 'fail',
      dmarc: 'fail',
      malformed: false,
    });
  });

  it('ignores what a comment claims, because a comment is free text', () => {
    // A sender who writes `(dmarc=fail)` inside a comment has not said dmarc failed.
    const verdicts = parseAuthResults('mx.example; spf=pass (dmarc=fail is only a comment here)');
    expect(verdicts.spf).toBe('pass');
    expect(verdicts.dmarc).toBeNull();
  });

  it('is case-insensitive and tolerates spacing around the equals sign', () => {
    expect(parseAuthResults('MX.EXAMPLE; SPF = PASS; DKIM=Fail').spf).toBe('pass');
    expect(parseAuthResults('MX.EXAMPLE; SPF = PASS; DKIM=Fail').dkim).toBe('fail');
  });

  it('distinguishes an explicit "none" from the header not saying', () => {
    const verdicts = parseAuthResults('mx.example; spf=none');
    expect(verdicts.spf).toBe('none');
    expect(verdicts.dkim).toBeNull();
  });

  it('reports an unrecognised result as unknown rather than guessing', () => {
    expect(parseAuthResults('mx.example; spf=weird').spf).toBe('unknown');
  });

  it('marks a present-but-unreadable header malformed, not failed', () => {
    for (const header of ['((((', 'nonsense', 'mx.google.com']) {
      const verdicts = parseAuthResults(header);
      expect(verdicts.malformed).toBe(true);
      expect(verdicts.spf).toBeNull();
      expect(verdicts.dkim).toBeNull();
      expect(verdicts.dmarc).toBeNull();
    }
  });
});

describe('the "missing is not failing" rule', () => {
  it('produces no symbol whatsoever for an ordinary message with no headers', () => {
    expect(headerSymbols(plain())).toEqual([]);
  });

  it('produces no authentication symbol when the header is absent', () => {
    expect(authNames(plain())).toEqual([]);
  });

  it('produces no authentication symbol when every method says "none"', () => {
    expect(authNames(plain({ headers: { authenticationResults: 'mx.example; spf=none; dkim=none; dmarc=none' } })))
      .toEqual([]);
  });

  it('produces no authentication symbol for a result it does not recognise', () => {
    expect(authNames(plain({ headers: { authenticationResults: 'mx.example; spf=weird; dmarc=weird' } }))).toEqual([]);
  });

  it('notices a malformed header without scoring it as a failure', () => {
    const input = plain({ headers: { authenticationResults: '(((( not a header' } });
    expect(names(input)).toContain('AUTH_RESULTS_MALFORMED');
    expect(names(input).some((n) => n.endsWith('_FAIL'))).toBe(false);
    expect(weightOf(input, 'AUTH_RESULTS_MALFORMED')).toBeLessThan(0.5);
  });

  it('scores an absent Reply-To, Return-Path and Message-ID as nothing', () => {
    expect(names(plain({ headers: {} }))).toEqual([]);
  });
});

describe('authentication symbols', () => {
  const withAuth = (authenticationResults: string): SpamInput => plain({ headers: { authenticationResults } });

  it('credits a passing DMARC and a passing SPF+DKIM pair', () => {
    const symbols = headerSymbols(withAuth('mx.example; spf=pass; dkim=pass; dmarc=pass'));
    expect(symbols.map((s) => s.name)).toEqual(['AUTH_DMARC_PASS', 'AUTH_SPF_DKIM_PASS']);
    expect(symbols.every((s) => s.kind === 'ham' && s.weight < 0)).toBe(true);
  });

  it('treats a DMARC failure as the strongest header signal, and as phishing evidence', () => {
    const symbols = headerSymbols(withAuth('mx.example; dmarc=fail header.from=b.example'));
    const dmarc = symbols.find((s) => s.name === 'AUTH_DMARC_FAIL');
    expect(dmarc).toBeDefined();
    expect(dmarc?.kind).toBe('phishing');
    // Legitimate list traffic breaks DMARC, so even this cannot classify alone.
    expect(dmarc!.weight).toBeLessThan(SPAM_THRESHOLD);
  });

  it('scores SPF and DKIM failures separately and more weakly than DMARC', () => {
    const spf = weightOf(withAuth('mx.example; spf=fail'), 'AUTH_SPF_FAIL')!;
    const dkim = weightOf(withAuth('mx.example; dkim=fail'), 'AUTH_DKIM_FAIL')!;
    const dmarc = weightOf(withAuth('mx.example; dmarc=fail'), 'AUTH_DMARC_FAIL')!;
    expect(spf).toBeGreaterThan(0);
    expect(dkim).toBeGreaterThan(0);
    expect(spf).toBeLessThan(dmarc);
    expect(dkim).toBeLessThan(dmarc);
  });

  it('scores a softfail well below a fail', () => {
    const soft = weightOf(withAuth('mx.example; spf=softfail'), 'AUTH_SPF_SOFTFAIL')!;
    const hard = weightOf(withAuth('mx.example; spf=fail'), 'AUTH_SPF_FAIL')!;
    expect(soft).toBeLessThan(hard);
  });

  it('withholds the SPF+DKIM credit when DMARC contradicts it', () => {
    // Both mechanisms passing for the wrong domain is not alignment.
    expect(authNames(withAuth('mx.example; spf=pass; dkim=pass; dmarc=fail'))).not.toContain('AUTH_SPF_DKIM_PASS');
  });

  it('does not credit a lone passing SPF', () => {
    expect(authNames(withAuth('mx.example; spf=pass'))).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // One fact, one charge. DMARC *is* the alignment check over SPF and DKIM, so
  // when it has stated a verdict the two underlying mechanisms are not separate
  // evidence — charging all three sums 3.5 + 1.6 + 1.4 = 6.5 and makes broken
  // authentication a phishing verdict by itself, which is precisely what the
  // weights in this module are chosen to prevent.
  // ---------------------------------------------------------------------------

  it('charges a DMARC failure once, not three times over SPF and DKIM as well', () => {
    const symbols = headerSymbols(withAuth('mx.example; spf=fail; dkim=fail; dmarc=fail'));
    expect(symbols.map((s) => s.name)).toEqual(['AUTH_DMARC_FAIL']);
    // The whole authentication story stays below the phishing bar, so a message
    // that merely failed authentication is not yet a verdict.
    expect(symbols.reduce((sum, s) => sum + s.weight, 0)).toBeLessThan(PHISHING_THRESHOLD);
  });

  it('says nothing about a broken SPF once DMARC has passed — that is forwarded mail', () => {
    // A forwarder relays from its own servers (SPF fails for the original domain)
    // while the signature survives (DKIM passes), so DMARC aligns through DKIM.
    // This is the ordinary signature of forwarded mail, not evidence of anything.
    const symbols = headerSymbols(withAuth('mx.example; spf=fail; dkim=pass; dmarc=pass'));
    expect(symbols.map((s) => s.name)).toEqual(['AUTH_DMARC_PASS']);
    expect(symbols.every((s) => s.weight < 0)).toBe(true);
  });

  it('still scores SPF and DKIM when the domain publishes no DMARC policy', () => {
    // Absent, `none`, or unreadable: then the two mechanisms are the best evidence
    // there is, and withholding them would throw away real information.
    expect(authNames(withAuth('mx.example; spf=fail; dkim=fail')))
      .toEqual(['AUTH_SPF_FAIL', 'AUTH_DKIM_FAIL']);
    expect(authNames(withAuth('mx.example; spf=fail; dmarc=none'))).toEqual(['AUTH_SPF_FAIL']);
  });

  it('counts the authentication credits against the phishing score, not only the total', () => {
    // Phishing is impersonation, and a passing DMARC is a cryptographic statement
    // that the visible From domain really sent the message. A ham credit that did
    // not reach the phishing score is how a bank's own fraud alert — written, of
    // necessity, in the language of the attack it warns about — ends up flagged as
    // that attack.
    for (const name of ['AUTH_DMARC_PASS', 'AUTH_SPF_DKIM_PASS']) {
      const symbol = headerSymbols(withAuth('mx.example; spf=pass; dkim=pass; dmarc=pass'))
        .find((s) => s.name === name);
      expect(symbol?.counterPhishing).toBe(true);
    }
  });

  it('does not lend the unsubscribe credit to the phishing score', () => {
    // A phisher sets `List-Unsubscribe` for free, so it says nothing about identity.
    const symbol = headerSymbols(plain({ headers: { listUnsubscribe: '<mailto:stop@list.example>' } }))
      .find((s) => s.name === 'HAS_LIST_UNSUBSCRIBE');
    expect(symbol?.weight).toBeLessThan(0);
    expect(symbol?.counterPhishing).toBeUndefined();
  });
});

describe('address consistency', () => {
  it('flags a Reply-To on free mail for a business sender as the BEC signature', () => {
    const input = plain({ headers: { replyTo: 'northgate.accounts.recovery@gmail.com' } });
    expect(names(input)).toContain('REPLY_TO_FREEMAIL_MISMATCH');
    expect(weightOf(input, 'REPLY_TO_FREEMAIL_MISMATCH')).toBeLessThan(SPAM_THRESHOLD);
  });

  it('flags a plain Reply-To mismatch more weakly', () => {
    const freemail = weightOf(plain({ headers: { replyTo: 'x@gmail.com' } }), 'REPLY_TO_FREEMAIL_MISMATCH')!;
    const other = weightOf(plain({ headers: { replyTo: 'x@some-other.example' } }), 'REPLY_TO_MISMATCH')!;
    expect(other).toBeGreaterThan(0);
    expect(other).toBeLessThan(freemail);
  });

  it('does not flag a Reply-To inside the sender’s own registrable domain', () => {
    const input: SpamInput = {
      from: { address: 'noreply@mail.shop.example' },
      to: ['you@gmail.com'],
      headers: { replyTo: 'Support <support@shop.example>' },
    };
    expect(names(input)).toEqual([]);
  });

  it('reads only the first address of a Reply-To list, which is where a reply goes', () => {
    expect(names(plain({ headers: { replyTo: 'x@gmail.com, y@northgate-eng.example' } })))
      .toContain('REPLY_TO_FREEMAIL_MISMATCH');
  });

  it('says nothing about a Reply-To it cannot parse', () => {
    expect(names(plain({ headers: { replyTo: 'not an address at all' } }))).toEqual([]);
  });

  it('flags a Return-Path and Message-ID on other domains, but only just', () => {
    const returnPath = weightOf(plain({ headers: { returnPath: '<bounce@mailer-9931.example>' } }), 'RETURN_PATH_MISMATCH')!;
    const messageId = weightOf(plain({ headers: { messageId: '<abc.123@mailer-9931.example>' } }), 'MESSAGE_ID_MISMATCH')!;
    expect(returnPath).toBeLessThan(1);
    expect(messageId).toBeLessThan(1);
  });

  it('does not flag a Return-Path or Message-ID on the sender’s own domain', () => {
    expect(names(plain({
      headers: { returnPath: '<bounce@northgate-eng.example>', messageId: '<abc@mail.northgate-eng.example>' },
    }))).toEqual([]);
  });

  it('stops charging the Return-Path and Message-ID proxies once DMARC has passed', () => {
    // Both are weak *proxies* for "did this domain really send this", and DMARC
    // answers that question directly. Every message sent through an ESP bounces to
    // the ESP and stamps its Message-ID there while aligning through DKIM, so
    // scoring these anyway would put a standing 0.9 on the largest single class of
    // legitimate bulk and transactional mail there is.
    const esp = plain({
      headers: {
        authenticationResults: 'mx.example; spf=pass; dkim=pass; dmarc=pass header.from=northgate-eng.example',
        returnPath: '<bounce@mailer-9931.example>',
        messageId: '<abc.123@mailer-9931.example>',
      },
    });
    expect(names(esp)).not.toContain('RETURN_PATH_MISMATCH');
    expect(names(esp)).not.toContain('MESSAGE_ID_MISMATCH');
    // Still charged when DMARC did not answer it.
    expect(names(plain({
      headers: { returnPath: '<bounce@mailer-9931.example>', messageId: '<abc.123@mailer-9931.example>' },
    }))).toEqual(['RETURN_PATH_MISMATCH', 'MESSAGE_ID_MISMATCH']);
  });

  it('flags a From that is not an address', () => {
    const input: SpamInput = { from: { address: 'not-an-address' }, to: ['you@gmail.com'] };
    expect(names(input)).toEqual(['FROM_MALFORMED']);
  });
});

describe('impersonation', () => {
  it('flags a display name that is an address on a different domain', () => {
    const input: SpamInput = {
      from: { address: 'random@mailer-9931.example', name: 'accounts@northgate-bank.example' },
      to: ['you@gmail.com'],
    };
    expect(names(input)).toContain('DISPLAY_NAME_SPOOFS_ADDRESS');
  });

  it('flags a brand in the display name that the sending domain does not own', () => {
    const input: SpamInput = {
      from: { address: 'security@mailer-9931.example', name: 'PayPal Service' },
      to: ['you@gmail.com'],
    };
    expect(names(input)).toContain('BRAND_NAME_WRONG_DOMAIN');
  });

  it('weighs a brand name sent from free mail higher still', () => {
    const freemail = weightOf(
      { from: { address: 'paypal.security@gmail.com', name: 'PayPal Service' }, to: ['you@gmail.com'] },
      'BRAND_NAME_FROM_FREEMAIL',
    )!;
    const other = weightOf(
      { from: { address: 'security@mailer-9931.example', name: 'PayPal Service' }, to: ['you@gmail.com'] },
      'BRAND_NAME_WRONG_DOMAIN',
    )!;
    expect(freemail).toBeGreaterThan(other);
  });

  it('scores real brand mail at nothing at all, which is the point of the brand table', () => {
    // The false-positive case that matters: PayPal writing from PayPal.
    expect(headerSymbols({ from: { address: 'service@paypal.com', name: 'PayPal' }, to: ['you@gmail.com'] }))
      .toEqual([]);
    expect(headerSymbols({ from: { address: 'no-reply@amazon.co.uk', name: 'Amazon.co.uk' }, to: ['you@gmail.com'] }))
      .toEqual([]);
  });

  it('emits one brand symbol per message, not one per brand word', () => {
    const input: SpamInput = {
      from: { address: 'x@mailer-9931.example', name: 'PayPal and Apple and Microsoft Security' },
      to: ['you@gmail.com'],
    };
    expect(names(input).filter((n) => n.startsWith('BRAND_NAME_'))).toHaveLength(1);
  });

  it('flags a sending domain that renders as a brand, most heavily of all', () => {
    const digitSwap = weightOf({ from: { address: 'a@paypa1.com' }, to: ['you@gmail.com'] }, 'FROM_LOOKALIKE_DOMAIN')!;
    const nearMiss = weightOf({ from: { address: 'a@paypall.com' }, to: ['you@gmail.com'] }, 'FROM_LOOKALIKE_DOMAIN')!;
    const embedded = weightOf(
      { from: { address: 'a@paypal-security.example' }, to: ['you@gmail.com'] },
      'FROM_LOOKALIKE_DOMAIN',
    )!;
    expect(digitSwap).toBeGreaterThan(nearMiss);
    expect(nearMiss).toBeGreaterThan(embedded);
    expect(digitSwap).toBeLessThan(SPAM_THRESHOLD);
  });

  it('flags a Cyrillic homoglyph domain the same way as a digit swap', () => {
    // "pаypal.com" — the second character is Cyrillic а.
    expect(names({ from: { address: 'a@pаypal.com' }, to: ['you@gmail.com'] }))
      .toContain('FROM_LOOKALIKE_DOMAIN');
  });

  it('flags a brand as a subdomain of somebody else’s domain', () => {
    expect(names({ from: { address: 'a@paypal.account-verify.example' }, to: ['you@gmail.com'] }))
      .toContain('FROM_LOOKALIKE_DOMAIN');
  });

  it('flags a punycode sending domain', () => {
    expect(names({ from: { address: 'a@xn--pypal-4ve.com' }, to: ['you@gmail.com'] }))
      .toContain('FROM_PUNYCODE_DOMAIN');
  });
});

describe('sender-domain shape', () => {
  it('adds a fraction of a point for a TLD with a poor reputation', () => {
    const input: SpamInput = { from: { address: 'winners@prize-drop.xyz' }, to: ['you@gmail.com'] };
    expect(names(input)).toEqual(['FROM_RISKY_TLD']);
    expect(weightOf(input, 'FROM_RISKY_TLD')).toBeLessThan(1);
  });

  it('flags a domain assembled out of the words of a pretext', () => {
    expect(names({ from: { address: 'a@secure-account-verify-login.example' }, to: ['you@gmail.com'] }))
      .toContain('FROM_DOMAIN_MANY_PARTS');
  });

  it('flags a throwaway-looking domain label', () => {
    expect(names({ from: { address: 'a@xkrtplmzqwbn.example' }, to: ['you@gmail.com'] }))
      .toContain('FROM_DOMAIN_RANDOM');
  });

  it('does not call an ordinary long hyphenated business domain random', () => {
    expect(names({ from: { address: 'a@northgate-engineering.example' }, to: ['you@gmail.com'] })).toEqual([]);
  });
});

describe('the user’s own address', () => {
  const self = 'you@northgate-eng.example';

  it('flags mail from your own address that authentication does not back up', () => {
    const input: SpamInput = { from: { address: self }, to: [self], selfAddress: self };
    expect(names(input)).toContain('FROM_SELF_UNAUTHENTICATED');
  });

  it('says nothing when that same message authenticates', () => {
    const input: SpamInput = {
      from: { address: self },
      to: [self],
      selfAddress: self,
      headers: { authenticationResults: 'mx.example; spf=pass; dkim=pass; dmarc=pass' },
    };
    expect(names(input)).not.toContain('FROM_SELF_UNAUTHENTICATED');
  });

  it('flags a sender imitating your own domain', () => {
    const input: SpamInput = {
      from: { address: 'ceo@northgateeng.example', name: 'Priya Raman' },
      to: [self],
      selfAddress: self,
    };
    expect(names(input)).toContain('FROM_LOOKALIKE_OF_SELF');
  });

  it('never flags a colleague on your own domain', () => {
    expect(names({ from: { address: 'priya@northgate-eng.example' }, to: [self], selfAddress: self })).toEqual([]);
  });
});

describe('hygiene signals', () => {
  it('credits a standard unsubscribe header', () => {
    const input = plain({ headers: { listUnsubscribe: '<mailto:stop@list.example>' } });
    expect(names(input)).toEqual(['HAS_LIST_UNSUBSCRIBE']);
    expect(weightOf(input, 'HAS_LIST_UNSUBSCRIBE')).toBeLessThan(0);
  });

  it('notes an empty recipient list weakly, since BCC is ordinary', () => {
    const input: SpamInput = { from: { address: 'a@northgate-eng.example' }, to: [] };
    expect(names(input)).toEqual(['NO_VISIBLE_RECIPIENT']);
    expect(weightOf(input, 'NO_VISIBLE_RECIPIENT')).toBeLessThan(1);
    expect(names({ ...input, to: ['  '] })).toEqual(['NO_VISIBLE_RECIPIENT']);
  });

  it('says nothing at all when the To field was never supplied', () => {
    // An absent `to` is missing information, not an empty recipient list: a
    // connector that does not populate the field, or a caller scoring bare text,
    // must score exactly as it did before the field existed. Same rule as
    // `Authentication-Results` — missing is not failing.
    expect(names({ from: { address: 'a@northgate-eng.example' } })).toEqual([]);
  });

  it('notes a message addressed only to somebody else', () => {
    expect(names({
      from: { address: 'a@northgate-eng.example' },
      to: ['someone.else@other.example'],
      selfAddress: 'you@gmail.com',
    })).toContain('RECIPIENT_NOT_SELF');
  });
});

describe('defensive parsing', () => {
  it('survives every header being empty', () => {
    expect(() =>
      headerSymbols({
        from: { address: '', name: '' },
        to: [],
        headers: { replyTo: '', authenticationResults: '', listUnsubscribe: '', returnPath: '', messageId: '' },
      }),
    ).not.toThrow();
  });

  it('survives headers holding punctuation rather than addresses', () => {
    expect(() =>
      headerSymbols({
        from: { address: '<<<>>>', name: '@@@' },
        to: ['', '   ', '@'],
        headers: {
          replyTo: ',,,',
          authenticationResults: 'spf=(((',
          listUnsubscribe: '<>',
          returnPath: '>>>',
          messageId: '<<<>>>',
          received: 'from nowhere',
        },
        selfAddress: '@',
      }),
    ).not.toThrow();
  });

  it('survives an entirely empty input', () => {
    expect(() => headerSymbols({})).not.toThrow();
  });

  it('never lets one header symbol reach the spam threshold on its own', () => {
    const hostile: SpamInput = {
      from: { address: 'security@paypa1-verify.example', name: 'PayPal Service' },
      to: ['someone.else@other.example'],
      selfAddress: 'you@gmail.com',
      headers: {
        replyTo: 'paypal.recovery@gmail.com',
        returnPath: '<bounce@mailer-9931.example>',
        messageId: '<x@mailer-9931.example>',
        authenticationResults: 'mx.example; spf=fail; dkim=fail; dmarc=fail',
      },
    };
    const symbols = headerSymbols(hostile);
    expect(symbols.length).toBeGreaterThan(4);
    for (const symbol of symbols) expect(Math.abs(symbol.weight)).toBeLessThan(SPAM_THRESHOLD);
    // Together, though, they are decisive — which is the whole design.
    expect(symbols.reduce((sum, s) => sum + s.weight, 0)).toBeGreaterThan(SPAM_THRESHOLD);
  });
});

describe('domainOf', () => {
  it('takes the part after the last @, lowercased', () => {
    expect(domainOf('a@b.example')).toBe('b.example');
    expect(domainOf('A.B@Mail.Shop.CO.UK')).toBe('mail.shop.co.uk');
  });

  it('is empty when there is no domain to take', () => {
    expect(domainOf('')).toBe('');
    expect(domainOf('not-an-address')).toBe('');
  });

  it('strips the punctuation a header leaves behind', () => {
    expect(domainOf('<bounce@list.example>')).toBe('list.example');
    expect(domainOf('a@b.example; ')).toBe('b.example');
  });
});
