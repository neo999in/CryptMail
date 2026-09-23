//! Level 2 end to end: two phones, each signed in to its own mailbox —
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
fn level_3_is_gone_it_neither_seals_nor_opens_and_costs_no_keys() {
    let (alice, bob) = linked("l3");
    let err = alice.qkd_seal(PW, ALICE, 3, "x").unwrap_err();
    assert!(err.to_string().contains("level-3-removed"), "{err}");
    assert_eq!(status(&alice, ALICE)["available"], 100, "a refused seal spent keys");

    // A Level 3 message sent by an older version: refused before any key is
    // fetched, so the key it names stays in the bank.
    let id = {
        let m = alice.qkd_seal(PW, ALICE, 2, "spend one").unwrap();
        m.lines().find_map(|l| l.strip_prefix("Key-ID:")).unwrap().trim().to_string()
    };
    let old = format!(
        "-----BEGIN CRYPTMAIL QKD MESSAGE-----\nLevel: 3\nCipher: one-time pad, HMAC-SHA256 with a QKD key\n\
         SAE: sae-old\nKey-ID: {id}\nKey-ID: {id}\n\n{}\n-----END CRYPTMAIL QKD MESSAGE-----\n",
        "QUJD".repeat(20)
    );
    let before = status(&bob, BOB)["remaining"].as_u64().unwrap();
    let err = open(&bob, BOB, &old).unwrap_err();
    assert_eq!(err.code(), "decrypt-failed");
    assert!(err.to_string().contains("level-3-removed"), "{err}");
    assert_eq!(status(&bob, BOB)["remaining"].as_u64().unwrap(), before, "a refused message spent keys");
}

#[test]
fn both_ends_may_send_with_the_same_key_and_each_reads_the_other() {
    // No halves: both ends draw from the whole bank in the same order, so
    // before either has seen the other's mail they pick the same key. The
    // AES key is bound to the sender, so that is two keys, not one used twice.
    let (alice, bob) = linked("collide");
    let hers = alice.qkd_seal(PW, ALICE, 2, "from alice").unwrap();
    let his = bob.qkd_seal(PW, BOB, 2, "from bob").unwrap();
    let id = |m: &str| m.lines().find_map(|l| l.strip_prefix("Key-ID:")).unwrap().trim().to_string();
    assert_eq!(id(&hers), id(&his), "the test needs both ends on one key");

    assert_eq!(open(&bob, BOB, &hers).unwrap()["plaintext"], "from alice");
    assert_eq!(open(&alice, ALICE, &his).unwrap()["plaintext"], "from bob");
}

#[test]
fn a_message_relabelled_as_the_other_end_does_not_open() {
    let (alice, bob) = linked("relabel");
    let hers = alice.qkd_seal(PW, ALICE, 2, "from alice").unwrap();
    let alice_sae = status(&alice, ALICE)["saeId"].as_str().unwrap().to_string();
    let bob_sae = status(&bob, BOB)["saeId"].as_str().unwrap().to_string();
    let forged = hers.replace(&format!("SAE: {alice_sae}"), &format!("SAE: {bob_sae}"));
    assert_ne!(forged, hers);
    assert_eq!(open(&bob, BOB, &forged).unwrap_err().code(), "decrypt-failed");
}

#[test]
fn each_end_sends_from_the_whole_bank() {
    let (alice, bob) = linked("whole");
    assert_eq!(status(&alice, ALICE)["available"], 100);
    assert_eq!(status(&bob, BOB)["available"], 100);
    for i in 0..100 {
        alice.qkd_seal(PW, ALICE, 2, &format!("message {i}")).unwrap();
    }
    let err = alice.qkd_seal(PW, ALICE, 2, "one too many").unwrap_err();
    assert_eq!(err.code(), "no-key");
    assert!(err.to_string().contains("no-qkd-keys"), "{err}");
    // What Alice issued is still Bob's to send with.
    assert_eq!(status(&bob, BOB)["available"], 100);
}

#[test]
fn a_message_opens_once_the_keys_are_gone_after() {
    let (alice, bob) = linked("once");
    let armored = alice.qkd_seal(PW, ALICE, 2, "read me once").unwrap();
    open(&bob, BOB, &armored).unwrap();
    assert_eq!(open(&bob, BOB, &armored).unwrap_err().code(), "decrypt-failed");
}

#[test]
fn a_changed_message_is_refused() {
    let (alice, bob) = linked("tamper");
    for level in [2u8] {
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
    let armored = alice.qkd_seal(PW, ALICE, 2, "note to self").unwrap();
    assert_eq!(open(&alice, ALICE, &armored).unwrap()["plaintext"], "note to self");
}

#[test]
fn another_mailbox_on_the_same_phone_has_its_own_bank() {
    let phone = phone("two-mailboxes");
    let armored = phone.qkd_seal(PW, ALICE, 2, "for alice's bank").unwrap();
    assert!(open(&phone, BOB, &armored).is_err(), "one mailbox's keys opened another's mail");
    assert!(open(&phone, ALICE, &armored).is_ok());
}
