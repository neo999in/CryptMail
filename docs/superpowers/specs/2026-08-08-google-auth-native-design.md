# Google sign-in without a redirect URI — design

Written 2026-08-08. Replaces the OAuth approach assumed by §2.4 of
[handoff.md](../../handoff.md) and by
[`app/src/auth/googleAuth.ts`](../../../app/src/auth/googleAuth.ts), which cannot
work as written.

## Why the current approach is dead, not merely broken

`googleAuth.ts` builds an `AuthSession` PKCE flow redirecting to
`cryptmail://oauth`. The handoff anticipated a `redirect_uri_mismatch` and
suggested switching to the reversed-client-id scheme
(`com.googleusercontent.apps.<id>:/…`).

Both are now refused. Google's
[OAuth 2.0 for native apps](https://developers.google.com/identity/protocols/oauth2/native-app)
states: *"Custom URI schemes are no longer supported on Android and Chrome
apps."* Loopback redirects are deprecated for the Android client type as well.

So there is no redirect URI an Android OAuth client will accept, and the fix is
not a scheme change in `app.json`. What remained:

| Option | Verdict |
|---|---|
| Custom scheme (`cryptmail://oauth`) | Refused. |
| Reversed client id | Refused — same rule. |
| Loopback `127.0.0.1` | Deprecated for the Android client type. |
| Hosted `https` redirect / App Links | Works, but needs a domain serving `assetlinks.json` — this project's first server, against "a client, never a provider". |
| **Native sign-in via Play services** | **Chosen.** No redirect URI exists to mismatch. |

## The chosen shape

`@react-native-google-signin/google-signin`. Play services returns tokens
in-process; there is no browser round trip and no redirect. No client secret and
no backend, so the "never a provider" rule holds.

**The cost, recorded rather than hidden:** sign-in now depends on Google Play
services. A de-Googled Android device cannot sign in, and neither can the web
build. That is a real narrowing of where CryptMail runs, accepted because the
alternative is standing up a server.

### API surface actually used

Verified against the library's
[API reference](https://react-native-google-signin.github.io/docs/api); the
response types are discriminated unions, not bare values.

```ts
GoogleSignin.configure({ webClientId, scopes });
GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true }); // → boolean
GoogleSignin.signIn();          // → { type: 'success', data: User } | { type: 'cancelled', data: null }
GoogleSignin.signInSilently();  // → { type: 'success', data: User } | { type: 'noSavedCredentialFound', data: null }
GoogleSignin.getTokens();       // → { accessToken: string, idToken: string }
GoogleSignin.clearCachedAccessToken(token: string);
GoogleSignin.signOut();
GoogleSignin.getCurrentUser();  // → User | null
```

`User.user.email` supplies the address, so `emailFromIdToken` and its base64url
decoding are no longer needed — one fewer hand-rolled JWT parse.

Use the exported `isSuccessResponse` / `isNoSavedCredentialFoundResponse` helpers
rather than comparing `type` strings by hand.

## What changes

`AuthProvider` in [`auth/types.ts`](../../../app/src/auth/types.ts) is unchanged —
`signIn` / `restore` / `signOut` / `freshAccessToken`. `AppState` and every screen
are untouched. Only the inside of `googleAuth.ts` is replaced: `AuthRequest`,
`exchangeCodeAsync`, `refreshAsync` and the `discovery` document all go.

### Tokens stop being persisted

Today both the access **and refresh** tokens are written to `expo-secure-store`.
Under Play services the refresh token never reaches JavaScript at all, so the
session becomes derived rather than stored:

- `restore()` → `signInSilently()`; `noSavedCredentialFound` means signed out.
- `freshAccessToken()` → `getTokens()`, which refreshes as needed.
- `signOut()` → `GoogleSignin.signOut()`.

This **deletes a stored long-lived secret** rather than relocating it. The
`Session` type keeps its shape for callers, but `refreshToken` becomes
permanently absent and `expiresAt` is advisory only — Play services owns expiry.

`revocation.ts` survives intact and still decides what signs a user out: a
revoked grant is permanent and clears the session, while a dropped connection is
transient and keeps it. That asymmetry was the point of §7.4 and does not change
just because the token source did. On a permanent failure, call
`clearCachedAccessToken` before surfacing `reauth-required`, so a stale token
cannot be handed out again.

### Two clients in the console, one in code

The library's `webClientId` is a **Web**-type client id, required even on
Android. The **Android** client (package + signing SHA-1) must also exist but is
never named in code — Play services matches it implicitly. Getting this backwards
is the most common setup failure.

- Android client: package `app.cryptmail.prototype`, debug SHA-1
  `AD:CC:27:38:68:34:50:AE:D7:53:A4:C1:76:74:35:DF:55:FF:81:DA`
- Web client: its id goes in `app/.env` as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`

`config.ts` gains that variable. `EXPO_PUBLIC_GOOGLE_CLIENT_ID` is retired; a
value left in `.env` under the old name must not silently satisfy the check.

### Scopes rise to `gmail.modify`

Decided 2026-08-08. `GMAIL_SCOPES` becomes `openid`, `email`,
`https://www.googleapis.com/auth/gmail.modify`.

`updateFlags` calls `messages.modify`, so star, mark-read and archive — all
already built and shipped in the UI — would 403 under the current
`readonly + send`. Raising the scope makes the built features work.

The trade is honest and must be recorded, not buried: `gmail.modify` reads on the
consent screen as permission to change and delete mail, which is broader than
this app needs for anything but flags. Two docs currently describe least-privilege
as a deliberate choice and now contradict the code —
[handoff.md](../../handoff.md) §2.4 and the comment on `GMAIL_SCOPES` in
[`config.ts`](../../../app/src/config.ts). Both change in the same commit.

### Web must degrade honestly

`mailMode` currently flips to `gmail` on nothing but a client id being present. A
web build would then claim a real mailbox it cannot reach, because the native
module is absent — the exact silent-downgrade failure `demoReason()` exists to
prevent, and the same bug class as trap 1 in the handoff (a core that was present
while the app reported it missing).

`mailMode` gains the same "is the native module actually here?" test `cryptoMode`
already applies, and `demoReason()` gains a case naming Play services as the
reason. No screen changes: the banner already renders whatever `demoReason()`
returns.

### Build

The library ships a config plugin, so `app.json` gains it and the native project
must be regenerated with `npx expo prebuild -p android`.

This is safe **because** of trap 3 in the handoff: the `.so` and generated Kotlin
live in `app/modules/cryptmail-core/android/src/main/`, not `app/android/`, and
survive a regeneration. Re-verify rather than assume — after the prebuild the
banner must still say encryption is real, which is `getNativeCore()` returning
non-null.

## Testing

Against a fake `GoogleSignin`, the way `nativeCore` is tested against a fake
bridge — the composition is where the bugs are:

- `restore()` returns null on `noSavedCredentialFound` rather than throwing
- `signIn()` maps `cancelled` to the existing `cancelled` AuthError, not `failed`
- `freshAccessToken()` returns the token from `getTokens()`
- a revoked grant → `reauth-required`, session cleared, `clearCachedAccessToken`
  called; a network failure → `failed`, session **kept** (the §7.4 asymmetry)
- `hasPlayServices()` false → an error naming Play services, not a crash

**Not verifiable without a credential**, and therefore not to be claimed until
run on the emulator: the grant itself, the consent screen, and the real token
lifecycle.

## The open uncertainty

`getTokens()`'s refresh behaviour on Android is documented ambiguously, and one
secondary source describes a different return shape from the API reference. What
matters is whether it keeps returning valid tokens across a long-lived session
without a fresh interactive sign-in.

**Prove this early**, because §7.3's background scheduler depends on it: if a
token cannot be refreshed while the app is backgrounded, scheduled sends fail in
a way no amount of scheduler work fixes. The cheapest check is signing in, then
forcing an expiry and calling `freshAccessToken()`.

## Sequencing

The console credential is a hard prerequisite for verification, not for writing
code — but this project already learned what unverified native work costs (the
Kotlin module, handoff §3). So: build and test everything that runs against a
fake first, and treat the credential-dependent parts as unproven until the
emulator says otherwise.

## Docs to update in the same change

[handoff.md](../../handoff.md) §2.4 (the redirect advice is wrong, and the scope
decision is reversed), [config.ts](../../../app/src/config.ts)'s least-privilege
comment and its header block naming `EXPO_PUBLIC_GOOGLE_CLIENT_ID`,
[`app/.env.example`](../../../app/.env.example) (which still names only the old
variable — a fresh clone would configure the wrong one and get demo mode with no
explanation), [implementation-status.md](../../implementation-status.md) §5.3, and
[features.md](../../features.md).

`key-management.md` needs no change: it never names the OAuth flow.
