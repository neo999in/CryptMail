//! Levels 2 and 3: messages encrypted with keys from the Key Manager (`km.rs`).
//!
//! - **Level 2, quantum-aided AES.** One 1 Kb key from the bank seeds
//!   HKDF-SHA256, whose output is the AES-256-GCM key for this message. The
//!   quantum key is the entropy; AES does the bulk work, so any size of message
//!   and its attachments fit in one key.
//! - **Level 3, one-time pad.** The message is XORed with quantum key bytes
//!   directly — as many 1 Kb keys as it is long, never reused — and a final
//!   key authenticates it with HMAC-SHA256. A pad alone would let anyone flip
//!   bits undetected, so the MAC is not optional. The pad is information-
//!   theoretically secure; the MAC is computational (a Wegman–Carter MAC would
//!   make it information-theoretic too, at the cost of more key).
//!
//! Neither level uses a public key: what makes a message readable is holding
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
//! Cipher: AES-256-GCM, key from HKDF-SHA256 over a QKD key
//! SAE: sae-3f9a01c2b7d4
//! Key-ID: 1c0e…-0001
//!
//! base64 payload
//! -----END CRYPTMAIL QKD MESSAGE-----
//! ```
//!
//! Level 3 repeats `Key-ID:` once per key, pad keys first and the MAC key
//! last. Each header line is authenticated: the AEAD or the MAC covers them.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{thread_rng, RngCore};
use serde::Serialize;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::km::{KeyManager, KEY_BYTES};
use crate::{CoreError, Result};

pub const BEGIN: &str = "-----BEGIN CRYPTMAIL QKD MESSAGE-----";
pub const END: &str = "-----END CRYPTMAIL QKD MESSAGE-----";

#[derive(Serialize)]
pub struct Opened {
    pub plaintext: String,
    pub level: u8,
    #[serde(rename = "senderSae")]
    pub sender_sae: String,
}

/// Encrypt `plaintext` at `level` (2 or 3) with fresh keys from this end's bank.
pub fn seal(km: &KeyManager, level: u8, plaintext: &str) -> Result<String> {
    let bytes = plaintext.as_bytes();
    match level {
        2 => {
            let (sae, keys) = km.enc_keys(1)?;
            let ids = vec![keys[0].id.clone()];
            let header = header(2, &sae, &ids);
            let mut nonce = [0u8; 12];
            thread_rng().fill_bytes(&mut nonce);
            let sealed = aes(&keys[0].key, &keys[0].id)
                .encrypt(Nonce::from_slice(&nonce), Payload { msg: bytes, aad: header.as_bytes() })
                .map_err(|_| CoreError::Unavailable("could not encrypt with the quantum key".into()))?;
            Ok(armor(&header, &[&nonce[..], &sealed].concat()))
        }
        3 => {
            let pads = bytes.len().div_ceil(KEY_BYTES).max(1);
            let (sae, keys) = km.enc_keys(pads + 1)?;
            let ids: Vec<String> = keys.iter().map(|k| k.id.clone()).collect();
            let header = header(3, &sae, &ids);
            let pad: Zeroizing<Vec<u8>> = Zeroizing::new(keys[..pads].iter().flat_map(|k| k.key.iter().copied()).collect());
            let cipher: Vec<u8> = bytes.iter().zip(pad.iter()).map(|(m, p)| m ^ p).collect();
            let tag = mac(&keys[pads].key, &header, &cipher);
            Ok(armor(&header, &[cipher, tag].concat()))
        }
        _ => Err(CoreError::Malformed(format!("there is no quantum security level {level}"))),
    }
}

/// Open a Level 2 or 3 message. The keys it names are fetched from the bank and
/// **deleted** there — it opens once.
pub fn open(km: &KeyManager, armored: &str) -> Result<Opened> {
    let parsed = parse(armored)?;
    let header = header(parsed.level, &parsed.sae, &parsed.ids);
    // Checked before any key is fetched: a malformed message must not cost keys.
    match parsed.level {
        2 if parsed.ids.len() == 1 && parsed.payload.len() >= 12 + 16 => {}
        3 if parsed.ids.len() >= 2 && parsed.payload.len() >= 32 => {
            let pads = parsed.ids.len() - 1;
            if parsed.payload.len() - 32 > pads * KEY_BYTES {
                return Err(damaged());
            }
        }
        _ => return Err(damaged()),
    }
    let keys = km.dec_keys(&parsed.ids)?;

    let plain = match parsed.level {
        2 => {
            let (nonce, sealed) = parsed.payload.split_at(12);
            Zeroizing::new(
                aes(&keys[0].key, &keys[0].id)
                    .decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad: header.as_bytes() })
                    .map_err(|_| tampered())?,
            )
        }
        _ => {
            let pads = keys.len() - 1;
            let (cipher, tag) = parsed.payload.split_at(parsed.payload.len() - 32);
            let mut check = <Hmac<Sha256> as Mac>::new_from_slice(&keys[pads].key).expect("any key length");
            check.update(header.as_bytes());
            check.update(cipher);
            check.verify_slice(tag).map_err(|_| tampered())?;
            let pad: Zeroizing<Vec<u8>> = Zeroizing::new(keys[..pads].iter().flat_map(|k| k.key.iter().copied()).collect());
            Zeroizing::new(cipher.iter().zip(pad.iter()).map(|(c, p)| c ^ p).collect())
        }
    };
    let plaintext = String::from_utf8(plain.to_vec()).map_err(|_| damaged())?;
    Ok(Opened { plaintext, level: parsed.level, sender_sae: parsed.sae })
}

struct Parsed {
    level: u8,
    sae: String,
    ids: Vec<String>,
    payload: Vec<u8>,
}

fn parse(armored: &str) -> Result<Parsed> {
    let start = armored.find(BEGIN).ok_or_else(damaged)? + BEGIN.len();
    let end = armored[start..].find(END).ok_or_else(damaged)? + start;
    let (mut level, mut sae, mut ids, mut body) = (0u8, String::new(), Vec::new(), String::new());
    for line in armored[start..end].lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("Level:") {
            level = v.trim().parse().map_err(|_| damaged())?;
        } else if let Some(v) = line.strip_prefix("SAE:") {
            sae = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Key-ID:") {
            ids.push(v.trim().to_string());
        } else if !line.contains(':') {
            body.push_str(line);
        }
    }
    let payload = B64.decode(body).map_err(|_| damaged())?;
    Ok(Parsed { level, sae, ids, payload })
}

/// The authenticated header: what the AEAD or MAC covers besides the payload.
fn header(level: u8, sae: &str, ids: &[String]) -> String {
    let cipher = if level == 2 {
        "AES-256-GCM, key from HKDF-SHA256 over a QKD key"
    } else {
        "one-time pad, HMAC-SHA256 with a QKD key"
    };
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

fn aes(qkd_key: &[u8], key_id: &str) -> Aes256Gcm {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(key_id.as_bytes()), qkd_key)
        .expand(b"cryptmail/v1/qkd-aes", &mut *key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    Aes256Gcm::new_from_slice(&*key).expect("32-byte key")
}

fn mac(key: &[u8], header: &str, cipher: &[u8]) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    m.update(header.as_bytes());
    m.update(cipher);
    m.finalize().into_bytes().to_vec()
}

fn damaged() -> CoreError {
    CoreError::Malformed("this quantum-encrypted message is damaged or incomplete".into())
}

fn tampered() -> CoreError {
    CoreError::DecryptFailed("this quantum-encrypted message was changed after it was sent".into())
}
