/**
 * Unicode tricks, and domains that are lying about who they are.
 *
 * Two distinct problems live here because they share one mechanism — characters
 * that do not mean what they look like:
 *
 * 1. **Obfuscation inside text.** Zero-width joiners inside `p‌a‌y‌p‌a‌l` defeat a
 *    keyword check while rendering identically; Cyrillic `а` for Latin `a` does
 *    the same. The answer is to *skeletonize* — strip the invisible characters,
 *    fold the lookalikes to their Latin base — and let the rules match on the
 *    skeleton as well as the original, so hiding a word costs the sender a
 *    symbol rather than buying them silence.
 *
 * 2. **Lookalike domains.** `paypa1.com`, `pаypal.com` (Cyrillic а) and
 *    `xn--pypal-4ve.com` are three spellings of the same attack. Comparing
 *    skeletons catches all three, and Levenshtein distance catches the ones no
 *    confusable table covers.
 *
 * The brand list is short and deliberately so: it holds the names that are
 * impersonated *because* they are universally recognised, and a name only earns a
 * symbol when the sending domain is a near-miss of the real one — never for
 * appearing in prose.
 */

/**
 * Characters that render as nothing.
 *
 * Zero-width space/non-joiner/joiner, the BOM, and the bidirectional overrides —
 * the last of those can reverse how a filename or a URL *displays* without
 * changing what it is, which is the classic double-extension trick.
 */
const INVISIBLE = /[­͏؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/**
 * Latin letters and digits that stand in for other Latin letters.
 *
 * Kept apart from the cross-script table below because these are *not* Unicode
 * confusables — they are ordinary ASCII, and folding them is only safe for
 * comparing a domain against a known brand. Folding them inside prose would make
 * "l1" and "ll" the same word.
 */
const ASCII_LOOKALIKES: Record<string, string> = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i',
};

/**
 * Non-Latin characters that render as a Latin letter.
 *
 * A working subset of the Unicode confusables data — Cyrillic, Greek, fullwidth
 * forms and the mathematical alphanumerics — rather than the whole table, which
 * is tens of thousands of entries and would be a data file, not a rule.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'с': 'c', 'е': 'e', 'н': 'h', 'к': 'k', 'м': 'm', 'о': 'o',
  'р': 'p', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'һ': 'h',
  'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ᴀ': 'a', 'ɡ': 'g',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o',
  'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ϲ': 'c', 'ѡ': 'w',
  // Armenian / Cherokee / other single-script lookalikes
  'օ': 'o', 'ց': 'g', 'ѵ': 'v', 'Ꭺ': 'a', 'Ꭼ': 'e', 'Ꮋ': 'h', 'Ꮮ': 'l', 'Ꮸ': 'c',
  // Fullwidth
  'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd', 'ｅ': 'e', 'ｆ': 'f', 'ｇ': 'g', 'ｈ': 'h',
  'ｉ': 'i', 'ｊ': 'j', 'ｋ': 'k', 'ｌ': 'l', 'ｍ': 'm', 'ｎ': 'n', 'ｏ': 'o', 'ｐ': 'p',
  'ｑ': 'q', 'ｒ': 'r', 'ｓ': 's', 'ｔ': 't', 'ｕ': 'u', 'ｖ': 'v', 'ｗ': 'w', 'ｘ': 'x',
  'ｙ': 'y', 'ｚ': 'z',
};

/** Whether a string contains a character that renders as nothing. */
export function hasInvisibleCharacters(text: string): boolean {
  INVISIBLE.lastIndex = 0;
  return new RegExp(INVISIBLE.source).test(text);
}

/** Drop every zero-width and direction-override character. */
export function stripInvisible(text: string): string {
  return text.replace(new RegExp(INVISIBLE.source, 'g'), '');
}

/**
 * Whether a string mixes scripts in a way normal text does not.
 *
 * A word of Latin letters containing one Cyrillic character is a substitution,
 * not multilingual writing — real multilingual text switches scripts at word
 * boundaries. So the check is per-token, and a token that is *entirely*
 * non-Latin (a Russian word in a Russian email) is correctly ignored.
 */
export function hasMixedScriptWord(text: string): boolean {
  for (const token of stripInvisible(text).split(/[\s.,:;!?/\\|()[\]{}<>"'@=+-]+/)) {
    if (token.length < 3) continue;
    let latin = 0;
    let confusable = 0;
    for (const char of token) {
      if (/[a-zA-Z]/.test(char)) latin += 1;
      else if (CONFUSABLES[char.toLowerCase()] !== undefined && !/[＀-￯]/.test(char)) confusable += 1;
    }
    if (latin > 0 && confusable > 0) return true;
  }
  return false;
}

/**
 * A comparison form: invisibles removed, confusables folded to Latin, lowercased.
 *
 * Used for matching text, so ASCII lookalikes are *not* folded here — see the note
 * on `ASCII_LOOKALIKES`.
 */
export function skeleton(text: string): string {
  let out = '';
  for (const char of stripInvisible(text).toLowerCase()) {
    out += CONFUSABLES[char] ?? char;
  }
  return out.normalize('NFKC').toLowerCase();
}

/**
 * A domain's comparison form: `skeleton`, plus the ASCII lookalikes and the
 * punycode label prefix.
 *
 * Punycode is decoded only as far as noticing it: `xn--` labels are marked rather
 * than decoded, because a decoder is a dependency and the *presence* of an
 * encoded label in a message claiming to be a household brand is already the
 * signal worth having.
 */
export function domainSkeleton(domain: string): string {
  let out = '';
  for (const char of skeleton(domain)) {
    out += ASCII_LOOKALIKES[char] ?? char;
  }
  // Separators are interchangeable to the eye: `pay-pal.com` and `paypal.com`.
  return out.replace(/[-_.]/g, '');
}

/** Whether any label of a host is punycode-encoded. */
export const hasPunycodeLabel = (host: string): boolean => /(^|\.)xn--/i.test(host);

/**
 * Multi-label public suffixes common enough that ignoring them misreads a host.
 *
 * Not the Public Suffix List — that is a 15 000-line data file that would need
 * updating, and getting `co.uk` and the big cloud-hosting suffixes right covers
 * the cases that actually change a verdict.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.za', 'org.za', 'web.za',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.cn', 'com.hk',
  'com.sg', 'com.tw', 'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.pl', 'com.ua', 'co.il', 'com.ph', 'com.my', 'co.id', 'com.vn',
  'github.io', 'blogspot.com', 'firebaseapp.com', 'web.app', 'pages.dev',
  'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'azurewebsites.net',
  'r2.dev', 's3.amazonaws.com', 'weebly.com', 'wixsite.com', 'square.site',
  'glitch.me', 'repl.co', 'ngrok.io', 'ngrok-free.app', 'duckdns.org',
  'sharepoint.com', 'onedrive.live.com', 'my.canva.site', 'notion.site',
]);

/**
 * The registrable part of a host — `shop.example.co.uk` → `example.co.uk`.
 *
 * This is the unit every domain comparison uses. Comparing full hosts would call
 * `mail.google.com` and `google.com` different senders; comparing only the last
 * two labels would call every `github.io` page the same one, which is exactly
 * the free-hosting phishing case.
 */
export function registrableDomain(host: string): string {
  const clean = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!clean || clean.includes(' ')) return '';
  const labels = clean.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  for (let take = 3; take <= Math.min(4, labels.length); take += 1) {
    const suffix = labels.slice(-(take - 1)).join('.');
    if (MULTI_LABEL_SUFFIXES.has(suffix)) return labels.slice(-take).join('.');
  }
  return labels.slice(-2).join('.');
}

/** Whether two hosts belong to the same registrable domain. */
export const sameRegistrableDomain = (a: string, b: string): boolean => {
  const left = registrableDomain(a);
  const right = registrableDomain(b);
  return left !== '' && left === right;
};

/** Edit distance, capped: anything past `limit` is reported as `limit + 1`. */
export function editDistance(a: string, b: string, limit = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Brands whose names are worth impersonating, and the domains they actually send
 * from.
 *
 * The `domains` list exists to *prevent* false positives: mail from
 * `paypal.co.uk` mentioning PayPal is PayPal, and must not score.
 */
const BRANDS: { name: string; domains: string[] }[] = [
  { name: 'paypal', domains: ['paypal.com', 'paypal.co.uk', 'paypal-community.com'] },
  { name: 'apple', domains: ['apple.com', 'icloud.com', 'me.com'] },
  { name: 'microsoft', domains: ['microsoft.com', 'office.com', 'live.com', 'outlook.com', 'office365.com', 'microsoftonline.com'] },
  { name: 'google', domains: ['google.com', 'gmail.com', 'googlemail.com', 'youtube.com'] },
  { name: 'amazon', domains: ['amazon.com', 'amazon.co.uk', 'amazon.in', 'amazonses.com', 'amazon.de'] },
  { name: 'netflix', domains: ['netflix.com'] },
  { name: 'facebook', domains: ['facebook.com', 'facebookmail.com', 'meta.com'] },
  { name: 'instagram', domains: ['instagram.com', 'mail.instagram.com'] },
  { name: 'whatsapp', domains: ['whatsapp.com'] },
  { name: 'linkedin', domains: ['linkedin.com'] },
  { name: 'dropbox', domains: ['dropbox.com', 'dropboxmail.com'] },
  { name: 'docusign', domains: ['docusign.com', 'docusign.net'] },
  { name: 'coinbase', domains: ['coinbase.com'] },
  { name: 'binance', domains: ['binance.com'] },
  { name: 'chase', domains: ['chase.com'] },
  { name: 'wellsfargo', domains: ['wellsfargo.com'] },
  { name: 'hsbc', domains: ['hsbc.com', 'hsbc.co.uk'] },
  { name: 'barclays', domains: ['barclays.co.uk', 'barclays.com'] },
  { name: 'santander', domains: ['santander.co.uk', 'santander.com'] },
  { name: 'natwest', domains: ['natwest.com'] },
  { name: 'citibank', domains: ['citibank.com', 'citi.com'] },
  { name: 'americanexpress', domains: ['americanexpress.com', 'aexp.com'] },
  { name: 'fedex', domains: ['fedex.com'] },
  { name: 'dhl', domains: ['dhl.com', 'dhl.de'] },
  { name: 'ups', domains: ['ups.com'] },
  { name: 'usps', domains: ['usps.com', 'usps.gov'] },
  { name: 'steam', domains: ['steampowered.com', 'valvesoftware.com'] },
  { name: 'spotify', domains: ['spotify.com'] },
  { name: 'adobe', domains: ['adobe.com'] },
  { name: 'stripe', domains: ['stripe.com'] },
  { name: 'wise', domains: ['wise.com', 'transferwise.com'] },
  { name: 'revolut', domains: ['revolut.com'] },
  { name: 'hmrc', domains: ['hmrc.gov.uk', 'gov.uk'] },
  { name: 'irs', domains: ['irs.gov'] },
];

export type LookalikeHit = { brand: string; host: string; reason: 'confusable' | 'near-miss' | 'embedded' };

/**
 * Whether a host is pretending to be one of the brands above.
 *
 * Three ways it can be, in decreasing order of certainty:
 *
 * - **confusable** — the folded skeleton equals the brand's own skeleton, so it
 *   renders as the brand. `pаypal.com` and `paypa1.com`.
 * - **near-miss** — one or two edits from the brand's domain: `paypall.com`.
 * - **embedded** — the brand name is a label, but the registrable domain belongs
 *   to someone else: `paypal.account-verify.example`.
 *
 * A host inside the brand's own registrable domain returns null, always.
 */
export function lookalikeBrand(host: string): LookalikeHit | null {
  const clean = host.trim().toLowerCase();
  if (!clean) return null;
  const registrable = registrableDomain(clean);
  if (!registrable) return null;

  for (const brand of BRANDS) {
    if (brand.domains.some((domain) => sameRegistrableDomain(registrable, domain))) return null;
  }

  const folded = domainSkeleton(registrable);
  for (const brand of BRANDS) {
    for (const domain of brand.domains) {
      const target = domainSkeleton(domain);
      if (folded === target) return { brand: brand.name, host: clean, reason: 'confusable' };
    }
  }

  // Compare only the name part: `paypall.com` vs `paypal`, so a different TLD on
  // the same word is not itself the finding.
  //
  // Both sides must be at least five characters. One edit away from a three- or
  // four-letter brand (`ups`, `irs`, `dhl`, `wise`) is not evidence of anything —
  // `ups2.example` and `wisely.example` are one edit from a brand and are not
  // imitating it — and at 3.2 points a false hit there would be the single largest
  // unjustified weight the engine can produce.
  const stem = domainSkeleton(registrable.split('.').slice(0, -1).join('.') || registrable);
  for (const brand of BRANDS) {
    if (stem.length < 5 || brand.name.length < 5) continue;
    const distance = editDistance(stem, brand.name, 2);
    if (distance > 0 && distance <= (brand.name.length >= 8 ? 2 : 1)) {
      return { brand: brand.name, host: clean, reason: 'near-miss' };
    }
  }

  const labels = clean.split('.');
  const outside = labels.slice(0, Math.max(0, labels.length - registrable.split('.').length));
  for (const brand of BRANDS) {
    if (outside.some((label) => domainSkeleton(label) === brand.name)) {
      return { brand: brand.name, host: clean, reason: 'embedded' };
    }
    // `paypal-security.example` — the brand as a hyphenated part of the
    // registrable label, which is not the brand's domain.
    const first = registrable.split('.')[0];
    if (first !== brand.name && first.includes('-') && first.split('-').some((p) => domainSkeleton(p) === brand.name)) {
      return { brand: brand.name, host: clean, reason: 'embedded' };
    }
  }

  return null;
}

/**
 * Words that follow a brand name in the display names phishers write, and never
 * in an ordinary English word that happens to start with a brand.
 *
 * This list is what lets `PayPalSupport` and `microsoft365` be read as one word
 * naming a brand while `Appleton`, `Chasewater`, `Steamboat` and `Stripes` are
 * not. It is deliberately a closed list of role words rather than "anything after
 * the brand": the open version is what produced the false positives above.
 */
const BRAND_ROLE_WORDS = [
  'support', 'security', 'secure', 'service', 'services', 'billing', 'team', 'account',
  'accounts', 'alert', 'alerts', 'help', 'helpdesk', 'care', 'customer', 'notification',
  'notifications', 'verify', 'verification', 'login', 'signin', 'mail', 'inc', 'ltd',
  'update', 'updates', 'center', 'centre', 'refund', 'refunds', 'delivery', 'tracking',
  'express', 'payments', 'rewards', 'store', 'id',
];

/**
 * The brand names a display name claims, folded so `PаyPal` counts.
 *
 * Matching is by *word*, not by substring. Folding the whole string to `[a-z0-9]`
 * and asking `includes` — which is what this did — reads brand names out of
 * ordinary English: "Rewards Team" contains `steam` across the word break, "First
 * National Bank" contains `irs` inside "first", "Purchase Support" contains
 * `chase`, "Groups Digest" and "Startups Weekly" contain `ups`, "Otherwise Studio"
 * contains `wise`. Each of those was worth 2.8 phishing points — 3.4 from a
 * freemail address — so a bookshop's newsletter arrived most of the way to a
 * phishing verdict on its display name alone.
 *
 * The text is therefore split into words *on the skeleton*, which is what keeps
 * `Pay-Pal`, `Pay<ZWSP>Pal` and Cyrillic `PаyPal` matching, and a brand counts as
 * named when either:
 *
 * - a run of consecutive words spells it exactly — `PayPal`, `Pay Pal`, `Pay-Pal`; or
 * - a single word is the brand followed by digits or a role word —
 *   `microsoft365`, `PayPalSupport` (see `BRAND_ROLE_WORDS`).
 *
 * A brand as the *tail* or the middle of a longer word (`SecurePayPal`) is not
 * matched. Accepting that miss is much cheaper than re-admitting the substring
 * class, and the spaced and hyphenated forms — which is what phishers actually
 * send, because the display name has to read as the brand to a human — are caught.
 *
 * **Known limit.** A brand whose name is also an ordinary word or given name still
 * matches when written as that word: "Wise Owl Books" reports `wise`, "Chase
 * Bennett" reports `chase`. Separating those needs meaning, not spelling. The
 * consequence is bounded — one 2.8-point symbol (3.4 on freemail), below both
 * thresholds on its own — and `brandOwnsHost` keeps the real brand's mail clear.
 */
export function brandsNamedIn(text: string): string[] {
  const words = skeleton(text).split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];
  return BRANDS.filter((brand) => namesBrand(words, brand.name)).map((brand) => brand.name);
}

/** Whether these words name one brand, by the two rules above. */
function namesBrand(words: string[], brand: string): boolean {
  for (let i = 0; i < words.length; i += 1) {
    // The brand plus a role word or a number, run together as one word.
    if (words[i].length > brand.length && words[i].startsWith(brand)) {
      const rest = words[i].slice(brand.length);
      if (/^[0-9]+$/.test(rest) || BRAND_ROLE_WORDS.includes(rest)) return true;
    }
    // The brand spelled by one word, or by consecutive words: `Pay Pal`.
    let run = '';
    for (let j = i; j < words.length && run.length < brand.length; j += 1) run += words[j];
    if (run === brand) return true;
  }
  return false;
}

/** Whether a brand legitimately sends from this host. */
export function brandOwnsHost(brand: string, host: string): boolean {
  const entry = BRANDS.find((b) => b.name === brand);
  if (!entry) return false;
  return entry.domains.some((domain) => sameRegistrableDomain(host, domain));
}
