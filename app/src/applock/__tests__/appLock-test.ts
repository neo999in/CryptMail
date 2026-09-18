import {
  afterFailure,
  afterSuccess,
  checkPin,
  cooldownAfter,
  cooldownRemaining,
  DEFAULT_APP_LOCK,
  describeWait,
  FREE_ATTEMPTS,
  isLockEnabled,
  isValidPin,
  makePinVerifier,
  needsRehash,
  PIN_ITERATIONS,
  normaliseAppLock,
  shouldLockOnReturn,
} from '../appLock';

// Few rounds: these tests are about the shape of the check, not its cost.
const ROUNDS = 10;
const salt = new Uint8Array(16).fill(7);

describe('isValidPin', () => {
  it('takes 4 to 8 ASCII digits', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
  });

  it('refuses anything shorter, longer or not digits', () => {
    for (const pin of ['', '123', '123456789', '12a4', '12 34', '１２３４', '-1234']) {
      expect(isValidPin(pin)).toBe(false);
    }
  });
});

describe('PIN verifier', () => {
  it('accepts the PIN it was made from and nothing else', async () => {
    const verifier = await makePinVerifier('482915', salt, ROUNDS);
    expect(await checkPin('482915', verifier)).toBe(true);
    expect(await checkPin('482916', verifier)).toBe(false);
    expect(await checkPin('48291', verifier)).toBe(false);
    expect(await checkPin('4829150', verifier)).toBe(false);
  });

  it('never stores the PIN itself', async () => {
    const verifier = await makePinVerifier('482915', salt, ROUNDS);
    expect(JSON.stringify(verifier)).not.toContain('482915');
    expect(verifier.length).toBe(6);
    expect(verifier.iterations).toBe(ROUNDS);
  });

  it('gives the same PIN a different hash under a different salt', async () => {
    const a = await makePinVerifier('1234', salt, ROUNDS);
    const b = await makePinVerifier('1234', new Uint8Array(16).fill(8), ROUNDS);
    expect(a.hash).not.toBe(b.hash);
  });

  it('asks for a re-hash only when made with a different round count', async () => {
    expect(needsRehash(await makePinVerifier('1234', salt, 30_000))).toBe(true);
    expect(needsRehash(await makePinVerifier('1234', salt, PIN_ITERATIONS))).toBe(false);
  });

  it('refuses to make a verifier for an invalid PIN', async () => {
    await expect(makePinVerifier('12', salt, ROUNDS)).rejects.toThrow();
  });
});

describe('cooldown', () => {
  it('is free for the first attempts, then 30 s doubling to an hour', () => {
    for (let n = 0; n < FREE_ATTEMPTS; n++) expect(cooldownAfter(n)).toBe(0);
    expect(cooldownAfter(FREE_ATTEMPTS)).toBe(30_000);
    expect(cooldownAfter(FREE_ATTEMPTS + 1)).toBe(60_000);
    expect(cooldownAfter(FREE_ATTEMPTS + 2)).toBe(120_000);
    expect(cooldownAfter(FREE_ATTEMPTS + 30)).toBe(60 * 60_000);
  });

  it('starts counting down on the fifth miss and clears on success', () => {
    let prefs = { ...DEFAULT_APP_LOCK };
    for (let n = 1; n < FREE_ATTEMPTS; n++) prefs = afterFailure(prefs, 1000);
    expect(prefs.lockedUntil).toBe(0);

    prefs = afterFailure(prefs, 1000);
    expect(prefs.failures).toBe(FREE_ATTEMPTS);
    expect(cooldownRemaining(prefs, 1000)).toBe(30_000);
    expect(cooldownRemaining(prefs, 31_000)).toBe(0);

    prefs = afterSuccess(prefs);
    expect(prefs.failures).toBe(0);
    expect(prefs.lockedUntil).toBe(0);
  });
});

describe('shouldLockOnReturn', () => {
  const on = async () => ({ ...DEFAULT_APP_LOCK, pin: await makePinVerifier('1234', salt, ROUNDS) });

  it('never locks when there is no PIN', () => {
    expect(shouldLockOnReturn(DEFAULT_APP_LOCK, 0, 10_000_000)).toBe(false);
  });

  it('never locks when the app did not leave, or left for something it opened', async () => {
    expect(shouldLockOnReturn(await on(), null, 10_000_000)).toBe(false);
  });

  it('locks on any return when the timeout is immediate', async () => {
    expect(shouldLockOnReturn(await on(), 5000, 5000)).toBe(true);
  });

  it('waits out a longer timeout', async () => {
    const prefs = { ...(await on()), timeout: '5m' as const };
    expect(shouldLockOnReturn(prefs, 0, 4 * 60_000)).toBe(false);
    expect(shouldLockOnReturn(prefs, 0, 5 * 60_000)).toBe(true);
  });

  it('locks when the clock went backwards', async () => {
    const prefs = { ...(await on()), timeout: '1h' as const };
    expect(shouldLockOnReturn(prefs, 10_000, 5_000)).toBe(true);
  });
});

describe('normaliseAppLock', () => {
  it('fills a missing or broken store with the defaults', () => {
    expect(normaliseAppLock(null)).toEqual(DEFAULT_APP_LOCK);
    expect(normaliseAppLock({ timeout: 'forever' as never, failures: -3, lockedUntil: NaN })).toEqual(
      DEFAULT_APP_LOCK,
    );
  });

  it('drops the fingerprint when there is no PIN behind it', () => {
    expect(normaliseAppLock({ biometrics: true }).biometrics).toBe(false);
  });

  it('keeps a stored PIN, and so keeps the lock on', async () => {
    const pin = await makePinVerifier('1234', salt, ROUNDS);
    const prefs = normaliseAppLock({ pin, biometrics: true, timeout: '15m', failures: 2, lockedUntil: 99 });
    expect(isLockEnabled(prefs)).toBe(true);
    expect(prefs).toEqual({ pin, biometrics: true, timeout: '15m', failures: 2, lockedUntil: 99 });
  });
});

describe('describeWait', () => {
  it('rounds up to the unit a person would say', () => {
    expect(describeWait(1)).toBe('1 second');
    expect(describeWait(30_000)).toBe('30 seconds');
    expect(describeWait(61_000)).toBe('2 minutes');
    expect(describeWait(60 * 60_000)).toBe('1 hour');
  });
});
