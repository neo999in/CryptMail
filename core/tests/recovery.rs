//! Key recovery, end to end through the public `Core` API.
//!
//! Argon2id at 64 MiB costs ~100ms per unlock and most of these do two, so this
//! file is deliberately slower than the rest of the suite. That is the feature
//! working.

use std::fs;

use cryptmail_core::Core;
use pgp::composed::{Deserializable, SignedSecretKey};
use pgp::types::Password;
use serde_json::Value;

const PW: &str = "correct horse battery staple";
const CODE: &str = "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q";

fn tmpdir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cryptmail-recovery-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_blob_is_a_conforming_secret_key_locked_under_the_code() {
    let dir = tmpdir("blob");
    let core = Core::new(&dir);
    core.generate_identity("alice@example.com", PW).unwrap();

    let blob = core.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    assert!(blob.contains("BEGIN PGP PRIVATE KEY BLOCK"), "not an armored secret key");
    assert!(!blob.contains(PW), "the Keystore passphrase leaked into the blob");
    assert!(!blob.contains(CODE), "the recovery code leaked into the blob");

    // It parses as a standard transferable secret key — the interoperability
    // claim in the spec, asserted rather than assumed.
    let (mut parsed, _) =
        SignedSecretKey::from_string(&blob).expect("blob is not a parseable secret key");
    assert!(!parsed.secret_subkeys.is_empty(), "the ML-KEM subkey did not survive the wrap");

    // It is locked under the *code*, not the device passphrase — otherwise a
    // stolen backup would open with a Keystore secret the thief may also have.
    let device_pw: Password = PW.into();
    assert!(
        parsed.primary_key.remove_password(&device_pw).is_err(),
        "the blob still opens with this device's Keystore passphrase"
    );
}

#[test]
fn exporting_leaves_the_device_key_untouched() {
    // Taking a backup must not be able to lock a user out of the device they
    // took it on. The export works on an in-memory copy and writes nothing.
    let dir = tmpdir("untouched");
    let core = Core::new(&dir);
    core.generate_identity("alice@example.com", PW).unwrap();
    let before: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();

    core.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let after: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();
    assert_eq!(before, after, "export rewrote the stored secret key");
    // And it still opens with the Keystore passphrase.
    core.load_identity("alice@example.com").unwrap().expect("identity vanished");
}

#[test]
fn exporting_without_an_identity_is_no_key() {
    let core = Core::new(tmpdir("no-identity"));
    let err = core.export_recovery_backup("nobody@example.com", PW, CODE).unwrap_err();
    assert_eq!(err.code(), "no-key");
}

#[test]
fn a_backup_restores_the_same_identity_on_a_fresh_device() {
    let old = Core::new(tmpdir("restore-old"));
    let original: Value =
        serde_json::from_str(&old.generate_identity("alice@example.com", PW).unwrap()).unwrap();
    let blob = old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    // A different device: different directory, different Keystore passphrase.
    let new = Core::new(tmpdir("restore-new"));
    let restored: Value = serde_json::from_str(
        &new.import_recovery_backup("a different keystore pw", &blob, CODE).unwrap(),
    )
    .unwrap();

    assert_eq!(restored["fingerprint"], original["fingerprint"], "fingerprint changed");
    assert_eq!(restored["email"], "alice@example.com");
    assert_eq!(restored["publicKeyArmored"], original["publicKeyArmored"]);
    assert!(
        !restored.to_string().contains("PRIVATE KEY"),
        "secret key leaked into the identity JSON"
    );

    // The restored key is usable on the new device under its own passphrase.
    let loaded = new.load_identity("alice@example.com").unwrap().expect("nothing stored");
    let loaded: Value = serde_json::from_str(&loaded).unwrap();
    assert_eq!(loaded["fingerprint"], original["fingerprint"]);
}

#[test]
fn the_code_is_accepted_however_it_was_written_down() {
    let old = Core::new(tmpdir("written-old"));
    old.generate_identity("alice@example.com", PW).unwrap();
    let blob = old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let new = Core::new(tmpdir("written-new"));
    // Lowercase, no grouping, and an l typed where a 1 was written.
    new.import_recovery_backup(PW, &blob, "k7m2nq8zr4j5twxb3hypd6c9fgkmln8q")
        .expect("a transcription slip must not read as a wrong code");
}

#[test]
fn a_wrong_code_is_decrypt_failed() {
    let old = Core::new(tmpdir("wrong-old"));
    old.generate_identity("alice@example.com", PW).unwrap();
    let blob = old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let new = Core::new(tmpdir("wrong-new"));
    let err = new
        .import_recovery_backup(PW, &blob, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH")
        .unwrap_err();
    assert_eq!(err.code(), "decrypt-failed", "a wrong code must not read as a corrupt blob");
}

#[test]
fn something_that_is_not_a_backup_is_malformed() {
    let core = Core::new(tmpdir("malformed"));
    let id: Value =
        serde_json::from_str(&core.generate_identity("alice@example.com", PW).unwrap()).unwrap();

    assert_eq!(
        core.import_recovery_backup(PW, "not a key at all", CODE).unwrap_err().code(),
        "malformed"
    );
    // A *public* key is well-formed OpenPGP and still not a backup.
    let public = id["publicKeyArmored"].as_str().unwrap();
    assert_eq!(core.import_recovery_backup(PW, public, CODE).unwrap_err().code(), "malformed");
}

#[test]
fn mail_encrypted_to_the_lost_device_is_readable_after_recovery() {
    // The whole point of the feature: Bob sends to Alice, Alice's phone is
    // destroyed, Alice restores from her code on a new phone and can still read
    // it. Everything else here is a proxy for this — a matching fingerprint
    // proves the bytes survived, not that the key can still decrypt anything.
    let alice_old = Core::new(tmpdir("e2e-alice-old"));
    let alice: Value =
        serde_json::from_str(&alice_old.generate_identity("alice@example.com", PW).unwrap()).unwrap();
    let alice_key = alice["publicKeyArmored"].as_str().unwrap().to_string();

    let bob = Core::new(tmpdir("e2e-bob"));
    let bob_id: Value =
        serde_json::from_str(&bob.generate_identity("bob@example.com", PW).unwrap()).unwrap();
    let bob_key = bob_id["publicKeyArmored"].as_str().unwrap().to_string();

    let backup = alice_old.export_recovery_backup("alice@example.com", PW, CODE).unwrap();

    let ciphertext = bob
        .encrypt_sign(
            "bob@example.com",
            PW,
            "the eagle lands at dawn",
            &[alice_key, bob_key.clone()],
        )
        .unwrap();

    // Alice's phone is gone. New device, new Keystore passphrase, only the code.
    let alice_new = Core::new(tmpdir("e2e-alice-new"));
    let new_pw = "a completely different keystore passphrase";
    alice_new.import_recovery_backup(new_pw, &backup, CODE).unwrap();

    let decrypted: Value = serde_json::from_str(
        &alice_new
            .decrypt_verify("alice@example.com", new_pw, &ciphertext, &[bob_key])
            .unwrap(),
    )
    .unwrap();

    assert_eq!(decrypted["plaintext"], "the eagle lands at dawn");
    assert_eq!(
        decrypted["signature"], "valid",
        "Bob's signature no longer verifies after recovery"
    );
}
