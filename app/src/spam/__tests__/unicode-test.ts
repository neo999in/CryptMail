/**
 * The Unicode layer, which exists because two strings that render identically are
 * not the same string.
 *
 * Everything here is a comparison primitive, so the tests are mostly about the
 * boundaries: what folds and what must not. The must-nots matter more. Folding
 * ASCII lookalikes inside prose would make "l1" and "ll" the same word; treating
 * `mail.google.com` and `google.com` as different senders would flag every large
 * organisation's mail; and `lookalikeBrand` firing on a brand's own domain would
 * put a warning banner on real PayPal receipts.
 */
import {
  brandOwnsHost,
  brandsNamedIn,
  domainSkeleton,
  editDistance,
  hasInvisibleCharacters,
  hasMixedScriptWord,
  hasPunycodeLabel,
  lookalikeBrand,
  registrableDomain,
  sameRegistrableDomain,
  skeleton,
  stripInvisible,
} from '../unicode';

/** Zero-width space, zero-width non-joiner, and a right-to-left override. */
const ZWSP = '​';
const ZWNJ = '‌';
const RLO = '‮';

describe('invisible characters', () => {
  it('finds the zero-width characters used to break up a word', () => {
    expect(hasInvisibleCharacters(`p${ZWSP}a${ZWSP}y${ZWSP}p${ZWSP}a${ZWSP}l`)).toBe(true);
    expect(hasInvisibleCharacters(`pay${ZWNJ}pal`)).toBe(true);
    expect(hasInvisibleCharacters('﻿paypal')).toBe(true);
  });

  it('finds the direction overrides used to reverse how a filename displays', () => {
    expect(hasInvisibleCharacters(`invoice${RLO}fdp.exe`)).toBe(true);
  });

  it('finds nothing in ordinary text, including other alphabets', () => {
    expect(hasInvisibleCharacters('Your invoice is ready')).toBe(false);
    expect(hasInvisibleCharacters('')).toBe(false);
    expect(hasInvisibleCharacters('здравствуйте')).toBe(false);
    expect(hasInvisibleCharacters('こんにちは')).toBe(false);
  });

  it('is not stateful — the same string answers the same way twice', () => {
    // A module-level regex with /g and a surviving lastIndex is the classic bug here.
    const text = `pay${ZWSP}pal`;
    expect(hasInvisibleCharacters(text)).toBe(true);
    expect(hasInvisibleCharacters(text)).toBe(true);
  });

  it('strips them, leaving the word a filter can actually match', () => {
    expect(stripInvisible(`p${ZWSP}a${ZWNJ}y${ZWSP}p${ZWSP}a${ZWSP}l`)).toBe('paypal');
    expect(stripInvisible('nothing to strip')).toBe('nothing to strip');
  });
});

describe('hasMixedScriptWord', () => {
  it('flags a Latin word carrying one Cyrillic substitute', () => {
    expect(hasMixedScriptWord('pаypal')).toBe(true); // Cyrillic а
    expect(hasMixedScriptWord('Your аccount is locked')).toBe(true);
  });

  it('flags a Latin word carrying a Greek substitute', () => {
    expect(hasMixedScriptWord('pαyment')).toBe(true); // Greek α
  });

  it('does not flag genuinely multilingual writing', () => {
    // Real multilingual text switches script at word boundaries, not inside a word.
    expect(hasMixedScriptWord('Привет — meeting at three')).toBe(false);
    expect(hasMixedScriptWord('請查看 the attached invoice')).toBe(false);
  });

  it('does not flag ordinary English', () => {
    expect(hasMixedScriptWord('Your invoice is attached')).toBe(false);
    expect(hasMixedScriptWord('')).toBe(false);
  });

  it('ignores tokens too short to judge', () => {
    expect(hasMixedScriptWord('а b')).toBe(false);
  });

  it('sees through zero-width padding', () => {
    expect(hasMixedScriptWord(`p${ZWSP}аypal`)).toBe(true);
  });
});

describe('skeleton', () => {
  it('folds confusables to Latin and lowercases', () => {
    expect(skeleton('PаyPal')).toBe('paypal'); // Cyrillic а
    expect(skeleton('ｐａｙｐａｌ')).toBe('paypal'); // fullwidth
  });

  it('drops invisible characters on the way', () => {
    expect(skeleton(`Pay${ZWSP}Pal`)).toBe('paypal');
  });

  it('does not fold ASCII lookalikes, which would corrupt prose', () => {
    // "l1" and "ll" must stay different words in body text.
    expect(skeleton('paypa1')).toBe('paypa1');
    expect(skeleton('l1')).not.toBe(skeleton('ll'));
  });

  it('leaves text with nothing to fold unchanged', () => {
    expect(skeleton('invoice')).toBe('invoice');
    expect(skeleton('')).toBe('');
  });
});

describe('domainSkeleton', () => {
  it('folds ASCII lookalikes, which is safe for a domain comparison', () => {
    expect(domainSkeleton('paypa1.com')).toBe(domainSkeleton('paypal.com'));
    expect(domainSkeleton('g00gle.com')).toBe(domainSkeleton('google.com'));
  });

  it('folds cross-script confusables the same way', () => {
    expect(domainSkeleton('pаypal.com')).toBe(domainSkeleton('paypal.com')); // Cyrillic а
  });

  it('treats separators as interchangeable, because the eye does', () => {
    expect(domainSkeleton('pay-pal.com')).toBe(domainSkeleton('paypal.com'));
    expect(domainSkeleton('pay_pal.com')).toBe(domainSkeleton('paypal.com'));
  });

  it('keeps genuinely different domains different', () => {
    expect(domainSkeleton('northgate-eng.example')).not.toBe(domainSkeleton('northgate-bank.example'));
  });
});

describe('hasPunycodeLabel', () => {
  it('finds an encoded label wherever it sits', () => {
    expect(hasPunycodeLabel('xn--pypal-4ve.com')).toBe(true);
    expect(hasPunycodeLabel('mail.xn--80ak6aa92e.com')).toBe(true);
    expect(hasPunycodeLabel('XN--PYPAL-4VE.COM')).toBe(true);
  });

  it('does not fire on a host that merely contains those letters', () => {
    expect(hasPunycodeLabel('exn--ample.com')).toBe(false);
    expect(hasPunycodeLabel('example.com')).toBe(false);
    expect(hasPunycodeLabel('')).toBe(false);
  });
});

describe('registrableDomain', () => {
  it('takes the last two labels of an ordinary host', () => {
    expect(registrableDomain('mail.google.com')).toBe('google.com');
    expect(registrableDomain('example.com')).toBe('example.com');
  });

  it('understands the multi-label suffixes that would otherwise be misread', () => {
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('www.hmrc.gov.uk')).toBe('hmrc.gov.uk');
    expect(registrableDomain('a.b.example.com.au')).toBe('example.com.au');
  });

  it('treats each free-hosting site as its own registrable unit', () => {
    // Otherwise every github.io page would read as the same sender, which is
    // exactly the free-hosting phishing case.
    expect(registrableDomain('attacker.github.io')).toBe('attacker.github.io');
    expect(registrableDomain('victim.github.io')).toBe('victim.github.io');
  });

  it('normalises case and a trailing root dot', () => {
    expect(registrableDomain('Mail.Google.COM.')).toBe('google.com');
  });

  it('is empty for input that is not a host', () => {
    expect(registrableDomain('')).toBe('');
    expect(registrableDomain('   ')).toBe('');
    expect(registrableDomain('two words')).toBe('');
  });

  it('handles a bare label without throwing', () => {
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('sameRegistrableDomain', () => {
  it('is true across subdomains of one organisation', () => {
    expect(sameRegistrableDomain('mail.shop.example', 'shop.example')).toBe(true);
    expect(sameRegistrableDomain('a.example.co.uk', 'b.example.co.uk')).toBe(true);
  });

  it('is false for different organisations, including two free-hosting sites', () => {
    expect(sameRegistrableDomain('shop.example', 'shop.test')).toBe(false);
    expect(sameRegistrableDomain('a.github.io', 'b.github.io')).toBe(false);
  });

  it('is false when either side has no registrable domain', () => {
    expect(sameRegistrableDomain('', 'shop.example')).toBe(false);
    expect(sameRegistrableDomain('shop.example', '')).toBe(false);
  });
});

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    expect(editDistance('paypal', 'paypal')).toBe(0);
  });

  it('counts single edits', () => {
    expect(editDistance('paypal', 'paypall')).toBe(1);
    expect(editDistance('paypal', 'paypa')).toBe(1);
    expect(editDistance('paypal', 'paypol')).toBe(1);
  });

  it('gives up past the limit rather than computing a large distance', () => {
    expect(editDistance('paypal', 'northgate')).toBe(4);
    expect(editDistance('a', 'a'.repeat(50))).toBe(4);
  });

  it('respects a caller-supplied limit', () => {
    expect(editDistance('paypal', 'paypallll', 1)).toBe(2);
    expect(editDistance('paypal', 'paypallll', 5)).toBe(3);
  });

  it('handles empty strings', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('lookalikeBrand', () => {
  it('never fires on a brand’s own domain, which is the whole point of the table', () => {
    for (const host of [
      'paypal.com',
      'www.paypal.com',
      'service.paypal.co.uk',
      'mail.google.com',
      'amazon.co.uk',
      'no-reply.microsoftonline.com',
      'hmrc.gov.uk',
    ]) {
      expect(lookalikeBrand(host)).toBeNull();
    }
  });

  it('reports a digit-swap spelling as a confusable', () => {
    expect(lookalikeBrand('paypa1.com')).toEqual({ brand: 'paypal', host: 'paypa1.com', reason: 'confusable' });
  });

  it('reports a Cyrillic homoglyph as a confusable', () => {
    expect(lookalikeBrand('pаypal.com')?.reason).toBe('confusable');
  });

  it('reports a one-letter misspelling as a near-miss', () => {
    expect(lookalikeBrand('paypall.com')).toEqual({ brand: 'paypal', host: 'paypall.com', reason: 'near-miss' });
  });

  it('reports the brand smuggled into somebody else’s domain as embedded', () => {
    expect(lookalikeBrand('paypal.account-verify.example')?.reason).toBe('embedded');
    expect(lookalikeBrand('login.microsoft.secure-mail.example')?.reason).toBe('embedded');
  });

  it('reports the brand hyphenated into a registrable label as embedded', () => {
    expect(lookalikeBrand('paypal-security.example')?.reason).toBe('embedded');
  });

  it('says nothing about ordinary domains that share a few letters', () => {
    for (const host of [
      'northgate-eng.example',
      'shop.example',
      'weekly.example',
      'apples-and-pears.example',
      'partner.com',
      'lee.legal',
    ]) {
      expect(lookalikeBrand(host)).toBeNull();
    }
  });

  it('does not fire on a short brand name, where one edit is not evidence', () => {
    // `ups`, `irs`, `dhl` and `wise` are one edit from ordinary words. At 3.2
    // points a false hit there would be the largest unjustified weight the engine
    // can produce, so near-miss matching requires five characters on both sides.
    expect(lookalikeBrand('ip.example')).toBeNull();
    expect(lookalikeBrand('ups2.example')).toBeNull();
    expect(lookalikeBrand('wisely.example')).toBeNull();
    expect(lookalikeBrand('irish.example')).toBeNull();
  });

  it('still catches a near-miss of a long brand name', () => {
    expect(lookalikeBrand('paypall.example')?.reason).toBe('near-miss');
    expect(lookalikeBrand('micosoft.example')?.reason).toBe('near-miss');
  });

  it('says nothing about input that is not a host', () => {
    expect(lookalikeBrand('')).toBeNull();
    expect(lookalikeBrand('   ')).toBeNull();
    expect(lookalikeBrand('not a host')).toBeNull();
  });
});

describe('brandsNamedIn', () => {
  it('finds a brand in a display name', () => {
    expect(brandsNamedIn('PayPal Service')).toContain('paypal');
    expect(brandsNamedIn('Microsoft Account Team')).toContain('microsoft');
  });

  it('sees through confusables and separators', () => {
    expect(brandsNamedIn('PаyPal')).toContain('paypal'); // Cyrillic а
    expect(brandsNamedIn('Pay-Pal Security')).toContain('paypal');
    expect(brandsNamedIn(`Pay${ZWSP}Pal`)).toContain('paypal');
  });

  it('finds every brand a name claims', () => {
    expect(brandsNamedIn('Apple and Amazon')).toEqual(expect.arrayContaining(['apple', 'amazon']));
  });

  it('finds nothing in a name that claims nothing', () => {
    expect(brandsNamedIn('Priya Raman')).toEqual([]);
    expect(brandsNamedIn('')).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Words, not substrings. Folding a display name to `[a-z0-9]` and asking
  // `includes` finds a brand inside ordinary English — `steam` across the break
  // in "Rewards Team", `irs` inside "First", `chase` inside "Purchase", `ups`
  // inside "Groups" and "Startups", `wise` inside "Otherwise" — and each hit is
  // worth 2.8 phishing points, or 3.4 from a freemail address.
  // ---------------------------------------------------------------------------

  it('does not read a brand out of an ordinary phrase spanning a word break', () => {
    expect(brandsNamedIn('Rewards Team')).toEqual([]); // ...ards Team → "steam"
    expect(brandsNamedIn('Prize Team')).toEqual([]);
    expect(brandsNamedIn('Shop Weekly')).toEqual([]);
  });

  it('does not read a brand out of the inside of a longer word', () => {
    expect(brandsNamedIn('First National Bank')).toEqual([]); // f-IRS-t
    expect(brandsNamedIn('Purchase Support')).toEqual([]); // pur-CHASE
    expect(brandsNamedIn('Groups Digest')).toEqual([]); // gro-UPS
    expect(brandsNamedIn('Startups Weekly')).toEqual([]);
    expect(brandsNamedIn('Otherwise Studio')).toEqual([]); // other-WISE
    expect(brandsNamedIn('Chasewater Angling')).toEqual([]);
    expect(brandsNamedIn('Steamboat Springs News')).toEqual([]);
    expect(brandsNamedIn('Appleton Dental')).toEqual([]);
    expect(brandsNamedIn('Stripes and Checks')).toEqual([]);
    expect(brandsNamedIn('Upstate Records')).toEqual([]);
  });

  it('still finds a brand run together with a role word or a number', () => {
    // The forms a phisher writes when a space would break their spoof.
    expect(brandsNamedIn('PayPalSupport')).toEqual(['paypal']);
    expect(brandsNamedIn('microsoft365 billing')).toEqual(['microsoft']);
    expect(brandsNamedIn('AmazonSecurity')).toEqual(['amazon']);
  });

  it('still finds a short brand written as its own word', () => {
    // The short names are the ones the substring bug punished hardest, so the
    // legitimate direction has to keep working: these are the real impersonations.
    expect(brandsNamedIn('UPS Tracking')).toEqual(['ups']);
    expect(brandsNamedIn('IRS Refund Dept')).toEqual(['irs']);
    expect(brandsNamedIn('DHL Express')).toEqual(['dhl']);
  });
});

describe('brandOwnsHost', () => {
  it('is true for a brand’s own domains and their subdomains', () => {
    expect(brandOwnsHost('paypal', 'paypal.com')).toBe(true);
    expect(brandOwnsHost('paypal', 'service.paypal.co.uk')).toBe(true);
    expect(brandOwnsHost('google', 'mail.googlemail.com')).toBe(true);
  });

  it('is false for a domain the brand does not own', () => {
    expect(brandOwnsHost('paypal', 'paypa1.com')).toBe(false);
    expect(brandOwnsHost('paypal', 'gmail.com')).toBe(false);
  });

  it('is false for a brand it has never heard of', () => {
    expect(brandOwnsHost('northgate', 'northgate.example')).toBe(false);
  });
});
