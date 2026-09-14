/**
 * Waiting out a provider's rate limit instead of treating it as a failure.
 *
 * Found on a device (2026-09-14): exporting a 387-message Gmail mailbox skipped
 * 226 of them, every one refused with `403 Quota exceeded … Units per minute
 * per user`. Nothing was wrong with those messages — the export had simply
 * spent the minute's quota — and counting them as "could not be fetched"
 * handed the user a backup missing most of its mail.
 *
 * Gmail reports the per-user quota as 403 (with `quota`/`rateLimitExceeded` in
 * the body) as well as the usual 429; Microsoft Graph uses 429. A plain 403 is
 * a permission refusal and is never retried.
 */
import { MailError } from './types';

export function isRateLimited(e: unknown): boolean {
  if (!(e instanceof MailError)) return false;
  if (e.status === 429) return true;
  return e.status === 403 && /quota|rate ?limit/i.test(e.message);
}

/**
 * Backoff between attempts. The quota is per *minute*, so the ladder reaches a
 * full minute rather than giving up after a few seconds of an exhausted window.
 */
export const RATE_LIMIT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Run `work`, retrying only while the provider says to slow down.
 *
 * Any other error is thrown at once, so a genuinely missing message still fails
 * fast. `delays` and `sleep` are parameters so a test does not wait a minute.
 */
export async function withRateLimitRetry<T>(
  work: () => Promise<T>,
  delays: number[] = RATE_LIMIT_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= delays.length) throw e;
      await sleep(delays[attempt]);
    }
  }
}
