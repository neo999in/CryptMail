/**
 * What the envelope says, and whether it is internally consistent.
 *
 * Header analysis is the strongest part of a client-side filter, and it is the
 * part that separates phishing from bulk mail. The content of a phishing message
 * is *designed* to look legitimate — that is the whole craft — but the headers
 * have to carry a real sending domain, and a real sending domain either
 * authenticates for the brand it claims or it does not.
 *
 * ## The rule this module is written around
 *
 * **Missing is not failing.** A message with no `Authentication-Results` at all is
 * the normal case for mail that arrived by a path that did not stamp one, for a
 * provider that does not stamp one, and for every message in CryptMail's demo
 * mode. Treating absence as failure would classify a large fraction of ordinary
 * mail as suspicious, so absence contributes exactly nothing: no symbol, no
 * weight. Only an explicit `dmarc=fail` is evidence.
 *
 * The same reasoning applies throughout. `Reply-To` pointing somewhere else is
 * suspicious; `Reply-To` being absent is the overwhelming majority of real mail.
 *
 * ## Why the weights look timid
 *
 * Against a threshold of 5.0, almost nothing here can classify a message alone.
 * A DMARC failure is 3.5, which is a lot of evidence and still not a verdict —
 * because legitimate mail forwarded through a mailing list breaks DMARC as a
 * matter of routine, and a filter that did not know that would eat its user's
 * list traffic. What crosses the line is a *combination*: DMARC fails **and** the
 * display name claims a bank **and** the reply address is somewhere else.
 *
 * Nothing here parses attacker-controlled markup, follows anything, or resolves
 * anything over the network. It reads strings that are already on the device.
 */
import { parseAddress } from '../lib/format';
import type { SpamInput, SpamSymbol } from './types';
import {
  brandOwnsHost,
  brandsNamedIn,
  hasPunycodeLabel,
  lookalikeBrand,
  registrableDomain,
  sameRegistrableDomain,
  skeleton,
} from './unicode';

/** One `method=result` pair from an `Authentication-Results` header. */
export type AuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'unknown';

export type AuthVerdicts = {
  spf: AuthResult | null;
  dkim: AuthResult | null;
  dmarc: AuthResult | null;
  /** True when the header was present but nothing could be read out of it. */
  malformed: boolean;
};

const KNOWN_RESULTS: AuthResult[] = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror'];

/**
 * Read SPF/DKIM/DMARC out of an `Authentication-Results` header.
 *
 * RFC 8601 allows comments, quoted strings, `header.d=` properties and multiple
 * `authserv-id` sections, and real-world headers use all of it. Rather than
 * implement the grammar, this scans for `method=result` tokens — which is what
 * SpamAssassin's own `AskDNS`/`AuthRes` plugins effectively do, and which cannot
 * throw on input it does not understand.
 *
 * `null` for a method means "the header did not say", which is not the same as
 * `'none'` (the header explicitly said no policy was found).
 */
export function parseAuthResults(header?: string): AuthVerdicts {
  const empty: AuthVerdicts = { spf: null, dkim: null, dmarc: null, malformed: false };
  if (typeof header !== 'string') return empty;
  const text = header.trim();
  if (!text) return empty;

  // Comments in parentheses may themselves contain `=`, so they go first.
  const stripped = text.replace(/\([^)]*\)/g, ' ').toLowerCase();

  const read = (method: string): AuthResult | null => {
    const match = stripped.match(new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`));
    if (!match) return null;
    const value = match[1];
    return (KNOWN_RESULTS as string[]).includes(value) ? (value as AuthResult) : 'unknown';
  };

  const verdicts: AuthVerdicts = {
    spf: read('spf'),
    dkim: read('dkim'),
    dmarc: read('dmarc'),
    malformed: false,
  };
  // Present, non-empty, and not one recognisable pair: the sender wrote something
  // that is not an Authentication-Results header. Worth noticing, not worth much.
  verdicts.malformed = verdicts.spf === null && verdicts.dkim === null && verdicts.dmarc === null;
  return verdicts;
}

/**
 * TLDs where the ratio of abuse to legitimate mail is high enough to be a signal.
 *
 * A weak signal on purpose, and one that can never classify alone: real businesses
 * do use `.xyz` and `.top`. It is here to add half a point to a message that is
 * already suspicious for other reasons.
 */
const RISKY_TLDS = new Set([
  'tk', 'ml', 'ga', 'cf', 'gq', 'top', 'xyz', 'click', 'link', 'work', 'loan',
  'review', 'country', 'stream', 'download', 'racing', 'win', 'bid', 'kim',
  'monster', 'quest', 'sbs', 'cyou', 'icu', 'buzz', 'fit', 'host', 'casa',
  'uno', 'autos', 'boats', 'mom', 'lol', 'makeup', 'hair', 'skin', 'beauty',
  'zip', 'mov', 'rest', 'bar', 'cam', 'surf', 'gdn', 'men', 'date', 'faith',
]);

/**
 * Providers anyone can sign up with in a minute.
 *
 * Not suspicious in itself — most of the world's mail comes from these — but a
 * message whose *display name* is a bank and whose *domain* is one of these is a
 * complete phishing signature on its own.
 */
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.in',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com',
  'me.com', 'mail.com', 'gmx.com', 'gmx.de', 'yandex.com', 'yandex.ru',
  'protonmail.com', 'proton.me', 'zoho.com', 'rediffmail.com', 'inbox.lv',
  'mail.ru', 'qq.com', '163.com', '126.com', 'naver.com', 'daum.net',
  'tutanota.com', 'hushmail.com', 'fastmail.com',
]);

/** The domain part of an address, lowercased. `''` when there isn't one. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at === -1) return '';
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[>,;\s]+$/, '');
}

/** Whether a string looks like a single deliverable address. */
const looksLikeAddress = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

/**
 * Header and authentication symbols for one message.
 *
 * Every branch is guarded: `input.headers` may be absent, each field may be
 * absent, and any of them may hold something that is not what its name suggests.
 * A malformed header produces no symbol rather than an exception, because the
 * inbox renders these verdicts and a throw here would be a blank screen.
 */
export function headerSymbols(input: SpamInput): SpamSymbol[] {
  const out: SpamSymbol[] = [];
  const headers = input.headers ?? {};

  const fromAddress = (input.from?.address ?? '').trim().toLowerCase();
  const fromDomain = domainOf(fromAddress);
  const fromRegistrable = fromDomain ? registrableDomain(fromDomain) : '';
  const displayName = (input.from?.name ?? '').trim();

  /* ------------------------------------------------------ authentication ---- */

  const auth = parseAuthResults(headers.authenticationResults);

  // DMARC is the one that matters: it is the check that ties the *visible* From
  // domain to an authenticated identity, which is exactly what a phisher must
  // break. SPF and DKIM can each fail on legitimate mail (forwarding breaks SPF;
  // a list footer breaks DKIM) as long as the other one aligns.
  if (auth.dmarc === 'fail') {
    out.push({
      name: 'AUTH_DMARC_FAIL',
      weight: 3.5,
      kind: 'phishing',
      detail: 'The sender’s domain says this message should have been rejected (DMARC failed).',
    });
  } else if (auth.dmarc === 'pass') {
    out.push({
      name: 'AUTH_DMARC_PASS',
      weight: -1.2,
      kind: 'ham',
      // Counts against the phishing score as well as the total: phishing is
      // impersonation, and this is the one signal that positively rules it out
      // for the visible From domain. See `SpamSymbol.counterPhishing`.
      counterPhishing: true,
      detail: 'The sending domain is authenticated (DMARC passed).',
    });
  }

  // SPF and DKIM are only scored when DMARC did **not** state a verdict.
  //
  // They are not independent evidence: DMARC *is* the alignment check over these
  // two, so `dmarc=fail` already reports that neither mechanism aligned, and
  // adding their weights on top charges a message three times for one fact.
  // 3.5 + 1.6 + 1.4 = 6.5, past the phishing bar — which would make a broken
  // signature a verdict on its own and contradict this module's whole premise,
  // most damagingly for the mailing-list traffic that breaks all three as a
  // matter of routine (the list's servers break SPF, its footer breaks DKIM,
  // and DMARC therefore fails).
  //
  // `dmarc=pass` is the mirror image: alignment held through whichever mechanism
  // did pass, so the other one failing is the ordinary signature of forwarded
  // mail and says nothing. Only when the domain publishes no policy — DMARC
  // absent, `none`, or unreadable — are SPF and DKIM the best evidence there is,
  // and then they are scored.
  const dmarcSpoke = auth.dmarc === 'fail' || auth.dmarc === 'pass';

  if (!dmarcSpoke) {
    if (auth.spf === 'fail') {
      out.push({ name: 'AUTH_SPF_FAIL', weight: 1.6, kind: 'phishing', detail: 'The sending server is not authorised for this domain (SPF failed).' });
    } else if (auth.spf === 'softfail') {
      out.push({ name: 'AUTH_SPF_SOFTFAIL', weight: 0.6, kind: 'spam' });
    }

    if (auth.dkim === 'fail') {
      out.push({ name: 'AUTH_DKIM_FAIL', weight: 1.4, kind: 'phishing', detail: 'The message signature did not verify (DKIM failed).' });
    }
  }

  if (auth.spf === 'pass' && auth.dkim === 'pass' && auth.dmarc !== 'fail') {
    out.push({
      name: 'AUTH_SPF_DKIM_PASS',
      weight: -0.8,
      kind: 'ham',
      counterPhishing: true,
      detail: 'Both SPF and DKIM passed.',
    });
  }

  // Present but unreadable. A tenth of a point: it says the header is odd, and
  // odd headers are weakly correlated with bulk senders. It says nothing about
  // authentication, so it must not be scored as a failure.
  if (auth.malformed) {
    out.push({ name: 'AUTH_RESULTS_MALFORMED', weight: 0.3, kind: 'spam' });
  }

  /* ------------------------------------------------------------- addresses ---- */

  // A From that is not an address at all. Real senders manage this.
  if (fromAddress && !looksLikeAddress(fromAddress)) {
    out.push({ name: 'FROM_MALFORMED', weight: 1.5, kind: 'spam', detail: 'The sender address is not a valid email address.' });
  }

  if (headers.replyTo) {
    // `Reply-To` may be a list; the first address is the one a reply reaches.
    const replyTo = parseAddress(headers.replyTo.split(',')[0] ?? '').address;
    const replyDomain = domainOf(replyTo);
    if (replyDomain && fromDomain && !sameRegistrableDomain(replyDomain, fromDomain)) {
      // Freemail as the reply target for a non-freemail sender is the specific
      // pattern in business-email-compromise: the mail looks like it comes from
      // the company, the reply goes to the attacker's mailbox.
      const toFreemail = FREEMAIL_DOMAINS.has(registrableDomain(replyDomain));
      out.push({
        name: toFreemail ? 'REPLY_TO_FREEMAIL_MISMATCH' : 'REPLY_TO_MISMATCH',
        weight: toFreemail ? 2.6 : 1.4,
        kind: 'phishing',
        detail: `Replies would go to ${replyDomain}, not ${fromDomain}.`,
      });
    }
  }

  // `Return-Path` and `Message-ID` on a domain other than the sender's are weak
  // *proxies* for "did this domain really send the message". When DMARC has
  // answered that question directly, the proxies say nothing and must not be
  // charged for: every mail sent through an ESP — which is most legitimate bulk
  // and transactional mail there is — bounces to the ESP and stamps its
  // `Message-ID` there, aligning through DKIM while the envelope belongs to the
  // relay. Scoring that would put a standing 0.9 on the largest single class of
  // ordinary mail. Same principle as the SPF/DKIM block above.
  if (auth.dmarc !== 'pass') {
    if (headers.returnPath) {
      const bounce = domainOf(parseAddress(headers.returnPath).address);
      // Every mailing list and every ESP legitimately bounces to its own domain, so
      // this is worth a fraction of a point and only in combination.
      if (bounce && fromDomain && !sameRegistrableDomain(bounce, fromDomain)) {
        out.push({ name: 'RETURN_PATH_MISMATCH', weight: 0.5, kind: 'spam' });
      }
    }

    if (headers.messageId) {
      const idDomain = domainOf(headers.messageId.replace(/[<>]/g, ''));
      if (idDomain && fromDomain && !sameRegistrableDomain(idDomain, fromDomain)) {
        out.push({ name: 'MESSAGE_ID_MISMATCH', weight: 0.4, kind: 'spam' });
      }
    }
  }

  /* -------------------------------------------------------- impersonation ---- */

  // A display name that is itself an address, different from the real sender:
  // `"billing@paypal.com" <random@mailer.example>` renders as PayPal in every
  // mail client's list view.
  if (displayName && looksLikeAddress(displayName)) {
    const claimed = domainOf(displayName.toLowerCase());
    if (claimed && fromDomain && !sameRegistrableDomain(claimed, fromDomain)) {
      out.push({
        name: 'DISPLAY_NAME_SPOOFS_ADDRESS',
        weight: 3.0,
        kind: 'phishing',
        detail: `The sender is shown as ${displayName} but the message came from ${fromDomain}.`,
      });
    }
  }

  // A brand in the display name that the sending domain does not own. This is the
  // single most common phishing shape, and the `brandOwnsHost` check is what keeps
  // real PayPal mail from tripping it.
  if (displayName && fromDomain) {
    for (const brand of brandsNamedIn(displayName)) {
      if (brandOwnsHost(brand, fromDomain)) continue;
      const freemail = FREEMAIL_DOMAINS.has(fromRegistrable);
      out.push({
        name: freemail ? 'BRAND_NAME_FROM_FREEMAIL' : 'BRAND_NAME_WRONG_DOMAIN',
        weight: freemail ? 3.4 : 2.8,
        kind: 'phishing',
        detail: `Signed “${displayName}” but sent from ${fromDomain}.`,
      });
      break;
    }
  }

  // The sending domain itself imitating a brand.
  if (fromDomain) {
    const hit = lookalikeBrand(fromDomain);
    if (hit) {
      const weight = hit.reason === 'confusable' ? 4.0 : hit.reason === 'near-miss' ? 3.2 : 2.6;
      out.push({
        name: 'FROM_LOOKALIKE_DOMAIN',
        weight,
        kind: 'phishing',
        detail: `${fromDomain} imitates ${hit.brand}.`,
      });
    }
    if (hasPunycodeLabel(fromDomain)) {
      out.push({
        name: 'FROM_PUNYCODE_DOMAIN',
        weight: 1.8,
        kind: 'phishing',
        detail: 'The sender’s domain is written in an encoded alphabet that can imitate other names.',
      });
    }
    const tld = fromRegistrable.split('.').pop() ?? '';
    if (RISKY_TLDS.has(tld)) {
      out.push({ name: 'FROM_RISKY_TLD', weight: 0.9, kind: 'spam', detail: `Sent from a .${tld} domain.` });
    }
    // `secure-account-verify-login.example` — a domain assembled out of the words
    // of the pretext. Four or more hyphenated parts is not how businesses name
    // themselves.
    const label = fromRegistrable.split('.')[0] ?? '';
    if (label.split('-').filter(Boolean).length >= 4) {
      out.push({ name: 'FROM_DOMAIN_MANY_PARTS', weight: 0.8, kind: 'spam' });
    }
    // A throwaway label: long, and mostly consonants or digits.
    if (label.length >= 12 && /^[a-z0-9-]+$/.test(label) && !/[aeiou]{1}/.test(label.replace(/[^a-z]/g, '').slice(0, 8))) {
      out.push({ name: 'FROM_DOMAIN_RANDOM', weight: 0.8, kind: 'spam' });
    }
  }

  // The user's own address as the sender. Legitimate for notes-to-self, so it only
  // scores when authentication did not back it up — which is the actual attack:
  // "your account has been accessed", apparently from you.
  const self = (input.selfAddress ?? '').trim().toLowerCase();
  if (self && fromAddress && fromAddress === self && auth.dmarc !== 'pass') {
    out.push({
      name: 'FROM_SELF_UNAUTHENTICATED',
      weight: 2.2,
      kind: 'phishing',
      detail: 'The message claims to come from your own address but is not authenticated.',
    });
  }
  // A sender that imitates the user's own domain — the colleague-impersonation
  // shape, and the reason `selfAddress` is part of the input at all.
  if (self && fromDomain) {
    const selfDomain = registrableDomain(domainOf(self));
    if (
      selfDomain &&
      fromRegistrable !== selfDomain &&
      !FREEMAIL_DOMAINS.has(selfDomain) &&
      skeleton(fromRegistrable).replace(/[-_.]/g, '') === skeleton(selfDomain).replace(/[-_.]/g, '')
    ) {
      out.push({
        name: 'FROM_LOOKALIKE_OF_SELF',
        weight: 3.4,
        kind: 'phishing',
        detail: `${fromDomain} imitates your own domain ${selfDomain}.`,
      });
    }
  }

  /* --------------------------------------------------------------- hygiene ---- */

  // Unsubscribe headers are a legal requirement for bulk senders and a nuisance
  // for spammers, so their presence is mild evidence of legitimacy. It is *mild*:
  // sophisticated spam includes one.
  if (headers.listUnsubscribe) {
    out.push({ name: 'HAS_LIST_UNSUBSCRIBE', weight: -0.7, kind: 'ham', detail: 'The message includes a standard unsubscribe header.' });
  }

  // Nobody in the To or Cc line. Normal for BCC'd mail, and normal for bulk mail
  // that hides its recipient list, so a fraction of a point.
  //
  // Only when the field was *supplied* and turned out to be empty. An absent
  // `to` is missing information — a connector that does not populate it, or a
  // caller scoring bare text — and missing information is never evidence, which
  // is the same rule the authentication block above follows.
  const supplied = Array.isArray(input.to);
  const recipients = (input.to ?? []).filter((value) => typeof value === 'string' && value.trim() !== '');
  if (supplied && recipients.length === 0) {
    out.push({ name: 'NO_VISIBLE_RECIPIENT', weight: 0.4, kind: 'spam' });
  } else if (self && recipients.length === 1 && recipients[0].trim().toLowerCase() !== self) {
    // Addressed to someone else entirely, and it still arrived — bulk mail with a
    // hidden recipient list.
    const only = recipients[0].trim().toLowerCase();
    if (looksLikeAddress(only)) out.push({ name: 'RECIPIENT_NOT_SELF', weight: 0.5, kind: 'spam' });
  }

  return out;
}
