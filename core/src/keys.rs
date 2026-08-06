//! Contacts' public keys: parsing an armored block into something the keyring
//! can hold. Mirrors `PublicKeyInfo` in `app/src/core/types.ts`.

use pgp::composed::{Deserializable, SignedPublicKey};
use pgp::types::KeyDetails as _;
use serde::Serialize;

use crate::{CoreError, Result};

#[derive(Debug, Serialize)]
pub struct PublicKeyInfo {
    pub email: String,
    pub fingerprint: String,
    pub armored: String,
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

pub fn import(armored: &str) -> Result<PublicKeyInfo> {
    let trimmed = armored.trim();
    if !trimmed.contains("BEGIN PGP PUBLIC KEY BLOCK") {
        return Err(CoreError::Malformed(
            "that does not look like an armored public key block".into(),
        ));
    }

    let (key, _) = SignedPublicKey::from_string(trimmed)
        .map_err(|e| CoreError::Malformed(format!("unreadable public key: {e}")))?;
    key.verify_bindings()
        .map_err(|e| CoreError::Malformed(format!("public key failed self-verification: {e}")))?;

    // `id()` is raw bytes — a User ID is free text and need not be valid UTF-8.
    let user_id = key
        .details
        .users
        .first()
        .and_then(|u| String::from_utf8(u.id.id().to_vec()).ok());
    let email = user_id
        .as_deref()
        .and_then(address_of)
        .ok_or_else(|| CoreError::Malformed("public key carries no usable email address".into()))?;

    Ok(PublicKeyInfo {
        email,
        fingerprint: hex::encode_upper(key.fingerprint().as_bytes()),
        armored: trimmed.to_string(),
        user_id,
    })
}

/// Pull the address out of an OpenPGP User ID — `Ada Lovelace <ada@x.com>`, or
/// a bare address. Returns it lowercased so it matches keyring lookups, which
/// key on a normalised address.
fn address_of(user_id: &str) -> Option<String> {
    let candidate = match (user_id.rfind('<'), user_id.rfind('>')) {
        (Some(open), Some(close)) if close > open + 1 => &user_id[open + 1..close],
        _ => user_id.trim(),
    };
    let candidate = candidate.trim();
    // Minimal shape check — a User ID is free text, so "contains an @ with
    // something either side" is as much as can be asserted.
    let (local, domain) = candidate.split_once('@')?;
    if local.is_empty() || domain.is_empty() || domain.contains('@') || candidate.contains(' ') {
        return None;
    }
    Some(candidate.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::address_of;

    #[test]
    fn reads_an_address_out_of_a_named_user_id() {
        assert_eq!(address_of("Ada Lovelace <Ada@Example.COM>").as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn accepts_a_bare_address() {
        assert_eq!(address_of("bob@example.com").as_deref(), Some("bob@example.com"));
    }

    #[test]
    fn rejects_a_user_id_with_no_address() {
        assert_eq!(address_of("Ada Lovelace"), None);
        assert_eq!(address_of("<>"), None);
        assert_eq!(address_of("a@b@c"), None);
    }
}
