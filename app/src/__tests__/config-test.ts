/**
 * The mail and crypto capabilities must stay independent.
 *
 * They were once a single `appMode` requiring both, which meant a correctly
 * configured OAuth client still produced demo fixtures until the Rust core
 * existed — and made the "core missing, block the send" branches unreachable,
 * because `!hasNativeCore` always implied demo mode.
 *
 * config.ts reads `process.env` and `core.kind` at module load, so these tests
 * re-import it under each combination rather than mutating a live binding.
 */

type ConfigModule = typeof import('../config');

/** Load config.ts fresh with the given OAuth client id and core kind. */
function loadConfig(clientId: string, coreKind: 'native' | 'demo'): ConfigModule {
  let mod!: ConfigModule;
  jest.isolateModules(() => {
    jest.doMock('../core', () => ({ core: { kind: coreKind } }));
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = clientId;
    mod = require('../config') as ConfigModule;
  });
  return mod;
}

const CLIENT = 'abc123.apps.googleusercontent.com';

afterEach(() => {
  delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
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
    expect(c.mailMode).toBe('demo');
    expect(c.cryptoMode).toBe('real');
  });

  it('is fully demo when neither is configured', () => {
    const c = loadConfig('', 'demo');
    expect(c.mailMode).toBe('demo');
    expect(c.cryptoMode).toBe('demo');
  });

  it('is fully real when both are configured', () => {
    const c = loadConfig(CLIENT, 'native');
    expect(c.mailMode).toBe('gmail');
    expect(c.cryptoMode).toBe('real');
  });
});

describe('appMode is the conjunction', () => {
  it.each([
    ['', 'demo', 'demo'],
    [CLIENT, 'demo', 'demo'],
    ['', 'native', 'demo'],
    [CLIENT, 'native', 'live'],
  ] as const)('client=%s core=%s -> %s', (clientId, coreKind, expected) => {
    expect(loadConfig(clientId, coreKind).appMode).toBe(expected);
  });
});

describe('demoReason names which half is fake', () => {
  it('says nothing when both halves are real', () => {
    expect(loadConfig(CLIENT, 'native').demoReason()).toBeNull();
  });

  it('reports both when neither is wired up', () => {
    expect(loadConfig('', 'demo').demoReason()).toMatch(/crypto core.*OAuth client/i);
  });

  it('distinguishes real-mail-fake-crypto from its inverse', () => {
    // The dangerous configuration: mail looks real, so the user must be told
    // plainly that nothing is actually encrypted.
    expect(loadConfig(CLIENT, 'demo').demoReason()).toMatch(/nothing is really encrypted/i);
    expect(loadConfig('', 'native').demoReason()).toMatch(/fixtures/i);
  });
});
