/**
 * What the message says, and how it says it.
 *
 * ## The constraint this module exists to satisfy
 *
 * The specification is explicit: a message must **not** be classified because it
 * contains *account*, *verify*, *payment*, *login*, *password* or *security*.
 * Those words are in every password-reset mail, every bank statement, every
 * receipt and every legitimate security notice a user will ever receive. A filter
 * that scored them would be worse than no filter, because it would fail on
 * exactly the mail that matters most.
 *
 * So no single word scores here. Content evidence is built two ways instead:
 *
 * 1. **Co-occurrence across categories.** Words are grouped into intent families
 *    — urgency, threat, credential-solicitation, money, prize, secrecy. A single
 *    family firing is worth nothing. `URGENCY + CREDENTIAL` together is a
 *    recognisable shape ("your account will be closed in 24 hours, confirm your
 *    password"), and *that* is what earns weight. `CREDENTIAL` alone, which is
 *    what a real password-reset mail looks like, earns nothing at all.
 *
 * 2. **Form rather than vocabulary.** Shouting, exclamation runs, invisible
 *    characters, mixed scripts and hidden text are properties of how a message is
 *    written. They are largely independent of what it claims to be about, so they
 *    survive paraphrase — and unlike a keyword, a legitimate sender's use of them
 *    is genuinely unusual.
 *
 * Everything is matched against the *skeleton* as well as the raw text, so
 * inserting a zero-width space into a word buys nothing.
 */
import type { SpamInput, SpamSymbol } from './types';
import { words } from './tokenize';
import { hasInvisibleCharacters, hasMixedScriptWord, skeleton } from './unicode';

/** Body text beyond this is not read. Matches the tokenizer's cap. */
const MAX_SCAN_CHARS = 20_000;

/**
 * Intent families.
 *
 * Each is a list of phrases and words that indicate one *purpose*. The families
 * are what get combined; the entries within a family are alternatives, so adding a
 * synonym never makes a message score higher on its own.
 */
const FAMILIES = {
  /** "Do this now or lose something." */
  urgency: [
    'urgent', 'immediately', 'right away', 'within 24 hours', 'within 48 hours',
    'expires today', 'expire today', 'expires tomorrow', 'last chance',
    'final notice', 'final warning', 'last warning', 'act now', 'act fast',
    'immediate action', 'action required', 'urgent action', 'time sensitive',
    'do not delay', 'without delay', 'as soon as possible', 'limited time',
    'hurry', 'expiring soon', 'deadline', 'before it is too late', 'today only',
  ],
  /** "Something bad happens if you do not." */
  threat: [
    'suspended', 'suspension', 'terminated', 'termination', 'deactivated',
    'deactivation', 'closed permanently', 'will be closed', 'will be deleted',
    'will be locked', 'has been locked', 'restricted', 'on hold', 'blocked',
    'unauthorised access', 'unauthorized access', 'unusual activity',
    'suspicious activity', 'unusual sign in', 'unusual sign-in', 'legal action',
    'law enforcement', 'penalty', 'fine', 'court', 'lawsuit', 'permanently lose',
    'lose access', 'losing access', 'violation', 'breach of', 'compromised',
  ],
  /** "Give me your credentials." Never scored alone — see the module note. */
  credential: [
    'verify your account', 'verify your identity', 'confirm your identity',
    'confirm your account', 'update your account', 'validate your account',
    'reactivate your account', 'restore your account', 'unlock your account',
    'confirm your password', 'enter your password', 'update your password',
    'verify your password', 'confirm your login', 'sign in to verify',
    'log in to verify', 'click here to verify', 'click here to login',
    'click to verify', 'verify now', 'confirm now', 'update now',
    'enter your credentials', 'provide your password', 'send your password',
    'your login details', 'your account details', 'security question',
    'one time password', 'otp code', 'authentication code', 'verification code',
    'two factor code', 'seed phrase', 'recovery phrase', 'private key',
    'wallet key', 'card number', 'cvv', 'pin number', 'social security number',
    'national insurance number', 'date of birth to confirm',
  ],
  /** "Move money." */
  money: [
    'wire transfer', 'bank transfer', 'western union', 'moneygram',
    'gift card', 'gift cards', 'itunes card', 'steam card', 'bitcoin',
    'btc wallet', 'ethereum', 'usdt', 'crypto wallet', 'cryptocurrency',
    'send payment', 'make a payment', 'payment is required', 'processing fee',
    'transfer fee', 'clearance fee', 'customs fee', 'release fee',
    'outstanding balance of', 'overdue payment of', 'unpaid invoice',
    'refund of', 'tax refund', 'claim your refund', 'reimbursement',
    'inheritance', 'next of kin', 'unclaimed funds', 'beneficiary',
    'million dollars', 'million usd', 'investment opportunity',
    'guaranteed return', 'guaranteed income', 'double your money',
    'high return', 'roi guaranteed', 'no risk investment',
  ],
  /** "You have won." */
  prize: [
    'you have won', 'you won', 'congratulations you', 'lucky winner',
    'lottery winner', 'prize winner', 'selected winner', 'you are a winner',
    'claim your prize', 'claim your reward', 'claim your gift',
    'free gift card', 'free iphone', 'free vacation', 'free cruise',
    'risk free', 'no cost to you', 'absolutely free', '100% free',
    'you have been selected', 'randomly selected', 'sweepstakes',
    'cash prize', 'jackpot', 'bonus reward', 'exclusive winner',
  ],
  /** "Do not tell anyone." Rare in legitimate mail and strong in fraud. */
  secrecy: [
    'keep this confidential', 'strictly confidential', 'do not tell anyone',
    'do not share this', 'between us', 'keep it between', 'do not inform',
    'discreet', 'discretion is required', 'do not reply to this email with',
    'delete this email after', 'this must remain private',
  ],
  /** "Reply outside your normal channel." Business-email-compromise shape. */
  channel: [
    'reply to this email with', 'send me your', 'text me at', 'whatsapp me',
    'call this number', 'contact me on', 'reach me at my personal',
    'my new email', 'use this alternate email', 'i am in a meeting',
    'i cannot talk right now', 'do not call me', 'email me back with',
  ],
} as const;

type Family = keyof typeof FAMILIES;

/** Which families a piece of text hits, and how many distinct entries in each. */
function familyHits(haystacks: string[]): Map<Family, number> {
  const hits = new Map<Family, number>();
  for (const [family, entries] of Object.entries(FAMILIES) as [Family, readonly string[]][]) {
    let count = 0;
    for (const entry of entries) {
      if (haystacks.some((text) => text.includes(entry))) count += 1;
    }
    if (count > 0) hits.set(family, count);
  }
  return hits;
}

/**
 * The pairings that mean something, and what they are worth.
 *
 * Read as: *this combination is the recognisable shape of an attack, in a way
 * neither half is on its own.* The weights are deliberately below the 5.0
 * threshold — even the strongest pairing needs one more signal from the headers,
 * the links or the model to reach a verdict.
 */
const COMBINATIONS: { pair: [Family, Family]; name: string; weight: number; kind: 'spam' | 'phishing'; detail: string }[] = [
  {
    pair: ['urgency', 'credential'],
    name: 'CONTENT_URGENT_CREDENTIAL',
    weight: 3.4,
    kind: 'phishing',
    detail: 'The message pressures you to confirm account details quickly.',
  },
  {
    pair: ['threat', 'credential'],
    name: 'CONTENT_THREAT_CREDENTIAL',
    weight: 3.6,
    kind: 'phishing',
    detail: 'The message threatens your account and asks you to confirm details.',
  },
  {
    pair: ['urgency', 'threat'],
    name: 'CONTENT_URGENT_THREAT',
    weight: 2.0,
    kind: 'phishing',
    detail: 'The message warns of losing access unless you act immediately.',
  },
  {
    pair: ['threat', 'money'],
    name: 'CONTENT_THREAT_MONEY',
    weight: 2.8,
    kind: 'spam',
    detail: 'The message demands a payment to avoid a consequence.',
  },
  {
    pair: ['urgency', 'money'],
    name: 'CONTENT_URGENT_MONEY',
    weight: 2.4,
    kind: 'spam',
    detail: 'The message asks for a payment or transfer under time pressure.',
  },
  {
    pair: ['prize', 'money'],
    name: 'CONTENT_PRIZE_MONEY',
    weight: 3.2,
    kind: 'spam',
    detail: 'The message offers winnings and involves a payment or transfer.',
  },
  {
    pair: ['prize', 'urgency'],
    name: 'CONTENT_PRIZE_URGENT',
    weight: 2.6,
    kind: 'spam',
    detail: 'The message claims you have won something and must claim it now.',
  },
  {
    pair: ['secrecy', 'money'],
    name: 'CONTENT_SECRET_MONEY',
    weight: 3.4,
    kind: 'phishing',
    detail: 'The message asks you to move money and keep it confidential.',
  },
  {
    pair: ['secrecy', 'urgency'],
    name: 'CONTENT_SECRET_URGENT',
    weight: 2.4,
    kind: 'phishing',
    detail: 'The message asks for secrecy and urgency together.',
  },
  {
    pair: ['channel', 'money'],
    name: 'CONTENT_CHANNEL_MONEY',
    weight: 3.0,
    kind: 'phishing',
    detail: 'The message asks you to move money through a different channel.',
  },
  {
    pair: ['channel', 'credential'],
    name: 'CONTENT_CHANNEL_CREDENTIAL',
    weight: 2.8,
    kind: 'phishing',
    detail: 'The message asks you to send account details by reply.',
  },
];

/**
 * Content symbols for one message.
 *
 * Subject and body are scanned as one haystack for family matching — a pretext
 * split across the two ("Account suspended" / "confirm your password below") is
 * the same pretext — but the *form* checks treat them separately, because a
 * shouted subject and a shouted body are different behaviours.
 */
export function contentSymbols(input: SpamInput): SpamSymbol[] {
  const out: SpamSymbol[] = [];

  const subject = typeof input.subject === 'string' ? input.subject.slice(0, 1000) : '';
  const body = typeof input.body === 'string' ? input.body.slice(0, MAX_SCAN_CHARS) : '';
  if (!subject && !body) return out;

  const raw = `${subject}\n${body}`.toLowerCase();
  const folded = skeleton(`${subject}\n${body}`);
  const haystacks = folded === raw ? [raw] : [raw, folded];

  /* -------------------------------------------------------------- families ---- */

  const hits = familyHits(haystacks);

  // **One combination symbol per message: the heaviest that fired.**
  //
  // The pairings are drawn from the same family hits, so three families produce
  // three pairings, four produce six, and the score grows quadratically in the
  // evidence rather than linearly. Urgency + threat + credential is *one*
  // observation — "your access is at risk, act now, confirm your details" — and
  // charging it 3.6 + 3.4 + 2.0 = 9.0 puts it past the phishing bar on wording
  // alone. That is exactly what this module exists not to do, and it lands on
  // legitimate mail first: a corporate password-expiry notice and a bank's own
  // fraud alert are both written in precisely those three families.
  //
  // So the strongest pairing is the one that scores, and the breadth of the
  // pretext is reported separately by `CONTENT_MANY_PRETEXTS` below — one symbol
  // for the shape, one for how wide it is, neither of them a verdict.
  const matched = COMBINATIONS.filter(({ pair }) => hits.has(pair[0]) && hits.has(pair[1]));
  const strongest = matched.reduce<(typeof COMBINATIONS)[number] | null>(
    (best, candidate) => (best === null || candidate.weight > best.weight ? candidate : best),
    null,
  );
  if (strongest) {
    out.push({ name: strongest.name, weight: strongest.weight, kind: strongest.kind, detail: strongest.detail });
  }

  // Breadth *beyond* the pairing already charged above.
  //
  // Four, not three: the strongest pairing accounts for two families on its own,
  // so three families is that pairing plus one — the ordinary shape of a genuine
  // security notice, which is urgency and a threat and a request to confirm
  // something. Charging it here would be charging the same wording twice, and
  // 3.6 + 1.6 lands a bank's own fraud alert on the spam threshold with nothing
  // from the headers or the links involved at all. Four distinct families is a
  // message assembled out of pretexts rather than one written about a real event.
  if (hits.size >= 4) {
    out.push({
      name: 'CONTENT_MANY_PRETEXTS',
      weight: 1.6,
      kind: 'spam',
      detail: 'The message combines several classic pressure tactics.',
    });
  }

  // Saturation within one family: eight different money phrases is an advance-fee
  // letter, not a mail that happens to mention a payment.
  for (const [family, count] of hits) {
    if (count >= 6) {
      out.push({
        name: `CONTENT_${family.toUpperCase()}_HEAVY`,
        weight: 1.4,
        kind: family === 'credential' || family === 'secrecy' || family === 'channel' ? 'phishing' : 'spam',
      });
    }
  }

  /* ------------------------------------------------------------------ form ---- */

  if (subject) {
    const letters = subject.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 8) {
      const upper = (subject.match(/[A-Z]/g) ?? []).length / letters.length;
      if (upper > 0.7) {
        out.push({ name: 'SUBJECT_ALL_CAPS', weight: 1.2, kind: 'spam', detail: 'The subject line is written in capitals.' });
      }
    }
    if (/[!?]{3,}/.test(subject)) {
      out.push({ name: 'SUBJECT_PUNCTUATION_RUN', weight: 1.0, kind: 'spam', detail: 'The subject line uses repeated exclamation or question marks.' });
    }
    // `[URGENT]`, `RE:` on a message that is not a reply, `***SPAM***`-style
    // decoration around the subject.
    if (/^\s*(?:\*{2,}|\[{1,2}\s*(?:urgent|important|alert|warning|final)\b)/i.test(subject)) {
      out.push({ name: 'SUBJECT_DECORATED', weight: 0.8, kind: 'spam' });
    }
    if (/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u.test(subject)) {
      const emoji = (subject.match(/\p{Extended_Pictographic}/gu) ?? []).length;
      if (emoji >= 3) out.push({ name: 'SUBJECT_MANY_EMOJI', weight: 0.7, kind: 'spam' });
    }
    if (/(?:\$|£|€|₹|usd|eur|gbp)\s?[\d,]{4,}/i.test(subject)) {
      out.push({ name: 'SUBJECT_LARGE_AMOUNT', weight: 0.8, kind: 'spam' });
    }
  }

  if (body) {
    const letters = body.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 200) {
      const upper = (body.match(/[A-Z]/g) ?? []).length / letters.length;
      if (upper > 0.6) out.push({ name: 'BODY_ALL_CAPS', weight: 1.0, kind: 'spam', detail: 'The message is largely written in capitals.' });
    }
    if (/[!]{4,}/.test(body)) {
      out.push({ name: 'BODY_PUNCTUATION_RUN', weight: 0.7, kind: 'spam' });
    }
    // Generic salutations. Worth very little alone — plenty of legitimate bulk mail
    // says "Dear Customer" — but they are the tell that the sender does not know
    // who they are writing to.
    if (/\b(?:dear (?:customer|user|client|member|friend|valued customer|account holder|sir\/madam|sir or madam))\b/i.test(body)) {
      out.push({ name: 'BODY_GENERIC_SALUTATION', weight: 0.6, kind: 'spam' });
    }
  }

  /* --------------------------------------------------------------- unicode ---- */

  // Invisible characters *inside* words. A message that renders as one thing and
  // matches as another has exactly one purpose, and there is no legitimate reason
  // for a zero-width joiner to sit between two Latin letters.
  const source = `${subject}\n${body}`;
  if (hasInvisibleCharacters(source)) {
    // Only when stripping them changes what the words are — some fonts and some
    // scripts legitimately carry joiners.
    if (skeleton(source).replace(/\s+/g, '') !== source.toLowerCase().replace(/\s+/g, '')) {
      out.push({
        name: 'CONTENT_INVISIBLE_CHARS',
        weight: 2.0,
        kind: 'phishing',
        detail: 'The message hides invisible characters inside words.',
      });
    }
  }

  if (hasMixedScriptWord(source)) {
    out.push({
      name: 'CONTENT_MIXED_SCRIPT',
      weight: 1.8,
      kind: 'phishing',
      detail: 'Some words mix alphabets so they look like other words.',
    });
  }

  // A body that is almost all one repeated word — filler used to dilute a Bayes
  // filter, and a shape no human writes.
  if (body.length > 400) {
    const list = words(body);
    if (list.length >= 40) {
      const unique = new Set(list).size;
      if (unique / list.length < 0.25) {
        out.push({ name: 'BODY_LOW_VOCABULARY', weight: 1.0, kind: 'spam' });
      }
    }
  }

  return out;
}

/**
 * Attachment symbols, from metadata only.
 *
 * The bytes are never read, never decoded and never executed — this looks at the
 * filename, the declared type and the size, which is all the engine is given.
 *
 * The executable check is about *what the user would open*: a `.exe` or `.scr`
 * arriving by mail is worth a symbol, and a name written to look like a document
 * (`invoice.pdf.exe`, or one using a bidirectional override to display as
 * `invoicefdp.exe`) is worth considerably more, because the deception is the
 * evidence rather than the extension.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'msi', 'msp', 'hta', 'cpl', 'jar',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'reg', 'lnk', 'inf',
  'apk', 'app', 'dmg', 'iso', 'img', 'vhd', 'scf', 'url', 'chm', 'sct',
]);

/** Types that carry macros. Ordinary in business mail, so the weight is small. */
const MACRO_EXTENSIONS = new Set(['docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'xlam', 'ppam', 'sldm']);

/** Archives, which are how an executable gets past a naive filter. */
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'cab', 'ace', 'arj', 'lzh', 'z']);

export function attachmentSymbols(input: SpamInput): SpamSymbol[] {
  const out: SpamSymbol[] = [];
  // `Array.isArray` rather than `?? []`: this shape ultimately comes from a
  // provider response, so the field can be absent, null, or something that is not
  // a list at all. None of those is a crash.
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).filter(
    (meta) => meta && typeof meta === 'object',
  );
  if (attachments.length === 0) return out;

  const fired = new Set<string>();
  const push = (symbol: SpamSymbol) => {
    if (fired.has(symbol.name)) return;
    fired.add(symbol.name);
    out.push(symbol);
  };

  for (const meta of attachments) {
    const filename = typeof meta.filename === 'string' ? meta.filename : '';
    if (!filename) continue;

    // A bidirectional override in a filename exists to reverse how the extension
    // displays. There is no other use for it in a filename.
    if (/[‪-‮⁦-⁩]/.test(filename)) {
      push({
        name: 'ATTACH_NAME_REVERSED',
        weight: 3.6,
        kind: 'phishing',
        detail: 'An attachment’s name is written to display a false file type.',
      });
    }

    const parts = skeleton(filename).split('.').filter(Boolean);
    const extension = parts.length > 1 ? parts[parts.length - 1] : '';
    const previous = parts.length > 2 ? parts[parts.length - 2] : '';

    if (EXECUTABLE_EXTENSIONS.has(extension)) {
      // `report.pdf.exe` — two extensions, the visible one harmless.
      const disguised = previous !== '' && !EXECUTABLE_EXTENSIONS.has(previous) && previous.length <= 4;
      push({
        name: disguised ? 'ATTACH_DOUBLE_EXTENSION' : 'ATTACH_EXECUTABLE',
        weight: disguised ? 4.0 : 2.6,
        kind: 'phishing',
        detail: disguised
          ? `An attachment is named to look like a document but is a program (.${extension}).`
          : `An attachment is a program (.${extension}).`,
      });
    } else if (MACRO_EXTENSIONS.has(extension)) {
      push({ name: 'ATTACH_MACRO_DOCUMENT', weight: 1.2, kind: 'spam', detail: 'An attachment is a document that can contain macros.' });
    } else if (ARCHIVE_EXTENSIONS.has(extension)) {
      push({ name: 'ATTACH_ARCHIVE', weight: 0.5, kind: 'spam' });
    }

    // The declared type disagreeing with the name. Mail clients decide what to do
    // with a file by one or the other, so a mismatch is a way to get one behaviour
    // from the filter and another from the viewer.
    const declared = typeof meta.contentType === 'string' ? meta.contentType.toLowerCase() : '';
    if (declared && extension) {
      const claimsPdf = declared.includes('application/pdf');
      if (claimsPdf && extension !== 'pdf') {
        push({ name: 'ATTACH_TYPE_MISMATCH', weight: 1.4, kind: 'phishing', detail: 'An attachment’s declared type does not match its name.' });
      }
    }

    // An HTML attachment is a local phishing page: it opens in a browser, with no
    // address bar to check and no server to block.
    if (extension === 'html' || extension === 'htm' || extension === 'shtml' || extension === 'xhtml') {
      push({
        name: 'ATTACH_HTML_PAGE',
        weight: 2.2,
        kind: 'phishing',
        detail: 'An attachment is a web page, which can imitate a sign-in screen.',
      });
    }
  }

  return out;
}
