//! Device transfer, end to end: a conversation with per-email keys survives a
//! move to a new phone, and the old phone stops writing into it.

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

fn seal(from: &Phone, to: &Phone, text: &str) -> (String, bool) {
    let sealed: Value =
        serde_json::from_str(&from.core.seal(from.email, from.pw, text, &[to.key.clone()]).unwrap()).unwrap();
    (sealed["armored"].as_str().unwrap().to_string(), sealed["forwardSecret"].as_bool().unwrap())
}

fn open(reader: &Phone, sender: &Phone, armored: &str) -> Value {
    serde_json::from_str(&reader.core.open(reader.email, reader.pw, armored, &[sender.key.clone()]).unwrap()).unwrap()
}

/// Alice and Bob, already writing to each other with per-email keys.
fn conversation(tag: &str) -> (Phone, Phone) {
    let alice = phone(&format!("alice-{tag}"), "alice@example.com", PW);
    let bob = phone(&format!("bob-{tag}"), "bob@example.com", PW);
    let hello = alice.core.handshake(alice.email, PW, "Subject: handshake\n\n", &[bob.key.clone()]).unwrap();
    open(&bob, &alice, &hello);
    let (m, fs) = seal(&bob, &alice, "hi");
    assert!(fs);
    open(&alice, &bob, &m);
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
fn the_conversation_carries_on_from_the_new_phone_in_both_directions() {
    let (alice, bob) = conversation("carry-on");
    let file = alice.core.export_transfer(alice.email, PW, CODE, "the archive").unwrap();

    let mut new = new_phone("carry-on");
    let imported = adopt(&mut new, &file);
    assert_eq!(new.fingerprint, alice.fingerprint, "the identity did not move");
    assert_eq!(imported["archive"], "the archive");

    for i in 0..3 {
        let text = format!("from the new phone {i}");
        let (m, fs) = seal(&new, &bob, &text);
        assert!(fs, "the new phone lost the conversation (#{i})");
        let opened = open(&bob, &new, &m);
        assert_eq!(opened["plaintext"], text.as_str());
        assert_eq!(opened["forwardSecret"], true);

        let text = format!("to the new phone {i}");
        let (m, fs) = seal(&bob, &new, &text);
        assert!(fs);
        assert_eq!(open(&new, &bob, &m)["plaintext"], text.as_str());
    }
}

#[test]
fn the_old_phone_stops_sending_but_still_reads() {
    let (alice, bob) = conversation("old-phone");
    assert!(handed_over(&alice).is_null());
    let file = alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();
    assert!(handed_over(&alice).is_i64());

    // Per-email keys are the only kind, so a handed-over phone sends nothing
    // sealed at all — not a message, not a handshake.
    let refused = alice.core.seal(alice.email, PW, "from the old phone", &[bob.key.clone()]).unwrap_err();
    assert_eq!(refused.code(), "unavailable");
    assert!(refused.to_string().contains("handed-over"), "{refused}");
    assert!(alice.core.handshake(alice.email, PW, "x", &[bob.key.clone()]).is_err());
    assert!(alice.core.session_status(alice.email, PW, &[bob.key.clone()]).is_err());

    // Bob writes; both phones read it, and arrive at the same state.
    let mut new = new_phone("old-phone");
    adopt(&mut new, &file);
    let (m, fs) = seal(&bob, &new, "to whichever phone");
    assert!(fs);
    assert_eq!(open(&alice, &bob, &m)["plaintext"], "to whichever phone");
    assert_eq!(open(&new, &bob, &m)["plaintext"], "to whichever phone");

    let (m, fs) = seal(&new, &bob, "the new phone answers");
    assert!(fs);
    assert_eq!(open(&bob, &new, &m)["plaintext"], "the new phone answers");
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
    for needle in ["swordfish", "alice@example.com", "PRIVATE KEY", "session-"] {
        assert!(!file.contains(needle), "{needle} is visible in the transfer file");
    }
}

#[test]
fn a_transfer_never_used_can_be_taken_back() {
    let (alice, bob) = conversation("resume");
    alice.core.export_transfer(alice.email, PW, CODE, "").unwrap();
    assert!(alice.core.seal(alice.email, PW, "handed over", &[bob.key.clone()]).is_err());

    alice.core.resume_sessions(PW).unwrap();
    assert!(handed_over(&alice).is_null());
    let (m, fs) = seal(&alice, &bob, "back again");
    assert!(fs);
    assert_eq!(open(&bob, &alice, &m)["plaintext"], "back again");
}
