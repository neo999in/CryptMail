//! This device's keypair: generation, storage at rest, and loading.
//!
//! Stage 1 of `docs/post-quantum.md` — Ed25519 primary for signing and
//! certification, ML-KEM-768 + X25519 subkey for encryption (RFC 9980
//! algorithm 35).
//!
//! **V4 keys.** The PQC spec confines its new algorithms to v6 with exactly one
//! exception: ML-KEM-768+X25519 is also permitted on a *v4* encryption subkey,
//! so that an existing v4 certificate can gain post-quantum confidentiality
//! without its holder changing key. `docs/post-quantum.md` chose Stage 1 around
//! that exception because the install base reads v4 — and `keys.openpgp.org`
//! turns out to enforce the point, answering a v6 upload with
//! `400 OpenPGP v6 (RFC 9580) is not yet supported`. A v6 identity is therefore
//! one nobody can publish, and an address nobody can publish is one no stranger
//! can encrypt to on a first message.
//!
//! The primary uses `Ed25519Legacy` (algorithm 22) rather than `Ed25519` (27):
//! 27 is RFC 9580's codepoint and is not recognised by the v4-era software this
//! version exists to interoperate with. Both are accepted by the keyserver, so
//! only a test on the algorithm id catches the difference.
//!
//! The secret key is written S2K-encrypted under the caller's passphrase and is
//! never returned to the caller in any form.

use std::fs;
use std::path::Path;

use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType, SecretKeyParamsBuilder, SignedSecretKey,
    SubkeyParamsBuilder,
};
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::types::{KeyDetails, KeyVersion};
use rand::thread_rng;
use serde::Serialize;
use smallvec::smallvec;

use crate::{CoreError, Result};

/// The public description of this device's identity. Mirrors `Identity` in
/// `app/src/core/types.ts`. Contains no secret material by construction.
#[derive(Debug, Serialize)]
pub struct Identity {
    pub email: String,
    pub fingerprint: String,
    #[serde(rename = "publicKeyArmored")]
    pub public_key_armored: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Where a given address's secret key lives. One file per address so multiple
/// identities can coexist (`data-model.md` allows N identity keys per account).
fn secret_path(dir: &Path, email: &str) -> std::path::PathBuf {
    // Hash rather than embed the address: a filename is not a place to leak
    // which accounts this device holds keys for.
    let digest = hex::encode(&sha_short(email.trim().to_lowercase().as_bytes()));
    dir.join(format!("identity-{digest}.asc"))
}

/// A short, stable, non-cryptographic file discriminator (FNV-1a, 8 bytes).
fn sha_short(bytes: &[u8]) -> [u8; 8] {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h.to_be_bytes()
}

pub fn generate(dir: &Path, email: &str, passphrase: &str) -> Result<Identity> {
    if passphrase.is_empty() {
        return Err(CoreError::Unavailable(
            "refusing to store a secret key without a passphrase".into(),
        ));
    }
    let email = email.trim().to_lowercase();
    let mut rng = thread_rng();

    let params = SecretKeyParamsBuilder::default()
        .version(KeyVersion::V4)
        .key_type(KeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(true)
        .primary_user_id(format!("<{email}>"))
        .preferred_symmetric_algorithms(smallvec![SymmetricKeyAlgorithm::AES256])
        .preferred_hash_algorithms(smallvec![HashAlgorithm::Sha256])
        .passphrase(Some(passphrase.to_string()))
        .subkey(
            SubkeyParamsBuilder::default()
                .version(KeyVersion::V4)
                // RFC 9980 algorithm 35 — post-quantum confidentiality.
                .key_type(KeyType::MlKem768X25519)
                .can_encrypt(EncryptionCaps::All)
                .passphrase(Some(passphrase.to_string()))
                .build()
                .map_err(|e| CoreError::Unavailable(e.to_string()))?,
        )
        .build()
        .map_err(|e| CoreError::Unavailable(e.to_string()))?;

    let secret = params
        .generate(&mut rng)
        .map_err(|e| CoreError::Unavailable(format!("key generation failed: {e}")))?;
    secret
        .verify_bindings()
        .map_err(|e| CoreError::Unavailable(format!("generated key failed self-verification: {e}")))?;

    fs::create_dir_all(dir).map_err(|e| CoreError::Unavailable(e.to_string()))?;
    let armored_secret = secret
        .to_armored_string(None.into())
        .map_err(|e| CoreError::Unavailable(e.to_string()))?;
    fs::write(secret_path(dir, &email), armored_secret)
        .map_err(|e| CoreError::Unavailable(e.to_string()))?;

    describe(&secret, &email)
}

/// Store a secret key that came from somewhere other than `generate`, and
/// describe it.
///
/// Used by recovery. The key is already locked under this device's passphrase
/// by the time it arrives, and the address comes from its own User ID rather
/// than from the caller — someone restoring on a new device may not have signed
/// in yet, and the backup already knows who it belongs to.
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

/// The public identity for an address, or `None` if this device has no key yet.
pub fn load_public(dir: &Path, email: &str) -> Result<Option<Identity>> {
    let email = email.trim().to_lowercase();
    match read_secret(dir, &email)? {
        None => Ok(None),
        Some(secret) => describe(&secret, &email).map(Some),
    }
}

pub fn load_secret(dir: &Path, email: &str) -> Result<SignedSecretKey> {
    read_secret(dir, &email.trim().to_lowercase())?
        .ok_or_else(|| CoreError::NoKey(format!("no identity key stored for {email}")))
}

fn read_secret(dir: &Path, email: &str) -> Result<Option<SignedSecretKey>> {
    let path = secret_path(dir, email);
    if !path.exists() {
        return Ok(None);
    }
    let armored = fs::read_to_string(&path).map_err(|e| CoreError::Unavailable(e.to_string()))?;
    let (secret, _) = SignedSecretKey::from_string(&armored)
        .map_err(|e| CoreError::Malformed(format!("stored identity key is unreadable: {e}")))?;
    Ok(Some(secret))
}

/// The address of the identity stored on this device, if any.
///
/// The filename is a hash, so the address cannot be read back from it — it
/// comes from the key's own User ID instead. The prototype stores one identity
/// per device; when `data-model.md`'s multiple identities land, the caller
/// should try each rather than assume one.
pub fn stored_email(dir: &Path) -> Result<Option<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // A fresh install has no directory yet — that is "no identity", not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CoreError::Unavailable(e.to_string())),
    };

    for entry in entries.flatten() {
        let Ok(armored) = fs::read_to_string(entry.path()) else { continue };
        let Ok((secret, _)) = SignedSecretKey::from_string(&armored) else { continue };
        let email = secret
            .details
            .users
            .first()
            .and_then(|u| String::from_utf8(u.id.id().to_vec()).ok())
            .and_then(|id| crate::keys::address_of(&id));
        if email.is_some() {
            return Ok(email);
        }
    }
    Ok(None)
}

/// Public description of a secret key. Serialises only the public half.
fn describe(secret: &SignedSecretKey, email: &str) -> Result<Identity> {
    let public = secret.to_public_key();
    let armored = public
        .to_armored_string(None.into())
        .map_err(|e| CoreError::Unavailable(e.to_string()))?;
    Ok(Identity {
        email: email.to_string(),
        fingerprint: hex::encode_upper(secret.fingerprint().as_bytes()),
        public_key_armored: armored,
        created_at: created_at(secret)?,
    })
}

/// When the key was actually made, read from the key packet.
///
/// This used to be `Utc::now()`, which meant `loadIdentity` reported a
/// different creation time on every call — the key appeared to have been
/// created the instant it was looked at. Nothing branched on it, so nothing
/// broke; a "key first seen" UI built on it would simply have lied.
///
/// The creation timestamp is not incidental metadata: it is hashed into the
/// fingerprint, so it is fixed the moment the key exists and is the same value
/// every other OpenPGP implementation reports.
fn created_at(secret: &SignedSecretKey) -> Result<String> {
    let seconds = i64::from(KeyDetails::created_at(&secret.primary_key).as_secs());
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|t| t.to_rfc3339())
        .ok_or_else(|| CoreError::Malformed("key creation time is out of range".into()))
}
