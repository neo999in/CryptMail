//! Device transfer, end to end: the identity key — and the Key Manager's bank
//! of quantum keys — survive a move to a new phone, and the old phone stops
//! issuing quantum keys.

use std::fs;

use cryptmail_core::Core;
use serde_json::Value;

const PW: &str = "old phone keystore passphrase";
const NEW_PW: &str = "new phone keystore passphrase";
const CODE: &str = "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q";

struct Phone {
    core: Core,
    pw: &'static str,
    email: &'static str,
    key: String,
    fingerprint: String,
}

fn phone(name: &str, email: &'static str, pw: &'static str) -> Phone {
    let dir = std::env::temp_dir().join(format!("cryptmail-transfer-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let core = Core::new(&dir);
    let id: Value = serde_json::from_str(&core.generate_identity(email, pw).unwrap()).unwrap();
    Phone {
        core,
        pw,
        email,
        key: id["publicKeyArmored"].as_str().unwrap().to_string(),
        fingerprint: id["fingerprint"].as_str().unwrap().to_string(),
    }
}

fn send(from: &Phone, to: &Phone, text: &str) -> String {
    from.core.encrypt_sign(from.email, from.pw, text, &[to.key.clone()]).unwrap()
}

fn open(reader: &Phone, sender: &Phone, armored: &str) -> Value {
    serde_json::from_str(&reader.core.decrypt_verify(reader.email, reader.pw, armored, &[sender.key.clone()]).unwrap())
        .unwrap()
}

/// Alice and Bob, each holding the other's key.
fn conversation(tag: &str) -> (Phone, Phone) {
    let alice = phone(&format!("alice-{tag}"), "alice@example.com", PW);
    let bob = phone(&format!("bob-{tag}"), "bob@example.com", PW);
    (alice, bob)
}

/// The new phone, as setup leaves it: signed in, holding a throwaway key.
fn new_phone(tag: &str) -> Phone {
    phone(&format!("alice-new-{tag}"), "alice@example.com", NEW_PW)
}

fn adopt(new: &mut Phone, file: &str) -> Value {
    let imported: Value =
        serde_json::from_str(&new.core.import_transfer(NEW_PW, file, CODE, "alice@example.com").unwrap()).unwrap();
    new.key = imported["identity"]["publicKeyArmored"].as_str().unwrap().to_string();
    new.fingerprint = imported["identity"]["fingerprint"].as_str().unwrap().to_string();
    imported
}

fn handed_over(p: &Phone) -> Value {
    serde_json::from_str::<Value>(&p.core.transfer_status(p.pw).unwrap()).unwrap()["handedOverAt"].clone()
}

#[test]
fn the_identity_moves_and_mail_flows_both_ways_from_the_new_phone() {
    let (alice, bob) = conversation("carry-on");
    let before = send(&bob, &alice, "sent before the move");
    let file = alice.core.export_transfer(alice.email, PW, CODE, "the archive").unwrap();

    let mut new = new_phone("carry-on");
    let imported = adopt(&mut new, &file);
    assert_eq!(new.fingerprint, alice.fingerprint, "the identity did not move");
    assert_eq!(imported["archive"], "the archive");
    assert_eq!(open(&new, &bob, &before)["plaintext"], "sent before the move");

    let m = send(&new, &bob, "from the new phone");
    let opened = open(&bob, &new, &m);
    assert_eq!(opened["plaintext"], "from the new phone");
    assert_eq!(opened["signature"], "valid");
}

#[test]
fn the_old_phone_is_marked_handed_over_and_still_reads() {
    let (alice, bob) = conversation("old-phone");
    assert!(handed_over(&alice).is_null());
    alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();
    assert!(handed_over(&alice).is_i64());

    let m = send(&bob, &alice, "to whichever phone");
    assert_eq!(open(&alice, &bob, &m)["plaintext"], "to whichever phone");
}

#[test]
fn a_wrong_code_opens_nothing_and_changes_nothing() {
    let (alice, _bob) = conversation("wrong-code");
    let file = alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();

    let new = new_phone("wrong-code");
    let before = new.fingerprint.clone();
    let err = new
        .core
        .import_transfer(NEW_PW, &file, "0000-0000-0000-0000-0000-0000-0000-0000", "alice@example.com")
        .unwrap_err();
    assert_eq!(err.code(), "decrypt-failed");
    let still: Value = serde_json::from_str(&new.core.load_identity(new.email).unwrap().unwrap()).unwrap();
    assert_eq!(still["fingerprint"], before.as_str());
}

#[test]
fn a_transfer_for_another_mailbox_is_refused_before_anything_changes() {
    let (alice, _bob) = conversation("other-mailbox");
    let file = alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();

    let carol = phone("carol-other-mailbox", "carol@example.com", NEW_PW);
    let err = carol.core.import_transfer(NEW_PW, &file, CODE, "carol@example.com").unwrap_err();
    assert_eq!(err.code(), "malformed");
    assert!(err.to_string().contains("alice@example.com"), "{err}");
    assert_eq!(carol.core.stored_identity_email().unwrap().as_deref(), Some("carol@example.com"));
}

#[test]
fn a_file_that_is_not_a_transfer_is_malformed() {
    let new = new_phone("not-a-transfer");
    for text in ["", "-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----BEGIN CRYPTMAIL TRANSFER-----\n!!!\n-----END CRYPTMAIL TRANSFER-----"] {
        assert_eq!(new.core.import_transfer(NEW_PW, text, CODE, "").unwrap_err().code(), "malformed", "{text:?}");
    }
}

#[test]
fn a_short_code_is_refused_rather_than_trusted() {
    let alice = phone("alice-short-code", "alice@example.com", PW);
    assert_eq!(alice.core.export_transfer(alice.email, PW, "ABCD-EFGH", "").unwrap_err().code(), "malformed");
    assert!(handed_over(&alice).is_null(), "a refused export still handed the phone over");
}

#[test]
fn nothing_in_the_file_is_readable_without_the_code() {
    let (alice, _bob) = conversation("sealed");
    let archive = "Subject: the password is swordfish";
    let file = alice.core.export_transfer(alice.email, PW, CODE, archive).unwrap();
    assert!(file.starts_with("-----BEGIN CRYPTMAIL TRANSFER-----"));
    for needle in ["swordfish", "alice@example.com", "PRIVATE KEY"] {
        assert!(!file.contains(needle), "{needle} is visible in the transfer file");
    }
}

#[test]
fn a_transfer_never_used_can_be_taken_back() {
    let (alice, _bob) = conversation("resume");
    alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();
    assert!(handed_over(&alice).is_i64());

    alice.core.resume_transfer(PW).unwrap();
    assert!(handed_over(&alice).is_null());
}

// --------------------------------------------------- the Key Manager's bank --
//
// The bank is state, not a key that can be re-derived: a phone that left it
// behind could open no unread Level 2 or 3 mail and would be unlinked from the
// other end. It travels, and it moves rather than copies.

fn km(p: &Phone) -> Value {
    serde_json::from_str(&p.core.km_status(p.pw, p.email).unwrap()).unwrap()
}

/// Alice, with her bank linked to Bob's phone.
fn linked(tag: &str) -> (Phone, Phone) {
    let (alice, bob) = conversation(tag);
    let link = alice.core.km_export_link(PW, alice.email, CODE).unwrap();
    bob.core.km_import_link(PW, bob.email, &link, CODE).unwrap();
    (alice, bob)
}

#[test]
fn the_key_bank_moves_with_the_phone_and_the_link_survives() {
    let (alice, bob) = linked("bank-moves");
    // Mail Alice has not opened yet, sealed with keys only her bank holds.
    let waiting = bob.core.qkd_seal(PW, bob.email, 2, "read me on the new phone").unwrap();

    let file = alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();
    let mut new = new_phone("bank-moves");
    adopt(&mut new, &file);

    let status = km(&new);
    assert_eq!(status["role"], "Master", "the new phone is not the end Alice was");
    assert_eq!(status["peerSaeId"], km(&bob)["saeId"], "the link with Bob did not survive");
    assert_eq!(status["handedOver"], false);

    let opened: Value = serde_json::from_str(&new.core.qkd_open(NEW_PW, new.email, &waiting).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], "read me on the new phone");

    // And it still sends to Bob, under the same SAE ID as before.
    let m = new.core.qkd_seal(NEW_PW, new.email, 2, "from the new phone").unwrap();
    let back: Value = serde_json::from_str(&bob.core.qkd_open(PW, bob.email, &m).unwrap()).unwrap();
    assert_eq!(back["plaintext"], "from the new phone");
}

#[test]
fn the_old_phone_stops_sending_with_the_bank_but_still_reads() {
    let (alice, bob) = linked("bank-handover");
    let waiting = bob.core.qkd_seal(PW, bob.email, 2, "sent before the move").unwrap();
    alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();

    // Two phones sending under one SAE ID would derive one AES key twice.
    let err = alice.core.qkd_seal(PW, alice.email, 2, "still sending?").unwrap_err();
    assert_eq!(err.code(), "no-key");
    assert!(err.to_string().contains("km-handed-over"), "{err}");
    assert_eq!(km(&alice)["handedOver"], true);

    // Reading only deletes this phone's own copy, so it is left alone.
    let opened: Value = serde_json::from_str(&alice.core.qkd_open(PW, alice.email, &waiting).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], "sent before the move");
}

#[test]
fn a_transfer_never_used_gives_the_bank_back_too() {
    let (alice, bob) = linked("bank-resume");
    alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();
    alice.core.resume_transfer(PW).unwrap();

    assert_eq!(km(&alice)["handedOver"], false);
    let m = alice.core.qkd_seal(PW, alice.email, 2, "back again").unwrap();
    let opened: Value = serde_json::from_str(&bob.core.qkd_open(PW, bob.email, &m).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], "back again");
}

#[test]
fn a_transfer_from_before_banks_travelled_still_imports() {
    // The bank is optional in the file: an older transfer must not be refused.
    let (alice, _bob) = conversation("bank-absent");
    let file = alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();
    let mut new = new_phone("bank-absent");
    adopt(&mut new, &file);
    assert_eq!(km(&new)["available"], 100, "the new phone has no bank to send with");
}
