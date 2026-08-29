/**
 * What configuration decides, now that the mailbox is not one of the things it
 * decides.
 *
 * There used to be a `mailMode` that fell back to fixture mail whenever a client
 * id or Play services was missing, and these tests pinned that matrix. The
 * fallback is gone: a build that cannot reach Gmail has no mailbox, says so, and
 * refuses to sign in — so what is asserted here is that the *reason* is specific
 * (the two causes have different fixes), that `appMode` now tracks the crypto
 * alone, and that `demoReason()` never again claims the mail is fake.
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

describe('reaching Gmail is configuration, not a product mode', () => {
  it('can use Gmail once a client id and Play services are both present', () => {
    const c = loadConfig(CLIENT, 'demo');
    expect(c.canUseGmail).toBe(true);
    expect(c.mailUnavailableReason()).toBeNull();
  });

  it('does not depend on the crypto core — real mail with a stand-in core is valid', () => {
    // The whole point of separating them: transport can be commissioned before
    // encryption, so a missing core must not make the mailbox unreachable.
    expect(loadConfig(CLIENT, 'demo').canUseGmail).toBe(true);
    expect(loadConfig(CLIENT, 'native').canUseGmail).toBe(true);
  });

  it('names the missing client id, and the file to put it in', () => {
    const c = loadConfig('', 'demo');
    expect(c.canUseGmail).toBe(false);
    expect(c.mailUnavailableReason()).toMatch(/EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID/);
  });

  it('names Play services where sign-in cannot run, even with a client id', () => {
    // The web build. It has no mailbox at all now — it used to quietly serve
    // fixtures, which is the downgrade this reason exists to replace.
    const c = loadConfig(CLIENT, 'native', false);
    expect(c.canUseGmail).toBe(false);
    expect(c.mailUnavailableReason()).toMatch(/play services/i);
  });

  it('reports the client id first when both are missing, since that is the fix to make', () => {
    expect(loadConfig('', 'demo', false).mailUnavailableReason()).toMatch(
      /EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID/,
    );
  });
});

describe('scopes', () => {
  it('requests gmail.modify, because star, archive and mark-read call messages.modify', () => {
    const c = loadConfig(CLIENT, 'native');
    expect(c.GMAIL_SCOPES).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(c.GMAIL_SCOPES).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
  });
});

describe('appMode tracks the crypto alone', () => {
  it.each([
    ['', 'demo', 'demo'],
    [CLIENT, 'demo', 'demo'],
    ['', 'native', 'live'],
    [CLIENT, 'native', 'live'],
  ] as const)('client=%s core=%s -> %s', (clientId, coreKind, expected) => {
    // Mail is real by construction, so the client id no longer moves this.
    expect(loadConfig(clientId, coreKind).appMode).toBe(expected);
    expect(loadConfig(clientId, coreKind).cryptoMode).toBe(coreKind === 'native' ? 'real' : 'demo');
  });
});

describe('demoReason is about the crypto and nothing else', () => {
  it('says nothing once the core is linked', () => {
    expect(loadConfig(CLIENT, 'native').demoReason()).toBeNull();
    expect(loadConfig('', 'native').demoReason()).toBeNull();
  });

  it('says plainly that nothing is encrypted while the core is a stand-in', () => {
    // The dangerous configuration, and the one the app is in today: mail is
    // real, so the user must be told the encryption is not.
    expect(loadConfig(CLIENT, 'demo').demoReason()).toMatch(/nothing is really encrypted/i);
  });

  it('never claims the mail is fixtures, because it cannot be', () => {
    for (const clientId of ['', CLIENT]) {
      expect(loadConfig(clientId, 'demo').demoReason()).not.toMatch(/fixture|demo mailbox/i);
    }
  });
});
