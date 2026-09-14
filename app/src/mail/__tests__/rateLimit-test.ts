/**
 * The quota refusal a device export hit, pinned: waited out and retried, while
 * every other failure still fails at once.
 */
import { isRateLimited, withRateLimitRetry } from '../rateLimit';
import { MailError } from '../types';

const QUOTA = new MailError(
  "Gmail 403: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
  403,
);

describe('isRateLimited', () => {
  it('recognises Gmail’s per-user quota 403 and a 429', () => {
    expect(isRateLimited(QUOTA)).toBe(true);
    expect(isRateLimited(new MailError('Graph 429: Too many requests', 429))).toBe(true);
    expect(isRateLimited(new MailError('Gmail 403: rateLimitExceeded', 403))).toBe(true);
  });

  it('does not retry a permission refusal, a missing message, or a non-provider error', () => {
    expect(isRateLimited(new MailError('Gmail 403: Insufficient Permission', 403))).toBe(false);
    expect(isRateLimited(new MailError('Gmail 404: Not Found', 404))).toBe(false);
    expect(isRateLimited(new Error('quota'))).toBe(false);
  });
});

describe('withRateLimitRetry', () => {
  const noWait = async () => {};

  it('waits out a rate limit and returns the result', async () => {
    let calls = 0;
    const result = await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw QUOTA;
        return 'raw';
      },
      [1, 1, 1],
      noWait,
    );

    expect(result).toBe('raw');
    expect(calls).toBe(3);
  });

  it('gives up once the backoff ladder is spent', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw QUOTA;
        },
        [1, 1],
        noWait,
      ),
    ).rejects.toBe(QUOTA);
    expect(calls).toBe(3);
  });

  it('throws any other error on the first attempt', async () => {
    let calls = 0;
    const gone = new MailError('Gmail 404: Not Found', 404);
    await expect(
      withRateLimitRetry(
        async () => {
          calls += 1;
          throw gone;
        },
        [1, 1],
        noWait,
      ),
    ).rejects.toBe(gone);
    expect(calls).toBe(1);
  });
});
