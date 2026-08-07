/**
 * Token revocation vs. a transient failure.
 *
 * These are different situations with opposite correct responses, and getting
 * the distinction wrong is bad in both directions: treating a revocation as
 * transient leaves the user stuck on an error they cannot act on, and treating
 * a dropped connection as a revocation signs them out of a working account
 * every time they lose signal.
 */
import { describeError, isPermanentAuthFailure } from '../revocation';
import { AuthError, needsReauth } from '../types';

describe('classifying an auth failure', () => {
  it('treats a revoked grant as needing a new sign-in', () => {
    expect(needsReauth(new AuthError('revoked', 'reauth-required'))).toBe(true);
  });

  it('does not treat a retryable failure as a revocation', () => {
    expect(needsReauth(new AuthError('network is down', 'failed'))).toBe(false);
  });

  it('does not treat a cancelled sign-in as a revocation', () => {
    expect(needsReauth(new AuthError('cancelled', 'cancelled'))).toBe(false);
  });

  it('ignores errors from elsewhere', () => {
    expect(needsReauth(new Error('invalid_grant'))).toBe(false);
    expect(needsReauth('invalid_grant')).toBe(false);
    expect(needsReauth(null)).toBe(false);
  });
});

describe('classifying a refresh failure', () => {
  it('reads a structured OAuth error code', () => {
    expect(isPermanentAuthFailure({ code: 'invalid_grant' })).toBe(true);
    expect(isPermanentAuthFailure({ code: 'invalid_client' })).toBe(true);
  });

  it('falls back to the message, since the shape varies by platform', () => {
    expect(isPermanentAuthFailure(new Error('{"error":"invalid_grant"}'))).toBe(true);
  });

  it('treats a network failure as retryable, not a revocation', () => {
    // The direction that matters: a wrong "permanent" verdict destroys a
    // working session, a wrong "transient" one only costs a retry.
    expect(isPermanentAuthFailure(new Error('Network request failed'))).toBe(false);
    expect(isPermanentAuthFailure({ code: 'server_error' })).toBe(false);
    expect(isPermanentAuthFailure(new Error('timeout'))).toBe(false);
  });

  it('treats an unrecognised failure as retryable', () => {
    expect(isPermanentAuthFailure(undefined)).toBe(false);
    expect(isPermanentAuthFailure({})).toBe(false);
  });

  it('describes an error whatever it is', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('boom')).toBe('boom');
    expect(describeError(undefined)).toBe('undefined');
  });
});
