# Key Recovery (Rust half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap this device's OpenPGP secret key under a user-held recovery code, and restore it on another device, so a lost phone stops meaning a permanently lost identity.

**Architecture:** A new private module `core/src/recovery.rs` re-locks the stored secret key — primary and every subkey — from the Android Keystore passphrase to an Argon2id S2K derived from the recovery code, using rPGP's `remove_password` / `set_password_with_s2k`. The blob is therefore a standard armored OpenPGP secret key, not a bespoke envelope. Two methods reach it through `Core`, two more through the UniFFI surface, and `nativeCore.ts` composes them with the recovery code generated in TypeScript.

**Tech Stack:** Rust 1.97 · rPGP (`pgp`) 0.20 with `draft-pqc` · UniFFI 0.32 · Kotlin/Expo modules · TypeScript / jest-expo

**Spec:** [2026-08-08-key-recovery-rust-design.md](../specs/2026-08-08-key-recovery-rust-design.md), which supersedes step 3 of [2026-08-07-key-recovery-design.md](../specs/2026-08-07-key-recovery-design.md).

## Global Constraints

- **Claude never runs a git command that writes.** Commit steps below are printed for a human to run. Do not run them, do not offer to. (CLAUDE.md, "Git — never run write commands".)
- **Nothing crosses the core boundary but strings, and a private key is never returned from it.** The blob is ciphertext; it is not an exception to this rule, it is an instance of it. (CLAUDE.md rule 3.)
- **No new error codes.** The TypeScript union is `'no-key' | 'malformed' | 'decrypt-failed' | 'unavailable'` and stays that way.
- **The recovery code is generated in TypeScript only.** Rust never implements Crockford base32. It normalises and hashes; it does not decode.
- **The Argon2 password is the normalised bare code:** uppercase, separators stripped, `I`/`L` → `1`, `O` → `0`. 32 characters.
- **Docs are the source of truth.** A change contradicting a doc updates the doc in the same change. (CLAUDE.md.)
- Rust commands run from `core/`; npm commands run from `app/`. Node 22+. There is no root `package.json`.
- TypeScript tests live in a sibling `__tests__/<name>-test.ts` — the jest `testMatch` in `app/package.json`. A test anywhere else silently never runs.

## File Structure

| File | Responsibility |
|---|---|
| `core/src/recovery.rs` | **Create.** Normalise a code; re-lock a secret key between two passphrases; export and import. |
| `core/src/lib.rs` | **Modify.** `mod recovery;` and two `Core` methods. |
| `core/src/ffi.rs` | **Modify.** Two `#[uniffi::export]` methods, taking the bridge from five to seven. |
| `core/tests/recovery.rs` | **Create.** End-to-end behaviour through `Core`. |
| `app/modules/cryptmail-core/android/src/main/java/.../CryptMailCoreModule.kt` | **Modify.** Two `AsyncFunction`s. |
| `app/src/core/nativeCore.ts` | **Modify.** Bridge type + code generation and normalisation on the way down. |
| `app/src/core/__tests__/nativeCore-test.ts` | **Modify.** Cover the new composition. |

---

### Task 1: Normalising the recovery code

**Files:**
- Create: `core/src/recovery.rs`
- Modify: `core/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub(crate) fn normalise(code: &str) -> String`.

- [ ] **Step 1: Create the module with a failing test**

Create `core/src/recovery.rs`:

```rust
//! Key recovery: re-wrapping this device's secret key under a code the user
//! holds, and adopting a key back from one.
//!
//! `docs/superpowers/specs/2026-08-08-key-recovery-rust-design.md`. The blob is
//! a standard armored OpenPGP secret key locked with an Argon2id S2K, not a
//! bespoke envelope — any conforming implementation could open it with the code.

/// Crockford base32, as in `app/src/core/recoveryCode.ts`. Rust never *decodes*
/// a code; this is only the set of characters worth keeping.
const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Fold a written-down code back to the exact string that was hashed.
///
/// A code can be written grouped, spaced or lowercased, and each variant is a
/// different byte string — so this must agree with `normaliseRecoveryCode` in
/// `app/src/core/recoveryCode.ts` exactly. `I` and `L` fold to `1` and `O` to
/// `0` because handwriting does not distinguish them, and "wrong recovery code"
/// is an alarming thing to tell someone whose key is in fact correct.
pub(crate) fn normalise(code: &str) -> String {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::normalise;

    /// These pairs are copied from `app/src/core/__tests__/recoveryCode-test.ts`.
    /// No test can span both languages; if you change one table, change both.
    #[test]
    fn folds_grouping_case_and_confusables() {
        let expected = "K7M2NQ8ZR4J5TWXB3HYPD6C9FGKM1N8Q";
        for input in [
            "K7M2NQ8ZR4J5TWXB3HYPD6C9FGKM1N8Q",
            "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q",
            "k7m2 nq8z r4j5 twxb 3hyp d6c9 fgkm 1n8q",
            // I, L and O typed where 1, 1 and 0 were written.
            "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-IN8Q",
            "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-LN8Q",
        ] {
            assert_eq!(normalise(input), expected, "normalising {input}");
        }
        assert_eq!(normalise("0O0o"), "0000");
    }

    #[test]
    fn drops_anything_outside_the_alphabet() {
        assert_eq!(normalise("A B\tC\nD!?"), "ABCD");
        assert_eq!(normalise(""), "");
    }
}
```

Add to `core/src/lib.rs`, after `mod message;`:

```rust
mod recovery;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib recovery`
Expected: FAIL — both tests panic at `not implemented`.

- [ ] **Step 3: Implement `normalise`**

```rust
pub(crate) fn normalise(code: &str) -> String {
    code.to_uppercase()
        .chars()
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .filter(|c| ALPHABET.contains(*c))
        .collect()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib recovery`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit — print this for a human, do not run it**

```powershell
git add core/src/recovery.rs core/src/lib.rs
git commit -m "feat(core): normalise a written-down recovery code"
```

---

### Task 2: Wrapping the key under the code

**Files:**
- Modify: `core/src/recovery.rs`, `core/src/lib.rs`
- Test: `core/tests/recovery.rs` (create)

**Interfaces:**
- Consumes: `normalise` (Task 1); `identity::load_secret(dir, email) -> Result<SignedSecretKey>`; `CoreError::{NoKey, Malformed, DecryptFailed, Unavailable}`.
- Produces: `pub(crate) fn export(dir: &Path, email: &str, keystore_pass: &str, code: &str) -> Result<String>` and `Core::export_recovery_backup(&self, email: &str, keystore_pass: &str, code: &str) -> Result<String>`, returning the armored blob.

- [ ] **Step 1: Write the failing test**

Create `core/tests/recovery.rs`:

```rust
//! Key recovery, end to end through the public `Core` API.
//!
//! Argon2id at 64 MiB costs ~100ms per unlock and most of these do two, so this
//! file is deliberately slower than the rest of the suite. That is the feature
//! working.

use std::fs;

use cryptmail_core::Core;
use pgp::composed::{Deserializable, SignedSecretKey};

const PW: &str = "correct horse battery staple";
const CODE: &str = "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q";

fn tmpdir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cryptmail-recovery-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_blob_is_a_conforming_secret_key_locked_under_the_code() {
    let dir = tmpdir("blob");
    let core = Core::new(&dir);
    core.generate_identity("alice@example.com", PW).unwrap();

    let blob = core.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    assert!(blob.contains("BEGIN PGP PRIVATE KEY BLOCK"), "not an armored secret key");
    assert!(!blob.contains(PW), "the Keystore passphrase leaked into the blob");
    assert!(!blob.contains(CODE), "the recovery code leaked into the blob");

    // It parses as a standard transferable secret key — the interoperability
    // claim in the spec, asserted rather than assumed.
    let (mut parsed, _) = SignedSecretKey::from_string(&blob).expect("blob is not a parseable secret key");
    assert!(!parsed.secret_subkeys.is_empty(), "the ML-KEM subkey did not survive the wrap");

    // It is locked under the *code*, not the device passphrase — otherwise a
    // stolen backup would open with a Keystore secret the thief may also have.
    assert!(
        parsed.primary_key.remove_password(&PW.into()).is_err(),
        "the blob still opens with this device's Keystore passphrase"
    );
}

#[test]
fn exporting_leaves_the_device_key_untouched() {
    // Taking a backup must not be able to lock a user out of the device they
    // took it on. The export works on an in-memory copy and writes nothing.
    let dir = tmpdir("untouched");
    let core = Core::new(&dir);
    core.generate_identity("alice@example.com", PW).unwrap();
    let before: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();

    core.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let after: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();
    assert_eq!(before, after, "export rewrote the stored secret key");
    // And it still opens with the Keystore passphrase.
    core.load_identity("alice@example.com").unwrap().expect("identity vanished");
}

#[test]
fn exporting_without_an_identity_is_no_key() {
    let core = Core::new(tmpdir("no-identity"));
    let err = core.export_recovery_backup("nobody@example.com", PW, CODE).unwrap_err();
    assert_eq!(err.code(), "no-key");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --test recovery`
Expected: FAIL to compile — `no method named export_recovery_backup found for struct Core`.

- [ ] **Step 3: Implement the wrap**

Add to the top of `core/src/recovery.rs`:

```rust
use std::path::Path;

use pgp::composed::{Deserializable, SignedSecretKey};
use pgp::ser::Serialize as _;
use pgp::types::{Password, S2kParams};
use rand::thread_rng;

use crate::{identity, CoreError, Result};
```

and the functions:

```rust
/// Re-lock a secret key, primary and every subkey, from one passphrase to
/// another.
///
/// Every subkey is iterated rather than reaching for the one ML-KEM subkey by
/// hand: a key that later grows a second subkey must not end up half-wrapped,
/// which would restore as an identity that cannot decrypt.
fn rewrap(secret: &mut SignedSecretKey, from: &Password, to: &Password) -> Result<()> {
    let mut rng = thread_rng();

    secret
        .primary_key
        .remove_password(from)
        .map_err(|e| CoreError::DecryptFailed(format!("could not unlock the key: {e}")))?;
    let s2k = S2kParams::new_default(&mut rng, secret.primary_key.version());
    secret
        .primary_key
        .set_password_with_s2k(to, s2k)
        .map_err(|e| CoreError::Unavailable(format!("could not re-lock the key: {e}")))?;

    for sub in &mut secret.secret_subkeys {
        sub.key
            .remove_password(from)
            .map_err(|e| CoreError::DecryptFailed(format!("could not unlock a subkey: {e}")))?;
        let s2k = S2kParams::new_default(&mut rng, sub.key.version());
        sub.key
            .set_password_with_s2k(to, s2k)
            .map_err(|e| CoreError::Unavailable(format!("could not re-lock a subkey: {e}")))?;
    }

    Ok(())
}

/// Wrap this device's secret key under `code`, returning an armored blob.
///
/// Nothing is written: the stored key keeps its Keystore passphrase.
pub(crate) fn export(dir: &Path, email: &str, keystore_pass: &str, code: &str) -> Result<String> {
    let mut secret = identity::load_secret(dir, email)?;
    rewrap(&mut secret, &keystore_pass.into(), &normalise(code).as_str().into())?;
    secret
        .to_armored_string(None.into())
        .map_err(|e| CoreError::Unavailable(format!("could not armor the backup: {e}")))
}
```

If `version()` is not in scope on the key packets, add `use pgp::types::KeyDetails;` — `core/src/identity.rs` already imports it for the same reason. The test file needs `use pgp::types::Password;` for the `PW.into()` above.

Then pin rPGP's default, in `core/src/recovery.rs`'s `mod tests`:

```rust
    /// The Argon2id choice is inherited from rPGP's V6 default rather than
    /// spelled out, which is only safe if the default is what the spec says it
    /// is. A dependency bump that quietly changed it would otherwise weaken
    /// every backup taken afterwards, silently and with all tests green.
    #[test]
    fn the_v6_default_s2k_is_argon2id() {
        use pgp::types::{S2kParams, StringToKey};

        let params = S2kParams::new_default(rand::thread_rng(), pgp::types::KeyVersion::V6);
        match params {
            S2kParams::Aead { s2k: StringToKey::Argon2 { t, p, m_enc, .. }, .. } => {
                // RFC 9106 parameter choice 2: 64 MiB, 3 passes, 4 lanes.
                assert_eq!((t, p, m_enc), (3, 4, 16));
            }
            other => panic!("rPGP's V6 default S2K is no longer Argon2id: {other:?}"),
        }
    }
```

Add to `core/src/lib.rs`, in `impl Core`:

```rust
    /// Wrap this device's secret key under a recovery code the user holds.
    ///
    /// The code is generated in TypeScript (`app/src/core/recoveryCode.ts`) and
    /// passed in, so there is only ever one implementation of the alphabet.
    /// Returns an armored OpenPGP secret key — opaque to the caller, and the
    /// only form in which secret material may leave this crate.
    pub fn export_recovery_backup(&self, email: &str, passphrase: &str, code: &str) -> Result<String> {
        recovery::export(&self.dir, email, passphrase, code)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --test recovery`
Expected: PASS, 3 tests. Slower than the rest of the suite — Argon2id is doing its job.

- [ ] **Step 5: Check nothing else broke**

Run: `cargo test`
Expected: PASS. 27 tests existed before this plan; you have now added 2 normalisation tests, the Argon2 default pin, and 3 integration tests — 33.

- [ ] **Step 6: Commit — print this for a human, do not run it**

```powershell
git add core/src/recovery.rs core/src/lib.rs core/tests/recovery.rs
git commit -m "feat(core): wrap the secret key under a recovery code"
```

---

### Task 3: Restoring from a backup

**Files:**
- Modify: `core/src/recovery.rs`, `core/src/lib.rs`, `core/tests/recovery.rs`

**Interfaces:**
- Consumes: `export` and `rewrap` (Task 2); `identity::Identity`.
- Produces: `pub(crate) fn import(dir: &Path, keystore_pass: &str, blob: &str, code: &str) -> Result<Identity>` and `Core::import_recovery_backup(&self, passphrase: &str, blob: &str, code: &str) -> Result<String>`, returning Identity JSON.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/recovery.rs`:

```rust
use serde_json::Value;

#[test]
fn a_backup_restores_the_same_identity_on_a_fresh_device() {
    let old = Core::new(tmpdir("restore-old"));
    let original: Value =
        serde_json::from_str(&old.generate_identity("alice@example.com", PW).unwrap()).unwrap();
    let blob = old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    // A different device: different directory, different Keystore passphrase.
    let new = Core::new(tmpdir("restore-new"));
    let restored: Value =
        serde_json::from_str(&new.import_recovery_backup("a different keystore pw", &blob, CODE).unwrap())
            .unwrap();

    assert_eq!(restored["fingerprint"], original["fingerprint"], "fingerprint changed");
    assert_eq!(restored["email"], "alice@example.com");
    assert_eq!(restored["publicKeyArmored"], original["publicKeyArmored"]);
    assert!(!restored.to_string().contains("PRIVATE KEY"), "secret key leaked into the identity JSON");

    // The restored key is usable on the new device under its own passphrase.
    let loaded = new.load_identity("alice@example.com").unwrap().expect("nothing stored");
    let loaded: Value = serde_json::from_str(&loaded).unwrap();
    assert_eq!(loaded["fingerprint"], original["fingerprint"]);
}

#[test]
fn the_code_is_accepted_however_it_was_written_down() {
    let old = Core::new(tmpdir("written-old"));
    old.generate_identity("alice@example.com", PW).unwrap();
    let blob = old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let new = Core::new(tmpdir("written-new"));
    // Lowercase, no grouping, and an l typed where a 1 was written.
    new.import_recovery_backup(PW, &blob, "k7m2nq8zr4j5twxb3hypd6c9fgkmln8q")
        .expect("a transcription slip must not read as a wrong code");
}

#[test]
fn a_wrong_code_is_decrypt_failed() {
    let old = Core::new(tmpdir("wrong-old"));
    old.generate_identity("alice@example.com", PW).unwrap();
    let blob = old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let new = Core::new(tmpdir("wrong-new"));
    let err = new
        .import_recovery_backup(PW, &blob, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH")
        .unwrap_err();
    assert_eq!(err.code(), "decrypt-failed", "a wrong code must not read as a corrupt blob");
}

#[test]
fn something_that_is_not_a_backup_is_malformed() {
    let core = Core::new(tmpdir("malformed"));
    let id: Value = serde_json::from_str(&core.generate_identity("alice@example.com", PW).unwrap()).unwrap();

    assert_eq!(core.import_recovery_backup(PW, "not a key at all", CODE).unwrap_err().code(), "malformed");
    // A *public* key is well-formed OpenPGP and still not a backup.
    let public = id["publicKeyArmored"].as_str().unwrap();
    assert_eq!(core.import_recovery_backup(PW, public, CODE).unwrap_err().code(), "malformed");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --test recovery`
Expected: FAIL to compile — `no method named import_recovery_backup found for struct Core`.

- [ ] **Step 3: Implement the unwrap**

Add to `core/src/recovery.rs`:

```rust
/// Adopt an identity from a backup, replacing whatever key this device holds.
///
/// The address comes from the restored key's own User ID rather than from the
/// caller: the person restoring is on a new device and may not have signed in
/// yet, and the backup already knows who it belongs to.
pub(crate) fn import(
    dir: &Path,
    keystore_pass: &str,
    blob: &str,
    code: &str,
) -> Result<identity::Identity> {
    let (mut secret, _) = SignedSecretKey::from_string(blob)
        .map_err(|e| CoreError::Malformed(format!("this is not a recovery backup: {e}")))?;

    rewrap(&mut secret, &normalise(code).as_str().into(), &keystore_pass.into())?;

    identity::adopt(dir, secret)
}
```

Add to `core/src/identity.rs` — writing the key is that module's job, not recovery's:

```rust
/// Store a secret key that came from somewhere other than `generate`, and
/// describe it. Used by recovery; the key is already locked under this device's
/// passphrase by the time it arrives.
pub fn adopt(dir: &Path, secret: SignedSecretKey) -> Result<Identity> {
    let email = secret
        .details
        .users
        .first()
        .and_then(|u| String::from_utf8(u.id.id().to_vec()).ok())
        .and_then(|id| crate::keys::address_of(&id))
        .ok_or_else(|| CoreError::Malformed("the backup carries no usable address".into()))?;

    fs::create_dir_all(dir).map_err(|e| CoreError::Unavailable(e.to_string()))?;
    let armored = secret
        .to_armored_string(None.into())
        .map_err(|e| CoreError::Unavailable(e.to_string()))?;
    fs::write(secret_path(dir, &email), armored).map_err(|e| CoreError::Unavailable(e.to_string()))?;

    describe(&secret, &email)
}
```

Add to `core/src/lib.rs`, in `impl Core`:

```rust
    /// Adopt an identity from a backup. Returns the public identity as JSON.
    ///
    /// Whatever key this device held is replaced — on a fresh device that is the
    /// throwaway identity generated at sign-in, which nothing was ever sent to.
    pub fn import_recovery_backup(&self, passphrase: &str, blob: &str, code: &str) -> Result<String> {
        json(&recovery::import(&self.dir, passphrase, blob, code)?)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --test recovery`
Expected: PASS, 7 tests.

If `a_wrong_code_is_decrypt_failed` reports `malformed` instead, the failure is coming from parsing rather than unlocking — check that `rewrap`'s `remove_password` error maps to `DecryptFailed`, not that the test is wrong. The distinction is the whole point: it tells a user whose code is mistyped apart from one whose backup is damaged.

- [ ] **Step 5: Commit — print this for a human, do not run it**

```powershell
git add core/src/recovery.rs core/src/identity.rs core/src/lib.rs core/tests/recovery.rs
git commit -m "feat(core): restore an identity from a recovery backup"
```

---

### Task 4: The test that justifies the feature

**Files:**
- Modify: `core/tests/recovery.rs`

**Interfaces:**
- Consumes: `Core::{generate_identity, import_public_key, encrypt_sign, decrypt_verify, export_recovery_backup, import_recovery_backup}`.
- Produces: nothing — this is a behavioural gate, not an API.

- [ ] **Step 1: Write the failing test**

A matching fingerprint proves the bytes survived. It does not prove the restored key can *read anything* — a half-wrapped subkey would pass every test so far and fail here. Append to `core/tests/recovery.rs`:

```rust
#[test]
fn mail_encrypted_to_the_lost_device_is_readable_after_recovery() {
    // The whole point of the feature: Bob sends to Alice, Alice's phone is
    // destroyed, Alice restores from her code on a new phone and can still read
    // it. Everything else here is a proxy for this.
    let alice_old = Core::new(tmpdir("e2e-alice-old"));
    let alice: Value =
        serde_json::from_str(&alice_old.generate_identity("alice@example.com", PW).unwrap()).unwrap();
    let alice_key = alice["publicKeyArmored"].as_str().unwrap().to_string();

    let bob_dir = tmpdir("e2e-bob");
    let bob = Core::new(&bob_dir);
    let bob_id: Value = serde_json::from_str(&bob.generate_identity("bob@example.com", PW).unwrap()).unwrap();
    let bob_key = bob_id["publicKeyArmored"].as_str().unwrap().to_string();

    let backup = alice_old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let ciphertext = bob
        .encrypt_sign("bob@example.com", PW, "the eagle lands at dawn", &[alice_key, bob_key.clone()])
        .unwrap();

    // Alice's phone is gone. New device, new Keystore passphrase, only the code.
    let alice_new = Core::new(tmpdir("e2e-alice-new"));
    let new_pw = "a completely different keystore passphrase";
    alice_new.import_recovery_backup(new_pw, &backup, CODE).unwrap();

    let decrypted: Value = serde_json::from_str(
        &alice_new
            .decrypt_verify("alice@example.com", new_pw, &ciphertext, &[bob_key])
            .unwrap(),
    )
    .unwrap();

    assert_eq!(decrypted["plaintext"], "the eagle lands at dawn");
    assert_eq!(decrypted["signature"], "valid", "Bob's signature no longer verifies after recovery");
}
```

- [ ] **Step 2: Run the test**

Run: `cargo test --test recovery mail_encrypted_to_the_lost_device`

If Tasks 2 and 3 are correct this passes immediately. That is expected for a gate written over finished behaviour — the value is that it fails loudly if subkey handling ever regresses. If it *does* fail, the likely cause is `rewrap` skipping subkeys: the ML-KEM subkey is the one that decrypts, and the primary alone cannot.

Confirm the field names against `core/src/message.rs` (`Decrypted`) if `plaintext` or `signature` do not resolve.

- [ ] **Step 3: Run the whole suite**

Run: `cargo test`
Expected: PASS, 38 — 33 from Task 2's count, plus Task 3's 4 and this one.

- [ ] **Step 4: Commit — print this for a human, do not run it**

```powershell
git add core/tests/recovery.rs
git commit -m "test(core): mail survives losing the device it was sent to"
```

---

### Task 5: The FFI surface

**Files:**
- Modify: `core/src/ffi.rs:1-13` (the module doc says "five operations" — it becomes seven), `core/src/ffi.rs:80-117`

**Interfaces:**
- Consumes: `Core::{export_recovery_backup, import_recovery_backup}` (Tasks 2–3).
- Produces: `CryptMailCore::export_recovery_backup(email: String, code: String) -> FfiResult<String>` and `CryptMailCore::import_recovery_backup(blob: String, code: String) -> FfiResult<String>`.

- [ ] **Step 1: Add the two methods**

Inside the existing `#[uniffi::export] impl CryptMailCore` block, after `import_public_key`:

```rust
    /// → the armored blob. The recovery code is generated in TypeScript and
    /// passed in; the Keystore passphrase is not, and never appears in a
    /// JS-visible signature.
    pub fn export_recovery_backup(&self, email: String, code: String) -> FfiResult<String> {
        Ok(self.core.export_recovery_backup(&email, &self.passphrase, &code)?)
    }

    /// → Identity JSON. Rewrites the secret key under this device's Keystore
    /// passphrase. Takes no address: the backup carries its own.
    pub fn import_recovery_backup(&self, blob: String, code: String) -> FfiResult<String> {
        Ok(self.core.import_recovery_backup(&self.passphrase, &blob, &code)?)
    }
```

Update the module doc comment on line 1 from "the five operations" to "the seven operations".

- [ ] **Step 2: Verify it compiles and the suite is green**

Run: `cargo test`
Expected: PASS, 38 tests. The FFI adds surface, not behaviour, so the count does not move.

- [ ] **Step 3: Regenerate the Kotlin bindings**

From `core/`, with `ANDROID_NDK_HOME` set as recorded in `docs/handoff.md` §0:

```powershell
cargo ndk -t arm64-v8a -t x86_64 -o ..\app\modules\cryptmail-core\android\src\main\jniLibs build --release
cargo run --bin uniffi-bindgen -- generate --library ..\app\modules\cryptmail-core\android\src\main\jniLibs\arm64-v8a\libcryptmail_core.so --language kotlin --out-dir ..\app\modules\cryptmail-core\android\src\main\java
```

- [ ] **Step 4: Confirm the generated Kotlin carries the new methods**

Run: `Select-String -Path ..\app\modules\cryptmail-core\android\src\main\java\uniffi\cryptmail_core\cryptmail_core.kt -Pattern "exportRecoveryBackup|importRecoveryBackup"`
Expected: both names appear. If they do not, the `.so` is stale — rebuild before going further, or the Kotlin in Task 7 will not compile.

- [ ] **Step 5: Commit — print this for a human, do not run it**

The `.so` and generated Kotlin are gitignored, so only the Rust is staged.

```powershell
git add core/src/ffi.rs
git commit -m "feat(core): expose recovery across the FFI"
```

---

### Task 6: The TypeScript bridge

**Files:**
- Modify: `app/src/core/nativeCore.ts:53-80` (bridge type), `app/src/core/nativeCore.ts:131-139` (composition)
- Test: `app/src/core/__tests__/nativeCore-test.ts`

**Interfaces:**
- Consumes: `generateRecoveryCode`, `normaliseRecoveryCode` from `app/src/core/recoveryCode.ts`.
- Produces: no change to `CryptCore` — `exportRecoveryBackup(email): Promise<RecoveryBackup>` and `importRecoveryBackup(blob, code): Promise<Identity>` keep their shipped signatures.

- [ ] **Step 1: Update the fake bridge**

`fakeBridge()` at `app/src/core/__tests__/nativeCore-test.ts:16-57` currently has `exportRecoveryBackup` returning a whole `RecoveryBackup` JSON and taking only an email. That is the old contract. Replace that one member:

```typescript
    exportRecoveryBackup: jest.fn(
      async (email: string, _code: string) =>
        `-----BEGIN PGP PRIVATE KEY BLOCK-----\nd3JhcHBlZDoke${email}}\n-----END PGP PRIVATE KEY BLOCK-----`,
    ),
```

Leave `importRecoveryBackup` as it is — its signature is unchanged.

- [ ] **Step 2: Write the failing tests**

Append to the same file, using the existing `withBridge()` helper at line 59 rather than a second fake:

```typescript
describe('recovery through the native bridge', () => {
  it('generates the code itself and hands the bridge the normalised form', async () => {
    const { core, bridge } = withBridge();

    const backup = await core.exportRecoveryBackup('me@example.com');

    expect(backup.blob).toContain('BEGIN PGP PRIVATE KEY BLOCK');
    // The code shown to the user is grouped, for writing down…
    expect(backup.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    // …but what Argon2 hashes is the bare 32 characters.
    expect(bridge.exportRecoveryBackup).toHaveBeenCalledWith(
      'me@example.com',
      backup.code.replace(/-/g, ''),
    );
  });

  it('issues a different code every time, so one backup never unlocks another', async () => {
    const { core } = withBridge();
    const first = await core.exportRecoveryBackup('me@example.com');
    const second = await core.exportRecoveryBackup('me@example.com');
    expect(first.code).not.toBe(second.code);
  });

  it('normalises a code the user typed before restoring', async () => {
    const { core, bridge } = withBridge();

    await core.importRecoveryBackup('BLOB', ' k7m2-nq8z-r4j5-twxb-3hyp-d6c9-fgkm-ln8q ');

    expect(bridge.importRecoveryBackup).toHaveBeenCalledWith(
      'BLOB',
      'K7M2NQ8ZR4J5TWXB3HYPD6C9FGKM1N8Q',
    );
  });
});
```

The existing suite at line 111, "against a native core built before recovery landed", already covers the `unavailable` fallback and needs no change — `withOlderBridge` deletes both methods and asserts the message names the upgrade.

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `app/`): `npx jest src/core/__tests__/nativeCore-test.ts`
Expected: FAIL. `nativeCore.ts` still `JSON.parse`s the bridge's return and reads `.code` from it, so `backup.code` is undefined and the armor assertion fails. TypeScript will also object to the fake's new two-argument signature — that mismatch is the point of changing the fake first.

- [ ] **Step 4: Change the bridge type**

In `app/src/core/nativeCore.ts`, replace the two optional bridge members and their comment:

```typescript
  /**
   * → the armored blob. The code is generated *here* and passed down, so
   * Crockford base32 has exactly one implementation — a second one in Rust
   * would have to agree character for character forever, with no test able to
   * span both languages.
   *
   * Optional: a Kotlin module built before recovery landed will not have these
   * two, and an app bundle can be newer than the native library it loads.
   */
  exportRecoveryBackup?(email: string, code: string): Promise<string>;
  /** → Identity JSON. Rewrites the secret key under this device's Keystore passphrase. */
  importRecoveryBackup?(blob: string, code: string): Promise<string>;
```

- [ ] **Step 5: Change the composition**

Replace the two implementations in the returned object:

```typescript
    /**
     * The code is generated here and shown to the user grouped; what crosses
     * the bridge is the normalised bare form, which is what Argon2 hashes.
     */
    exportRecoveryBackup: async (email) => {
      const code = generateRecoveryCode();
      const blob = await required(bridge, 'exportRecoveryBackup', 'Backing up')(
        email,
        normaliseRecoveryCode(code),
      );
      return { code, blob };
    },

    importRecoveryBackup: async (blob, code) =>
      JSON.parse(
        await required(bridge, 'importRecoveryBackup', 'Restoring from a backup')(
          blob,
          normaliseRecoveryCode(code),
        ),
      ) as Identity,
```

and add the import:

```typescript
import { generateRecoveryCode, normaliseRecoveryCode } from './recoveryCode';
```

`required()` is generic over the two method names and needs no change.

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `app/`): `npx jest src/core/__tests__/nativeCore-test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full check**

Run (from `app/`): `npx tsc --noEmit` then `npm test -- --ci`
Expected: clean typecheck; all suites pass.

- [ ] **Step 8: Commit — print this for a human, do not run it**

```powershell
git add app/src/core/nativeCore.ts app/src/core/__tests__/nativeCore-test.ts
git commit -m "feat(recovery): generate the recovery code in TypeScript"
```

---

### Task 7: The Kotlin module

**Files:**
- Modify: `app/modules/cryptmail-core/android/src/main/java/app/cryptmail/core/CryptMailCoreModule.kt:13` (the doc says "five string-in/string-out crypto calls") and `:80-82` (after `decryptVerify`)

**Interfaces:**
- Consumes: the generated `uniffi.cryptmail_core.CryptMailCore` methods from Task 5.
- Produces: `CryptMailCore.exportRecoveryBackup(email, code)` and `.importRecoveryBackup(blob, code)` as Expo `AsyncFunction`s — the names `nativeCore.ts` looks up.

- [ ] **Step 1: Add the two functions**

Inside `definition()`, after the `decryptVerify` entry. `Coroutine` and `mapErrors` are not optional decoration: the former keeps the call off the main thread, and Argon2id at 64 MiB takes long enough that running it inline would freeze the UI outright; the latter is what preserves the four error codes, and without it a wrong recovery code surfaces as an opaque crash instead of "wrong code".

```kotlin
    AsyncFunction("exportRecoveryBackup") Coroutine { email: String, code: String ->
      mapErrors { core.exportRecoveryBackup(email, code) }
    }

    AsyncFunction("importRecoveryBackup") Coroutine { blob: String, code: String ->
      mapErrors { core.importRecoveryBackup(blob, code) }
    }
```

Change "five string-in/string-out crypto calls" to "seven" in the class doc comment at line 13.

- [ ] **Step 2: Build and run on the emulator**

Run (from `app/`): `npx expo run:android`
Expected: builds and installs. If Metro cannot connect, `adb reverse tcp:8081 tcp:8081`.

- [ ] **Step 3: Verify on the device**

In the app: Keys → Recovery. Export a backup and write the code down. Then restore with it and confirm the fingerprint on the Keys screen is unchanged. Then, the check that matters — restore with a deliberately wrong code and confirm the message says the code is wrong rather than that the backup is damaged.

The banner must still read "Real encryption, demo mailbox".

- [ ] **Step 4: Commit — print this for a human, do not run it**

```powershell
git add app/modules/cryptmail-core/android/src/main/java/app/cryptmail/core/CryptMailCoreModule.kt
git commit -m "feat(android): wire recovery through the Kotlin module"
```

---

### Task 8: Docs

**Files:**
- Modify: `docs/handoff.md`, `docs/implementation-status.md`, `docs/key-management.md`, `docs/features.md`

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1–7.
- Produces: nothing in code.

- [ ] **Step 1: Update each doc**

- `docs/handoff.md`: §2.1 becomes done; the status table row "Key recovery" goes from ◐ to ✅; the one-line summary at the foot drops "a recovery story that must be finished" and keeps only the Google transport.
- `docs/implementation-status.md`: recovery moves from "contract and UI implemented, Rust pending" to implemented, naming Argon2id via OpenPGP S2K and the device verification from Task 7 step 3.
- `docs/key-management.md`: record that option A is implemented, that the wrapping is an Argon2id S2K, and that the blob is a standard armored secret key rather than a bespoke envelope.
- `docs/features.md`: move key recovery out of whatever tier lists it as blocked on the Rust core.

Do not restate the design in these; link to `docs/superpowers/specs/2026-08-08-key-recovery-rust-design.md`.

- [ ] **Step 2: Check the claims are true**

Every "✅" added here must correspond to a command that was actually run. Re-read the diff against what Tasks 4 and 7 actually produced. If the device check in Task 7 step 3 was skipped, the docs say so rather than implying a device confirmed it.

- [ ] **Step 3: Commit — print this for a human, do not run it**

```powershell
git add docs/
git commit -m "docs: key recovery is implemented end to end"
```

---

## Definition of done

- `cargo test` from `core/` — 38 tests, including a message encrypted to a lost device decrypting after recovery.
- `npx tsc --noEmit` and `npm test -- --ci` from `app/` — clean, all suites.
- A backup exported and restored **on the emulator**, with a wrong code reporting a wrong code.
- The four docs above reflect what was actually run, with no claim ahead of its evidence.

## Deliberately not in this plan

- **Where the blob is stored.** The user copies it. Storing it as a self-addressed message in their own mailbox is the next increment and needs M3's Gmail transport first; it drops onto this contract unchanged.
- **Recovery in first-run onboarding.** `AppState.attach` still generates a throwaway identity at sign-in that a restore then discards. Correct, but the wrong shape for a new user — divergence 3 of the 2026-08-07 spec.
- **StrongBox.** Unrelated to recovery, and still unexecuted until there is a physical phone (handoff §2.3).
