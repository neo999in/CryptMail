//! Levels 2 and 3 end to end: two phones, each signed in to its own mailbox —
//! which is also its Key Manager login — with linked banks, exchanging messages
//! only those banks can open.

use std::fs;

use cryptmail_core::Core;
use serde_json::Value;

const PW: &str = "keystore passphrase";
const CODE: &str = "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q";
const ALICE: &str = "alice@example.com";
const BOB: &str = "bob@example.com";

fn phone(name: &str) -> Core {
    let dir = std::env::temp_dir().join(format!("cryptmail-qkd-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Core::new(&dir)
}

fn status(core: &Core, email: &str) -> Value {
    serde_json::from_str(&core.km_status(PW, email).unwrap()).unwrap()
}

/// Alice's and Bob's phones, banks linked.
fn linked(tag: &str) -> (Core, Core) {
    let (alice, bob) = (phone(&format!("a-{tag}")), phone(&format!("b-{tag}")));
    let link = alice.km_export_link(PW, ALICE, CODE).unwrap();
    bob.km_import_link(PW, BOB, &link, CODE).unwrap();
    (alice, bob)
}

fn open(core: &Core, email: &str, armored: &str) -> Result<Value, cryptmail_core::CoreError> {
    core.qkd_open(PW, email, armored).map(|j| serde_json::from_str(&j).unwrap())
}

#[test]
fn signing_in_to_the_mailbox_is_the_km_login() {
    let alice = phone("login");
    let s = status(&alice, ALICE);
    assert_eq!(s["account"], ALICE);
    assert_eq!((s["available"].as_u64(), s["bankSize"].as_u64(), s["keyBits"].as_u64()), (Some(100), Some(100), Some(1024)));
    // Nobody signed in: no KM.
    assert_eq!(alice.qkd_seal(PW, "", 2, "x").unwrap_err().code(), "no-key");
}

#[test]
fn level_2_quantum_aided_aes_between_two_linked_phones() {
    let (alice, bob) = linked("l2");
    let text = "Subject: hi\n\nThe launch is at noon.".repeat(50); // larger than one key
    let armored = alice.qkd_seal(PW, ALICE, 2, &text).unwrap();
    assert!(armored.contains("Level: 2"));
    assert_eq!(armored.matches("Key-ID:").count(), 1, "Level 2 uses exactly one quantum key");
    assert!(!armored.contains("launch"));

    let opened = open(&bob, BOB, &armored).unwrap();
    assert_eq!(opened["plaintext"], text.as_str());
    assert_eq!(opened["level"], 2);
}

#[test]
fn level_3_one_time_pad_uses_one_key_per_kilobit_plus_a_mac_key() {
    let (alice, bob) = linked("l3");
    let before = status(&alice, ALICE)["available"].as_u64().unwrap();
    let text = "x".repeat(300); // 300 bytes → 3 pad keys of 128 bytes, + 1 MAC key
    let armored = alice.qkd_seal(PW, ALICE, 3, &text).unwrap();
    assert_eq!(armored.matches("Key-ID:").count(), 4);
    assert_eq!(status(&alice, ALICE)["available"].as_u64().unwrap(), before - 4);

    let opened = open(&bob, BOB, &armored).unwrap();
    assert_eq!(opened["plaintext"], text.as_str());
    assert_eq!(opened["level"], 3);
}

#[test]
fn a_message_opens_once_the_keys_are_gone_after() {
    let (alice, bob) = linked("once");
    let armored = alice.qkd_seal(PW, ALICE, 2, "read me once").unwrap();
    open(&bob, BOB, &armored).unwrap();
    assert_eq!(open(&bob, BOB, &armored).unwrap_err().code(), "decrypt-failed");
}

#[test]
fn a_changed_message_is_refused_at_both_levels() {
    let (alice, bob) = linked("tamper");
    for level in [2u8, 3] {
        let armored = alice.qkd_seal(PW, ALICE, level, "pay 100 to alice").unwrap();
        // Flip one base64 character in the payload.
        let lines: Vec<&str> = armored.lines().collect();
        let payload_line = lines.iter().position(|l| l.is_empty()).unwrap() + 1;
        let mut changed: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        let first = changed[payload_line].remove(0);
        changed[payload_line].insert(0, if first == 'A' { 'B' } else { 'A' });
        let err = open(&bob, BOB, &changed.join("\n")).unwrap_err();
        assert_eq!(err.code(), "decrypt-failed", "level {level} opened a changed message");
    }
}

#[test]
fn an_unlinked_phone_cannot_open_it() {
    let (alice, _bob) = linked("stranger");
    let carol = phone("carol-stranger");
    let armored = alice.qkd_seal(PW, ALICE, 2, "not for carol").unwrap();
    assert!(open(&carol, "carol@example.com", &armored).is_err());
}

#[test]
fn a_solo_bank_reads_its_own_mail() {
    // Mail to yourself, and the sender's own copy, before any link exists.
    let alice = phone("solo");
    let armored = alice.qkd_seal(PW, ALICE, 3, "note to self").unwrap();
    assert_eq!(open(&alice, ALICE, &armored).unwrap()["plaintext"], "note to self");
}

#[test]
fn another_mailbox_on_the_same_phone_has_its_own_bank() {
    let phone = phone("two-mailboxes");
    let armored = phone.qkd_seal(PW, ALICE, 2, "for alice's bank").unwrap();
    assert!(open(&phone, BOB, &armored).is_err(), "one mailbox's keys opened another's mail");
    assert!(open(&phone, ALICE, &armored).is_ok());
}

#[test]
fn a_one_time_pad_bigger_than_the_bank_is_refused_not_reused() {
    let (alice, _bob) = linked("exhaust");
    // 50 keys on this side → 49 pad keys = 6,272 bytes at most.
    let err = alice.qkd_seal(PW, ALICE, 3, &"y".repeat(6_273)).unwrap_err();
    assert_eq!(err.code(), "no-key");
    assert!(err.to_string().contains("no-qkd-keys"), "{err}");
    assert_eq!(status(&alice, ALICE)["available"], 50, "a refused message spent keys");
    alice.qkd_seal(PW, ALICE, 3, &"y".repeat(6_272)).unwrap();
    assert_eq!(status(&alice, ALICE)["available"], 0);
}
