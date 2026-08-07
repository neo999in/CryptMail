//! End-to-end behaviour of the core, at the level the app depends on.
//!
//! Two people, two devices (two directories), one message. These are the M1
//! checks from `docs/prototype-plan.md`, plus the invariants that make the
//! native core worth having at all.

use std::fs;

use cryptmail_core::Core;
use pgp::composed::{Deserializable, SignedPublicKey};
use pgp::types::{KeyDetails, KeyVersion};
use serde_json::Value;

const PW: &str = "correct horse battery staple";

/// A fresh, isolated storage directory per test — identities must not leak
/// between them.
fn tmpdir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cryptmail-core-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn identity(core: &Core, email: &str) -> Value {
    serde_json::from_str(&core.generate_identity(email, PW).unwrap()).unwrap()
}

fn armored(identity: &Value) -> String {
    identity["publicKeyArmored"].as_str().unwrap().to_string()
}

#[test]
fn generates_a_post_quantum_identity_and_never_returns_the_secret_key() {
    let dir = tmpdir("identity");
    let core = Core::new(&dir);
    let id = identity(&core, "alice@example.com");

    assert_eq!(id["email"], "alice@example.com");
    assert!(id["fingerprint"].as_str().unwrap().len() >= 40);
    assert!(armored(&id).contains("BEGIN PGP PUBLIC KEY BLOCK"));

    // Invariant 1: no secret material in the returned document, in any field.
    let serialised = id.to_string();
    assert!(!serialised.contains("PRIVATE KEY"), "secret key leaked into the identity JSON");
    assert!(!serialised.contains(PW), "passphrase leaked into the identity JSON");

    // Invariant 2: what is on disk is encrypted, not a bare secret key.
    let stored: String = fs::read_dir(&dir)
        .unwrap()
        .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
        .collect();
    assert!(stored.contains("BEGIN PGP PRIVATE KEY BLOCK"), "expected a stored secret key");
    assert!(!stored.contains(PW), "passphrase written to disk in the clear");
}

#[test]
fn the_identity_is_stage_one_hybrid() {
    // Stage 1 of docs/post-quantum.md, asserted on the actual algorithm IDs
    // rather than on certificate size. Size alone is a proxy: it would not
    // notice the encryption subkey silently becoming something classical, which
    // is the one regression this whole crate exists to prevent.
    let core = Core::new(tmpdir("stage1"));
    let armored_cert = armored(&identity(&core, "alice@example.com"));
    let (cert, _) = SignedPublicKey::from_string(&armored_cert).unwrap();

    assert_eq!(
        format!("{:?}", KeyDetails::algorithm(&cert.primary_key)),
        "Ed25519",
        "primary key is not Ed25519"
    );
    assert_eq!(cert.primary_key.version(), KeyVersion::V6, "RFC 9980 requires V6 keys");

    let subkeys: Vec<String> = cert
        .public_subkeys
        .iter()
        .map(|s| format!("{:?}", KeyDetails::algorithm(&s.key)))
        .collect();
    assert!(
        subkeys.iter().any(|a| a == "MlKem768X25519"),
        "no ML-KEM-768+X25519 encryption subkey — got {subkeys:?}. \
         Without it this is not post-quantum at all."
    );
}

#[test]
fn loads_a_previously_generated_identity_and_none_otherwise() {
    let core = Core::new(tmpdir("load"));
    assert!(core.load_identity("nobody@example.com").unwrap().is_none());

    let generated = identity(&core, "alice@example.com");
    let loaded: Value = serde_json::from_str(&core.load_identity("alice@example.com").unwrap().unwrap()).unwrap();
    assert_eq!(loaded["fingerprint"], generated["fingerprint"]);
}

#[test]
fn addresses_are_matched_case_insensitively() {
    let core = Core::new(tmpdir("case"));
    let generated = identity(&core, "Alice@Example.COM");
    let loaded: Value = serde_json::from_str(&core.load_identity("alice@example.com").unwrap().unwrap()).unwrap();
    assert_eq!(loaded["fingerprint"], generated["fingerprint"]);
}

#[test]
fn imports_a_real_public_key() {
    let core = Core::new(tmpdir("import"));
    let cert = armored(&identity(&core, "bob@example.com"));

    let info: Value = serde_json::from_str(&core.import_public_key(&cert).unwrap()).unwrap();
    assert_eq!(info["email"], "bob@example.com");
    assert!(info["fingerprint"].as_str().unwrap().len() >= 40);
}

#[test]
fn rejects_things_that_are_not_public_keys() {
    let core = Core::new(tmpdir("reject"));
    for junk in ["", "hello", "-----BEGIN PGP PUBLIC KEY BLOCK-----\nnonsense\n-----END PGP PUBLIC KEY BLOCK-----"] {
        assert!(core.import_public_key(junk).is_err(), "accepted junk: {junk:?}");
    }
}

#[test]
fn alice_encrypts_to_bob_and_only_bob_can_read_it() {
    let alice_dir = tmpdir("alice");
    let bob_dir = tmpdir("bob");
    let mallory_dir = tmpdir("mallory");
    let (alice, bob, mallory) = (Core::new(&alice_dir), Core::new(&bob_dir), Core::new(&mallory_dir));

    let alice_id = identity(&alice, "alice@example.com");
    let bob_id = identity(&bob, "bob@example.com");
    let _mallory_id = identity(&mallory, "mallory@example.com");

    let plaintext = "Subject: Lunch on Friday?\n\nAre we still on for noon?";
    let armored_msg = alice
        .encrypt_sign("alice@example.com", PW, plaintext, &[armored(&bob_id)])
        .unwrap();

    assert!(armored_msg.contains("BEGIN PGP MESSAGE"));
    assert!(!armored_msg.contains("Lunch on Friday"), "plaintext visible in the ciphertext");

    let opened: Value = serde_json::from_str(
        &bob.decrypt_verify("bob@example.com", PW, &armored_msg, &[armored(&alice_id)]).unwrap(),
    )
    .unwrap();
    assert_eq!(opened["plaintext"], plaintext);
    assert_eq!(opened["signature"], "valid");
    assert_eq!(opened["signerFingerprint"], alice_id["fingerprint"]);

    // The whole point: a third party holding a valid key of their own cannot read it.
    assert!(
        mallory.decrypt_verify("mallory@example.com", PW, &armored_msg, &[armored(&alice_id)]).is_err(),
        "an unintended recipient decrypted the message"
    );
}

#[test]
fn encrypting_to_the_sender_too_keeps_sent_readable() {
    // docs/encryption.md: the session key is encrypted to the sender as well,
    // or the copy in Sent is unreadable to the person who wrote it.
    let dir = tmpdir("sent");
    let core = Core::new(&dir);
    let alice = identity(&core, "alice@example.com");
    let bob = Core::new(tmpdir("sent-bob"));
    let bob_id = identity(&bob, "bob@example.com");

    let msg = core
        .encrypt_sign("alice@example.com", PW, "hello", &[armored(&bob_id), armored(&alice)])
        .unwrap();

    let opened: Value =
        serde_json::from_str(&core.decrypt_verify("alice@example.com", PW, &msg, &[armored(&alice)]).unwrap())
            .unwrap();
    assert_eq!(opened["plaintext"], "hello");
}

#[test]
fn a_signature_from_an_unknown_key_is_unknown_not_invalid() {
    // key-management.md: "we cannot check this" and "this is wrong" are
    // different trust states and must not collapse into one.
    let alice = Core::new(tmpdir("sig-alice"));
    let bob = Core::new(tmpdir("sig-bob"));
    let _alice_id = identity(&alice, "alice@example.com");
    let bob_id = identity(&bob, "bob@example.com");

    let msg = alice.encrypt_sign("alice@example.com", PW, "hi", &[armored(&bob_id)]).unwrap();

    let opened: Value =
        serde_json::from_str(&bob.decrypt_verify("bob@example.com", PW, &msg, &[]).unwrap()).unwrap();
    assert_eq!(opened["signature"], "unknown");
    assert!(opened["signerFingerprint"].is_null());
}

#[test]
fn a_signature_checked_against_the_wrong_key_is_invalid() {
    let alice = Core::new(tmpdir("wrong-alice"));
    let bob = Core::new(tmpdir("wrong-bob"));
    let carol = Core::new(tmpdir("wrong-carol"));
    let _alice_id = identity(&alice, "alice@example.com");
    let bob_id = identity(&bob, "bob@example.com");
    let carol_id = identity(&carol, "carol@example.com");

    let msg = alice.encrypt_sign("alice@example.com", PW, "hi", &[armored(&bob_id)]).unwrap();

    // Bob holds a key for the claimed sender, but it is the wrong one.
    let opened: Value =
        serde_json::from_str(&bob.decrypt_verify("bob@example.com", PW, &msg, &[armored(&carol_id)]).unwrap())
            .unwrap();
    assert_eq!(opened["signature"], "invalid");
}

#[test]
fn the_wrong_passphrase_cannot_decrypt() {
    let alice = Core::new(tmpdir("pw-alice"));
    let bob = Core::new(tmpdir("pw-bob"));
    let _alice_id = identity(&alice, "alice@example.com");
    let bob_id = identity(&bob, "bob@example.com");

    let msg = alice.encrypt_sign("alice@example.com", PW, "hi", &[armored(&bob_id)]).unwrap();
    assert!(bob.decrypt_verify("bob@example.com", "wrong passphrase", &msg, &[]).is_err());
}

#[test]
fn refuses_to_encrypt_with_no_recipients() {
    let core = Core::new(tmpdir("norcpt"));
    let _ = identity(&core, "alice@example.com");
    let err = core.encrypt_sign("alice@example.com", PW, "hi", &[]).unwrap_err();
    assert_eq!(err.code(), "no-key");
}

#[test]
fn refuses_to_encrypt_without_an_identity() {
    let core = Core::new(tmpdir("noid"));
    let err = core.encrypt_sign("nobody@example.com", PW, "hi", &[]).unwrap_err();
    assert_eq!(err.code(), "no-key");
}

#[test]
fn refuses_to_store_a_key_with_an_empty_passphrase() {
    let core = Core::new(tmpdir("nopw"));
    assert!(core.generate_identity("alice@example.com", "").is_err());
}

#[test]
fn tampered_ciphertext_does_not_decrypt_silently() {
    let alice = Core::new(tmpdir("tamper-alice"));
    let bob = Core::new(tmpdir("tamper-bob"));
    let _alice_id = identity(&alice, "alice@example.com");
    let bob_id = identity(&bob, "bob@example.com");

    let msg = alice.encrypt_sign("alice@example.com", PW, "transfer $10", &[armored(&bob_id)]).unwrap();

    // Flip a character in the middle of the armor body.
    let lines: Vec<&str> = msg.lines().collect();
    let mid = lines.len() / 2;
    let mut tampered = lines.clone();
    let swapped: String = lines[mid]
        .chars()
        .enumerate()
        .map(|(i, c)| if i == 4 { if c == 'A' { 'B' } else { 'A' } } else { c })
        .collect();
    tampered[mid] = &swapped;

    let result = bob.decrypt_verify("bob@example.com", PW, &tampered.join("\n"), &[]);
    match result {
        Err(_) => {}
        Ok(json) => {
            let opened: Value = serde_json::from_str(&json).unwrap();
            assert_ne!(opened["plaintext"], "transfer $10", "tampered message decrypted to the original");
        }
    }
}

#[test]
fn finds_the_stored_identity_address_without_being_told_it() {
    // The FFI layer needs this: an incoming envelope cannot say which identity
    // to decrypt with, and the filename is a hash, so the address has to come
    // from the key's own User ID.
    let dir = tmpdir("stored-email");
    let core = Core::new(&dir);
    assert_eq!(core.stored_identity_email().unwrap(), None);

    identity(&core, "Alice@Example.COM");
    assert_eq!(core.stored_identity_email().unwrap().as_deref(), Some("alice@example.com"));
}

#[test]
fn a_missing_storage_directory_is_no_identity_not_an_error() {
    let core = Core::new(std::env::temp_dir().join("cryptmail-core-does-not-exist"));
    assert_eq!(core.stored_identity_email().unwrap(), None);
    assert!(core.load_identity("alice@example.com").unwrap().is_none());
}

/// `createdAt` used to be `Utc::now()`, so it changed on every call — the key
/// looked as though it had been created the moment it was looked at. The
/// creation time is hashed into the fingerprint, so it is fixed for the life of
/// the key and must read back identically however often it is loaded.
#[test]
fn the_creation_time_is_the_keys_own_and_does_not_move() {
    let dir = tmpdir("created-at");
    let core = Core::new(&dir);

    let generated = identity(&core, "alice@example.com");
    let created = generated["createdAt"].as_str().unwrap().to_string();
    assert!(!created.is_empty(), "no creation time reported");

    // Every subsequent load must agree — with itself, and with generation.
    for _ in 0..3 {
        let loaded: Value =
            serde_json::from_str(&core.load_identity("alice@example.com").unwrap().unwrap())
                .unwrap();
        assert_eq!(loaded["createdAt"].as_str().unwrap(), created, "creation time moved");
    }

    // Sanity: it is a real timestamp, not an empty string that happens to be
    // stable, and it is not in the future.
    let parsed = chrono::DateTime::parse_from_rfc3339(&created).expect("not an RFC 3339 timestamp");
    assert!(parsed <= chrono::Utc::now(), "key claims to have been created in the future");
}
