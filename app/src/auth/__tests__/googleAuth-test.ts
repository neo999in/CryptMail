/**
 * The provider against a fake Play-services module that holds two grants.
 *
 * The composition is what these cover, and there are now two kinds of it. The
 * first is unchanged and still the most important: which library response maps
 * to which AuthError, and that a dropped connection never signs a user out of a
 * working account. That asymmetry is `revocation.ts`'s whole reason to exist and
 * is easy to lose in a rewrite.
 *
 * The second is new, and is the reason this file's fake is a small state
 * machine rather than a bag of `mockResolvedValue`s. Play services has one
 * current user, so serving two mailboxes means re-pointing it between calls —
 * which makes "whose token is this?" a question the code can now get *wrong*.
 * A fake that returns the same token whatever is configured cannot fail that
 * way, and so cannot test it. This one mints a token per account, from whoever
 * is actually signed in, so a crossed token shows up as a wrong string.
 *
 * The `mock` prefixes are not decoration: babel-plugin-jest-hoist lifts the
 * factory above these declarations and rejects any other out-of-scope name.
 */

/** Grants this device holds: address → the access token Google would mint. */
const mockGrants = new Map<string, string>();
/** Who Play services currently has in front, and the last `accountName` hint. */
let mockCurrent: string | null = null;
let mockHint: string | undefined;
/** Whom an interactive `signIn()` picks. */
let mockPicks: string | null = null;
/** Every library call, in order — how interleaving is detected. */
let mockOps: string[] = [];
/** Lets a test hold `getTokens` open to force an overlap. */
let mockStall: Promise<void> | null = null;
/** Play services ignoring `accountName` — the risk the design is built on. */
let mockIgnoresHint = false;

const mockHasPlayServices = jest.fn(async (..._a: unknown[]) => true);

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: (options: { accountName?: string }) => {
      mockHint = options.accountName;
      mockOps.push(`configure:${options.accountName ?? '-'}`);
    },
    signInSilently: async () => {
      mockOps.push(`silent:${mockHint ?? '-'}`);
      // With a hint, Play services is asked for that account; without one it
      // answers with whoever is already in front.
      const wanted = mockIgnoresHint ? mockCurrent : (mockHint ?? mockCurrent);
      if (!wanted || !mockGrants.has(wanted)) return { type: 'noSavedCredentialFound', data: null };
      mockCurrent = wanted;
      return { type: 'success', data: { user: { email: wanted }, idToken: 'id' } };
    },
    signIn: async () => {
      mockOps.push('signIn');
      if (!mockPicks) return { type: 'cancelled', data: null };
      mockCurrent = mockPicks;
      return { type: 'success', data: { user: { email: mockPicks }, idToken: 'id' } };
    },
    getTokens: async () => {
      mockOps.push(`getTokens:${mockCurrent ?? '-'}`);
      if (mockStall) await mockStall;
      if (!mockCurrent) throw new Error('Not signed in.');
      const token = mockGrants.get(mockCurrent);
      if (!token) throw Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' });
      return { accessToken: token, idToken: 'id' };
    },
    signOut: async () => {
      mockOps.push('signOut');
      mockCurrent = null;
      return null;
    },
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

import { __resetGoogleAuthForTests, googleAuth } from '../googleAuth';

const ALICE = 'alice@example.com';
const BOB = 'bob@work.example';

beforeEach(() => {
  jest.clearAllMocks();
  __resetGoogleAuthForTests();
  mockGrants.clear();
  mockGrants.set(ALICE, 'at-alice');
  mockGrants.set(BOB, 'at-bob');
  mockCurrent = null;
  mockHint = undefined;
  mockPicks = null;
  mockOps = [];
  mockStall = null;
  mockIgnoresHint = false;
});

describe('signIn', () => {
  it('returns a session with the address from Play services, lower-cased', async () => {
    mockPicks = ALICE;
    const session = await googleAuth.signIn();
    expect(session.email).toBe(ALICE);
    expect(session.accessToken).toBe('at-alice');
    expect(session.provider).toBe('gmail');
  });

  it('signs the current user out first, so a second mailbox can be picked', async () => {
    // Without this, Play services answers `signIn()` with whoever is already in
    // front and never shows the picker — so "add account" would silently
    // re-add the account the user is trying to add a second one beside.
    mockPicks = ALICE;
    await googleAuth.signIn();

    mockOps = [];
    mockPicks = BOB;
    const second = await googleAuth.signIn();

    expect(mockOps.indexOf('signOut')).toBeLessThan(mockOps.indexOf('signIn'));
    expect(second.email).toBe(BOB);
  });

  it('maps a cancelled sign-in to `cancelled`, not `failed`', async () => {
    mockPicks = null;
    await expect(googleAuth.signIn()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('names Play services when it is unavailable, rather than crashing', async () => {
    mockHasPlayServices.mockRejectedValueOnce(new Error('no play services'));
    await expect(googleAuth.signIn()).rejects.toThrow(/play services/i);
  });
});

describe('restoreAll', () => {
  it('is empty when nobody is signed in', async () => {
    mockGrants.clear();
    await expect(googleAuth.restoreAll()).resolves.toEqual([]);
  });

  it('restores whoever is in front when no address is known', async () => {
    // A first launch, and an install from before the account registry existed.
    mockCurrent = ALICE;
    const [session] = await googleAuth.restoreAll();
    expect(session?.email).toBe(ALICE);
  });

  it('restores every named mailbox, without an interactive prompt', async () => {
    const sessions = await googleAuth.restoreAll([ALICE, BOB]);

    expect(sessions.map((s) => s.email)).toEqual([ALICE, BOB]);
    // Each carries its **own** token, which is the property the whole
    // account-multiplexing design exists to keep true.
    expect(sessions.map((s) => s.accessToken)).toEqual(['at-alice', 'at-bob']);
    expect(mockOps).not.toContain('signIn');
  });

  it('asks Play services for each account by name', async () => {
    await googleAuth.restoreAll([ALICE, BOB]);
    expect(mockOps).toContain(`configure:${ALICE}`);
    expect(mockOps).toContain(`configure:${BOB}`);
  });

  it('omits a revoked mailbox and keeps the one that still works', async () => {
    // The failure this guards: one dead grant costing the user the other
    // mailbox, which is what a single `restoreAll` that throws would do.
    mockGrants.delete(ALICE);
    const sessions = await googleAuth.restoreAll([ALICE, BOB]);
    expect(sessions.map((s) => s.email)).toEqual([BOB]);
  });

  it('throws when nothing restored and something failed', async () => {
    // An offline launch must reach the user as an error, not as a silent
    // sign-out of every mailbox they have.
    mockGrants.clear();
    await expect(googleAuth.restoreAll([ALICE])).rejects.toMatchObject({
      code: 'reauth-required',
    });
  });
});

describe('two mailboxes at once', () => {
  it('hands each account its own token', async () => {
    await expect(googleAuth.freshAccessToken(ALICE)).resolves.toBe('at-alice');
    await expect(googleAuth.freshAccessToken(BOB)).resolves.toBe('at-bob');
  });

  it('never interleaves one account with another', async () => {
    // The bug this exists for: A configures, B configures, then A's getTokens
    // runs against B's user and the Gmail client reads the wrong inbox. The
    // stall forces the overlap that would expose it.
    let release!: () => void;
    mockStall = new Promise<void>((resolve) => {
      release = resolve;
    });

    const both = Promise.all([googleAuth.freshAccessToken(ALICE), googleAuth.freshAccessToken(BOB)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    mockStall = null;

    await expect(both).resolves.toEqual(['at-alice', 'at-bob']);
    // One account's configure/sign-in/token triple completes before the other
    // begins — the sequence, not just the results, is the guarantee.
    expect(mockOps.indexOf(`getTokens:${ALICE}`)).toBeLessThan(mockOps.indexOf(`configure:${BOB}`));
  });

  it('refuses to hand back a token when Play services returns another account', async () => {
    // `accountName` is documented as an account that should be "prioritized",
    // not one that is forced — so this is the failure the whole design rests on
    // not happening silently. The caller must get an error, never another
    // mailbox's token, which would read and could send from the wrong account.
    mockIgnoresHint = true;
    mockCurrent = BOB;

    const refused = googleAuth.freshAccessToken(ALICE);
    // `failed`, not `reauth-required`: Alice's grant may be perfectly good, and
    // signing in again fixes nothing. Calling an unrecognised failure permanent
    // is the inversion `revocation.ts` exists to prevent.
    await expect(refused).rejects.toMatchObject({ code: 'failed' });
    await expect(refused).rejects.toThrow(new RegExp(BOB));
    // Nothing was minted under Alice's name on the way out.
    expect(mockOps).not.toContain(`getTokens:${ALICE}`);
  });

  it('signs out one mailbox without touching the other', async () => {
    await googleAuth.restoreAll([ALICE, BOB]);
    await googleAuth.signOut(BOB);

    // Alice is still reachable; Bob has to be signed in again.
    await expect(googleAuth.freshAccessToken(ALICE)).resolves.toBe('at-alice');
    mockGrants.delete(BOB);
    await expect(googleAuth.freshAccessToken(BOB)).rejects.toMatchObject({
      code: 'reauth-required',
    });
  });
});

describe('token cache', () => {
  it('serves a second request for the same mailbox without asking again', async () => {
    // A merged-inbox refresh is `limit + 1` requests per account; without this
    // each one would re-point Play services at a different user.
    await googleAuth.freshAccessToken(ALICE);
    mockOps = [];
    await expect(googleAuth.freshAccessToken(ALICE)).resolves.toBe('at-alice');
    expect(mockOps).toEqual([]);
  });

  it('shares one getTokens call across concurrent requests for one mailbox', async () => {
    // The library overwrites an in-flight getTokens promise rather than
    // queueing, and the overwritten one never settles — the inbox then waits
    // forever on a dead promise (observed on a device, 2026-08-08).
    const [a, b] = await Promise.all([
      googleAuth.freshAccessToken(ALICE),
      googleAuth.freshAccessToken(ALICE),
    ]);
    expect([a, b]).toEqual(['at-alice', 'at-alice']);
    expect(mockOps.filter((op) => op.startsWith('getTokens')).length).toBe(1);
  });

  it('never serves one account a token cached for another', async () => {
    await googleAuth.freshAccessToken(ALICE);
    await expect(googleAuth.freshAccessToken(BOB)).resolves.toBe('at-bob');
  });
});

describe('freshAccessToken', () => {
  it('signs that one account out when its grant is revoked', async () => {
    await googleAuth.restoreAll([ALICE, BOB]);
    mockGrants.delete(BOB);
    // Past the cache the restore filled, so the revocation is actually reached.
    await googleAuth.signOut(BOB);

    await expect(googleAuth.freshAccessToken(BOB)).rejects.toMatchObject({
      code: 'reauth-required',
    });
    // The other mailbox is untouched — the whole point of doing this per
    // account rather than clearing everything.
    await expect(googleAuth.freshAccessToken(ALICE)).resolves.toBe('at-alice');
  });

  it('keeps the session when the network is down', async () => {
    // Signing the user out over a dropped connection would lose a perfectly
    // good grant. Transient by default is the rule `revocation.ts` protects.
    mockCurrent = ALICE;
    mockStall = Promise.reject(new Error('Network request failed'));
    mockStall.catch(() => {});

    await expect(googleAuth.freshAccessToken(ALICE)).rejects.toMatchObject({ code: 'failed' });
    mockStall = null;

    // Still signed in: the grant was never cleared.
    await expect(googleAuth.freshAccessToken(ALICE)).resolves.toBe('at-alice');
  });
});
