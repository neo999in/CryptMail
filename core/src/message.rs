//! Encrypt-and-sign, and its inverse.
//!
//! The payload here is the *inner MIME tree* built by
//! `app/src/core/mime.ts` — this crate neither builds nor parses MIME. It
//! receives a string, returns armored ciphertext, and vice versa.
//!
//! Messages are always signed as well as encrypted (`docs/encryption.md`:
//! sign-then-encrypt), because the trust states the UI shows are derived from
//! signature verification, not from the fact that something decrypted.

use pgp::composed::{Deserializable, Message, MessageBuilder, SignedPublicKey, SignedSecretKey};
use pgp::crypto::aead::{AeadAlgorithm, ChunkSize};
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::types::{KeyDetails, Password};
use rand::thread_rng;
use serde::Serialize;

use crate::{CoreError, Result};

/// Mirrors the crypto half of `DecryptedMessage` in `app/src/core/types.ts`.
/// The TypeScript side turns `plaintext` back into subject + body.
#[derive(Debug, Serialize)]
pub struct Decrypted {
    pub plaintext: String,
    /// `valid` | `invalid` | `unknown` | `none` — the `SignatureStatus` union.
    pub signature: String,
    #[serde(rename = "signerFingerprint", skip_serializing_if = "Option::is_none")]
    pub signer_fingerprint: Option<String>,
}

pub fn encrypt_sign(
    secret: &SignedSecretKey,
    passphrase: &str,
    plaintext: &str,
    recipient_keys: &[String],
) -> Result<String> {
    let mut rng = thread_rng();
    let password = Password::from(passphrase.to_string());

    let mut builder = MessageBuilder::from_bytes("", plaintext.as_bytes().to_vec()).seipd_v2(
        &mut rng,
        SymmetricKeyAlgorithm::AES256,
        AeadAlgorithm::Ocb,
        ChunkSize::default(),
    );
    builder.sign(&secret.primary_key, password, HashAlgorithm::Sha256);

    for armored in recipient_keys {
        let cert = parse_public(armored)?;
        let subkey = encryption_subkey(&cert)?;
        builder
            .encrypt_to_key(&mut rng, &subkey)
            .map_err(|e| CoreError::Unavailable(format!("could not encrypt to a recipient: {e}")))?;
    }

    builder
        .to_armored_string(&mut rng, Default::default())
        .map_err(|e| CoreError::Unavailable(format!("could not serialise message: {e}")))
}

pub fn decrypt_verify(
    secret: &SignedSecretKey,
    passphrase: &str,
    armored: &str,
    sender_keys: &[String],
) -> Result<Decrypted> {
    let (message, _) = Message::from_armor(armored.as_bytes())
        .map_err(|e| CoreError::Malformed(format!("not a readable OpenPGP message: {e}")))?;

    let mut decrypted = message
        .decrypt(&Password::from(passphrase.to_string()), secret)
        .map_err(|e| CoreError::DecryptFailed(format!("could not decrypt: {e}")))?;

    let plaintext = decrypted
        .as_data_string()
        .map_err(|e| CoreError::DecryptFailed(format!("decrypted payload is not text: {e}")))?;

    let (signature, signer_fingerprint) = verify(&decrypted, sender_keys);

    Ok(Decrypted { plaintext, signature, signer_fingerprint })
}

/// Signature state against the keys we hold for the sender.
///
/// `unknown` is deliberately distinct from `invalid`: "we have no key to check
/// this against" and "this was checked and is wrong" drive very different UI
/// (`docs/key-management.md` trust levels), and collapsing them would let a
/// forged message read as merely unverified.
fn verify(message: &Message<'_>, sender_keys: &[String]) -> (String, Option<String>) {
    if !message.is_signed() {
        return ("none".into(), None);
    }
    if sender_keys.is_empty() {
        return ("unknown".into(), None);
    }

    let mut saw_key = false;
    for armored in sender_keys {
        let Ok(cert) = parse_public(armored) else { continue };
        saw_key = true;
        if message.verify(&cert).is_ok() {
            return ("valid".into(), Some(hex::encode_upper(cert.fingerprint().as_bytes())));
        }
    }

    if saw_key {
        ("invalid".into(), None)
    } else {
        ("unknown".into(), None)
    }
}

fn parse_public(armored: &str) -> Result<SignedPublicKey> {
    let (cert, _) = SignedPublicKey::from_string(armored.trim())
        .map_err(|e| CoreError::Malformed(format!("unreadable recipient key: {e}")))?;
    Ok(cert)
}

/// The subkey a message should be encrypted to.
///
/// Prefers a subkey over the primary: Stage 1 keys sign with the Ed25519
/// primary and encrypt with the ML-KEM-768+X25519 subkey, so a cert with no
/// encryption-capable subkey cannot receive mail and must fail loudly rather
/// than silently falling back to something weaker.
fn encryption_subkey(cert: &SignedPublicKey) -> Result<pgp::composed::SignedPublicSubKey> {
    cert.public_subkeys
        .iter()
        .find(|sub| KeyDetails::algorithm(&sub.key).can_encrypt())
        .cloned()
        .ok_or_else(|| {
            CoreError::NoKey("recipient key has no encryption-capable subkey".into())
        })
}
