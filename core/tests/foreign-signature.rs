//! Regression test for a defect this crate's own tests could not have found.
//!
//! `cryptmail-core` signs with its Ed25519 **primary** key. Most other OpenPGP
//! clients — Sequoia, GnuPG, Proton — sign with a dedicated **signing subkey**.
//! `verify()` originally checked the primary only, so every message from such a
//! sender came back `invalid`, which the UI renders as *forged*. Not merely
//! unhelpful: it accuses a legitimate correspondent, and `invalid` is the one
//! state `docs/key-management.md` treats as an active warning.
//!
//! No round-trip against ourselves can catch this, because we always sign with
//! the primary. It took a second implementation — see
//! `spike/interop-rpgp-sequoia`, which found it.
//!
//! The fixtures below were produced by that harness and are checked in so the
//! regression is guarded by a plain `cargo test`, with no Sequoia dependency
//! (the two libraries cannot even be linked into one binary — see its README).
//!
//! `identity/` holds a throwaway secret key, S2K-encrypted under the passphrase
//! below. It protects nothing and is used nowhere else.

use cryptmail_core::Core;
use serde_json::Value;

/// The passphrase the fixture identity was generated under.
const PW: &str = "interop-harness-passphrase";
const FIXTURES: &str = "tests/fixtures/subkey-signature";

fn decrypt_the_fixture() -> Value {
    let core = Core::new(format!("{FIXTURES}/identity"));
    let message = std::fs::read_to_string(format!("{FIXTURES}/message.asc")).unwrap();
    let sender = std::fs::read_to_string(format!("{FIXTURES}/sender-cert.asc")).unwrap();

    let json = core
        .decrypt_verify("alice@example.com", PW, &message, &[sender])
        .expect("could not decrypt a message from another OpenPGP implementation");
    serde_json::from_str(&json).unwrap()
}

#[test]
fn a_signature_from_a_signing_subkey_is_valid_not_forged() {
    let decrypted = decrypt_the_fixture();

    assert_eq!(decrypted["plaintext"], "Hey, are we still on for lunch?");
    assert_eq!(
        decrypted["signature"], "valid",
        "a signature made by the sender's signing subkey must verify; \
         reporting it as anything else accuses a real correspondent of forgery",
    );
}

/// The fingerprint shown to the user must identify the *certificate*, not
/// whichever subkey happened to sign. The keyring is indexed by the former, and
/// it is what a user compares out of band during verification.
#[test]
fn the_reported_fingerprint_is_the_certificates_own() {
    let decrypted = decrypt_the_fixture();
    let reported = decrypted["signerFingerprint"].as_str().expect("no fingerprint reported");

    let sender = std::fs::read_to_string(format!("{FIXTURES}/sender-cert.asc")).unwrap();
    let core = Core::new(format!("{FIXTURES}/identity"));
    let imported: Value = serde_json::from_str(&core.import_public_key(&sender).unwrap()).unwrap();

    assert_eq!(
        reported,
        imported["fingerprint"].as_str().unwrap(),
        "the signer fingerprint does not match the certificate the keyring stores",
    );
}

/// Accepting subkey signatures must not have turned `verify` into "try
/// everything until something passes" — an unrelated certificate must still
/// come back `invalid`.
#[test]
fn a_signature_checked_against_the_wrong_certificate_is_still_invalid() {
    let core = Core::new(format!("{FIXTURES}/identity"));
    let message = std::fs::read_to_string(format!("{FIXTURES}/message.asc")).unwrap();

    // Our own certificate — a real, parseable key that did not sign this.
    let ours: Value =
        serde_json::from_str(&core.load_identity("alice@example.com").unwrap().unwrap()).unwrap();
    let wrong_cert = ours["publicKeyArmored"].as_str().unwrap().to_string();

    let json = core.decrypt_verify("alice@example.com", PW, &message, &[wrong_cert]).unwrap();
    let decrypted: Value = serde_json::from_str(&json).unwrap();

    assert_eq!(decrypted["signature"], "invalid");
    assert!(decrypted.get("signerFingerprint").is_none(), "reported a signer it did not verify");
}
