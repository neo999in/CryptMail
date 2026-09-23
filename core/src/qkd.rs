//! Level 2: messages encrypted with keys from the Key Manager (`km.rs`).
//!
//! **Quantum-aided AES.** One 1 Kb key from the bank seeds HKDF-SHA256, whose
//! output is the AES-256-GCM key for this message. The quantum key is the
//! entropy; AES does the bulk work, so any size of message and its attachments
//! fit in one key.
//!
//! **Bound to the sender.** Both ends of a link draw from the whole bank — there
//! are no halves — so both may pick the same bank key before either has seen
//! the other's message. The derivation therefore takes the sender's SAE ID as
//! well as the key: the same bank key sealed by the two ends gives two
//! unrelated AES keys, and nothing is reused. That is what lets the bank stay
//! whole. It rests on the two ends' SAE IDs differing, which linking ensures,
//! and on one phone per SAE issuing keys, which a device transfer's hand-over
//! ensures.
//!
//! **Level 3, the one-time pad, is gone.** A pad cannot be bound this way — the
//! key bytes *are* the cipher, so two ends picking one key would reuse the pad —
//! and it was the only reason the bank had halves. A Level 3 message that
//! arrives is refused before any key is touched; one opened before is still in
//! the app's archive.
//!
//! Level 2 uses no public key: what makes a message readable is holding
//! the same keys at the Key Manager, which is what QKD provides. The key IDs
//! travel with the message, in the clear, exactly as ETSI GS QKD 014 intends —
//! an ID without the bank is worthless.
//!
//! # On the wire
//!
//! A text armor block, so the email is an ordinary text message any mail
//! system carries and any client displays:
//!
//! ```text
//! -----BEGIN CRYPTMAIL QKD MESSAGE-----
//! Level: 2
//! Cipher: AES-256-GCM, key from HKDF-SHA256 over a QKD key and the sender
//! SAE: sae-3f9a01c2b7d4
//! Key-ID: 1c0e…-0001
//!
//! base64 payload
//! -----END CRYPTMAIL QKD MESSAGE-----
//! ```
//!
//! The `Cipher:` line says which derivation sealed it: [`CIPHER_BOUND`] is what
//! this version sends, [`CIPHER_UNBOUND`] what it sent while the bank had
//! halves — mail sealed that way still opens. Every header line is
//! authenticated: the AEAD covers them.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use rand::{thread_rng, RngCore};
use serde::Serialize;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::km::KeyManager;
use crate::{CoreError, Result};

pub const BEGIN: &str = "-----BEGIN CRYPTMAIL QKD MESSAGE-----";
pub const END: &str = "-----END CRYPTMAIL QKD MESSAGE-----";

/// What this version seals with: the AES key depends on the sender's SAE ID.
pub const CIPHER_BOUND: &str = "AES-256-GCM, key from HKDF-SHA256 over a QKD key and the sender";
/// What Level 2 sealed with while the bank had halves: the key alone.
pub const CIPHER_UNBOUND: &str = "AES-256-GCM, key from HKDF-SHA256 over a QKD key";

#[derive(Serialize)]
pub struct Opened {
    pub plaintext: String,
    pub level: u8,
    #[serde(rename = "senderSae")]
    pub sender_sae: String,
}

/// Encrypt `plaintext` at `level` with a fresh key from this end's bank. Only
/// Level 2 exists.
pub fn seal(km: &KeyManager, level: u8, plaintext: &str) -> Result<String> {
    match level {
        2 => {
            let (sae, keys) = km.enc_keys(1)?;
            let ids = vec![keys[0].id.clone()];
            let header = header(2, CIPHER_BOUND, &sae, &ids);
            let mut nonce = [0u8; 12];
            thread_rng().fill_bytes(&mut nonce);
            let sealed = aes(&keys[0].key, &keys[0].id, Some(&sae))
                .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad: header.as_bytes() })
                .map_err(|_| CoreError::Unavailable("could not encrypt with the quantum key".into()))?;
            Ok(armor(&header, &[&nonce[..], &sealed].concat()))
        }
        3 => Err(level_3_removed()),
        _ => Err(CoreError::Malformed(format!("there is no quantum security level {level}"))),
    }
}

/// Open a Level 2 message. The key it names is fetched from the bank and
/// **deleted** there — it opens once.
pub fn open(km: &KeyManager, armored: &str) -> Result<Opened> {
    let parsed = parse(armored)?;
    // Checked before any key is fetched: a message that cannot open must not
    // cost keys.
    let bound = match parsed.level {
        2 if parsed.ids.len() == 1 && parsed.payload.len() >= 12 + 16 => match parsed.cipher.as_str() {
            CIPHER_BOUND => true,
            CIPHER_UNBOUND => false,
            _ => return Err(damaged()),
        },
        3 => return Err(level_3_removed()),
        _ => return Err(damaged()),
    };
    let header = header(parsed.level, &parsed.cipher, &parsed.sae, &parsed.ids);
    let keys = km.dec_keys(&parsed.ids)?;

    let (nonce, sealed) = parsed.payload.split_at(12);
    let plain = Zeroizing::new(
        aes(&keys[0].key, &keys[0].id, bound.then_some(parsed.sae.as_str()))
            .decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad: header.as_bytes() })
            .map_err(|_| tampered())?,
    );
    let plaintext = String::from_utf8(plain.to_vec()).map_err(|_| damaged())?;
    Ok(Opened { plaintext, level: parsed.level, sender_sae: parsed.sae })
}

struct Parsed {
    level: u8,
    cipher: String,
    sae: String,
    ids: Vec<String>,
    payload: Vec<u8>,
}

fn parse(armored: &str) -> Result<Parsed> {
    let start = armored.find(BEGIN).ok_or_else(damaged)? + BEGIN.len();
    let end = armored[start..].find(END).ok_or_else(damaged)? + start;
    let (mut level, mut cipher, mut sae, mut ids, mut body) =
        (0u8, String::new(), String::new(), Vec::new(), String::new());
    for line in armored[start..end].lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("Level:") {
            level = v.trim().parse().map_err(|_| damaged())?;
        } else if let Some(v) = line.strip_prefix("Cipher:") {
            cipher = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("SAE:") {
            sae = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Key-ID:") {
            ids.push(v.trim().to_string());
        } else if !line.contains(':') {
            body.push_str(line);
        }
    }
    let payload = B64.decode(body).map_err(|_| damaged())?;
    Ok(Parsed { level, cipher, sae, ids, payload })
}

/// The authenticated header: what the AEAD covers besides the payload.
fn header(level: u8, cipher: &str, sae: &str, ids: &[String]) -> String {
    let mut out = format!("Level: {level}\nCipher: {cipher}\nSAE: {sae}\n");
    for id in ids {
        out.push_str(&format!("Key-ID: {id}\n"));
    }
    out
}

fn armor(header: &str, payload: &[u8]) -> String {
    let mut out = format!("{BEGIN}\n{header}\n");
    for line in B64.encode(payload).as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
        out.push('\n');
    }
    out.push_str(END);
    out.push('\n');
    out
}

/// The AES key for one message. `sender` is the sealing end's SAE ID, so the
/// two ends of a link turn one bank key into two unrelated AES keys; `None` is
/// the derivation from while the bank had halves, kept so that mail still
/// opens.
fn aes(qkd_key: &[u8], key_id: &str, sender: Option<&str>) -> Aes256Gcm {
    let mut key = Zeroizing::new([0u8; 32]);
    let hkdf = Hkdf::<Sha256>::new(Some(key_id.as_bytes()), qkd_key);
    match sender {
        Some(sae) => hkdf.expand_multi_info(&[b"cryptmail/v2/qkd-aes\0", sae.as_bytes()], &mut *key),
        None => hkdf.expand(b"cryptmail/v1/qkd-aes", &mut *key),
    }
    .expect("32 bytes is a valid HKDF-SHA256 output length");
    Aes256Gcm::new_from_slice(&*key).expect("32-byte key")
}

fn level_3_removed() -> CoreError {
    CoreError::DecryptFailed(
        "level-3-removed: Level 3, the one-time pad, was removed from CryptMail, so this message cannot be \
         opened here. A copy you opened before is still in your archive."
            .into(),
    )
}

fn damaged() -> CoreError {
    CoreError::Malformed("this quantum-encrypted message is damaged or incomplete".into())
}

fn tampered() -> CoreError {
    CoreError::DecryptFailed("this quantum-encrypted message was changed after it was sent".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn km(name: &str) -> KeyManager {
        let dir = std::env::temp_dir().join(format!("cryptmail-qkd-unit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        KeyManager::for_account(&dir, "keystore passphrase", "alice@example.com").unwrap()
    }

    #[test]
    fn one_bank_key_sealed_by_two_ends_is_two_aes_keys() {
        let (key, id, nonce) = ([7u8; 128], "1c0e0000-0000-4000-0000-000000000001", [0u8; 12]);
        let seal = |sender: Option<&str>| aes(&key, id, sender).encrypt(Nonce::from_slice(&nonce), b"same".as_ref()).unwrap();
        assert_ne!(seal(Some("sae-alice")), seal(Some("sae-bob")));
        assert_ne!(seal(Some("sae-alice")), seal(None));
    }

    #[test]
    fn level_2_mail_sealed_before_the_sender_binding_still_opens() {
        // Exactly what the previous version sent: the key alone, and the old
        // `Cipher:` line under the AEAD.
        let km = km("unbound");
        let (sae, keys) = km.enc_keys(1).unwrap();
        let ids = vec![keys[0].id.clone()];
        let header = header(2, CIPHER_UNBOUND, &sae, &ids);
        let nonce = [9u8; 12];
        let sealed = aes(&keys[0].key, &keys[0].id, None)
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: b"sent last week", aad: header.as_bytes() })
            .unwrap();
        let armored = armor(&header, &[&nonce[..], &sealed].concat());

        let opened = open(&km, &armored).unwrap();
        assert_eq!(opened.plaintext, "sent last week");
        assert_eq!(opened.level, 2);
    }

    #[test]
    fn a_cipher_line_changed_between_the_two_derivations_does_not_open() {
        let km = km("downgrade");
        let armored = seal(&km, 2, "bound").unwrap();
        let swapped = armored.replace(CIPHER_BOUND, CIPHER_UNBOUND);
        assert_ne!(swapped, armored);
        assert!(open(&km, &swapped).is_err());
    }
}
