/**
 * The pure half of Microsoft sign-in: URLs, redirects, and what a profile says.
 *
 * Split out of `microsoftAuth.ts` for the same reason `revocation.ts` is split
 * out of `googleAuth.ts` — so it can be tested without the browser, the keystore
 * or the network. Every judgement call in the PKCE flow lives here.
 *
 * No `URL` or `URLSearchParams`: React Native's are partial, and a redirect
 * parsed wrongly is a sign-in that fails with no useful error.
 */

/** Standard base64 to the URL-safe, unpadded alphabet RFC 7636 requires. */
export const base64UrlFromBase64 = (b64: string) =>
  b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return base64UrlFromBase64(btoa(binary));
}

/**
 * The most a profile photo may weigh before it is left off the account.
 *
 * It is stored on the registry ref, which every screen reads, so a full-size
 * photo from the unsized fallback endpoint would be carried everywhere for an
 * avatar forty points wide. Initials are the better answer than that.
 */
const MAX_PHOTO_BYTES = 128 * 1024;

/**
 * Photo bytes from Graph as a `data:` URI, or nothing.
 *
 * Graph names no type on some responses and serves JPEG, so that is assumed.
 * A type that is not an image is refused: it is an error body that arrived
 * with a success status, and it would render as a broken picture.
 */
export function photoDataUri(bytes: Uint8Array, contentType: string | null | undefined): string | undefined {
  const type = (contentType || 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return undefined;
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) return undefined;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:${type};base64,${btoa(binary)}`;
}

const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

/** A form body for the token endpoint, which takes nothing else. */
export const formBody = query;

/**
 * The authorize request.
 *
 * `select_account` is what makes "add account" add one: without it Microsoft
 * answers from whichever browser session is already signed in, and a second
 * Outlook mailbox would silently re-add the first.
 */
export function authorizeUrl(options: {
  authority: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  challenge: string;
  state: string;
}): string {
  return `${options.authority}/authorize?${query({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    response_mode: 'query',
    scope: options.scopes.join(' '),
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    state: options.state,
    prompt: 'select_account',
  })}`;
}

/** The parameters on a redirect, from the query and the fragment alike. */
export function redirectParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const start = url.search(/[?#]/);
  if (start < 0) return out;
  for (const pair of url.slice(start + 1).split(/[&#?]/)) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    out[decode(key)] = decode(value);
  }
  return out;
}

export type RedirectOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

/**
 * What the redirect means.
 *
 * The state check is not optional. Without it any page that can open the
 * app's scheme could hand it an authorization code for an attacker's mailbox,
 * and the user would be reading — and sending from — someone else's account.
 */
export function readRedirect(url: string, expectedState: string): RedirectOutcome {
  const params = redirectParams(url);
  if (params.error) {
    // The user closing the consent page, or declining it, is not a failure to
    // report — the same as Google's cancelled picker.
    if (params.error === 'access_denied') return { kind: 'cancelled' };
    return { kind: 'error', message: params.error_description || params.error };
  }
  if (params.state !== expectedState) {
    return { kind: 'error', message: 'The sign-in response did not match the request, so it was refused.' };
  }
  if (!params.code) return { kind: 'error', message: 'Microsoft returned no authorization code.' };
  return { kind: 'code', code: params.code };
}

/**
 * The mailbox address, from Graph's `/me`.
 *
 * `mail` first: it is the SMTP address mail is sent from. A work account's
 * `userPrincipalName` is a sign-in name that may not receive mail at all, and a
 * From header built from it is one Exchange refuses. Personal outlook.com
 * accounts often leave `mail` empty, and for them the UPN *is* the address.
 */
export function addressFromProfile(profile: { mail?: string | null; userPrincipalName?: string | null }): string {
  return (profile.mail || profile.userPrincipalName || '').trim().toLowerCase();
}

/**
 * The keystore key for one mailbox's refresh token.
 *
 * Hex, because `expo-secure-store` accepts only `[A-Za-z0-9._-]` in a key and an
 * address carries `@` and `+`. Hex is also collision-free, which a character
 * substitution would not be.
 */
export function credentialKey(email: string): string {
  let hex = '';
  for (const b of new TextEncoder().encode(email.trim().toLowerCase())) hex += b.toString(16).padStart(2, '0');
  return `cryptmail.ms.v1.${hex}`;
}

/**
 * Whether a token-endpoint error means the user has to sign in again.
 *
 * `invalid_grant` is the refresh token revoked or expired. `interaction_required`
 * and `consent_required` are Microsoft's own: the grant may still exist, but a
 * policy (MFA, a new consent) now needs a person, which no silent retry gives.
 * Everything else — offline, 5xx, throttling — is transient, for the reason
 * `revocation.ts` spells out: a wrong "permanent" verdict signs the user out of
 * a working mailbox.
 */
export const isReauthError = (code: string | undefined) =>
  !!code && /invalid_grant|invalid_client|unauthorized_client|interaction_required|consent_required/i.test(code);
