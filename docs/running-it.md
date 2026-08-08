# Running it

What works today, and exactly what you must do to turn each half on.

The app has **two independent capabilities** ([app/src/config.ts](../app/src/config.ts)):

| | Off (default) | On |
|---|---|---|
| `mailMode` | demo fixtures | real Gmail — needs an OAuth client id |
| `cryptoMode` | `demoCore`, base64, **not encryption** | real post-quantum crypto — needs the native core |

They are deliberately independent, so you can commission one without the other.
`appMode === 'live'` only when both are on.

---

## 0. Today, with nothing configured

```bash
cd app && npm install && npm run web
```

Full UI, demo fixtures, and a banner saying nothing is really encrypted. Useful
for reviewing the UI; not useful for anything else.

---

## 1. Real Gmail — no Rust needed

The OAuth and Gmail code is already written ([auth/googleAuth.ts](../app/src/auth/googleAuth.ts),
[mail/gmail.ts](../app/src/mail/gmail.ts)). What is missing is a client id.

### 1a. Google Cloud (~1 hour, mostly waiting on the console)

1. Create a project and **enable the Gmail API**.
2. **OAuth consent screen** → External, in **Testing** mode. Add both Gmail
   accounts you intend to test with as test users. They will not work otherwise.
3. **Credentials → OAuth client ID → Android.** This one is never named in code.
   Play services matches it implicitly, by package name and signing certificate.
   - Package name: `app.cryptmail.prototype` (from [app/app.json](../app/app.json))
   - SHA-1: **the fingerprint of `app/android/app/debug.keystore`**, which is what
     Gradle signs with — *not* `~/.android/debug.keystore`, which signs nothing
     here. Read it off the APK itself:

     ```powershell
     & "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.1.0\apksigner.bat" verify `
       --print-certs app\android\app\build\outputs\apk\debug\app-debug.apk
     ```

     Get this wrong and sign-in fails with `DEVELOPER_ERROR` (status 10) *after*
     you pick an account — which looks like a code bug and is not. See
     [handoff.md](handoff.md) §2.4.
4. **Credentials → OAuth client ID → Web application.** Create this one *as
   well*. Its id is what the app actually passes to the sign-in library, even on
   Android — it identifies the backend the tokens are minted for. Ignore the
   secret it is issued; the app never sees it.

Sign-in goes through **Google Play services**, not a browser redirect, because
Google refuses custom URI schemes from an Android client. A device without Play
services (a de-Googled ROM, the web build) cannot sign in at all — the app
detects this and stays on demo fixtures rather than pretending otherwise.

Scopes are `openid`, `email` and `gmail.modify`
([config.ts](../app/src/config.ts)). `gmail.modify` is a **restricted** scope:
Testing mode caps you at 100 users, which is fine here, but production needs
Google verification plus a CASA assessment. Start that clock early if it
matters. Add all three to the consent screen before signing in — an existing
grant does not pick up new scopes without re-consent.

### 1b. Point the app at it

```bash
cp app/.env.example app/.env
# EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
```

The client id is **not** a secret — it ships inside the APK and anyone can
extract it. That is expected for a public client; security comes from Google
binding the Android client to your package name and signing SHA-1, which an
attacker cannot forge. `.env` is gitignored for hygiene, not secrecy.

This setup **has been run** — 2026-08-08, on an emulator, against a real Gmail
account: sign-in completes through the Play-services chooser, the inbox lists
real mail, and star and archive persist server-side. Token refresh across an
expiry and the revocation path are still unproven. See
[implementation-status.md](implementation-status.md) §5.3 for exactly what was
and was not observed.

---

## 2. Real post-quantum encryption

The crate is written and tested: [core/](../core/). It generates Stage 1 hybrid
identities per [post-quantum.md](post-quantum.md) — Ed25519 primary, ML-KEM-768 +
X25519 encryption subkey (RFC 9980).

```bash
cd core && cargo test     # 27 tests, no Android needed
```

What remains is getting it onto a phone. See [core/README.md](../core/README.md)
for the build. In outline:

1. Install the Android NDK and `cargo-ndk`; add the `aarch64-linux-android`
   Rust target.
2. Generate the UniFFI Kotlin bindings and cross-compile the crate.
3. Register the Kotlin module as `CryptMailCore` with the five methods in
   [nativeCore.ts](../app/src/core/nativeCore.ts).
4. `npx expo prebuild` → build and install the APK.

**Expo Go will not work** once a custom native module exists, and **web will
never load it** — a Kotlin module cannot run in a browser, so web stays on the
demo core permanently.

When `CryptMailCore` is registered, `getNativeCore()` finds it and nothing else
changes: `cryptoMode` flips to `real` on its own.

---

## 3. Testing encryption without Google

You do not need OAuth to exercise the crypto. Because the core is selected
independently of the mail provider, linking the native core with **no** `.env`
gives you real encryption over the demo mailbox — and `demoMail.send()` puts a
sent message straight into the inbox store, so a full loop works on one device:

> compose → real ML-KEM encrypt → appears in the inbox as ciphertext → open →
> real decrypt → subject restored

### What changes when the real core loads

The demo fixtures used to break here; that is handled now. With
`core.kind === 'native'`:

- The demo keyring is **not** seeded. `demoContactKeys` are `fakePublicKey()`
  armor a real OpenPGP parser rejects, and importing them threw — leaving an
  error banner and an empty keyring, with encrypted send blocked for everyone.
- The demo mailbox serves **no** `demoCore` ciphertext, and says so in a
  plaintext message rather than showing rows that fail to open.

They cannot simply be regenerated with the real core: encrypting *from* Anya
needs Anya's private key, which the demo does not have and should not ship. So
encrypted demo mail now comes from sending one to yourself, which round-trips
through the real core and demonstrates more.

---

## What is still not true

- **Nothing has run on Android.** No SDK, no NDK, no device. The Rust core has
  never been cross-compiled and the Kotlin module
  ([`app/modules/cryptmail-core/`](../app/modules/cryptmail-core)) has never been
  compiled. This is now the only thing standing between the prototype and its
  one-sentence goal.
- **Google OAuth has never run against Google.** No `.env`, no Cloud project.
- **The scheduler only runs while the app runs.** Real background delivery needs
  `expo-background-task`, which cannot be verified without a device.
- **Recovery does not exist.** The device key protecting local storage has no
  backup path, so a lost or wiped device is a lost keyring.

Interop, local encryption at rest, the verification ceremony and
token-revocation handling were on this list and are not any more — see
[implementation-status.md](implementation-status.md) for what each was replaced
with and what it still does not prove.
