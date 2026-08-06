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

/// The error crossing the FFI. One variant per `CoreError` code, so the
/// TypeScript union `'no-key' | 'malformed' | 'decrypt-failed' | 'unavailable'`
/// survives the trip intact.
///
/// This is an enum rather than a `{ code, message }` struct because UniFFI only
/// derives `Error` for enums — and the enum is the better shape anyway: Kotlin
/// receives a sealed `FfiException` whose subclasses *are* the four codes, so
/// the mapping is a `when` over types the compiler checks exhaustively instead
/// of a string comparison that fails silently on a typo. `code()` is retained
/// for callers that still want the wire string.
/// `flat_error` makes the Kotlin exception's `message` the `Display` string
/// ("no-key: …"). Without it UniFFI names the payload positionally and Kotlin
/// reports `message` as the literal `"v1=…"`, which would surface in the app's
/// error banner.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum FfiError {
    #[error("no-key: {0}")]
    NoKey(String),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("decrypt-failed: {0}")]
    DecryptFailed(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
}

impl FfiError {
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

impl From<CoreError> for FfiError {
    fn from(e: CoreError) -> Self {
        let message = e.to_string();
        match e {
            CoreError::NoKey(_) => Self::NoKey(message),
            CoreError::Malformed(_) => Self::Malformed(message),
            CoreError::DecryptFailed(_) => Self::DecryptFailed(message),
            CoreError::Unavailable(_) => Self::Unavailable(message),
        }
    }
}

type FfiResult<T> = std::result::Result<T, FfiError>;

/// Handle held by the Kotlin module for the lifetime of the app.
///
/// `storage_dir` is app-private storage; `passphrase` is unwrapped from the
/// Android Keystore by the Kotlin side at construction and held only here.
#[derive(uniffi::Object)]
pub struct CryptMailCore {
    core: Core,
    passphrase: String,
}

#[uniffi::export]
impl CryptMailCore {
    #[uniffi::constructor]
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
}

// Deliberately outside the `#[uniffi::export]` block above: that macro turns
// every method it sees into FFI surface, and this helper is internal.
impl CryptMailCore {
    /// The prototype holds one identity per device. `data-model.md` allows N
    /// per account, so when multiple identities land this becomes "try each
    /// until one decrypts" rather than an error.
    fn sole_identity_email(&self) -> FfiResult<String> {
        self.core
            .stored_identity_email()
            .map_err(FfiError::from)?
            .ok_or_else(|| FfiError::NoKey("this device has no identity key yet".into()))
    }
}

fn parse_keys(json: &str) -> FfiResult<Vec<String>> {
    serde_json::from_str(json).map_err(|e| {
        FfiError::Malformed(format!("expected a JSON array of armored keys: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_keys, FfiError};
    use crate::CoreError;

    /// The conversion is written by hand, so nothing but a test stops a variant
    /// from being wired to the wrong code. Getting this wrong is quiet and
    /// nasty: `decrypt-failed` arriving as `malformed` would send the UI down a
    /// "re-import their key" path for a message that simply was not for us.
    #[test]
    fn every_core_error_keeps_its_code_across_the_ffi() {
        let cases = [
            (CoreError::NoKey("x".into()), "no-key"),
            (CoreError::Malformed("x".into()), "malformed"),
            (CoreError::DecryptFailed("x".into()), "decrypt-failed"),
            (CoreError::Unavailable("x".into()), "unavailable"),
        ];
        for (source, expected) in cases {
            assert_eq!(source.code(), expected, "CoreError code drifted");
            assert_eq!(FfiError::from(source).code(), expected, "FfiError code drifted");
        }
    }

    /// `flat_error` hands Kotlin the `Display` string as the exception message,
    /// so it has to stay useful — both the code and the cause.
    #[test]
    fn the_message_carries_the_code_and_the_cause() {
        let message = FfiError::from(CoreError::DecryptFailed("bad tag".into())).to_string();
        assert!(message.contains("decrypt-failed"), "{message}");
        assert!(message.contains("bad tag"), "{message}");
    }

    #[test]
    fn a_recipient_list_that_is_not_json_is_malformed_not_a_panic() {
        assert_eq!(parse_keys("not json").unwrap_err().code(), "malformed");
        assert_eq!(parse_keys(r#"["-----BEGIN PGP PUBLIC KEY BLOCK-----"]"#).unwrap().len(), 1);
    }
}
