//! UniFFI surface — the five operations the Kotlin module exposes to React
//! Native as `CryptMailCore` (see `app/src/core/nativeCore.ts`).
//!
//! This layer exists to keep `lib.rs` free of FFI concerns and to enforce two
//! things at the boundary:
//!
//! 1. **Errors carry the code the TypeScript side already handles.** `CoreError`
//!    in `types.ts` switches on `'no-key' | 'malformed' | 'decrypt-failed' |
//!    'unavailable'`, so the FFI error must preserve that, not flatten to a
//!    string.
//! 2. **The passphrase is supplied by Kotlin, not JavaScript.** It comes from
//!    the Android Keystore and never appears in a JS-visible signature — which
//!    is the entire reason for a native core.

use crate::{Core, CoreError};

/// The error shape crossing the FFI. `code` maps 1:1 onto the TypeScript union.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct FfiError {
    pub code: String,
    pub message: String,
}

impl From<CoreError> for FfiError {
    fn from(e: CoreError) -> Self {
        Self { code: e.code().to_string(), message: e.to_string() }
    }
}

type FfiResult<T> = std::result::Result<T, FfiError>;

/// Handle held by the Kotlin module for the lifetime of the app.
///
/// `storage_dir` is app-private storage; `passphrase` is unwrapped from the
/// Android Keystore by the Kotlin side at construction and held only here.
pub struct CryptMailCore {
    core: Core,
    passphrase: String,
}

impl CryptMailCore {
    pub fn new(storage_dir: String, passphrase: String) -> Self {
        Self { core: Core::new(storage_dir), passphrase }
    }

    pub fn generate_identity(&self, email: String) -> FfiResult<String> {
        Ok(self.core.generate_identity(&email, &self.passphrase)?)
    }

    pub fn load_identity(&self, email: String) -> FfiResult<Option<String>> {
        Ok(self.core.load_identity(&email)?)
    }

    pub fn import_public_key(&self, armored: String) -> FfiResult<String> {
        Ok(self.core.import_public_key(&armored)?)
    }

    pub fn encrypt_sign(
        &self,
        email: String,
        plaintext: String,
        recipient_keys_json: String,
    ) -> FfiResult<String> {
        let keys = parse_keys(&recipient_keys_json)?;
        Ok(self.core.encrypt_sign(&email, &self.passphrase, &plaintext, &keys)?)
    }

    /// Takes no address on purpose: the envelope cannot say which identity to
    /// decrypt with — our address may be in `Cc`, or `To` may list several
    /// people — so the core uses the identity this device holds.
    pub fn decrypt_verify(&self, armored: String, sender_keys_json: String) -> FfiResult<String> {
        let keys = parse_keys(&sender_keys_json)?;
        let email = self.sole_identity_email()?;
        Ok(self.core.decrypt_verify(&email, &self.passphrase, &armored, &keys)?)
    }

    /// The prototype holds one identity per device. `data-model.md` allows N
    /// per account, so when multiple identities land this becomes "try each
    /// until one decrypts" rather than an error.
    fn sole_identity_email(&self) -> FfiResult<String> {
        self.core
            .stored_identity_email()
            .map_err(FfiError::from)?
            .ok_or_else(|| FfiError {
                code: "no-key".into(),
                message: "this device has no identity key yet".into(),
            })
    }
}

fn parse_keys(json: &str) -> FfiResult<Vec<String>> {
    serde_json::from_str(json).map_err(|e| FfiError {
        code: "malformed".into(),
        message: format!("expected a JSON array of armored keys: {e}"),
    })
}
