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

**✅ Verified.** `npx tsc --noEmit` clean; `npm test -- --ci` — 150 tests, 15 suites.

### Simple UI — ✅ verified in a real browser

Built the web bundle, served it, drove it with Chromium at 430×1000. No console
or page errors. Observed: sign-in → inbox with per-row lock badges → open an
encrypted message (real subject restored, `ENCRYPTED · VERIFIED SENDER`) →
compose.

The fail-safe was confirmed visually: with an unknown recipient, "Send
encrypted" is disabled and names the address, "Send unencrypted" is offered but
**left unselected**, and the send button stays disabled until the user chooses.

### Capability split — ✅ verified by test

`mailMode` and `cryptoMode` are independent (`app/src/config.ts`). Previously a
single `appMode` requiring both, so a valid OAuth client still produced demo
fixtures. Covered by `src/__tests__/config-test.ts`.

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

### 5.2 The Android build — ⛔ still the blocker

There is no Android SDK or NDK in the environment this was developed in —
`dl.google.com`, the only source `sdkmanager` fetches from, is unreachable — and
no `android/` directory, which `expo prebuild` would generate. So:

- The Kotlin module is now **written** but has **never been compiled**:
  [`app/modules/cryptmail-core/`](../app/modules/cryptmail-core), against the
  real Expo SDK 57 module API and the UniFFI bindings §4.1 verifies. Its README
  lists the parts most likely to need adjustment on a first build.
- Cross-compilation has **never been attempted**.
- The core has **never run on a device**.
- Nothing post-quantum has touched Android.

Everything else in this document is now either verified or blocked behind this
one item.

### 5.3 Google OAuth — ⛔

`auth/googleAuth.ts` and `mail/gmail.ts` are complete and were read, but have
**never been run against Google**. No `.env`, no Cloud project. See
[running-it.md](running-it.md).

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

Three of the four are closed ([features.md](features.md) has the full register).

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
