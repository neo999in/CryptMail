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

/**
 * A lookup runs while someone types a recipient, so it should not wait forever
 * — but the old six seconds was chosen against no measurement at all. Sampled
 * against `keys.openpgp.org`, a single lookup came back in 1.1s, 7.8s and 9.8s
 * on three consecutive tries, with a tail past twenty.
 *
 * Giving up early is not the cheap option it looks like. A lookup that gives up
 * leaves the recipient `missing`, and rule 1 then holds the message *and emails
 * that person an invitation* — so an impatient deadline sends a stranger an
 * invite to install CryptMail when they had a published key all along. Compose
 * stays usable while this runs and says what it is doing, so waiting costs the
 * user very little and giving up costs them something real.
 */
export const LOOKUP_TIMEOUT_MS = 15_000;

/**
 * Publishing is a button press whose entire purpose is the round trip, and it
 * uploads a key rather than downloading one — a v6 key with a post-quantum
 * subkey is several times the size of a classical one. Measured from a phone,
 * `keys.openpgp.org` regularly takes upwards of fifteen seconds to answer, so
 * the typing budget aborted every attempt before it could finish.
 */
export const PUBLISH_TIMEOUT_MS = 45_000;

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
 * Returns `null` only when **VKS** answered definitively "nothing published".
 * If it could not be reached, this throws — see `DiscoveryError`.
 *
 * The asymmetry between the two sources is deliberate, and getting it wrong is
 * how a message ends up queued forever. VKS is the source that can speak for an
 * address: it serves a key only after the address owner confirmed it, so its
 * 404 is a real answer. WKD is a supplement — the *majority* of domains publish
 * none at all, so a 404 there is the norm and says nothing about whether the
 * person uses encryption. Letting a WKD 404 stand in for an answer would turn
 * every keyserver outage into "this person does not use encryption", and the
 * send path would invite them and hold the message against a key that existed
 * the whole time.
 */
export async function lookupKey(email: string, deps: DiscoveryDeps): Promise<DiscoveryResult | null> {
  const address = email.trim().toLowerCase();
  if (!address.includes('@')) return null;

  let lastFailure: DiscoveryError | null = null;
  /** VKS said, in so many words, "no key for that address". */
  let answered = false;

  const attempts: { url: string; source: DiscoverySource }[] = [
    { url: vksLookupUrl(address), source: 'vks' },
    ...wkdUrls(address).map((url) => ({ url, source: 'wkd' as const })),
  ];

  for (const attempt of attempts) {
    try {
      const armored = await fetchKey(attempt.url, deps);
      if (armored) return { armored, source: attempt.source };
      if (attempt.source === 'vks') answered = true;
    } catch (e) {
      lastFailure = e instanceof DiscoveryError ? e : new DiscoveryError(message(e), 'network');
    }
  }

  if (answered) return null;
  if (lastFailure) throw lastFailure;
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
    PUBLISH_TIMEOUT_MS,
  );
  if (!upload.ok) throw new DiscoveryError(await refusal('Key upload failed', upload), 'server');

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
    PUBLISH_TIMEOUT_MS,
  );
  if (!verify.ok) throw new DiscoveryError(await refusal('Verification request failed', verify), 'server');

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
  fallbackBudget: number = LOOKUP_TIMEOUT_MS,
) {
  const budget = deps.timeoutMs ?? fallbackBudget;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  // Whether *we* called it off. Every platform words an aborted fetch
  // differently — a `DOMException` named `AbortError` in a browser, a plain
  // `Error` reading "Fetch request has been canceled" in React Native — so
  // recognising our own deadline by the shape of the error hands that judgement
  // to whichever runtime we happen to be on. On Android it got it wrong, and
  // the raw platform string was shown to the user in place of an explanation.
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller?.abort();
  }, budget);
  try {
    return await deps.fetch(url, { ...init, signal: controller?.signal });
  } catch (e) {
    if (expired || isAbort(e)) {
      throw new DiscoveryError('The keyserver did not answer in time.', 'timeout');
    }
    throw new DiscoveryError(message(e), 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** A signal aborted by someone other than our own timer. Kept as a backstop. */
const isAbort = (e: unknown) =>
  !!e && typeof e === 'object' && 'name' in e && (e as { name?: string }).name === 'AbortError';

/**
 * What the keyserver said, when it refuses.
 *
 * VKS explains a rejection in a JSON `error` field, and that sentence is the
 * entire diagnosis: "unsupported key version" and "malformed" send whoever is
 * reading it somewhere completely different, while a bare status code sends
 * them nowhere. Falls back to the code when the body explains nothing — a
 * proxy's HTML maintenance page is not an explanation.
 */
async function refusal(what: string, res: { status: number; text(): Promise<string> }): Promise<string> {
  const said = (await parseJson(res))?.error;
  // The server's sentence usually ends in a full stop of its own; a second one
  // reads as a typo in our copy.
  const detail = typeof said === 'string' ? said.trim().replace(/[.\s]+$/, '') : '';
  return detail ? `${what} (${res.status}): ${detail}.` : `${what} (${res.status}).`;
}

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
