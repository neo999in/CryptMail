/**
 * Where the links actually go.
 *
 * A phishing message is a link with a story attached. The story is unbounded and
 * hard to check; the link is a short string with structure, and almost every
 * technique used to disguise one leaves a mark that can be read locally.
 *
 * **Nothing in this module touches the network.** No URL is fetched, resolved,
 * expanded, previewed or HEAD-requested — not even to "just check" whether a
 * shortener points somewhere bad. A classifier that fetched links would announce
 * to the sender that the message was read, hand a tracking URL its confirmation,
 * and in a phishing case fetch attacker-controlled content on the user's network.
 * Every judgement here comes from the characters of the URL itself.
 *
 * The counterpart rule: a shortener is *not* a verdict. Every newsletter platform
 * on earth wraps its links, and `bit.ly` in a message is worth a fraction of a
 * point. What is worth real weight is a shortener next to credential language, or
 * an anchor whose visible text names one company and whose href names another.
 */
import { hostOf, pathOf } from '../lib/links';
import type { LinkPair, SpamInput, SpamSymbol } from './types';
import {
  brandsNamedIn,
  domainSkeleton,
  hasInvisibleCharacters,
  hasPunycodeLabel,
  lookalikeBrand,
  registrableDomain,
  sameRegistrableDomain,
  skeleton,
} from './unicode';
import { domainOf } from './headers';

/**
 * Link shorteners and redirector hosts.
 *
 * Not a blocklist — a "this URL does not disclose its destination" list. That is
 * the property being measured, which is why the weight is small and why it grows
 * only in combination with the rest of the message.
 */
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
  'adf.ly', 'bit.do', 'mcaf.ee', 'su.pr', 'shorte.st', 'cutt.ly', 'rb.gy',
  'rebrand.ly', 'shorturl.at', 'tiny.cc', 'lnkd.in', 'db.tt', 'qr.ae',
  'trib.al', 'ity.im', 'q.gs', 'po.st', 'bc.vc', 'twitthis.com', 'u.to',
  'j.mp', 'buzurl.com', 'v.gd', 'tr.im', 'zi.ma', 'clck.ru', 'soo.gd',
  's2r.co', 'clicky.me', 'bl.ink', 'short.io', 'kutt.it', 'tny.im',
  'gg.gg', '1url.com', 'hyperurl.co', 'urlz.fr', 'linktr.ee', 'shrtco.de',
]);

/** Free hosting where a page can be stood up in a minute under a real brand's TLS. */
const FREE_PAGE_HOSTS = new Set([
  'github.io', 'firebaseapp.com', 'web.app', 'pages.dev', 'workers.dev',
  'vercel.app', 'netlify.app', 'herokuapp.com', 'glitch.me', 'repl.co',
  'weebly.com', 'wixsite.com', 'square.site', 'blogspot.com', 'r2.dev',
  'ngrok.io', 'ngrok-free.app', 'duckdns.org', 'notion.site', 'my.canva.site',
  'azurewebsites.net', 'surge.sh', 'onrender.com', 'netlify.com', 'sites.google.com',
]);

/** Words in a URL path that mean the page wants a password. */
const CREDENTIAL_PATH_WORDS = [
  'login', 'signin', 'log-in', 'sign-in', 'logon', 'auth', 'authenticate',
  'verify', 'verification', 'validate', 'confirm', 'confirmation', 'secure',
  'security', 'account', 'password', 'passwd', 'credential', 'unlock',
  'recover', 'recovery', 'reset', 'update-info', 'billing', 'payment',
  'wallet', 'seed', 'mnemonic', 'private-key', 'kyc', 'session',
];

/**
 * The free-hosting suffix a host sits under, if any.
 *
 * Matched as a suffix rather than by equality because `registrableDomain`
 * deliberately treats `paypal.github.io` as its own registrable unit — that is
 * what stops every `github.io` page reading as the same sender — so the *provider*
 * has to be recovered separately from the *site*.
 */
function freeHostSuffix(host: string): string | null {
  for (const suffix of FREE_PAGE_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
  }
  return null;
}

/** Whether a host is a bare IPv4 or IPv6 literal. */
export function isIpHost(host: string): boolean {
  if (/^\[?[0-9a-f:]+\]?$/i.test(host) && host.includes(':')) return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Whether a host is written in a form designed not to look like a host.
 *
 * `http://0x7f000001/`, `http://2130706433/` and `http://017700000001/` are all
 * `127.0.0.1`. Nothing legitimate addresses a server this way.
 */
export function isObfuscatedHost(host: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^\d{7,}$/.test(host)) return true;
  if (/^0\d+(\.0\d+)*$/.test(host)) return true;
  return false;
}

/** The pairs a message's links actually consist of, defensively normalised. */
function usableLinks(input: SpamInput): { href: string; text: string; host: string }[] {
  const out: { href: string; text: string; host: string }[] = [];
  // `Array.isArray` rather than `?? []`: the field comes from a provider response,
  // so it can be absent, null, or not a list at all — a non-iterable value there
  // must not throw.
  for (const link of Array.isArray(input.links) ? input.links : []) {
    if (!link || typeof link.href !== 'string') continue;
    const href = link.href.trim();
    if (!href) continue;
    const host = hostOf(href);
    if (!host) continue;
    out.push({ href, text: typeof link.text === 'string' ? link.text : '', host });
  }
  return out;
}

/**
 * URL symbols for one message.
 *
 * Each distinct *finding* fires at most once no matter how many links exhibit it:
 * a newsletter with forty shortened links is one shortener finding, not forty. A
 * per-link tally would let link count alone push any bulk mail over the threshold.
 */
export function urlSymbols(input: SpamInput): SpamSymbol[] {
  const out: SpamSymbol[] = [];
  const links = usableLinks(input);
  if (links.length === 0) return out;

  const fromDomain = domainOf((input.from?.address ?? '').toLowerCase());

  const fired = new Set<string>();
  const push = (symbol: SpamSymbol) => {
    if (fired.has(symbol.name)) return;
    fired.add(symbol.name);
    out.push(symbol);
  };

  for (const { href, text, host } of links) {
    const registrable = registrableDomain(host);
    const path = (pathOf(href) ?? '').toLowerCase();
    const lowerHref = href.toLowerCase();

    if (isIpHost(host)) {
      push({
        name: 'URL_IP_ADDRESS',
        weight: 2.6,
        kind: 'phishing',
        detail: `A link points at a bare address (${host}) instead of a domain name.`,
      });
    } else if (isObfuscatedHost(host)) {
      push({
        name: 'URL_OBFUSCATED_HOST',
        weight: 3.0,
        kind: 'phishing',
        detail: 'A link hides its destination behind a numeric address.',
      });
    }

    if (SHORTENERS.has(registrable)) {
      push({ name: 'URL_SHORTENER', weight: 0.8, kind: 'spam', detail: `A link is shortened (${registrable}), so its destination is hidden.` });
    }

    if (hasPunycodeLabel(host)) {
      push({ name: 'URL_PUNYCODE_HOST', weight: 2.0, kind: 'phishing', detail: 'A link’s address is written in an encoded alphabet that can imitate another name.' });
    }

    const hit = lookalikeBrand(host);
    if (hit) {
      push({
        name: 'URL_LOOKALIKE_DOMAIN',
        weight: hit.reason === 'confusable' ? 4.0 : hit.reason === 'near-miss' ? 3.2 : 2.4,
        kind: 'phishing',
        detail: `A link goes to ${host}, which imitates ${hit.brand}.`,
      });
    }

    // Userinfo before the host. `hostOf` already reads the real host, so this is
    // about *intent*: the only reason to write a brand there is to make the URL
    // read as that brand.
    const authority = lowerHref.replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? '';
    if (authority.includes('@')) {
      push({
        name: 'URL_USERINFO',
        weight: 2.8,
        kind: 'phishing',
        detail: `A link is written to look like one site but goes to ${host}.`,
      });
    }

    if (hasInvisibleCharacters(href)) {
      push({ name: 'URL_INVISIBLE_CHARS', weight: 2.4, kind: 'phishing', detail: 'A link contains hidden characters.' });
    }

    // An encoded URL inside a URL: an open redirector being used to borrow a
    // trusted host's reputation. Only counts when the embedded target is
    // elsewhere, because ordinary login flows legitimately carry a same-site
    // `?next=`.
    const embedded = lowerHref.match(/[?&](?:url|u|redirect|redirect_uri|redir|next|target|dest|destination|continue|goto|link|out|r)=([^&]+)/);
    if (embedded) {
      let decoded = '';
      try {
        decoded = decodeURIComponent(embedded[1]);
      } catch {
        // A malformed percent-escape is not a crash — the raw value still tells us
        // whether a second URL is in there.
        decoded = embedded[1];
      }
      const innerHost = hostOf(decoded) ?? hostOf(decoded.replace(/^https?%3a%2f%2f/i, 'https://'));
      if (innerHost && !sameRegistrableDomain(innerHost, host)) {
        push({
          name: 'URL_EMBEDDED_REDIRECT',
          weight: 2.2,
          kind: 'phishing',
          detail: `A link on ${host} forwards to ${innerHost}.`,
        });
      }
    }

    // Percent-encoding of characters that never need it — an attempt to make the
    // path unreadable to a human skimming the status bar.
    const escapes = (lowerHref.match(/%[0-9a-f]{2}/g) ?? []).length;
    if (escapes >= 8 && /%(?:2f|3a|40|25|68|74|70)/.test(lowerHref)) {
      push({ name: 'URL_HEAVILY_ENCODED', weight: 1.6, kind: 'phishing', detail: 'A link’s address is heavily encoded, hiding where it goes.' });
    }

    if (path.length > 0) {
      const words = CREDENTIAL_PATH_WORDS.filter((word) => path.includes(word));
      // Two or more, and off the sender's own domain. One is ordinary — every
      // service has a `/login`. Two on a stranger's domain is a harvesting page.
      if (words.length >= 2 && (!fromDomain || !sameRegistrableDomain(host, fromDomain))) {
        push({
          name: 'URL_CREDENTIAL_PATH',
          weight: 1.8,
          kind: 'phishing',
          detail: `A link goes to a sign-in style page on ${host}.`,
        });
      }
    }

    // Deep subdomain nesting is how a brand name is smuggled into the part of the
    // address a phone truncates: `secure.paypal.com.verify.example`.
    const labels = host.split('.');
    if (labels.length >= 5) {
      push({ name: 'URL_DEEP_SUBDOMAIN', weight: 1.0, kind: 'spam', detail: `A link uses an unusually long address (${host}).` });
    }
    // A brand's name in the *site* part of a free-hosting address.
    //
    // The brand is looked for only in the labels the page's author chose, never in
    // the provider's own suffix — otherwise `sites.google.com` would report itself
    // as impersonating Google.
    const freeSuffix = freeHostSuffix(host);
    if (freeSuffix !== null) {
      const sitePart = host.slice(0, Math.max(0, host.length - freeSuffix.length));
      if (brandsNamedIn(sitePart).length > 0) {
        push({
          name: 'URL_BRAND_ON_FREE_HOST',
          weight: 2.6,
          kind: 'phishing',
          detail: `A page on free hosting (${host}) is using a company’s name.`,
        });
      }
    }

    /* ----------------------------------------------- text versus destination ---- */

    const label = text.trim();
    if (!label) continue;

    // The anchor text is itself a URL, pointing somewhere else. This is the
    // clearest form of the lie and it needs no interpretation.
    const shownHost = hostOf(label) ?? (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(label) ? label.toLowerCase().replace(/^www\./, '') : null);
    if (shownHost && !sameRegistrableDomain(shownHost, host)) {
      push({
        name: 'URL_TEXT_HOST_MISMATCH',
        weight: 3.2,
        kind: 'phishing',
        detail: `A link reads “${shownHost}” but goes to ${host}.`,
      });
      continue;
    }

    // The anchor text names a brand and the destination is not that brand's. "Log
    // in to PayPal" pointing at `secure-payments.example`.
    if (!shownHost) {
      const claimed = brandsNamedIn(label);
      if (claimed.length > 0) {
        const skeletonHost = domainSkeleton(host);
        const honest = claimed.some((brand) => skeletonHost.includes(brand));
        if (!honest) {
          push({
            name: 'URL_TEXT_BRAND_MISMATCH',
            weight: 2.4,
            kind: 'phishing',
            detail: `A link labelled with a company’s name goes to ${host}.`,
          });
        }
      }
    }
  }

  /* ----------------------------------------------------------- aggregates ---- */

  const distinctHosts = new Set(links.map(({ host }) => registrableDomain(host)));
  // Mail that is nothing but a link. Common in phishing, and the reason the weight
  // is low is that it is also common in notification mail.
  if (links.length === 1 && (input.body ?? '').trim().length < 200) {
    out.push({ name: 'URL_ONLY_MESSAGE', weight: 0.6, kind: 'spam' });
  }
  if (distinctHosts.size >= 8) {
    out.push({ name: 'URL_MANY_HOSTS', weight: 0.5, kind: 'spam' });
  }

  return out;
}

/**
 * Anchor `href`/text pairs from an HTML part.
 *
 * `plainBody.ts`'s `htmlToText` deliberately discards this pairing — it produces
 * readable text, and the pairing is not text. But the pairing *is* the evidence
 * for the strongest link symbol above, so it is extracted here with its own pass.
 *
 * The parser is a bounded scan, not an HTML parser:
 *
 * - it only ever *reads*; no markup is executed, no resource is loaded, and
 *   `javascript:` and `data:` hrefs are dropped rather than recorded;
 * - the regex has no nested quantifier that can backtrack, so hostile markup
 *   cannot make it hang;
 * - input and output are both capped, so a 5 MB page of anchors cannot exhaust
 *   memory.
 *
 * This runs on content that a remote sender wrote, so those three properties are
 * the requirements, not the niceties.
 */
const MAX_HTML_CHARS = 400_000;
const MAX_LINKS = 200;

export function extractLinks(html: string): LinkPair[] {
  if (typeof html !== 'string' || html === '') return [];
  const source = html.slice(0, MAX_HTML_CHARS);
  const out: LinkPair[] = [];

  const anchor = /<a\b([^>]*)>([\s\S]{0,2000}?)<\/a\s*>/gi;
  for (let match = anchor.exec(source); match !== null; match = anchor.exec(source)) {
    if (out.length >= MAX_LINKS) break;
    const href = readHref(match[1]);
    if (!href) continue;
    out.push({ href, text: stripTags(match[2]) });
  }

  // Unclosed anchors — malformed markup, or a truncated body. The href is still
  // worth having even without its text.
  if (out.length < MAX_LINKS) {
    const bare = /<a\b([^>]*)>/gi;
    for (let match = bare.exec(source); match !== null; match = bare.exec(source)) {
      if (out.length >= MAX_LINKS) break;
      const href = readHref(match[1]);
      if (href && !out.some((link) => link.href === href)) out.push({ href, text: '' });
    }
  }

  return out;
}

/** The `href` of an attribute string, if it is a web URL. */
function readHref(attributes: string): string | null {
  const match = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  if (!value) return null;
  // Only http(s). `javascript:`, `data:`, `file:` and `mailto:` are either not
  // navigable destinations or not things this app will ever open, and recording
  // them would put a script URL into a token table.
  if (!/^https?:\/\//i.test(value)) return null;
  return decodeEntities(value).slice(0, 2000);
}

/** Anchor text: tags removed, entities decoded, whitespace collapsed. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * The handful of entities that appear in anchor text and hrefs.
 *
 * `&amp;` is decoded last, exactly as in `plainBody.ts`, so `&amp;lt;` becomes
 * `&lt;` rather than `<` — otherwise the decoder would manufacture markup that
 * was not in the message.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d{1,6});/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code: string) => safeCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Whether any link in a message hides its destination. Used by the UI copy. */
export const hasDeceptiveLink = (symbols: SpamSymbol[]): boolean =>
  symbols.some((symbol) => symbol.name === 'URL_TEXT_HOST_MISMATCH' || symbol.name === 'URL_USERINFO');

/** Exported for the tests: the folded form of a host, for lookalike assertions. */
export const foldHost = (host: string): string => skeleton(host);
