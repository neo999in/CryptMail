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
  hasGoogleClient: true,
}));

import { googleAuth } from '../googleAuth';

const USER = { type: 'success', data: { user: { email: 'Alice@Example.com' }, idToken: 'id' } };

beforeEach(() => {
  jest.clearAllMocks();
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
