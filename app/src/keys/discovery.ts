/**
 * Public-key discovery over the open keyserver ecosystem.
 *
 * Two sources, in order:
 *
 *  · **VKS** — `keys.openpgp.org`, the verifying keyserver. It only serves a key
 *    by address after the address owner clicked a confirmation link, and it
 *    strips third-party signatures, so an address lookup is a claim about that
 *    address rather than an unauthenticated blob anyone could upload.
 *  · **WKD** — the RFC-shaped lookup at the recipient's *own* domain. It cannot
 *    help for `@gmail.com` (nobody but Google can publish under that domain), so
 *    it is a supplement for people on their own domains, never the primary path.
 *
 * CryptMail deliberately does **not** run a key directory of its own. A
 * directory would mean hosting, uptime (a server that is down means users cannot
 * send), abuse controls, an address-verification flow, and a live log of who is
 * about to email whom — the social graph, which is the thing the product exists
 * to protect. See docs/key-management.md §Discovery.
 *
 * A key from here is **never** `verified`. A keyserver is a party that can hand
 * out the wrong key; TOFU plus an out-of-band safety-number comparison remains
 * the real defence (docs/security.md, key substitution).
 *
 * Network access is injected rather than imported so the tests — and demo mode —
 * never touch the network.
 */
import { bytesToBase64 } from '../lib/base64';
import { zBase32Sha1 } from './zbase32';

export type DiscoverySource = 'vks' | 'wkd';

export type DiscoveryResult = {
  armored: string;
  source: DiscoverySource;
};

/**
 * A lookup that could not be completed.
 *
 * Distinct from "no key published", which is a normal outcome and comes back as
 * `null`: one means *this person does not use encryption*, the other means *we
 * do not know*, and telling a user the first when the second is true is how a
 * message ends up queued forever.
 */
export class DiscoveryError extends Error {
  constructor(message: string, readonly code: 'network' | 'server' | 'timeout') {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/** The subset of `fetch` this module uses. Real `fetch` satisfies it. */
export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type DiscoveryDeps = {
  fetch: Fetcher;
  /** Per-request budget. A slow keyserver must never hang compose. */
  timeoutMs?: number;
};

export const VKS_BASE = 'https://keys.openpgp.org';
const DEFAULT_TIMEOUT_MS = 6000;

const ARMOR_BEGIN = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
const ARMOR_END = '-----END PGP PUBLIC KEY BLOCK-----';

/* ------------------------------------------------------------- lookup ----- */

export function vksLookupUrl(email: string): string {
  return `${VKS_BASE}/vks/v1/by-email/${encodeURIComponent(email.trim().toLowerCase())}`;
}

/**
 * The two WKD URLs for an address, advanced method first (RFC draft
 * `openpgpkey-<domain>`), then the direct method under the domain itself.
 *
 * The local part is hashed — SHA-1, then z-base-32 — which is what the spec
 * requires and is why looking one up does not hand the domain a plaintext list
 * of the addresses being asked about.
 */
export function wkdUrls(email: string): string[] {
  const [local, domain] = email.trim().toLowerCase().split('@');
  if (!local || !domain) return [];
  const hashed = zBase32Sha1(local);
  const query = `?l=${encodeURIComponent(local)}`;
  return [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hashed}${query}`,
    `https://${domain}/.well-known/openpgpkey/hu/${hashed}${query}`,
  ];
}

/**
 * Look up a public key by address.
 *
 * Returns `null` only when every source answered definitively "nothing
 * published". If no source could be reached, this throws — see `DiscoveryError`.
 */
export async function lookupKey(email: string, deps: DiscoveryDeps): Promise<DiscoveryResult | null> {
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return null;

  let lastFailure: DiscoveryError | null = null;
  let sawDefiniteMiss = false;

  const attempts: { url: string; source: DiscoverySource }[] = [
    { url: vksLookupUrl(address), source: 'vks' },
    ...wkdUrls(address).map((url) => ({ url, source: 'wkd' as const })),
  ];

  for (const attempt of attempts) {
    try {
      const armored = await fetchKey(attempt.url, deps);
      if (armored) return { armored, source: attempt.source };
      sawDefiniteMiss = true;
    } catch (e) {
      lastFailure = e instanceof DiscoveryError ? e : new DiscoveryError(message(e), 'network');
    }
  }

  if (lastFailure && !sawDefiniteMiss) throw lastFailure;
  return null;
}

/** One source. `null` means a definite 404; anything else throws. */
async function fetchKey(url: string, deps: DiscoveryDeps): Promise<string | null> {
  const res = await request(url, {}, deps);
  if (res.status === 404) return null;
  if (!res.ok) throw new DiscoveryError(`Key lookup failed (${res.status}).`, 'server');

  // VKS answers with armor; WKD answers with the binary key packets. Read the
  // bytes either way and armor them if they are not text already — the packet
  // reader in `pgp/parseArmoredKey.ts` only speaks armor.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const asText = tryDecodeAscii(bytes);
  if (asText?.includes(ARMOR_BEGIN)) return asText.slice(asText.indexOf(ARMOR_BEGIN));
  if (bytes.length === 0) return null;
  return armorKey(bytesToBase64(bytes));
}

/* ------------------------------------------------------------ publish ----- */

export type PublishOutcome = 'pending-verification' | 'published';

/**
 * Upload the user's own public key to VKS and ask for the confirmation mail.
 *
 * VKS will not serve a key *by address* until the address owner clicks the link
 * it emails, which is exactly the property that makes an address lookup worth
 * anything. So a fresh upload is `pending-verification` and only becomes
 * `published` once that has happened.
 */
export async function publishKey(
  armored: string,
  email: string,
  deps: DiscoveryDeps,
): Promise<{ status: PublishOutcome }> {
  const upload = await request(
    `${VKS_BASE}/vks/v1/upload`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keytext: armored }),
    },
    deps,
  );
  if (!upload.ok) throw new DiscoveryError(`Key upload failed (${upload.status}).`, 'server');

  const body = await parseJson(upload);
  const token = typeof body?.token === 'string' ? body.token : undefined;
  const address = email.trim().toLowerCase();
  if (statusFor(body, address) === 'published') return { status: 'published' };
  if (!token) return { status: 'pending-verification' };

  const verify = await request(
    `${VKS_BASE}/vks/v1/request-verify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, addresses: [address] }),
    },
    deps,
  );
  if (!verify.ok) throw new DiscoveryError(`Verification request failed (${verify.status}).`, 'server');

  const verified = await parseJson(verify);
  return { status: statusFor(verified, address) === 'published' ? 'published' : 'pending-verification' };
}

/** VKS reports per-address state in `status: { "a@b.com": "published" | … }`. */
function statusFor(body: Record<string, unknown> | null, email: string): string | undefined {
  const status = body?.status;
  if (!status || typeof status !== 'object') return undefined;
  const entry = Object.entries(status as Record<string, unknown>).find(
    ([addr]) => addr.toLowerCase() === email,
  );
  return typeof entry?.[1] === 'string' ? entry[1].toLowerCase() : undefined;
}

/* ------------------------------------------------------------- helpers ---- */

async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  deps: DiscoveryDeps,
) {
  const budget = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), budget);
  try {
    return await deps.fetch(url, { ...init, signal: controller?.signal });
  } catch (e) {
    if (isAbort(e)) throw new DiscoveryError('The keyserver did not answer in time.', 'timeout');
    throw new DiscoveryError(message(e), 'network');
  } finally {
    clearTimeout(timer);
  }
}

const isAbort = (e: unknown) =>
  !!e && typeof e === 'object' && 'name' in e && (e as { name?: string }).name === 'AbortError';

async function parseJson(res: { text(): Promise<string> }): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await res.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** ASCII-only decode: enough to tell armor from binary packets, and never throws. */
function tryDecodeAscii(bytes: Uint8Array): string | null {
  let out = '';
  for (const b of bytes) {
    if (b > 0x7e && b !== 0x0a && b !== 0x0d && b !== 0x09) return null;
    out += String.fromCharCode(b);
  }
  return out;
}

function armorKey(base64: string): string {
  return [ARMOR_BEGIN, '', ...(base64.match(/.{1,64}/g) ?? []), ARMOR_END].join('\n');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
