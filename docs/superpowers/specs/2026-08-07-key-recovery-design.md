# Key recovery — design

Closes §4.1 of the handoff, the "sharpest remaining item". Written 2026-08-07.

## The problem

`core/src/identity.rs` writes the OpenPGP secret key S2K-encrypted under a
passphrase that the Kotlin side unwraps from the Android Keystore
(`core/src/ffi.rs`, `CryptMailCore::new`). That Keystore key has no backup path.

A lost, wiped or factory-reset device is therefore a **permanently lost identity
and keyring**, and every message ever sent to that key becomes unreadable. There
is no way back, for the user or for anyone else.

## The shape

`docs/key-management.md` §Recovery, option A: generate a high-entropy **recovery
code**, stretch it with Argon2id, and use the result as an *alternate* wrapping
key for the same secret key. The user writes the code down; the wrapped blob is
stored somewhere durable.

Nothing about the identity changes — same key, same fingerprint, same public key.
Recovery restores the existing identity rather than issuing a new one, so senders
never have to do anything.

## Contract

Two methods on `CryptCore` (`app/src/core/types.ts`), taking the native bridge
from five methods to seven:

```ts
export type RecoveryBackup = {
  /** Shown to the user once, never persisted. */
  code: string;
  /** The secret key wrapped under Argon2id(code). Opaque ciphertext. */
  blob: string;
};

exportRecoveryBackup(email: string): Promise<RecoveryBackup>;
importRecoveryBackup(blob: string, code: string): Promise<Identity>;
```

`importRecoveryBackup` unwraps the blob, rewrites the secret key into this
device's storage under *this* device's Keystore passphrase, and returns only the
public `Identity`.

**CLAUDE.md rule 3 holds.** Both values are strings; the blob is ciphertext the
core produced and only the core reopens. No private key crosses the boundary in
the clear.

**No new error codes.** A wrong code is `decrypt-failed`; a corrupt blob is
`malformed`; a missing identity is `no-key`. The existing TypeScript union is
unchanged, so every caller's error handling already covers recovery.

## Recovery code format

160 bits from the platform CSPRNG, rendered as Crockford base32 — no `I`, `L`,
`O` or `U`, so it survives being written on paper and typed back. 32 characters
in 8 groups of 4.

```
K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-2N8Q
```

Normalisation on input accepts any spacing or case and maps the confusable
characters (`I`/`l` → `1`, `O` → `0`) before decoding, so a transcription slip is
tolerated rather than reported as a wrong code.

160 bits is far beyond what Argon2id needs to defend; the code is generated, not
chosen, so there is no weak-passphrase failure mode. `docs/key-management.md`
option B (user-chosen passphrase) is deliberately **not** implemented — it is
strictly weaker and adds a second path to maintain.

## Divergences from key-management.md

Recorded in the doc in the same change, per the CLAUDE.md docs rule.

1. **No backend.** The doc stores the blob "in the encrypted key backup on the
   backend". No backend exists, and CryptMail is a client, never a provider — a
   key-backup server would be the project's first server-side component. The
   server in the doc is zero-knowledge and so contributes nothing
   cryptographically; removing it costs only convenience. The user exports the
   blob themselves.

   The obvious next increment is storing the blob as a self-addressed message in
   the user's own mailbox: durable, fetchable after sign-in on a new device,
   opaque to the provider, and no new infrastructure. It drops onto this contract
   without changing it — whether the blob goes to the clipboard or to an email is
   the caller's decision. Deferred until M3 proves the Gmail transport.

2. **Device approval is out of scope.** The doc's optional hardening (an existing
   device must approve a new one before the backup is released) is a coordination
   problem that genuinely does require a server. Marked optional in the doc; not
   built.

3. **Restore happens after a throwaway key exists.** `AppState.attach` generates
   an identity at sign-in, so a fresh device already has one by the time the user
   reaches Recovery. Restoring discards it. That is correct — nothing was ever
   sent to the discarded key — but wiring recovery into first-run onboarding
   instead is a follow-up.

## Components

| Unit | Responsibility |
|---|---|
| `app/src/core/recoveryCode.ts` | Generate, format and normalise the code. Pure, no I/O. |
| `app/src/core/demoCore.ts` | The contract, non-cryptographically. `kind: 'demo'`. |
| `app/src/core/nativeCore.ts` | Bridge wiring; `unavailable` when the native side lacks the methods. |
| `app/src/store/recoveryStore.ts` | `{ backedUpAt }` only. No secret. Sealed like every other store. |
| `app/src/state/AppState.tsx` | `exportRecovery` / `restoreFromRecovery`. |
| `app/src/screens/RecoveryScreen.tsx` | Back up and restore. Reached from `KeysScreen`. |

### The demo core still checks the code

`demoCore` base64-encodes rather than encrypts, exactly as it does for messages,
and reports `kind: 'demo'` so no UI can present it as secure. But it embeds a
hash of the recovery code in the blob and rejects a mismatch. Without that, the
wrong-code path in the UI would never be exercised by any test. It is flow
fidelity, not a crypto claim.

### The backed-up nudge

`recoveryStore` records a single timestamp — when a backup was last exported —
and nothing else. It drives a warning on the Keys screen for a device that has
never been backed up. A recovery feature nobody discovers does not prevent the
loss it exists to prevent.

The timestamp is not a secret, but it goes through `secureJson` like everything
else rather than becoming the one store written in the clear.

## The Rust half

Not built here: this machine has no cargo, and shipping Rust that has never been
compiled is how `app/modules/cryptmail-core/` became the long pole. The
TypeScript contract above is fixed, so the Rust is a contained job.

`core/src/recovery.rs`, plus two `#[uniffi::export]` methods on `CryptMailCore`:

```rust
pub fn export_recovery_backup(&self, email: String) -> FfiResult<String>;   // → RecoveryBackup JSON
pub fn import_recovery_backup(&self, blob: String, code: String) -> FfiResult<String>; // → Identity JSON
```

Implementation:

1. Load the secret key with `identity::load_secret`, unlock it with the Keystore
   passphrase already held in `CryptMailCore`.
2. Generate 20 bytes from a CSPRNG, format as Crockford base32 — must match
   `app/src/core/recoveryCode.ts` exactly, since a code generated by one and
   typed into the other has to work.
3. Re-wrap the secret key under the code, with an **OpenPGP-native Argon2id
   S2K** — so the blob is a standard armored secret key any conforming
   implementation could open with the code.

   ⚠️ **Superseded, 2026-08-08.** This step was written as two options, preferring
   the S2K but marking it unverified. It is now verified — rPGP 0.20 exposes
   `set_password_with_s2k`, and Argon2id is already its V6 default — so the
   XChaCha20-Poly1305 fallback is dropped, and with it the `argon2` dependency
   and the bespoke envelope. Steps 2 and 3 here are also overtaken: the code is
   generated in TypeScript and passed in, so Rust never implements base32.
   See [2026-08-08-key-recovery-rust-design.md](2026-08-08-key-recovery-rust-design.md).
4. Import is the inverse: unwrap with the code, re-wrap under the Keystore
   passphrase, write via the existing `identity` storage path, return `describe`.

Argon2id parameters should be stored in the blob rather than assumed, so they can
be raised later without breaking existing backups. *(2026-08-08: the OpenPGP S2K
packet carries them inline, so this holds by construction.)*

No `argon2` dependency is needed — rPGP already has one. Tests belong in `core/tests/` alongside
`roundtrip.rs`: round-trip, wrong code, corrupt blob, and — the one that matters
— that a restored key decrypts a message encrypted to the original.

## Testing

All of the TypeScript is jest-testable and gets tests in sibling `__tests__/`
directories, per the `testMatch` rule in `app/package.json`:

- code format, grouping, normalisation of confusables and spacing, entropy length
- demo round-trip export → import
- wrong code rejected as `decrypt-failed`
- malformed blob rejected as `malformed`
- bridge wiring, and the `unavailable` fallback when the native side is older
- `recoveryStore` round-trip through the seal

Screens are not tested; that is the existing convention.

## Docs to update

`key-management.md` (the divergences above), `implementation-status.md` (§4.1
moves from "does not exist" to "contract and UI implemented, Rust pending"),
`features.md`.
