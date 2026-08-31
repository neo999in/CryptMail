/**
 * The mail and crypto capabilities must stay independent.
 *
 * They were once a single `appMode` requiring both, which meant a correctly
 * configured OAuth client still produced demo fixtures until the Rust core
 * existed — and made the "core missing, block the send" branches unreachable,
 * because `!hasNativeCore` always implied demo mode.
 *
 * The fixture mailbox is gone, so mail is now "reachable or not" rather than
 * "real or fake". The crypto stand-in stays, and remains the half these tests
 * care most about: it is the one that can make an insecure build look normal.
 *
 * config.ts reads `process.env` and `core.kind` at module load, so these tests
 * re-import it under each combination rather than mutating a live binding.
 */

type ConfigModule = typeof import('../config');

/** Load config.ts fresh with the given client id, core kind and sign-in availability. */
function loadConfig(
  clientId: string,
  coreKind: 'native' | 'demo',
  signInModule: boolean = true,
): ConfigModule {
  let mod!: ConfigModule;
  jest.isolateModules(() => {
    jest.doMock('../core', () => ({ core: { kind: coreKind } }));
    jest.doMock('@react-native-google-signin/google-signin', () =>
      signInModule ? { GoogleSignin: { configure: jest.fn() } } : {},
    );
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = clientId;
    mod = require('../config') as ConfigModule;
  });
  return mod;
}

const CLIENT = 'abc123.apps.googleusercontent.com';

afterEach(() => {
  delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  jest.resetModules();
});

describe('mail and crypto capabilities are independent', () => {
  it('gives real Gmail with a client id even when the core is missing', () => {
    const c = loadConfig(CLIENT, 'demo');
    expect(c.mailMode).toBe('gmail');
    expect(c.cryptoMode).toBe('demo');
  });

  it('gives real crypto with a linked core even with no client id', () => {
    const c = loadConfig('', 'native');
    expect(c.mailMode).toBe('unconfigured');
    expect(c.cryptoMode).toBe('real');
  });

  it('has neither when neither is configured', () => {
    const c = loadConfig('', 'demo');
    expect(c.mailMode).toBe('unconfigured');
    expect(c.cryptoMode).toBe('demo');
  });

  /** No client id means no mailbox at all — there is nothing to fall back to. */
  it('cannot connect a mailbox without a client id', () => {
    expect(loadConfig('', 'native').canConnectMailbox).toBe(false);
    expect(loadConfig(CLIENT, 'native').canConnectMailbox).toBe(true);
  });

  it('is fully real when both are configured', () => {
    const c = loadConfig(CLIENT, 'native');
    expect(c.mailMode).toBe('gmail');
    expect(c.cryptoMode).toBe('real');
  });
});

describe('the sign-in module is a separate capability from the crypto core', () => {
  it('has no mailbox where Play services cannot run, even with a client id', () => {
    // The web build. Claiming a real mailbox it cannot reach would be exactly
    // the silent downgrade degradedReason() exists to prevent.
    const c = loadConfig(CLIENT, 'native', false);
    expect(c.mailMode).toBe('unconfigured');
    expect(c.canConnectMailbox).toBe(false);
    expect(c.degradedReason()).toMatch(/play services/i);
  });

  it('keeps mail and crypto independent — a sign-in module with no core is still real mail', () => {
    const c = loadConfig(CLIENT, 'demo', true);
    expect(c.mailMode).toBe('gmail');
    expect(c.cryptoMode).toBe('demo');
  });
});

describe('scopes', () => {
  it('requests gmail.modify, because star, archive and mark-read call messages.modify', () => {
    const c = loadConfig(CLIENT, 'native');
    expect(c.GMAIL_SCOPES).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(c.GMAIL_SCOPES).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
  });
});

describe('appMode is the conjunction', () => {
  it.each([
    ['', 'demo', 'degraded'],
    [CLIENT, 'demo', 'degraded'],
    ['', 'native', 'degraded'],
    [CLIENT, 'native', 'live'],
  ] as const)('client=%s core=%s -> %s', (clientId, coreKind, expected) => {
    expect(loadConfig(clientId, coreKind).appMode).toBe(expected);
  });
});

describe('degradedReason names what is missing', () => {
  it('says nothing when both halves are real', () => {
    expect(loadConfig(CLIENT, 'native').degradedReason()).toBeNull();
  });

  it('reports both when neither is wired up', () => {
    // Both halves, not either: an alternation here would pass while the string
    // named only one of the two things this build is missing.
    const reason = loadConfig('', 'demo').degradedReason();
    expect(reason).toMatch(/OAuth client/i);
    expect(reason).toMatch(/crypto core/i);
  });

  /**
   * The dangerous configuration, and the one that must never read as normal:
   * the mailbox is real, so every screen looks like the product, and only this
   * string tells the user that none of it is actually encrypted.
   */
  it('says plainly that a real mailbox is not really encrypted', () => {
    expect(loadConfig(CLIENT, 'demo').degradedReason()).toMatch(/nothing is really encrypted/i);
  });

  it('says there is no mailbox rather than offering a fake one', () => {
    const reason = loadConfig('', 'native').degradedReason();
    expect(reason).toMatch(/no mailbox/i);
    expect(reason).not.toMatch(/fixture|demo mailbox/i);
  });
});
