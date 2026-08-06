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

**✅ Verified.** `cd core && cargo test` — 20 tests (3 unit, 17 integration).

Implements the crypto half of the `CryptCore` contract. Deliberately does *not*
do MIME; see [core/README.md](../core/README.md) for why.

### Algorithms — ✅ verified by parsing a generated certificate

| | Value |
|---|---|
| Primary | `Ed25519` |
| Encryption subkey | **`MlKem768X25519`** (RFC 9980 algorithm 35) |
| Key version | `V6` |
| Certificate size | 2,411 bytes armored |

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
5. Wrong passphrase fails; tampered ciphertext does not decrypt to the original.
6. Encrypting to the sender as well keeps the copy in Sent readable.

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

**✅ Verified.** `npx tsc --noEmit` clean; `npm test -- --ci` — 101 tests, 10 suites.

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

## 4. Open defects

### 4.1 UniFFI is not actually wired up — ⛔

`core/src/ffi.rs` is plain Rust shaped like an FFI surface. **`uniffi` is not a
dependency and there are no UniFFI annotations.** It compiles, and the shape is
right, but the produced `.so` carries no UniFFI metadata, so a
`uniffi-bindgen generate --library …` invocation will fail.

Either add `uniffi` with `#[derive(uniffi::Object)]` and
`uniffi::setup_scaffolding!()`, or drop UniFFI and hand-write a JNI layer — for
five string-in/string-out methods the latter is defensible.

### 4.2 `createdAt` reports "now", not the key's creation time — ⛔

`identity::describe()` sets `created_at: chrono::Utc::now()`, so `loadIdentity`
returns a **different** timestamp on every call. The real creation time is in the
key packet and should be read from there.

Low blast radius today — nothing branches on it — but it is wrong, and a
"key first seen" UI built on it would silently lie.

### 4.3 Demo fixtures are incompatible with a real core — 🟨

Predicted by reading, **not observed**. When `core.kind === 'native'`:

- `AppState.tsx` seeds the keyring via `core.importPublicKey(demoContactKeys.anya)`,
  and those are `fakePublicKey()` armor blocks a real OpenPGP parser rejects →
  error banner and an **empty keyring**, so encrypted send stays blocked.
- Seeded inbox messages were built by `demoCore.buildEncrypted` (base64 behind a
  `CRYPTMAIL-DEMO-V1:` tag) and cannot be decrypted by the real core.

Left unfixed deliberately: compatibility code written against a core that does
not yet exist cannot be tested, and untested compatibility code produces a second
bug rather than fixing the first.

---

## 5. Unverified claims

Ranked by how much damage being wrong would do.

### 5.1 Interop — ❓ the largest open risk

Every test is **rPGP talking to itself**. rPGP gates RFC 9980 behind a feature
named **`draft-pqc`** — implemented against the pre-RFC draft. The algorithm IDs
match the published RFC, but nothing else is confirmed.

If it diverges, the failure mode is a real recipient unable to decrypt real mail.
Closing this costs about a day: round-trip against a second RFC 9980
implementation. Worth doing **before** the NDK work, not after.

Note this replaces M1's "cross-check against GnuPG" step, which cannot cover
post-quantum until GnuPG ships it.

### 5.2 The Android build — ⛔

There is no Android SDK or NDK in the environment this was developed in, and no
`android/` directory in the repo. So:

- The Kotlin module is **unwritten**. `core/README.md` is a specification.
- Cross-compilation has **never been attempted**.
- The core has **never run on a device**.
- Nothing post-quantum has touched Android.

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

## 7. Pre-existing debt that still gates real users

Unchanged by this work; listed so the picture is complete
([features.md](features.md) has the full register).

1. **Local storage is plaintext.** Keyring, drafts, outbox, and the decrypted
   search index are unencrypted AsyncStorage. Directly contradicts
   [security.md](security.md). → SQLCipher.
2. **No verification ceremony.** Every imported key is trusted on first use.
3. **The scheduler only runs while the app runs.**
4. **No token-revocation handling** — an expired refresh token surfaces as an
   error rather than a re-auth prompt.

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

---

## What would most improve this document

Interop testing. Everything else here is either verified or straightforwardly
buildable; §5.1 is the only item where the honest answer is "nobody knows yet."
