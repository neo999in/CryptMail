//! Key recovery: re-wrapping this device's secret key under a code the user
//! holds, and adopting a key back from one.
//!
//! `docs/superpowers/specs/2026-08-08-key-recovery-rust-design.md`. The blob is
//! a standard armored OpenPGP secret key locked with an Argon2id S2K, not a
//! bespoke envelope — any conforming implementation could open it with the code.

use std::path::Path;

use pgp::composed::{Deserializable as _, SignedSecretKey};
use pgp::types::{KeyDetails as _, Password, S2kParams};
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
}
