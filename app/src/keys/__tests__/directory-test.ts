/**
 * Which directory the app talks to.
 *
 * The rule worth pinning down: a build serving fixture mail must never send the
 * addresses a user types into it to a real keyserver. Demo mail and a live
 * directory is not a configuration that should be reachable by accident, so the
 * choice is made once, from `mailMode`, and asserted here.
 *
 * `keys/index.ts` reads that at module load, so — like `config-test` — these
 * re-import it under each combination rather than mutating a live binding.
 */
type KeysModule = typeof import('../index');

function loadKeys(clientId: string): KeysModule {
  let mod!: KeysModule;
  jest.isolateModules(() => {
    jest.doMock('@react-native-google-signin/google-signin', () => ({
      GoogleSignin: { configure: jest.fn() },
    }));
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = clientId;
    mod = require('../index') as KeysModule;
  });
  return mod;
}

const CLIENT_ID = '1234.apps.googleusercontent.com';

afterEach(() => {
  delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
});

describe('directory selection', () => {
  it('uses the in-memory fixture directory when the mailbox is a fixture', () => {
    const { directory } = loadKeys('');
    expect(directory.kind).toBe('demo');
  });

  it('uses keys.openpgp.org once mail is real', () => {
    const { directory } = loadKeys(CLIENT_ID);
    expect(directory.kind).toBe('vks');
    expect(directory.listedAt).toBe('keys.openpgp.org');
  });

  it('names where a key would be listed, so the consent copy can say it', () => {
    // The user is told what they are publishing to before anything is uploaded;
    // that string has to come from the directory itself, not from a screen.
    expect(loadKeys('').directory.listedAt).toMatch(/demo/i);
  });
});

describe('the demo directory', () => {
  it('serves a key for the one stranger the demo is built around', async () => {
    const { directory } = loadKeys('');
    const { DEMO_STRANGER } = require('../demoDirectory') as typeof import('../demoDirectory');
    const found = await directory.lookup(DEMO_STRANGER.email);
    expect(found?.armored).toContain('BEGIN PGP PUBLIC KEY BLOCK');
  });

  it('has nothing for anyone else, which is what exercises the queue', async () => {
    const { directory } = loadKeys('');
    await expect(directory.lookup('stranger@nowhere.example')).resolves.toBeNull();
  });

  it('serves a key by address once it has been published', async () => {
    const { directory } = loadKeys('');
    const armored = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----';
    await expect(directory.publish(armored, 'me@example.com')).resolves.toEqual({
      status: 'pending-verification',
    });
    expect((await directory.lookup('me@example.com'))?.armored).toBe(armored);
  });
});
