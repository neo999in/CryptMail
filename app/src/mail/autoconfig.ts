/**
 * Finding a mailbox's IMAP and SMTP servers from its address, so the user types
 * an address and a password rather than four hostnames.
 *
 * The order Thunderbird uses (docs/providers.md, "Autodiscovery"):
 *
 *  1. The domain's own autoconfig file, over HTTPS — the provider speaking for
 *     itself. It is sent the full address, since it is the provider.
 *  2. Mozilla's ISPDB, which knows the large providers. It is sent the
 *     **domain only**: which mail provider someone uses is metadata, and the
 *     address itself is none of Mozilla's business.
 *  3. A guess — `imap.<domain>` and `smtp.<domain>` on the TLS ports — which the
 *     sign-in then either proves or refutes by connecting.
 *
 * Only HTTPS is fetched: an autoconfig file over plain HTTP could point the app
 * at an attacker's server, and that server would then be handed the password.
 * Any entry that is not TLS or STARTTLS is skipped rather than downgraded.
 */
import { filesOwnSentCopy, ImapAccount } from './imap';
import { Security, ServerEndpoint } from './socket';

export type DiscoverySource = 'provider' | 'ispdb' | 'guess';

export type Discovered = { account: ImapAccount; source: DiscoverySource };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const LOOKUP_TIMEOUT_MS = 8_000;

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

/**
 * Parse a Thunderbird autoconfig document (the `clientConfig` v1.1 format) into
 * settings for this address, or null when it offers no usable IMAP and SMTP
 * pair. Regex rather than a DOM, because the format is small and fixed and this
 * runs where no DOMParser exists.
 */
export function parseAutoconfig(xml: string, email: string): ImapAccount | null {
  const imap = pickServer(xml, 'incomingServer', 'imap', email);
  const smtp = pickServer(xml, 'outgoingServer', 'smtp', email);
  if (!imap || !smtp) return null;
  return {
    imap: imap.endpoint,
    smtp: smtp.endpoint,
    username: imap.username || email,
    saveSentCopy: !filesOwnSentCopy(smtp.endpoint.host),
  };
}

function pickServer(
  xml: string,
  element: 'incomingServer' | 'outgoingServer',
  type: 'imap' | 'smtp',
  email: string,
): { endpoint: ServerEndpoint; username: string } | null {
  const blocks = xml.match(new RegExp(`<${element}\\b[^>]*\\btype=["']${type}["'][^>]*>[\\s\\S]*?</${element}>`, 'gi')) ?? [];
  // TLS from the first byte beats STARTTLS when a provider offers both: there
  // is no plaintext leg at all to interfere with.
  const candidates = blocks
    .map((block) => {
      const field = (name: string) => decodeXml(block.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1]?.trim() ?? '');
      const security = securityOf(field('socketType'));
      const port = Number(field('port'));
      const host = substitute(field('hostname'), email).toLowerCase();
      const methods = (block.match(/<authentication>([^<]*)<\/authentication>/gi) ?? []).map((m) =>
        m.replace(/<\/?authentication>/gi, '').trim().toLowerCase(),
      );
      // A server that only takes OAuth cannot be signed in to with a password,
      // however right its hostname.
      const passwordOk = methods.length === 0 || methods.some((m) => m === 'password-cleartext' || m === 'plain');
      if (!security || !host || !Number.isInteger(port) || port <= 0 || port > 65535 || !passwordOk) return null;
      return { endpoint: { host, port, security }, username: substitute(field('username'), email) };
    })
    .filter((c): c is { endpoint: ServerEndpoint; username: string } => c !== null);
  return candidates.find((c) => c.endpoint.security === 'tls') ?? candidates[0] ?? null;
}

function securityOf(socketType: string): Security | null {
  const t = socketType.toUpperCase();
  if (t === 'SSL' || t === 'TLS') return 'tls';
  if (t === 'STARTTLS') return 'starttls';
  return null;
}

function substitute(value: string, email: string): string {
  const [local = '', domain = ''] = email.trim().split('@');
  return value
    .replace(/%EMAILADDRESS%/g, email.trim())
    .replace(/%EMAILLOCALPART%/g, local)
    .replace(/%EMAILDOMAIN%/g, domain.toLowerCase());
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The last resort: the conventional names on the TLS ports. */
export function guessSettings(email: string): ImapAccount {
  const domain = domainOf(email);
  const smtpHost = `smtp.${domain}`;
  return {
    imap: { host: `imap.${domain}`, port: 993, security: 'tls' },
    smtp: { host: smtpHost, port: 465, security: 'tls' },
    username: email.trim(),
    saveSentCopy: !filesOwnSentCopy(smtpHost),
  };
}

async function lookup(fetcher: Fetcher, url: string, email: string): Promise<ImapAccount | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetcher(url, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) return null;
    return parseAutoconfig(await res.text(), email);
  } catch {
    // Offline, no such host, a timeout — each just means "not from here".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settings for this address — always something, since the guess never fails.
 * Whether they *work* is for the sign-in to find out.
 */
export async function discoverSettings(email: string, fetcher: Fetcher = fetch): Promise<Discovered> {
  const address = email.trim();
  const domain = domainOf(address);
  if (!domain) return { account: guessSettings(address), source: 'guess' };

  // All three asked at once, taken in order of authority: the slowest lookup
  // should not stand in front of an answer that is already in hand.
  const [own, wellKnown, ispdb] = await Promise.all([
    lookup(fetcher, `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address)}`, address),
    lookup(fetcher, `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`, address),
    lookup(fetcher, `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, address),
  ]);
  const provider = own ?? wellKnown;
  if (provider) return { account: provider, source: 'provider' };
  if (ispdb) return { account: ispdb, source: 'ispdb' };
  return { account: guessSettings(address), source: 'guess' };
}
