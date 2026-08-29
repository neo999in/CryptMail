/**
 * The provider against a fake Play-services module.
 *
 * The composition is what these cover: which library response maps to which
 * AuthError, and — the one that matters — that a dropped connection never signs
 * a user out of a working account. That asymmetry is `revocation.ts`'s whole
 * reason to exist, and it is easy to lose in a rewrite.
 *
 * The `mock` prefixes are not decoration: babel-plugin-jest-hoist lifts the
 * factory above these declarations and rejects any other out-of-scope name.
 */
const mockSignIn = jest.fn();
const mockSignInSilently = jest.fn();
const mockGetTokens = jest.fn();
const mockSignOut = jest.fn();
const mockHasPlayServices = jest.fn(async (..._a: unknown[]) => true);
/** Swapped per-test so the unconfigured build can be exercised too. */
const mockUnavailableReason = jest.fn<string | null, []>(() => null);

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signIn: (...a: unknown[]) => mockSignIn(...a),
    signInSilently: (...a: unknown[]) => mockSignInSilently(...a),
    getTokens: (...a: unknown[]) => mockGetTokens(...a),
    signOut: (...a: unknown[]) => mockSignOut(...a),
    hasPlayServices: (...a: unknown[]) => mockHasPlayServices(...a),
  },
  isSuccessResponse: (r: { type?: string }) => r?.type === 'success',
  isNoSavedCredentialFoundResponse: (r: { type?: string }) => r?.type === 'noSavedCredentialFound',
}));

jest.mock('../../config', () => ({
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
  GMAIL_SCOPES: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'],
  get canUseGmail() {
    return mockUnavailableReason() === null;
  },
  mailUnavailableReason: () => mockUnavailableReason(),
}));

import { googleAuth } from '../googleAuth';

const USER = { type: 'success', data: { user: { email: 'Alice@Example.com' }, idToken: 'id' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockUnavailableReason.mockReturnValue(null);
  mockGetTokens.mockResolvedValue({ accessToken: 'at-1', idToken: 'id' });
});

describe('signIn', () => {
  it('returns a session with the address from Play services, lower-cased', async () => {
    mockSignIn.mockResolvedValue(USER);
    const session = await googleAuth.signIn();
    expect(session.email).toBe('alice@example.com');
    expect(session.accessToken).toBe('at-1');
    expect(session.provider).toBe('gmail');
  });

  it('maps a cancelled sign-in to `cancelled`, not `failed`', async () => {
    mockSignIn.mockResolvedValue({ type: 'cancelled', data: null });
    await expect(googleAuth.signIn()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('names Play services when it is unavailable, rather than crashing', async () => {
    mockHasPlayServices.mockRejectedValueOnce(new Error('no play services'));
    await expect(googleAuth.signIn()).rejects.toThrow(/play services/i);
  });
});

/**
 * An unconfigured build has no mailbox, and must say so.
 *
 * This replaced a fixture auth provider that handed back a fabricated identity
 * whenever no client id was set — so a missing `.env` produced a signed-in app
 * full of invented mail, which a user cannot tell from the real thing. The
 * asymmetry between the three methods is the design: `signIn` is a user action and
 * owes them the reason, `restore` is boot and must land quietly on the Connect
 * screen, and `signOut` must not reach into a library that was never configured.
 */
describe('when Gmail cannot be reached on this build', () => {
  const unconfigured = 'No Google OAuth client is configured. Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in app/.env.';

  beforeEach(() => {
    mockUnavailableReason.mockReturnValue(unconfigured);
  });

  it('refuses an interactive sign-in with the reason, and never prompts', async () => {
    await expect(googleAuth.signIn()).rejects.toMatchObject({
      code: 'not-configured',
      message: unconfigured,
    });
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('restores to signed-out rather than erroring at boot', async () => {
    await expect(googleAuth.restore()).resolves.toBeNull();
    expect(mockSignInSilently).not.toHaveBeenCalled();
  });

  it('refuses to mint a token, naming the same reason', async () => {
    await expect(googleAuth.freshAccessToken()).rejects.toMatchObject({ code: 'not-configured' });
  });

  it('signs out without calling a library it never configured', async () => {
    await expect(googleAuth.signOut()).resolves.toBeUndefined();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe('restore', () => {
  it('is null when nobody is signed in', async () => {
    mockSignInSilently.mockResolvedValue({ type: 'noSavedCredentialFound', data: null });
    await expect(googleAuth.restore()).resolves.toBeNull();
  });

  it('rebuilds the session without an interactive prompt', async () => {
    mockSignInSilently.mockResolvedValue(USER);
    const session = await googleAuth.restore();
    expect(session?.email).toBe('alice@example.com');
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});

describe('concurrent silent sign-in', () => {
  it('shares one signInSilently call rather than starting a second', async () => {
    // The library overwrites an in-flight signInSilently promise instead of
    // queueing, and the overwritten one never settles. Boot hits this every
    // time: AppState calls restore() while the Gmail client it just built asks
    // for a token, and the inbox then waits forever on a dead promise.
    let release!: (value: unknown) => void;
    mockSignInSilently.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const restoring = googleAuth.restore();
    const refreshing = googleAuth.freshAccessToken();
    release(USER);
    await Promise.all([restoring, refreshing]);

    expect(mockSignInSilently).toHaveBeenCalledTimes(1);
  });

  it('shares one getTokens call rather than starting a second', async () => {
    // The library does the same overwriting to getTokens, and the first fix
    // only moved the failure here — restore() and freshAccessToken() both reach
    // getTokens once the silent sign-in is shared.
    mockSignInSilently.mockResolvedValue(USER);
    let release!: (value: unknown) => void;
    mockGetTokens.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const restoring = googleAuth.restore();
    const refreshing = googleAuth.freshAccessToken();
    // Let both get past signInSilently and reach getTokens before it settles.
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    release({ accessToken: 'at-9', idToken: 'id' });
    await Promise.all([restoring, refreshing]);

    expect(mockGetTokens).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh call once the previous one has settled', async () => {
    mockSignInSilently.mockResolvedValue(USER);
    await googleAuth.restore();
    await googleAuth.restore();
    expect(mockSignInSilently).toHaveBeenCalledTimes(2);
  });
});

describe('freshAccessToken', () => {
  it('asks Play services rather than caching a token itself', async () => {
    mockSignInSilently.mockResolvedValue(USER);
    mockGetTokens.mockResolvedValue({ accessToken: 'at-2', idToken: 'id' });
    await expect(googleAuth.freshAccessToken()).resolves.toBe('at-2');
  });

  it('signs the user out when the grant is revoked', async () => {
    mockSignInSilently.mockResolvedValue(USER);
    mockGetTokens.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' }),
    );
    await expect(googleAuth.freshAccessToken()).rejects.toMatchObject({ code: 'reauth-required' });
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('keeps the session when the network is down', async () => {
    // Signing out over a dropped connection would lose a perfectly good grant.
    mockSignInSilently.mockResolvedValue(USER);
    mockGetTokens.mockRejectedValue(new Error('Network request failed'));
    await expect(googleAuth.freshAccessToken()).rejects.toMatchObject({ code: 'failed' });
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
