# Running it

What works today, and exactly what you must do to turn each half on.

The app has **two independent capabilities** ([app/src/config.ts](../app/src/config.ts)):

| | Off (default) | On |
|---|---|---|
| `mailMode` | `unconfigured` — **no mailbox at all** | real Gmail — needs an OAuth client id |
| `cryptoMode` | `demoCore`, base64, **not encryption** | real post-quantum crypto — needs the native core |

They are deliberately independent, so you can commission one without the other.
`appMode === 'live'` only when both are on.

There used to be a third possibility here — a demo *mailbox* of fixtures, served
whenever no OAuth client was configured. It has been removed. Fake crypto and
fake mail are not the same kind of stand-in: `demoCore` is loudly reported as
insecure and still drives the real send path, whereas the fixture mailbox
quietly replaced the thing the product *is*, and every screen had to be read
twice to know which one it was describing.

---

## 0. Today, with nothing configured

```bash
cd app && npm install && npm run web
```

The connect screen, with sign-in **disabled** and `degradedReason()` explaining
that no OAuth client is configured. There is no mailbox to look at until you do
step 1. To review UI without a Google account, point the app at a Gmail account
you control — a throwaway is fine.

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
detects this and says so rather than pretending otherwise.

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

### 1c. Real Outlook — Azure app registration (~15 minutes, free)

The code is [auth/microsoftAuth.ts](../app/src/auth/microsoftAuth.ts) and
[mail/graph.ts](../app/src/mail/graph.ts). Like Gmail, all it needs is a client
id. Registering an app costs nothing and needs no Azure subscription or card.

1. Go to **entra.microsoft.com** (or portal.azure.com → *Microsoft Entra ID*)
   and sign in with any Microsoft account. If it says your account has no
   directory, sign up for a free Azure account first. That creates one, and app
   registrations are free.
2. **App registrations → New registration.**
   - Name: `CryptMail (dev)`.
   - Supported account types: **Accounts in any organizational directory and
     personal Microsoft accounts**. The app signs in through the `common`
     endpoint ([config.ts](../app/src/config.ts)), so a narrower choice will
     reject either outlook.com or work accounts at the consent page.
   - Redirect URI: platform **Public client/native (mobile & desktop)**, value
     **`cryptmail://auth`**, exactly as written. It must match
     `redirectUri()` in `microsoftAuth.ts`.
3. On the **Overview** page, copy **Application (client) ID**. That is the only
   value the app needs.
4. **API permissions → Add a permission → Microsoft Graph → Delegated**, and add
   `offline_access`, `openid`, `profile`, `User.Read`, `Mail.ReadWrite` and
   `Mail.Send`. Personal accounts consent for themselves on first sign-in. A work
   tenant may need its admin to grant consent.
5. Create **no** client secret or certificate. This is a public client using PKCE,
   and a secret shipped in an APK would not stay secret.
6. *(Optional, for `npm run web`.)* **Authentication → Add a platform →
   Single-page application**, with `http://localhost:8081` as its redirect URI.
   Microsoft only allows the browser's token call from an SPA-registered
   redirect. SPA refresh tokens last 24 hours, not the 90 days a native one gets.

Then add it to `app/.env` beside (or instead of) the Google one:

```bash
# EXPO_PUBLIC_MS_CLIENT_ID=00000000-0000-0000-0000-000000000000
```

Unlike Google, Microsoft *does* accept a custom scheme from a mobile client, so
sign-in is a browser tab that returns through `cryptmail://auth`. There is no
native SDK and no Play-services requirement. The `cryptmail` scheme comes from
[app/app.json](../app/app.json). After changing it, run `npx expo prebuild`
again so the Android intent filter matches.

Microsoft issues the refresh token to the app itself, unlike Google, where Play
services keeps it. It is stored in the OS keystore, one entry per mailbox, and
never in app state. Signing out deletes it from the device. Microsoft has no
revocation endpoint for public clients, so the grant itself stays until the user
removes the app at account.live.com/consent/Manage.

**This setup has been run.** On 2026-09-10 it was tested on an emulator against a
real outlook.com mailbox, alongside a Gmail one:

- Sign-in: the Custom Tab picker, consent, and the redirect back to the app.
- Display name and profile photo come from Graph.
- Inbox, Sent, Archive, Spam (Junk) and Trash (Deleted Items) all list.
- Star survives a full re-fetch. Mark unread works.
- Archive lands in the `archive` folder, and swiping it back restores it.
- Move to Trash lands in Deleted Items, and Restore brings it back. Both are
  round trips on the same message id, which is the immutable-id header at work.
- After a cold restart, both mailboxes come back with no browser and no password.

**Still unproven:** encrypted send and decrypt through Graph (whether `/$value`
of a received PGP/MIME message still decrypts once Exchange has stored it), and
harvesting Autocrypt keys from `internetMessageHeaders`.

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

## 3. Testing encryption

You need a Gmail account to exercise the crypto, because there is no fixture
mailbox to stand in for one. A throwaway account is enough — see
[`docs/handoff.md`](handoff.md) for the one already used for this.

With the native core linked and an OAuth client configured, send a message to
yourself. It round-trips on one device:

> compose → real ML-KEM encrypt → lands in the inbox as ciphertext → open →
> real decrypt → subject restored

This used to be possible with no `.env` at all, against a demo mailbox of
fixtures. That mailbox is gone, and with it a pile of caveats that existed only
to keep it honest against a real core: the fixtures were encrypted by `demoCore`
and a real core correctly refused to read them, the seeded contact keys were
`fakePublicKey()` armor a real OpenPGP parser rejects, and neither could be
regenerated — encrypting *from* a fictional contact needs that contact's private
key, which the repo does not have and should not ship. Sending to yourself
demonstrated more than any of it, so it is now the only path.

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
