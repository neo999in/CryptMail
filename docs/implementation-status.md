# Implementation Status

What is built, how strongly each claim is backed, and everything that is
flagged, unverified, or known-broken.

The other docs in `docs/` describe *intended* behaviour. This one describes
**what has actually been observed**, and is deliberately pessimistic: a claim
appears under "verified" only if a command was run and its output read.

Last updated: 2026-08-06.

---

## Confidence ledger

| Level | Meaning |
|---|---|
| ✅ **Verified** | A command was run and its output read. |
| 🟨 **Read** | Source was inspected but the path was never executed. |
| ⛔ **Unrun** | Written, or specified, but never executed by anyone. |
| ❓ **Unknown** | Not established either way. |

---

## 1. The crypto core (`core/`)

**✅ Verified.** `cd core && cargo test` — 27 tests (6 unit, 21 integration).

Implements the crypto half of the `CryptCore` contract. Deliberately does *not*
do MIME; see [core/README.md](../core/README.md) for why.

### Algorithms — ✅ verified by parsing a generated certificate

| | Value |
|---|---|
| Primary | `Ed25519` |
| Encryption subkey | **`MlKem768X25519`** (RFC 9980 algorithm 35) |
| Key version | `V6` |
| Certificate size | ≈2.4 KB armored — 2,419 B for a 14-character address. Varies with address length, since the User ID is embedded; not a constant. |

Asserted directly on algorithm IDs in `the_identity_is_stage_one_hybrid`. An
earlier version of that test asserted only certificate *size* and inferred the
rest — size would not have caught the encryption subkey silently becoming
classical, which is the one regression this crate exists to prevent.

### Invariants, each with a passing test — ✅

1. A private key never appears in a return value.
2. Secret keys are S2K-encrypted at rest; the passphrase never reaches disk.
3. An unintended recipient **cannot** decrypt, even holding a valid key of their
   own.
4. `unknown` and `invalid` signature states stay distinct — collapsing them
   would let a forged message read as merely unverified.
5. A signature from the sender's **signing subkey** verifies, rather than being
   reported as forged — see §5.1, which is where that came from.
6. Wrong passphrase fails; tampered ciphertext does not decrypt to the original.
7. Encrypting to the sender as well keeps the copy in Sent readable.

---

## 2. Library survey (PQ.1)

**✅ Verified.** Each result came from probing the library, not from documentation.

| Library | Version | RFC 9980 | How established |
|---|---|---|---|
| OpenPGP.js | 6.3.1 | **none** | Printed `enums.publicKey`; list ends at `ed448` |
| Bouncy Castle `bcpg` | 1.85 | **none** | Reflected over `PublicKeyAlgorithmTags`; stops at `Ed448 = 28` |
| rPGP (`pgp`) | 0.20 | **full** | Generated, encrypted, decrypted, re-parsed |

Reproduce with [`spike/pqc-rpgp`](../spike/pqc-rpgp). Measured certificate sizes:
Stage 1 **2,432 B**, Stage 2 **18,523 B** — a 7.6× gap, and the whole reason
post-quantum signatures are staged after post-quantum confidentiality.

**Consequence:** the Rust core is *required* for post-quantum, not preferred.
Neither the JavaScript nor the Java path can do it, and an Android-only target
does not open a Kotlin/Bouncy Castle shortcut.

---

## 3. The app (`app/`)

**✅ Verified.** `npx tsc --noEmit` clean; `npm test -- --ci` — 275 tests, 26 suites.

### Capability split — ✅ verified by test

`mailMode` and `cryptoMode` are independent (`app/src/config.ts`). Previously a
single `appMode` requiring both, so a valid OAuth client still produced demo
fixtures. Covered by `src/__tests__/config-test.ts`.

`mailMode` now takes **two** things, not one: a client id *and* the Play-services
sign-in module (`hasSignInModule`). A web build has the first and not the second,
so it falls back to fixtures and says why through `demoReason()`. The two
capabilities remain independent of each other — the module tested for is the
sign-in library, never the crypto core.

### Native bridge — ✅ verified against a fake module

`src/core/__tests__/nativeCore-test.ts` drives the bridge with a stub in place of
Rust. Includes a parity test asserting the demo and native cores emit **identical
envelope structure** — the property that makes the swap in `core/index.ts` safe.

⛔ The bridge has **never** run against the real native module.

---

## 4. Defects found and fixed

### 4.1 ~~UniFFI is not actually wired up~~ — ✅ fixed

Was: `ffi.rs` was plain Rust shaped like an FFI surface, with no `uniffi`
dependency and no annotations, so the `.so` carried no metadata and
`uniffi-bindgen generate --library …` had nothing to read.

Now wired up with `uniffi` 0.32 and **verified by running the generator**:
`cargo build --lib` then `cargo run --bin uniffi-bindgen -- generate --library
target/debug/libcryptmail_core.so --language kotlin` emits a
`CryptMailCoreInterface` with exactly the five methods `nativeCore.ts` expects
(`loadIdentity` nullable, `decryptVerify` taking no address) and a
`constructor(storageDir, passphrase)`.

Two choices worth recording:

- **The bindgen is a `[[bin]]` in the crate**, not `cargo install
  uniffi-bindgen`. That command installs whatever is newest on crates.io, and a
  version skew between scaffolding and bindgen yields Kotlin that compiles and
  then misreads the FFI at runtime.
- **`FfiError` became an enum** (`#[uniffi(flat_error)]`). UniFFI only derives
  `Error` for enums, and the enum is the better shape: Kotlin gets a sealed
  `FfiException` whose subclasses *are* the four codes, so the mapping is an
  exhaustive `when` rather than a string comparison. `code()` is retained. The
  hand-written `CoreError → FfiError` conversion is pinned by a test.

⛔ Still only ever generated from a **host** `.so`. The `aarch64-linux-android`
cross-compile has not been attempted — see §5.2.

### 4.2 ~~`createdAt` reports "now"~~ — ✅ fixed

Was: `identity::describe()` set `created_at: Utc::now()`, so `loadIdentity`
returned a different timestamp on every call.

Now read from the key packet. The creation time is hashed into the fingerprint,
so it is fixed for the life of the key — which is what
`the_creation_time_is_the_keys_own_and_does_not_move` asserts by loading the
identity repeatedly and requiring one answer.

### 4.3 ~~Demo fixtures are incompatible with a real core~~ — ✅ fixed

Was predicted by reading; now handled and covered by
`src/mail/__tests__/demoMail-test.ts`, which drives both shapes.

- Keyring seeding is gated on `core.kind === 'demo'`. `demoContactKeys` are
  `fakePublicKey()` armor that a real parser rejects, and feeding them to a
  native core threw, leaving an error banner and an **empty** keyring.
- The demo mailbox serves no `demoCore` ciphertext when a real core is loaded,
  and says why in a plaintext message rather than showing rows that fail to open.

The fixtures could not simply be regenerated: producing genuine ciphertext *from*
Anya needs Anya's private key, which the demo does not have and should not ship.
Encrypted demo mail with a real core therefore comes from sending one — which
round-trips through the real core and is a better demonstration anyway.

The earlier decision to leave this alone was right at the time and wrong now:
the argument was that compatibility code cannot be tested against a core that
does not exist, but the behaviour is entirely decidable from `core.kind`, which
is injectable.

---

## 5. Unverified claims

Ranked by how much damage being wrong would do.

### 5.1 Interop — ✅ closed, and it found a real defect

Was the largest open risk: every test was rPGP talking to itself, against a
`draft-pqc` feature written for the pre-RFC draft.

**Verified** by [`spike/interop-rpgp-sequoia`](../spike/interop-rpgp-sequoia) —
`./interop.sh`, 9 checks, all passing against **Sequoia-PGP 2.4**, which is
independent of rPGP in authorship, parser and primitives. Sequoia parses our
certificates and agrees on the algorithms; messages round-trip in **both**
directions with signatures verifying; fail-closed still holds.

Finding a counterparty was half the work. OpenPGP.js, Bouncy Castle (still 1.85)
and ProtonMail `go-crypto` all stop at `Ed448 = 28`; GnuPG 2.4.4 has no PQC and
`gnupg.org` is unreachable from this environment. Sequoia was the only option.

The two libraries **cannot be linked into one binary** — rPGP's `ml-kem` 0.2.3
pins `kem = "=0.3.0-pre.0"`, Sequoia's 0.3.2 wants `^0.3`, and cargo resolves one
`kem` in that range. Hence two processes exchanging armored files, which is what
interop means anyway.

#### What it found — ⛔ → ✅ fixed

**Signatures made by a signing subkey were reported `invalid`.** The core signs
with its Ed25519 primary and `verify()` checked only the primary, but Sequoia,
GnuPG and Proton all sign with a dedicated signing subkey by default. `invalid`
is not a soft failure: the UI renders it as *forged*, so the core would have
accused every legitimate correspondent using an ordinary OpenPGP client.

Note the direction — **we could always be read; we could not always read
others.** Self-round-trip bugs are symmetric by construction, which is precisely
why testing against yourself could never have caught this.

Fixed in `core/src/message.rs` and pinned by `core/tests/foreign-signature.rs`,
using fixtures generated by the harness so `cargo test` alone guards it.

#### What it still does not prove

- Two implementations agreeing is not either one matching the RFC; they could
  share a misreading. There is no third implementation to ask.
- Sequoia's pure-Rust backend is experimental and variable-time (the harness
  opts in to both). Irrelevant to *format* interop, but those binaries are a
  test counterparty and nothing else.
- Stage 1 only. Stage 2 is untested.
- The harness exchanges the inner payload; PGP/MIME assembly in
  `app/src/core/mime.ts` is not exercised.

This replaces M1's "cross-check against GnuPG" step, which cannot cover
post-quantum until GnuPG ships it.

### 5.2 The Android build — ✅ the core runs on a device

Closed on a Windows machine with Android Studio, against an x86_64 emulator
(Pixel 10 Pro XL, API 36). `cryptoMode` reports `real`, so `getNativeCore()`
returns non-null and the banner flips itself: *"Real encryption, demo mailbox"*.

Confirmed on the device, not inferred:

- Both ABIs cross-compile (`cargo ndk -t arm64-v8a -t x86_64`), and
  `lib/x86_64/libcryptmail_core.so` is present in the debug APK.
- `libjnidispatch.so` loads and the UniFFI bindings resolve — no
  `UnsatisfiedLinkError`, no JNA failure.
- Key generation runs in Rust on the device. The identity's fingerprint is **64
  hex characters**, i.e. a **V6 key** as RFC 9980 requires; a v4 key would be 40.

**The round trip is closed.** A message sent to self and opened again:

- The envelope on the wire carries `Subject: [Encrypted message]`; the real
  subject comes back only after decryption, from the protected-headers tree.
- The body decrypts to what was typed.
- The signature verifies, and the UI names the key it verified against —
  matching the identity's own fingerprint.

Decoding the ciphertext by hand confirms the algorithms rather than trusting the
UI. Two **v6 PKESK** packets (one for the recipient, one for the sender, which is
what keeps Sent readable), each with a **1197-byte body** — a plain X25519 PKESK
is ~120 bytes, while ML-KEM-768's ciphertext alone is 1088, so this is the
RFC 9980 hybrid and not a fallback to the classical subkey. The payload is
**SEIPD v2 under AES-256-OCB**. The PKESK names the *encryption subkey*, whose
fingerprint differs from the primary shown on the Keys screen — as it should.

The first-run snag found on that build — sending to yourself required importing
your own public key, because `resolveRecipients` read the keyring only and the
identity is not in it — is fixed. Resolution now lives in
`app/src/state/recipients.ts`, which resolves this device's own address from the
identity (`verified`) without storing it in the keyring. `pasteFromClipboard` in
`KeysScreen` also no longer fails silently: `Clipboard.getStringAsync()` returned
empty under automation on this emulator, and both that and a read that throws are
now reported.

#### What the first device build found

Five defects, none of them in the cryptography — every one in the bridge or the
build, which is where §5.2 always said the risk was.

1. **The module was looked up in the wrong registry.** `nativeCore.ts` read
   `NativeModules['CryptMailCore']`, but the Kotlin is an Expo module and only
   appears via `expo-modules-core`'s `requireOptionalNativeModule`. It failed
   *silently*: the core was installed and working while the app reported "not
   wired up yet". The tests passed throughout because they registered their fake
   in `NativeModules` too — a green suite over a bridge that could not work.
2. **A Fabric assertion crashed the app on every send.** `usePressScale`'s style
   was applied as `off ? undefined : press.style`, so a button going `busy`
   removed the `transform` array from a view the native animation driver still
   held, and `SurfaceMountingManager.overridePropsReadableMap` asserts on exactly
   that — an `AssertionError` on the main thread. The Send button sets `busy`
   mid-flight, so it died every time. The style is now unconditional; `Pressable`'s
   own `disabled` already stops the animation.
3. **`versionCode`/`versionName` were missing** from the module's
   `defaultConfig`, failing Gradle configuration outright.
4. **The `.so` and generated Kotlin were written into `app/android/`**, which is
   the `:app` module — so `:cryptmail-core` could not see them ("Unresolved
   reference 'uniffi'"), and `prebuild --clean` would have deleted the core.
   Both now live in the module.
5. **The module cannot compile before the bindings exist**, so M0 ("blank app on
   a device") needs it unlinked first. Recorded in the module README.

The NDK also needs pinning via `ANDROID_NDK_HOME`, not `android/build.gradle`:
`cargo-ndk` picks the highest installed while Gradle picks its own, and on a
machine with several they disagree silently.

#### Still not done on hardware

- **A physical phone.** Everything above is an emulator, which has no StrongBox —
  so `KeystorePassphrase` is exercising its *fallback* path, and the StrongBox
  path still has never run.
- **Two devices**, which the goal sentence needs for a real send and receive.

### 5.3 Google sign-in — 🟨 runs against real Gmail; two paths still unproven

This entry used to say `auth/googleAuth.ts` and `mail/gmail.ts` "are complete and
were read". The first half was false. `googleAuth.ts` implemented an
`expo-auth-session` redirect flow against a custom URI scheme, and Google refuses
custom schemes from an Android OAuth client — the approach could not have worked,
however completely it was written. It was **rewritten** on Play-services sign-in
(`@react-native-google-signin/google-signin`); `expo-auth-session` is gone. See
[the design spec](superpowers/specs/2026-08-08-google-auth-native-design.md).

**First run against Google: 2026-08-08**, Pixel emulator, test account, against a
Cloud project in Testing mode. What was observed, not inferred:

| Claim | Evidence |
|---|---|
| Sign-in is native, with no browser or redirect | logcat: `com.google.android.gms.auth.GOOGLE_SIGN_IN` → `SignInHubActivity` → GMS `SignInActivity`, all in-process |
| A real mailbox renders | Inbox listed real senders, unread counts and Gmail threading |
| `gmail.modify` is genuinely granted | A star set in the app survived a **cold restart** — so the label change reached Google, not just local state |
| Archive reaches Google | The archived message left the inbox and stayed gone across a cold restart |
| Flags target the message the user tapped | Starred a chosen row, cold-restarted, that same message came back starred. Repeated on a second message |

**Running it found three defects that every unit test had passed over.** The
first two are the reason this section is worth reading:

1. **Concurrent `signInSilently`.** The library *overwrites* an in-flight promise
   instead of queueing, and the overwritten one never settles. Boot triggers it
   every time: `AppState` calls `restore()` while the Gmail client it has just
   built asks for a token. The inbox sat empty forever on a dead promise.
2. **Concurrent `getTokens`** — the same defect on a second method. Fixing only
   the first moved the failure here rather than curing it.
3. **Message bodies rendered as raw MIME.** `plainBodyOf` returned everything
   after the first blank line, so a `multipart/alternative` message showed its
   boundary, its part headers and undecoded `=E2=80=87` escapes to the user.

(1) and (2) are fixed by single-flighting both calls in `auth/googleAuth.ts` —
sharing the in-flight promise without caching the *result*, so Play services
stays the only source of truth. (3) is fixed by `mail/plainBody.ts`, a reader for
inbound third-party mail, kept out of `core/mime.ts` because that file mirrors
[message-format.md](message-format.md) — the envelope CryptMail *writes*.

All three were invisible to the fake-module tests because the demo fixtures are
single-part US-ASCII and never race. Each now has regression tests.

**Still ⛔, and not to be claimed:**

- **Token refresh across an access-token expiry.** Never observed. §7.3's
  background scheduler depends on `signInSilently` refreshing without an
  interactive prompt, and that remains an open question, not an assumption.
- **The revocation path.** `isPermanentAuthFailure` has never seen a real revoked
  grant — it was written against the errors `AuthSession` threw, and Play
  services may signal revocation differently.
- **Sending.** No message has been sent through the real transport.
- **A physical device.** Emulator only.

One unexplained observation, recorded rather than tidied away: a second message
acquired a star that could not be traced to any interaction. Star *targeting*
tested correct twice, so this is not believed to be a targeting bug, but it was
not reproduced or explained.

See [running-it.md](running-it.md).

### 5.4 Smaller ones

| Claim | Status |
|---|---|
| 2.4 KB is Autocrypt-viable | 🟨 Judgement, not measurement. PQ.4 exists to test it through real providers. |
| RFC 9980 permits ML-KEM-768+X25519 on v4 subkeys | ❓ From a web search. The core uses V6 regardless, since that is what rPGP exposes. |
| `demoMail.send()` completes a local send→inbox loop | 🟨 Read, never executed. |
| Certificate sizes generalise | 🟨 Measured for these parameters and this library. Treat as "roughly", not constant. |

---

## 6. Design limits that are not bugs

- **Signatures are not quantum-safe.** Stage 1 signs with Ed25519, which Shor's
  algorithm breaks. Deliberate: a signature forged in 2040 does not retroactively
  compromise a message sent today, whereas harvested ciphertext does. Stated
  plainly because "CryptMail uses quantum encryption" is only half true —
  messages cannot be *decrypted* by a future quantum computer; they could be
  *forged* by one. Stage 2 (ML-DSA-65) fixes it and costs 18.5 KB certificates.
- **V6 keys only.** Older OpenPGP clients may reject them outright.
- **Web will never encrypt for real.** A Kotlin module cannot load in a browser,
  so web stays on the demo core permanently. That is a consequence of the
  Android-only core decision, not an oversight.
- **Metadata is not protected.** Sender, recipients, timestamps and size stay
  visible — see [security.md](security.md).

---

## 7. Debt that gated real users

Four of five are closed, including key recovery; one is blocked on a physical
device ([features.md](features.md) has the full register).

### 7.1 ~~Local storage is plaintext~~ — ✅ fixed

Was the sharpest contradiction in the repo: [security.md](security.md) promised
encryption at rest while the keyring, drafts, outbox and — worst — the search
index of *decrypted* subjects and bodies sat in plain AsyncStorage. The search
index is by construction a plaintext copy of exactly the mail the user
encrypted.

Every local store now writes through
[`secureJson.ts`](../app/src/store/secureJson.ts), sealed with
XChaCha20-Poly1305 under a 32-byte device key in `expo-secure-store`
(Keystore/Keychain). Reads still accept plaintext and a boot-time sweep re-seals
it, so an install that predates this keeps its data.

Not SQLCipher, as [data-model.md](data-model.md) specifies — that doc now records
the divergence. The property it asks for holds; the engine differs.

⛔ Web has no keychain, so the key sits beside the data there. Reported by
`storageReason()`, not hidden.

### 7.2 ~~No verification ceremony~~ — ✅ fixed

Was worse than "missing": a one-tap **Mark verified** button recorded the claim
of verification without the act, so a trust mark could be granted without
evidence — making an unchecked key look checked.

Replaced with a Signal-style **safety number**
([`safetyNumber.ts`](../app/src/pgp/safetyNumber.ts)): 30 digits derived from
both fingerprints in sorted order, so both people see the same value and either
can read while the other checks. `markVerified` now takes the fingerprint that
was actually compared and refuses if the key changed meanwhile, and a changed
key drops its `verifiedAt`.

Two things surfaced while testing it. jest-expo stubs `expo-crypto`'s digest to
return `""`, under which every safety number compared equal to every other and
the tests passed while certifying nothing — hence the pure-JS hash. And a
fingerprint of `"not-hex"` normalised to one hex character and produced a
perfectly plausible six-group number, hence the length floor.

### 7.3 The scheduler only runs while the app runs — ⛔ needs a device

Unchanged, and deliberately so. Background delivery needs
`expo-background-task`, which cannot run on web, cannot run under jest, and
cannot be verified without a device. Writing it now would add unverifiable
native-dependent code to a repo whose scheduler currently works correctly within
its stated limits. Blocked behind §5.2 along with everything else.

### 7.4 ~~No token-revocation handling~~ — ✅ fixed

A revoked or expired grant now raises `reauth-required`, clears the dead tokens
and returns the app to signed-out with the reason — from a failed refresh, from
a Gmail `401` mid-flight, and on launch.

The care is in the *other* direction: only `invalid_grant`, `invalid_client` and
`unauthorized_client` count as permanent. Everything else is transient and keeps
the session, because treating a dropped connection as a revocation would sign
the user out of a working account every time they lost signal. That asymmetry is
what `revocation.ts` exists to hold, and what its tests check.

### 7.5 Key recovery — ✅ built end to end

This was the sharpest remaining item, and the only one where the failure was
permanent: the OpenPGP secret key is protected by a passphrase wrapped with an
Android Keystore key that has **no backup path**. A lost, wiped or factory-reset
device meant a permanently lost identity and keyring, and every message ever sent
to that key became unreadable — by anyone, with no support path that could undo
it. A recovery code now provides the second path.

What exists:

- **The contract.** `exportRecoveryBackup` / `importRecoveryBackup` on
  `CryptCore` ([`types.ts`](../app/src/core/types.ts)), taking the native bridge
  from five methods to seven. Strings only; the blob is ciphertext, so no private
  key crosses the boundary.
- **The recovery code.** 160 bits of Crockford base32
  ([`recoveryCode.ts`](../app/src/core/recoveryCode.ts)), with confusables folded
  on input so a hand-copied code still opens the backup.
- **The demo implementation**, which encodes rather than wraps but *does* check
  the code — otherwise the wrong-code path would exist in no test until the Rust
  landed.
- **The UI.** A Recovery screen, plus an unprompted warning on Keys for a key
  that has never been backed up. Without that warning the feature protects only
  the users who already knew they needed it.
- **Tests on both sides**, covering transcription tolerance, the error-code split
  between `decrypt-failed` and `malformed`, and that restoring returns the *same*
  fingerprint rather than minting a new identity. The TypeScript suite runs
  against a fake bridge; the Rust suite runs against the real crypto.

✅ **The wrapping now exists.** `core/src/recovery.rs` re-locks the secret key —
primary and every subkey — between the Keystore passphrase and an **OpenPGP
Argon2id S2K** derived from the code, with two UniFFI methods and two Kotlin
`AsyncFunction`s behind it.

The open design decision closed in rPGP's favour: 0.20 does expose
`set_password_with_s2k`, and Argon2id is already its **V6 default** (RFC 9106
choice 2 — 64 MiB, 3 passes, 4 lanes, AES-256-OCB). The XChaCha20-Poly1305
fallback was therefore dropped, along with the `argon2` dependency, the bespoke
envelope, and the need to store the parameters — the S2K packet carries them
inline, so raising them later cannot strand an existing backup. The blob is a
**standard armored OpenPGP secret key**: GnuPG or Sequoia could open it with the
code.

The "two base32 generators must agree forever" hazard was removed rather than
managed. The code is generated in TypeScript and passed down; Rust never decodes,
only normalises (upper-case, `I`/`L`→`1`, `O`→`0`) and hashes the bare 32
characters. A unit test pins rPGP's V6 default to Argon2id, so a dependency bump
that quietly changed it fails loudly instead of silently weakening every backup
taken afterwards.

Four new integration tests cover it, the load-bearing one being that **a message
encrypted to a key whose device is then destroyed decrypts after restoring from
the code on a fresh device under a different Keystore passphrase**, with the
sender's signature still verifying. A matching fingerprint proves only that bytes
survived; that test proves the key still works. `cargo test` is 38.

See [`docs/superpowers/specs/2026-08-08-key-recovery-rust-design.md`](superpowers/specs/2026-08-08-key-recovery-rust-design.md).

⛔ Also unbuilt, deliberately: no backend to hold the blob, so transport is
manual export. See [key-management.md](key-management.md) §As built for why a
server would buy nothing cryptographically, and for the mailbox-stored backup
that should replace manual export once §5.3 proves the Gmail transport.

---

## 8. Claims made and later disproved

Recorded because the reasoning is in the commit history and a reader should know
which conclusions were superseded.

| Claimed | Corrected to |
|---|---|
| OpenPGP.js could replace the Rust core | Only for classical crypto — it has no PQC at all |
| Android-only means Kotlin + Bouncy Castle | `bcpg` has not reserved the RFC 9980 algorithm IDs |
| "The plan calls NDK the biggest time sink" (as an argument against Rust) | The plan says that as a reason to do it **first**, while the surface is trivial |
| Switching to OpenPGP.js deletes M0 | It deletes the Rust half; `expo prebuild` → APK remains |
| Demo-fixture compatibility "cannot be tested against a core that does not exist" | It is decidable from `core.kind`, which is injectable — §4.3 |
| A one-tap "Mark verified" button implemented the verified trust level | It recorded the claim without the act; §7.2 |
| rPGP and Sequoia could be tested in one binary | Their `ml-kem` requirements are unsatisfiable together — §5.1 |

---

## What would most improve this document

**Getting the core onto a phone** (§5.2). Interop was the previous answer here
and is now closed; with the UniFFI surface generating real Kotlin (§4.1), every
remaining unknown of consequence is on the other side of a toolchain that has
never been run. Nothing in this document can move much until an APK exists.
