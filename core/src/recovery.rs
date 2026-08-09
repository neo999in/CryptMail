//! Key recovery: re-wrapping this device's secret key under a code the user
//! holds, and adopting a key back from one.
//!
//! `docs/superpowers/specs/2026-08-08-key-recovery-rust-design.md`. The blob is
//! a standard armored OpenPGP secret key locked with an Argon2id S2K, not a
//! bespoke envelope — any conforming implementation could open it with the code.

use std::path::Path;

use pgp::composed::{Deserializable as _, SignedSecretKey};
use pgp::types::{KeyVersion, Password, S2kParams};
use rand::thread_rng;

use crate::{identity, CoreError, Result};

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
    secret
        .primary_key
        .set_password_with_s2k(to, recovery_s2k(&mut rng))
        .map_err(|e| CoreError::Unavailable(format!("could not re-lock the key: {e}")))?;

    for sub in &mut secret.secret_subkeys {
        sub.key
            .remove_password(from)
            .map_err(|e| CoreError::DecryptFailed(format!("could not unlock a subkey: {e}")))?;
        sub.key
            .set_password_with_s2k(to, recovery_s2k(&mut rng))
            .map_err(|e| CoreError::Unavailable(format!("could not re-lock a subkey: {e}")))?;
    }

    Ok(())
}

/// Argon2id + AES-256-OCB, stated rather than inherited.
///
/// This used to read `S2kParams::new_default(rng, key.version())`, which ties
/// the strength of every backup to the *key's version* — v6 defaults to
/// Argon2id, v4 to iterated-and-salted SHA-256 under CFB. Changing the key
/// version for an unrelated reason then silently weakened every backup taken
/// afterwards, with the whole suite green: the guard test below asks rPGP for
/// the V6 default and so never noticed that production had stopped using it.
///
/// The recovery code is the only thing standing between a stolen blob and the
/// user's entire mailbox (docs/key-management.md, "Recovery"), so the KDF is
/// named here and pinned by a test that reads what was actually written.
fn recovery_s2k<R: rand::CryptoRng + rand::Rng>(rng: &mut R) -> S2kParams {
    S2kParams::new_default(rng, KeyVersion::V6)
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

#[cfg(test)]
mod tests {
    use super::{normalise, recovery_s2k};
    use pgp::types::S2kParams;

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

    /// `recovery_s2k` still reaches for rPGP's V6 default rather than spelling
    /// out every Argon2 parameter, which is only safe while that default is
    /// what the spec says. A dependency bump that quietly changed it would
    /// weaken every backup taken afterwards.
    ///
    /// This asserts on the function the code actually calls, not on a version
    /// looked up a second time — the earlier form asked rPGP about V6 while
    /// production had moved to a v4 key, and so kept passing while the blobs
    /// it was meant to protect were being wrapped with SHA-256. The end-to-end
    /// guard is `the_blob_is_wrapped_with_argon2id_whatever_version_the_key_is`
    /// in `tests/recovery.rs`, which reads what was written.
    #[test]
    fn the_recovery_s2k_is_argon2id() {
        use pgp::types::StringToKey;

        match recovery_s2k(&mut rand::thread_rng()) {
            S2kParams::Aead { s2k: StringToKey::Argon2 { t, p, m_enc, .. }, .. } => {
                // RFC 9106 parameter choice 2: 64 MiB, 3 passes, 4 lanes.
                assert_eq!((t, p, m_enc), (3, 4, 16));
            }
            other => panic!("the recovery S2K is no longer Argon2id: {other:?}"),
        }
    }
}
