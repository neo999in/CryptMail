# Native Google Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace an OAuth redirect flow Google will not accept with native Play-services sign-in, so CryptMail can reach a real Gmail mailbox.

**Architecture:** `googleAuth.ts` keeps its `AuthProvider` shape and swaps its insides — `AuthSession` PKCE for `@react-native-google-signin/google-signin`. Tokens stop being persisted: Play services owns the refresh token, so the session is derived via `signInSilently()` / `getTokens()`. `config.ts` gains a Play-services availability test so a web build degrades honestly instead of claiming a mailbox it cannot reach.

**Tech Stack:** Expo SDK 57 · React Native 0.86 · `@react-native-google-signin/google-signin` · jest-expo

**Spec:** [2026-08-08-google-auth-native-design.md](../specs/2026-08-08-google-auth-native-design.md)

## Global Constraints

- **Claude never runs a git command that writes.** Commit steps are printed for a human. (CLAUDE.md.)
- **No secrets in the repo.** Client ids live in `app/.env`, which is gitignored. `.env.example` carries placeholders only.
- **Mail and crypto capabilities stay independent.** `config.ts` separates them on purpose so transport can be proven before the crypto core; `config-test.ts` asserts all four combinations. The module `mailMode` tests for is the **sign-in library**, never the crypto core.
- **A downgrade is reported, never hidden.** Anything that makes mail or crypto less than real must surface through `demoReason()`.
- **Scopes are `openid`, `email`, `https://www.googleapis.com/auth/gmail.modify`.** Decided 2026-08-08; changing later forces re-consent.
- **The Web client id is what the code uses**, even on Android. The Android client exists in the console so Play services can match package + SHA-1, and is never named in code.
- Tests live in a sibling `__tests__/<name>-test.ts` — the jest `testMatch` in `app/package.json`. Anywhere else and they silently never run.
- All npm commands run from `app/`. Node 22+.

## File Structure

| File | Responsibility |
|---|---|
| `app/src/auth/googleAuth.ts` | **Rewrite the body.** Play-services sign-in behind the unchanged `AuthProvider`. |
| `app/src/auth/__tests__/googleAuth-test.ts` | **Create.** Drives the provider against a fake `GoogleSignin`. |
| `app/src/config.ts` | **Modify.** New env var, `gmail.modify`, Play-services test, new `demoReason()` case. |
| `app/src/__tests__/config-test.ts` | **Modify.** Third axis: sign-in module present or not. |
| `app/.env.example` | **Modify.** Retire the old variable name. |
| `app/app.json` | **Modify.** Add the config plugin. |
| `docs/*` | **Modify.** handoff §2.4, implementation-status §5.3, features. |

## Task ordering and the credential

Tasks 1–5 need **no** Google credential and are fully testable. Task 6 needs the
console clients and an emulator, and nothing in it may be claimed as working
until it has actually run. This ordering is deliberate: the handoff records what
unverified native work cost this project once already.

---

### Task 1: Install the library and prove the crypto core survives prebuild

**Files:**
- Modify: `app/package.json` (via npm), `app/app.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `@react-native-google-signin/google-signin` importable; native project regenerated.

- [ ] **Step 1: Install**

Run (from `app/`): `npx expo install @react-native-google-signin/google-signin`

`expo install` rather than `npm install` so the version is matched to SDK 57.

- [ ] **Step 2: Add the config plugin**

In `app/app.json`, inside `expo.plugins`, add the string `"@react-native-google-signin/google-signin"`. No `iosUrlScheme` is needed — this is an Android-only build today.

- [ ] **Step 3: Regenerate the native project**

Run (from `app/`): `npx expo prebuild -p android`

- [ ] **Step 4: Prove the crypto core survived**

This is the point of the task. `app/android/` is regenerated, and trap 3 in `docs/handoff.md` is the reason the `.so` and generated Kotlin live in `app/modules/cryptmail-core/android/src/main/` instead. Verify rather than assume:

```powershell
Get-ChildItem app\modules\cryptmail-core\android\src\main\jniLibs -Recurse -Filter *.so
Get-ChildItem app\modules\cryptmail-core\android\src\main\java\uniffi -Recurse -Filter *.kt
```

Both must still exist. If either is gone, rebuild them with the two commands in `docs/handoff.md` §1 before continuing — a missing `.so` sends the app silently back to demo crypto.

- [ ] **Step 5: Build and confirm the app still runs**

Run (from `app/`): `npx expo run:android`

The banner must still report real encryption. `getNativeCore()` returning non-null is what drives it; a banner saying otherwise means step 4 lied.

- [ ] **Step 6: Commit — print this for a human, do not run it**

```powershell
git add app/package.json app/package-lock.json app/app.json
git commit -m "build(auth): add the native Google sign-in module"
```

---

### Task 2: Config — scopes, the new client id, and honest web degradation

**Files:**
- Modify: `app/src/config.ts`, `app/.env.example`
- Test: `app/src/__tests__/config-test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GOOGLE_WEB_CLIENT_ID`, `hasGoogleClient`, `hasSignInModule`, `mailMode`, `GMAIL_SCOPES` containing `gmail.modify`.

- [ ] **Step 1: Write the failing tests**

`config-test.ts` currently has a two-axis `loadConfig(clientId, coreKind)`. It gains a third axis, and the old env var name changes. Replace the loader and add the new cases:

```typescript
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
```

and update the `afterEach` to `delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;`.

New tests:

```typescript
describe('the sign-in module is a separate capability from the crypto core', () => {
  it('falls back to demo mail where Play services cannot run, even with a client id', () => {
    // The web build. Claiming a real mailbox it cannot reach would be exactly
    // the silent downgrade demoReason() exists to prevent.
    const c = loadConfig(CLIENT, 'native', false);
    expect(c.mailMode).toBe('demo');
    expect(c.demoReason()).toMatch(/play services/i);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `app/`): `npx jest src/__tests__/config-test.ts`
Expected: FAIL — `GOOGLE_WEB_CLIENT_ID` is not read, so `mailMode` is `demo` in every case and the scope assertions fail.

- [ ] **Step 3: Implement**

In `app/src/config.ts`:

```typescript
import { GoogleSignin } from '@react-native-google-signin/google-signin';

/**
 * The **Web**-type client id, even though this runs on Android — the sign-in
 * library uses it to identify the backend that tokens are minted for. The
 * Android client (package + signing SHA-1) also has to exist in the console, but
 * is never named here: Play services matches it implicitly.
 */
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

/**
 * Read, send, and change flags. `updateFlags` calls `messages.modify`, so star,
 * archive and mark-read 403 without this — and those are built, shipped UI.
 *
 * The trade is deliberate and worth stating: `gmail.modify` reads on the consent
 * screen as permission to change and delete mail, which is broader than this app
 * needs for anything but flags. Raising it later would force every user to
 * re-consent, so it is chosen up front rather than discovered.
 */
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
];

export const hasGoogleClient = GOOGLE_WEB_CLIENT_ID.length > 0;
export const hasNativeCore = core.kind === 'native';

/**
 * Whether Play-services sign-in can run at all. False on web, where the native
 * module does not exist — and a web build that claimed a real mailbox would be
 * the same silent downgrade as trap 1 in the handoff, where a working core was
 * reported missing.
 */
export const hasSignInModule = typeof GoogleSignin?.configure === 'function';

export const mailMode: MailMode = hasGoogleClient && hasSignInModule ? 'gmail' : 'demo';
```

Delete `GOOGLE_CLIENT_ID` and update the header comment block, which still names `EXPO_PUBLIC_GOOGLE_CLIENT_ID`.

Add the case to `demoReason()`, before the existing fixtures line:

```typescript
  if (hasGoogleClient && !hasSignInModule) {
    return 'Demo mailbox: Google sign-in needs Play services, which this platform does not have, so mail is served from fixtures.';
  }
```

- [ ] **Step 4: Update `.env.example`**

```
# Copy to .env and fill in. .env is gitignored — never commit real values.
# Without this the app serves mail from fixtures.
#
# This is the **Web** client id from Google Cloud, even though the app runs on
# Android. An Android client (package + signing SHA-1) must also exist in the
# console, but is not referenced here.
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `app/`): `npx jest src/__tests__/config-test.ts` then `npx tsc --noEmit`
Expected: PASS, clean typecheck. `tsc` will flag `googleAuth.ts`'s reference to the deleted `GOOGLE_CLIENT_ID` — that is Task 3, and it is expected to be red between these two tasks.

- [ ] **Step 6: Commit — print this for a human, do not run it**

```powershell
git add app/src/config.ts app/src/__tests__/config-test.ts app/.env.example
git commit -m "feat(auth): request gmail.modify and degrade honestly without Play services"
```

---

### Task 3: Rewrite the provider

**Files:**
- Rewrite: `app/src/auth/googleAuth.ts`
- Test: `app/src/auth/__tests__/googleAuth-test.ts` (create)

**Interfaces:**
- Consumes: `GOOGLE_WEB_CLIENT_ID`, `GMAIL_SCOPES`, `hasGoogleClient` (Task 2); `AuthError`, `Session`, `AuthProvider` from `auth/types.ts`; `isPermanentAuthFailure`, `describeError` from `auth/revocation.ts`.
- Produces: `googleAuth: AuthProvider`, unchanged in shape.

- [ ] **Step 1: Write the failing tests**

Create `app/src/auth/__tests__/googleAuth-test.ts`. The fake mirrors the library's real discriminated-union responses — a fake with a looser shape would let a bug through that the real module would produce:

```typescript
/**
 * The provider against a fake Play-services module.
 *
 * The composition is what these cover: which library response maps to which
 * AuthError, and — the one that matters — that a dropped connection never signs
 * a user out of a working account. That asymmetry is `revocation.ts`'s whole
 * reason to exist, and it is easy to lose in a rewrite.
 */
const signIn = jest.fn();
const signInSilently = jest.fn();
const getTokens = jest.fn();
const signOutFn = jest.fn();
const hasPlayServices = jest.fn(async () => true);

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    signIn: (...a: unknown[]) => signIn(...a),
    signInSilently: (...a: unknown[]) => signInSilently(...a),
    getTokens: (...a: unknown[]) => getTokens(...a),
    signOut: (...a: unknown[]) => signOutFn(...a),
    hasPlayServices: (...a: unknown[]) => hasPlayServices(...a),
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
import { AuthError } from '../types';

const USER = { type: 'success', data: { user: { email: 'Alice@Example.com' }, idToken: 'id' } };

beforeEach(() => {
  jest.clearAllMocks();
  getTokens.mockResolvedValue({ accessToken: 'at-1', idToken: 'id' });
});

describe('signIn', () => {
  it('returns a session with the address from Play services, lower-cased', async () => {
    signIn.mockResolvedValue(USER);
    const session = await googleAuth.signIn();
    expect(session.email).toBe('alice@example.com');
    expect(session.accessToken).toBe('at-1');
    expect(session.provider).toBe('gmail');
  });

  it('maps a cancelled sign-in to `cancelled`, not `failed`', async () => {
    signIn.mockResolvedValue({ type: 'cancelled', data: null });
    await expect(googleAuth.signIn()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('names Play services when it is unavailable, rather than crashing', async () => {
    hasPlayServices.mockRejectedValueOnce(new Error('no play services'));
    await expect(googleAuth.signIn()).rejects.toThrow(/play services/i);
  });
});

describe('restore', () => {
  it('is null when nobody is signed in', async () => {
    signInSilently.mockResolvedValue({ type: 'noSavedCredentialFound', data: null });
    await expect(googleAuth.restore()).resolves.toBeNull();
  });

  it('rebuilds the session without an interactive prompt', async () => {
    signInSilently.mockResolvedValue(USER);
    const session = await googleAuth.restore();
    expect(session?.email).toBe('alice@example.com');
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe('freshAccessToken', () => {
  it('asks Play services rather than caching a token itself', async () => {
    signInSilently.mockResolvedValue(USER);
    getTokens.mockResolvedValue({ accessToken: 'at-2', idToken: 'id' });
    await expect(googleAuth.freshAccessToken()).resolves.toBe('at-2');
  });

  it('signs the user out when the grant is revoked', async () => {
    signInSilently.mockResolvedValue(USER);
    getTokens.mockRejectedValue(Object.assign(new Error('invalid_grant'), { code: 'invalid_grant' }));
    await expect(googleAuth.freshAccessToken()).rejects.toMatchObject({ code: 'reauth-required' });
    expect(signOutFn).toHaveBeenCalled();
  });

  it('keeps the session when the network is down', async () => {
    // Signing out over a dropped connection would lose a perfectly good grant.
    signInSilently.mockResolvedValue(USER);
    getTokens.mockRejectedValue(new Error('Network request failed'));
    await expect(googleAuth.freshAccessToken()).rejects.toMatchObject({ code: 'failed' });
    expect(signOutFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `app/`): `npx jest src/auth/__tests__/googleAuth-test.ts`
Expected: FAIL — the module still imports `expo-auth-session` and `GOOGLE_CLIENT_ID`, which no longer exists.

- [ ] **Step 3: Rewrite the provider**

Replace the body of `app/src/auth/googleAuth.ts`. Keep the file's existing header comment about tokens never being logged, and add why they are no longer stored:

```typescript
/**
 * Gmail sign-in through Google Play services.
 *
 * There is no redirect URI and no PKCE exchange here, because Google no longer
 * accepts a custom URI scheme from an Android OAuth client — see
 * `docs/superpowers/specs/2026-08-08-google-auth-native-design.md`.
 *
 * Nothing is persisted. Play services holds the refresh token and mints access
 * tokens on demand, so this module keeps no long-lived secret at all — an
 * improvement on the previous design, which wrote both tokens to secure storage.
 */
import {
  GoogleSignin,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
} from '@react-native-google-signin/google-signin';

import { GMAIL_SCOPES, GOOGLE_WEB_CLIENT_ID, hasGoogleClient } from '../config';
import { describeError, isPermanentAuthFailure } from './revocation';
import { AuthError, AuthProvider, Session } from './types';

let configured = false;

function configure() {
  if (configured) return;
  GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, scopes: GMAIL_SCOPES });
  configured = true;
}

async function requirePlayServices() {
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch (e) {
    throw new AuthError(
      `Google sign-in needs Google Play services, which this device does not have: ${describeError(e)}`,
      'failed',
    );
  }
}

/** Play services owns expiry; this is advisory, so callers keep a sane number. */
const ADVISORY_TTL_MS = 3600_000;

async function sessionFrom(user: { user: { email?: string | null } }): Promise<Session> {
  const { accessToken } = await GoogleSignin.getTokens();
  return {
    provider: 'gmail',
    email: (user.user.email ?? '').toLowerCase(),
    accessToken,
    expiresAt: Date.now() + ADVISORY_TTL_MS,
  };
}

export const googleAuth: AuthProvider = {
  provider: 'gmail',

  async signIn(): Promise<Session> {
    if (!hasGoogleClient) {
      throw new AuthError(
        'No Google client id is configured (EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).',
        'not-configured',
      );
    }
    configure();
    await requirePlayServices();

    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw new AuthError('Sign-in was cancelled.', 'cancelled');
    }
    return sessionFrom(response.data);
  },

  async restore(): Promise<Session | null> {
    if (!hasGoogleClient) return null;
    configure();

    const response = await GoogleSignin.signInSilently();
    if (isNoSavedCredentialFoundResponse(response) || !isSuccessResponse(response)) return null;
    return sessionFrom(response.data);
  },

  async signOut(): Promise<void> {
    configure();
    await GoogleSignin.signOut();
  },

  async freshAccessToken(): Promise<string> {
    configure();
    const response = await GoogleSignin.signInSilently();
    if (!isSuccessResponse(response)) {
      throw new AuthError('Not signed in.', 'reauth-required');
    }

    try {
      const { accessToken } = await GoogleSignin.getTokens();
      return accessToken;
    } catch (e) {
      if (isPermanentAuthFailure(e)) {
        // The grant is gone; nothing cached can ever work again. Clearing it
        // here is what stops every later call failing the same way.
        await GoogleSignin.signOut();
        throw new AuthError(
          'Access to your Google account was revoked or expired. Sign in again to continue.',
          'reauth-required',
        );
      }
      // Offline, or Google returning a 5xx. Keep the session: signing the user
      // out over a dropped connection loses a perfectly good grant.
      throw new AuthError(`Could not refresh the session: ${describeError(e)}`, 'failed');
    }
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `app/`): `npx jest src/auth/__tests__/googleAuth-test.ts`
Expected: PASS, 8 tests.

If `signs the user out when the grant is revoked` fails, check `isPermanentAuthFailure` in `revocation.ts` — it was written against the shape `AuthSession` threw, and Play services may report a revoked grant differently. **Widen the predicate, with a test; do not weaken the asymmetry** by treating unknown errors as permanent. Signing a user out on an unrecognised error is the failure mode §7.4 exists to prevent.

- [ ] **Step 5: Full check**

Run (from `app/`): `npx tsc --noEmit` then `npm test -- --ci`
Expected: clean, all suites.

- [ ] **Step 6: Commit — print this for a human, do not run it**

```powershell
git add app/src/auth/googleAuth.ts app/src/auth/__tests__/googleAuth-test.ts
git commit -m "feat(auth): sign in through Play services instead of an OAuth redirect"
```

---

### Task 4: Remove the dead dependency

**Files:**
- Modify: `app/package.json`

**Interfaces:**
- Consumes: Task 3, which removed the last import of `expo-auth-session`.
- Produces: nothing.

- [ ] **Step 1: Confirm nothing imports it**

Run (from `app/`): `Select-String -Path src -Include *.ts,*.tsx -Recurse -Pattern "expo-auth-session"`
Expected: no matches. If there are any, they belong to Task 3 and it is not finished.

- [ ] **Step 2: Remove it**

Run (from `app/`): `npm uninstall expo-auth-session`

- [ ] **Step 3: Verify**

Run (from `app/`): `npx tsc --noEmit` then `npm test -- --ci`
Expected: clean, all suites pass.

- [ ] **Step 4: Commit — print this for a human, do not run it**

```powershell
git add app/package.json app/package-lock.json
git commit -m "chore(auth): drop expo-auth-session, now unused"
```

---

### Task 5: Docs

**Files:**
- Modify: `docs/handoff.md` §2.4, `docs/implementation-status.md` §5.3, `docs/features.md`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: nothing in code.

- [ ] **Step 1: Rewrite handoff §2.4**

It currently predicts a `redirect_uri_mismatch` and suggests the reversed-client-id scheme. Both are wrong: Google refuses custom URI schemes from Android clients entirely. Replace with the native approach, the two console clients, and the SHA-1. State the Play-services cost — no de-Googled devices, no web sign-in.

- [ ] **Step 2: Reverse the scope note**

Handoff §2.4 records least-privilege as "a deliberate least-privilege choice, not an oversight". That decision was reversed on 2026-08-08 in favour of `gmail.modify`, so star/archive/mark-read work. Say that it was reversed and why, rather than editing it to look like it was always so.

- [ ] **Step 3: Update the other two**

`implementation-status.md` §5.3 ("Google OAuth — ⛔") currently says
`auth/googleAuth.ts` and `mail/gmail.ts` "are complete and were read, but have
**never been run against Google**". After Task 3 the first half is false —
`googleAuth.ts` was rewritten because the approach it implemented cannot work.
Say that, and keep the second half: still never run against Google.

The "Capability split" entry near the top also needs a line: `mailMode` now
depends on Play services as well as a client id, and the two capabilities are
still independent of each other.

`features.md` wherever it describes OAuth as pending or names the redirect flow.

- [ ] **Step 4: Check every claim**

Nothing here may assert a working sign-in. At this point in the plan no credential exists and nothing has spoken to Google. Say what is built and what is unverified.

- [ ] **Step 5: Commit — print this for a human, do not run it**

```powershell
git add docs/
git commit -m "docs(auth): custom URI schemes are refused; record the native approach"
```

---

### Task 6: Verify against Google — needs the console credential

**Files:**
- Modify: `app/.env` (gitignored, never committed)

**Interfaces:**
- Consumes: everything above.
- Produces: evidence, and only then a docs update.

**Prerequisites, done by a human in the Google Cloud console:** the Gmail API enabled; a consent screen with `openid`, `email`, `gmail.modify` and the tester's address added as a test user; an **Android** client for package `app.cryptmail.prototype` with the debug SHA-1 `AD:CC:27:38:68:34:50:AE:D7:53:A4:C1:76:74:35:DF:55:FF:81:DA`; and a **Web** client whose id goes in `app/.env`.

- [ ] **Step 1: Configure and build**

```powershell
cp app\.env.example app\.env      # then set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
cd app; npx expo run:android
```

- [ ] **Step 2: Sign in**

Expect a Play-services account chooser, not a browser. Afterwards the banner must no longer say the mailbox is demo, and the inbox must show real mail.

- [ ] **Step 3: Exercise the scope**

Star a message, mark one unread, archive one. All three call `messages.modify`; a 403 here means the consent screen did not actually grant `gmail.modify` — re-check the scope list, and remember an existing grant does not pick up new scopes without re-consent.

- [ ] **Step 4: Prove the refresh, the open question in the spec**

This is the step worth doing carefully, because §7.3's background scheduler depends on it and the library's Android refresh semantics are documented ambiguously.

Sign in, background the app for longer than an access token's life (an hour is definitive; Google's default), return, and pull to refresh. It must fetch without an interactive prompt. If it demands a fresh sign-in, say so plainly — that is a finding that changes the scheduler's design, not a bug to paper over.

- [ ] **Step 5: Prove the revocation path**

Revoke CryptMail at <https://myaccount.google.com/permissions>, then use the app. It must report that access was revoked and require a new sign-in — not fail silently, and not sign out on some unrelated transient error.

- [ ] **Step 6: Record what actually happened**

Update `docs/implementation-status.md` and `docs/handoff.md` with the results — including anything that did not work. A doc claiming a verified sign-in that nobody performed is worse than one admitting it is untested.

- [ ] **Step 7: Commit — print this for a human, do not run it**

`app/.env` is gitignored and must never appear in `git status` as staged. Check before committing.

```powershell
git add docs/
git commit -m "docs(auth): record what the first real Google sign-in did"
```

---

## Definition of done

- `npx tsc --noEmit` and `npm test -- --ci` clean from `app/`.
- The app builds and runs, and the crypto core still reports real encryption after the prebuild.
- Sign-in reaches a real mailbox; star/archive/mark-read do not 403.
- Token refresh across an expiry is either proven, or its failure is written down.
- No doc claims anything that was not run.

## Deliberately not in this plan

- **iOS.** No `iosUrlScheme`, no iOS client. This is an Android build.
- **De-Googled Android and the web build.** Both lose sign-in under this design. Recorded in the spec as the accepted cost; revisit only with a hosted redirect, which means a server.
- **The background scheduler** (§7.3). Task 6 step 4 produces the fact it depends on; the work itself is separate.
- **Release signing.** The SHA-1 here is the debug keystore. A release build needs its own client entry.
