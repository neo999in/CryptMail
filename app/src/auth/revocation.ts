/**
 * Deciding whether a token refresh failed permanently or just this time.
 *
 * Split out of `googleAuth.ts` so it can be tested without pulling in
 * `expo-auth-session`, which needs a native module. This is the judgement call
 * in the whole re-auth path, so it is the part that most needs tests.
 */

/**
 * OAuth 2.0 error codes that mean the grant is gone for good.
 *
 * RFC 6749 §5.2 defines `invalid_grant` for a refresh token that is revoked,
 * expired, or does not match the redirect URI; Google also returns it after a
 * password change or when the user removes the app from their account.
 * `invalid_client` means the client id itself is wrong, which no retry fixes.
 *
 * Everything else — network failures, 5xx, timeouts — is transient by default.
 * That default is deliberate and matters more than the list: a wrong
 * "permanent" verdict destroys a working session, while a wrong "transient" one
 * only costs a retry.
 */
const PERMANENT = /invalid_grant|invalid_client|unauthorized_client/i;

/**
 * Whether a refresh failure means the user must sign in again.
 *
 * Checks the structured `code` first, then falls back to the message text,
 * because `expo-auth-session` surfaces token errors inconsistently across
 * platforms — sometimes as a `TokenError` with a code, sometimes as a plain
 * `Error` whose message carries the JSON body.
 */
export function isPermanentAuthFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && PERMANENT.test(code)) return true;

  return PERMANENT.test(describeError(error));
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
