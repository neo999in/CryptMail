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
 *
 * Since `KEY_DIRECTORY_ENABLED` is off in this build, the cases that pin the
 * *choice* between the fixture and live directories have to turn it back on to
 * reach that choice at all. The first block pins what ships.
 */
type KeysModule = typeof import('../index');

function loadKeys(clientId: string, directoryEnabled = true): KeysModule {
  let mod!: KeysModule;
  jest.isolateModules(() => {
    jest.doMock('@react-native-google-signin/google-signin', () => ({
      GoogleSignin: { configure: jest.fn() },
    }));
    jest.doMock('../../config', () => ({
      ...(jest.requireActual('../../config') as typeof import('../../config')),
      KEY_DIRECTORY_ENABLED: directoryEnabled,
      mailMode: clientId.length > 0 ? 'real' : 'unconfigured',
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

describe('with key lookup off — what this build ships', () => {
  it('talks to no directory at all, real mailbox or not', () => {
    expect(loadKeys(CLIENT_ID, false).directory.kind).toBe('none');
    // A fixture mailbox must not reach a *different* directory either: the
    // behaviour under test has to be the behaviour that ships.
    expect(loadKeys('', false).directory.kind).toBe('none');
  });

  it('reports every address as having no published key, rather than failing', async () => {
    // `null` is "nobody published a key", which sends an invite and queues the
    // message. A throw would be "the lookup broke", which is a different state
    // the send path is entitled to treat differently — see noDirectory.ts.
    const { directory } = loadKeys(CLIENT_ID, false);
    await expect(directory.lookup('stranger@example.com')).resolves.toBeNull();
  });

  it('refuses to publish rather than record a listing that does not exist', async () => {
    const { directory } = loadKeys(CLIENT_ID, false);
    await expect(directory.publish('-----BEGIN PGP PUBLIC KEY BLOCK-----', 'me@example.com')).rejects.toThrow(
      /turned off/i,
    );
  });

  it('names nowhere, so no screen can claim a server it never contacts', () => {
    expect(loadKeys(CLIENT_ID, false).directory.listedAt).not.toMatch(/openpgp\.org/i);
  });
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
