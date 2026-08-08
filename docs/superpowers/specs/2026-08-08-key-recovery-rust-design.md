# Key recovery, the Rust half — design

Written 2026-08-08. Closes §2.1 of [handoff.md](../../handoff.md), the sharpest
remaining item, and resolves the one open decision left by
[2026-08-07-key-recovery-design.md](2026-08-07-key-recovery-design.md) — which
remains the source of truth for the TypeScript half, the recovery code format,
and the divergences from `key-management.md`.

## What was open, and how it closed

That spec offered two ways to re-wrap the secret key, preferring an OpenPGP-native
Argon2 S2K but marking it **unverified**: nobody had confirmed rPGP 0.20 exposed
re-keying with a chosen S2K, and the machine had no cargo to find out.

It does. `pgp-0.20.0/src/packet/key/secret.rs` exposes

```rust
pub fn remove_password(&mut self, password: &Password) -> Result<()>;
pub fn set_password_with_s2k(&mut self, password: &Password, s2k_params: S2kParams) -> Result<()>;
```

on both `SecretKey` and `SecretSubkey`. Better, `S2kParams::new_default` for **V6
keys — which ours are** — already *is* Argon2id: AES-256-OCB with
`StringToKey::Argon2 { t: 3, p: 4, m_enc: 16 }`, RFC 9106 parameter choice 2
(64 MiB, 3 passes, 4 lanes).

The XChaCha20-Poly1305 fallback is therefore **dropped**, and three requirements
the earlier spec carried disappear with it:

- No `argon2` crate. rPGP already depends on it.
- No bespoke envelope format mirroring `localCrypto.ts`.
- No "store the Argon2 parameters in the blob so they can be raised later" — an
  OpenPGP S2K packet carries `t`, `p`, `m` and the salt inline, so an old backup
  stays openable by construction rather than by convention.

## Two decisions taken here

### The code is generated in TypeScript

The earlier spec had Rust generate the code, which required a second Crockford
base32 implementation agreeing with
[`app/src/core/recoveryCode.ts`](../../../app/src/core/recoveryCode.ts) character
for character — forever, with no test able to span both languages. A
one-character drift produces codes that never work and nothing catches it.

So: `recoveryCode.ts` is the only generator. Rust receives the code as a
parameter and never implements base32 at all.

**This does not change `CryptCore`.** `exportRecoveryBackup(email)` still returns
`{ code, blob }`; `nativeCore.ts` generates the code, passes it down, and
assembles the pair. Only the private `NativeBridge` type changes:

```ts
exportRecoveryBackup?(email: string, code: string): Promise<string>;  // → blob
importRecoveryBackup?(blob: string, code: string): Promise<string>;   // → Identity JSON
```

`demoCore.ts`, `AppState.tsx`, `RecoveryScreen.tsx` and their tests are untouched.

The trade is that the code now comes from `expo-crypto`'s CSPRNG rather than the
Rust one. Both are platform CSPRNGs; the earlier spec's stated reason for
preferring Rust ("never depends on JavaScript's random source") is a weaker
argument than a duplicated alphabet that cannot be tested across the boundary.

### The password is the normalised bare code

A code can be written down grouped, spaced or lowercased, and each variant is a
different byte string — so "what exactly is hashed" has to be pinned, or the
tolerance `recoveryCode.ts` already implements never reaches the crypto.

The password is `normaliseRecoveryCode()`'s output: uppercase, separators
stripped, confusables folded (`I`/`L` → `1`, `O` → `0`). 32 characters.

```
K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-2N8Q
  k7m2 nq8z r4j5 twxb 3hyp d6c9 fgkm 2n8q
  …FGKMlN8Q            (an l typed for a 1)
        ↓  all normalise to
K7M2NQ8ZR4J5TWXB3HYPD6C9FGKM1N8Q
```

`nativeCore.ts` normalises before calling; Rust normalises again rather than
trusting the caller. The Rust side is roughly ten lines — uppercase, fold, drop
anything outside the alphabet — and never decodes.

## `core/src/recovery.rs`

```rust
pub fn export(dir: &Path, email: &str, keystore_pass: &str, code: &str) -> Result<String>;
pub fn import(dir: &Path, keystore_pass: &str, blob: &str, code: &str) -> Result<Identity>;
```

**Export.** Load through the existing `identity::load_secret`. On the primary key
and on *every* subkey — iterated rather than reaching for the one ML-KEM subkey by
hand, so a key that later grows a second subkey is not silently half-wrapped:
`remove_password(keystore_pass)`, then
`set_password_with_s2k(code, S2kParams::new_default(rng, KeyVersion::V6))`. Armor
and return.

It works on the in-memory copy and **never writes to disk**. Taking a backup must
not be able to lock a user out of the device they took it on.

**Import.** Parse the blob, unlock with the code, re-lock under this device's
Keystore passphrase, write through `identity`'s existing storage path, return
`describe`. The address comes from the restored key's own User ID, the way
`identity::stored_email` already reads it — so the shipped
`importRecoveryBackup(blob, code)` signature needs no email parameter.

Import deliberately overwrites whatever throwaway identity `AppState.attach`
generated at sign-in. Nothing was ever sent to that key; divergence 3 of the
earlier spec records this.

**Errors — no new codes.** rPGP's unlock failure → `DecryptFailed`; input that is
not a parseable secret key → `Malformed`; no identity to export → `NoKey`, which
`load_secret` already returns. The TypeScript union is unchanged, so every
existing caller's error handling already covers recovery.

## The blob

A standard armored OpenPGP secret key locked under Argon2id — not a bespoke
envelope. GnuPG or Sequoia could open it with the code, which is the
interoperability the earlier spec wanted and expected to have to give up.

It is ciphertext the core produced and only the core reopens, so **CLAUDE.md rule
3 holds**: both values crossing the FFI are strings, and no private key crosses in
the clear.

## FFI and Kotlin

Two `#[uniffi::export]` methods on `CryptMailCore` in `core/src/ffi.rs`, taking
the bridge from five methods to seven. The Keystore passphrase comes from
`self.passphrase` and stays absent from every JS-visible signature, as with every
other method there.

```rust
pub fn export_recovery_backup(&self, email: String, code: String) -> FfiResult<String>;
pub fn import_recovery_backup(&self, blob: String, code: String) -> FfiResult<String>;
```

Then the matching two in `CryptMailCoreModule.kt`. `nativeCore.ts` already
degrades safely when they are absent — `required()` turns a missing bridge method
into an `unavailable` CoreError with a message about a newer core — so an app
bundle newer than the installed `.so` keeps working.

## Testing

`core/tests/recovery.rs`, alongside `roundtrip.rs`:

- round-trip: export, then import into a fresh storage dir, yields the same
  fingerprint
- **a message encrypted to the original key decrypts after restore** — the test
  that actually justifies the feature
- wrong code → `decrypt-failed`
- a corrupt blob, and a public key passed as a blob → `malformed`
- the on-disk key still opens with the Keystore passphrase after an export
- the blob parses as a conforming `SignedSecretKey` whose S2K is `Argon2`

Unit tests in `recovery.rs` for normalisation: grouping, case, and each
confusable. No test can span both languages, so these use a table of
input → expected pairs copied from `recoveryCode-test.ts`, with a comment in each
file naming the other. That is weaker than a shared test and is exactly why the
generator lives on one side only — normalisation is ten lines of folding, where
drift is visible; a base32 alphabet is not.

`nativeCore.ts` gets a test for the new composition — that the code returned to
the caller is the one passed to the bridge, and that it is normalised on the way
down.

Argon2id at 64 MiB × 4 lanes costs ~100ms per unlock, and several tests do two.
`cargo test` gets slower; that is the feature working.

## Docs to update in the same change

Per the CLAUDE.md docs rule: [handoff.md](../../handoff.md) §2.1 and its status
table, [implementation-status.md](../../implementation-status.md) (recovery moves
from "contract and UI implemented, Rust pending" to done),
[key-management.md](../../key-management.md) (the wrapping is Argon2id via
OpenPGP S2K, and the blob is a standard secret key),
[features.md](../../features.md), and step 3 of the
[2026-08-07 spec](2026-08-07-key-recovery-design.md), whose two options are now
one decision.
