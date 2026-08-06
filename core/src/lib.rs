//! CryptMail crypto core.
//!
//! Implements the crypto half of the `CryptCore` contract in
//! `app/src/core/types.ts`. **MIME assembly deliberately lives in TypeScript**
//! (`app/src/core/mime.ts`), which already implements `docs/message-format.md`
//! and is covered by tests — reimplementing it here would duplicate the one
//! piece of the envelope that is fiddly and already correct. This crate does
//! only what must not happen in JavaScript: hold the private key and perform
//! the operations that use it.
//!
//! # Invariants
//!
//! 1. **A private key never appears in a return value.** Every public function
//!    returns either a `String` (armored public material or ciphertext) or a
//!    JSON document containing no secret material. This is exit criterion 4 of
//!    `docs/prototype-plan.md`, and the reason a native core exists at all.
//! 2. **Secret keys are encrypted at rest**, S2K-protected with a passphrase the
//!    caller supplies. On Android that passphrase comes from the Keystore; in
//!    tests it is supplied directly.
//! 3. **Algorithms are Stage 1 of `docs/post-quantum.md`**: an Ed25519 primary
//!    with an ML-KEM-768 + X25519 encryption subkey (RFC 9980). Post-quantum
//!    confidentiality, classical signatures — see that document for why the two
//!    are staged apart.

use std::path::{Path, PathBuf};

mod ffi;
mod identity;
mod keys;
mod message;

pub use ffi::{CryptMailCore, FfiError};
pub use identity::Identity;
pub use keys::PublicKeyInfo;
pub use message::Decrypted;

/// Everything that can go wrong, mapped onto the `CoreError` codes the
/// TypeScript side already understands (`app/src/core/types.ts`).
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("no key: {0}")]
    NoKey(String),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("decrypt-failed: {0}")]
    DecryptFailed(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
}

impl CoreError {
    /// The `code` field of the TypeScript `CoreError`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoKey(_) => "no-key",
            Self::Malformed(_) => "malformed",
            Self::DecryptFailed(_) => "decrypt-failed",
            Self::Unavailable(_) => "unavailable",
        }
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

/// The core, bound to a directory holding this device's encrypted secret keys.
///
/// On Android that directory is app-private storage and the passphrase is
/// Keystore-wrapped; the crate itself is platform-agnostic so it can be tested
/// headlessly (M1 of `docs/prototype-plan.md`).
pub struct Core {
    dir: PathBuf,
}

impl Core {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self { dir: dir.as_ref().to_path_buf() }
    }

    /// Generate this device's identity and store the secret key encrypted.
    /// Returns the public half as JSON — never the secret key.
    pub fn generate_identity(&self, email: &str, passphrase: &str) -> Result<String> {
        let identity = identity::generate(&self.dir, email, passphrase)?;
        json(&identity)
    }

    /// The identity created on a previous run, or `Ok(None)` on a fresh install.
    pub fn load_identity(&self, email: &str) -> Result<Option<String>> {
        match identity::load_public(&self.dir, email)? {
            Some(identity) => Ok(Some(json(&identity)?)),
            None => Ok(None),
        }
    }

    /// Parse and validate an armored public key. Errors if it is not usable.
    pub fn import_public_key(&self, armored: &str) -> Result<String> {
        json(&keys::import(armored)?)
    }

    /// Sign with this device's key and encrypt to every recipient.
    ///
    /// `recipient_keys` are armored public keys; the caller is responsible for
    /// including the sender's own key so the message stays readable in Sent.
    /// Returns an armored OpenPGP message for the TypeScript side to wrap in a
    /// PGP/MIME envelope.
    pub fn encrypt_sign(
        &self,
        email: &str,
        passphrase: &str,
        plaintext: &str,
        recipient_keys: &[String],
    ) -> Result<String> {
        if recipient_keys.is_empty() {
            return Err(CoreError::NoKey("no recipient keys supplied".into()));
        }
        let secret = identity::load_secret(&self.dir, email)?;
        message::encrypt_sign(&secret, passphrase, plaintext, recipient_keys)
    }

    /// Decrypt an armored OpenPGP message and report the signature state.
    pub fn decrypt_verify(
        &self,
        email: &str,
        passphrase: &str,
        armored: &str,
        sender_keys: &[String],
    ) -> Result<String> {
        let secret = identity::load_secret(&self.dir, email)?;
        json(&message::decrypt_verify(&secret, passphrase, armored, sender_keys)?)
    }

    /// The address of the identity this device holds, if any. Used by the FFI
    /// layer, which cannot learn it from an incoming envelope.
    pub fn stored_identity_email(&self) -> Result<Option<String>> {
        identity::stored_email(&self.dir)
    }
}

fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|e| CoreError::Unavailable(e.to_string()))
}
