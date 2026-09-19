//! Per-email keys, end to end, through the same `Core` API the app calls.
//!
//! Each person is a directory — a device. Nothing is shared between them but
//! the armored strings that would travel through Gmail.

use std::fs;

use cryptmail_core::Core;
use serde_json::Value;

const PW: &str = "correct horse battery staple";

struct Person {
    core: Core,
    email: &'static str,
    key: String,
}

fn person(name: &str, email: &'static str) -> Person {
    let dir = std::env::temp_dir().join(format!("cryptmail-fs-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let core = Core::new(&dir);
    let id: Value = serde_json::from_str(&core.generate_identity(email, PW).unwrap()).unwrap();
    Person { core, email, key: id["publicKeyArmored"].as_str().unwrap().to_string() }
}

/// Seal from `from` to `to`, returning (armored, forwardSecret).
fn seal(from: &Person, to: &[&Person], text: &str) -> (String, bool) {
    let keys: Vec<String> = to.iter().map(|p| p.key.clone()).collect();
    let sealed: Value = serde_json::from_str(&from.core.seal(from.email, PW, text, &keys).unwrap()).unwrap();
    (sealed["armored"].as_str().unwrap().to_string(), sealed["forwardSecret"].as_bool().unwrap())
}

fn open(reader: &Person, sender: &Person, armored: &str) -> Result<Value, String> {
    reader
        .core
        .open(reader.email, PW, armored, &[sender.key.clone()])
        .map(|json| serde_json::from_str(&json).unwrap())
        .map_err(|e| e.to_string())
}

/// Alice writes first (she has nothing of Bob's but his key), Bob replies —
/// the shape of every real first contact.
fn introduce(alice: &Person, bob: &Person) {
    let (first, _) = seal(alice, &[bob], "hello");
    open(bob, alice, &first).unwrap();
    let (reply, _) = seal(bob, &[alice], "hi back");
    open(alice, bob, &reply).unwrap();
}

#[test]
fn the_first_message_uses_long_term_keys_because_nothing_else_exists_yet() {
    let (alice, bob) = (person("a1", "alice@example.com"), person("b1", "bob@example.com"));
    let (armored, forward_secret) = seal(&alice, &[&bob], "hello");
    assert!(!forward_secret, "claimed forward secrecy with no session possible");

    let opened = open(&bob, &alice, &armored).unwrap();
    assert_eq!(opened["plaintext"], "hello");
    assert_eq!(opened["forwardSecret"], false);
}

#[test]
fn once_both_sides_have_written_every_message_gets_its_own_key() {
    let (alice, bob) = (person("a2", "alice@example.com"), person("b2", "bob@example.com"));

    let (first, _) = seal(&alice, &[&bob], "hello");
    open(&bob, &alice, &first).unwrap();

    // Bob now holds Alice's signed offer, so his reply is already forward-secret.
    let (reply, fs) = seal(&bob, &[&alice], "hi back");
    assert!(fs);
    let opened = open(&alice, &bob, &reply).unwrap();
    assert_eq!(opened["plaintext"], "hi back");
    assert_eq!(opened["forwardSecret"], true);
    assert_eq!(opened["signature"], "valid");

    for i in 0..4 {
        let text = format!("alice {i}");
        let (m, fs) = seal(&alice, &[&bob], &text);
        assert!(fs, "alice → bob #{i} was not forward-secret");
        assert_eq!(open(&bob, &alice, &m).unwrap()["plaintext"], text.as_str());

        let text = format!("bob {i}");
        let (m, fs) = seal(&bob, &[&alice], &text);
        assert!(fs, "bob → alice #{i} was not forward-secret");
        assert_eq!(open(&alice, &bob, &m).unwrap()["plaintext"], text.as_str());
    }
}

#[test]
fn a_message_once_read_cannot_be_opened_again_by_the_device_that_read_it() {
    let (alice, bob) = (person("a3", "alice@example.com"), person("b3", "bob@example.com"));
    introduce(&alice, &bob);

    let (secret, _) = seal(&alice, &[&bob], "the password is swordfish");
    open(&bob, &alice, &secret).unwrap();

    // Someone takes Bob's phone afterwards. Every key it holds cannot reopen it.
    assert!(open(&bob, &alice, &secret).is_err(), "a forward-secret message reopened");
}

#[test]
fn no_long_term_key_opens_a_forward_secret_message_not_even_the_senders() {
    let (alice, bob) = (person("a4", "alice@example.com"), person("b4", "bob@example.com"));
    introduce(&alice, &bob);

    // The caller includes Alice's own key, as it does for normal mail. It must
    // be dropped: a copy under her long-term key would reopen everything.
    let (m, fs) = seal(&alice, &[&bob, &alice], "private");
    assert!(fs);

    assert!(bob.core.decrypt_verify(bob.email, PW, &m, &[alice.key.clone()]).is_err());
    assert!(alice.core.decrypt_verify(alice.email, PW, &m, &[alice.key.clone()]).is_err());
}

#[test]
fn one_recipient_without_a_session_means_the_whole_message_goes_the_old_way() {
    let (alice, bob, carol) = (
        person("a5", "alice@example.com"),
        person("b5", "bob@example.com"),
        person("c5", "carol@example.com"),
    );
    introduce(&alice, &bob);

    let (m, fs) = seal(&alice, &[&bob, &carol], "to both of you");
    assert!(!fs, "a message readable through Carol's long-term key was reported forward-secret");
    assert_eq!(open(&bob, &alice, &m).unwrap()["plaintext"], "to both of you");
    assert_eq!(open(&carol, &alice, &m).unwrap()["plaintext"], "to both of you");
}

#[test]
fn someone_else_cannot_open_a_forward_secret_message() {
    let (alice, bob, mallory) = (
        person("a6", "alice@example.com"),
        person("b6", "bob@example.com"),
        person("m6", "mallory@example.com"),
    );
    introduce(&alice, &bob);
    let (m, _) = seal(&alice, &[&bob], "for bob");
    assert!(open(&mallory, &alice, &m).is_err());
}

#[test]
fn messages_arriving_out_of_order_all_open() {
    let (alice, bob) = (person("a7", "alice@example.com"), person("b7", "bob@example.com"));
    introduce(&alice, &bob);

    let sent: Vec<(String, String)> = (0..4)
        .map(|i| {
            let text = format!("message {i}");
            (seal(&alice, &[&bob], &text).0, text)
        })
        .collect();
    for i in [2, 0, 3, 1] {
        assert_eq!(open(&bob, &alice, &sent[i].0).unwrap()["plaintext"], sent[i].1.as_str());
    }
}

#[test]
fn both_writing_at_once_keeps_the_conversation_intact() {
    let (alice, bob) = (person("a8", "alice@example.com"), person("b8", "bob@example.com"));
    introduce(&alice, &bob);

    let (from_alice, _) = seal(&alice, &[&bob], "crossing 1");
    let (from_bob, _) = seal(&bob, &[&alice], "crossing 2");
    assert_eq!(open(&bob, &alice, &from_alice).unwrap()["plaintext"], "crossing 1");
    assert_eq!(open(&alice, &bob, &from_bob).unwrap()["plaintext"], "crossing 2");

    let (after, fs) = seal(&alice, &[&bob], "and after");
    assert!(fs);
    assert_eq!(open(&bob, &alice, &after).unwrap()["plaintext"], "and after");
}

#[test]
fn an_offer_signed_by_someone_else_is_not_adopted() {
    let (alice, bob, mallory) = (
        person("a9", "alice@example.com"),
        person("b9", "bob@example.com"),
        person("m9", "mallory@example.com"),
    );
    // Mallory writes to Bob; Bob opens it believing it came from Alice, so
    // checks it against Alice's key. The offer Mallory signed must not be
    // filed under Alice.
    let (m, _) = seal(&mallory, &[&bob], "hello from 'alice'");
    let opened = open(&bob, &alice, &m).unwrap();
    assert_eq!(opened["signature"], "invalid");

    let (next, fs) = seal(&bob, &[&alice], "hi alice");
    assert!(!fs, "Bob opened a session with Alice using Mallory's offer");
    assert_eq!(open(&alice, &bob, &next).unwrap()["plaintext"], "hi alice");
}

#[test]
fn a_normal_message_is_still_readable_by_the_old_api() {
    // Other OpenPGP clients take this path. Armor headers must not stop it.
    let (alice, bob) = (person("a10", "alice@example.com"), person("b10", "bob@example.com"));
    let (m, fs) = seal(&alice, &[&bob], "plain old pgp");
    assert!(!fs);
    let opened: Value =
        serde_json::from_str(&bob.core.decrypt_verify(bob.email, PW, &m, &[alice.key.clone()]).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], "plain old pgp");
    assert_eq!(opened["signature"], "valid");
}

#[test]
fn opening_mail_we_sent_ourselves_does_not_file_our_own_offer() {
    // Found on the emulator: a self-addressed message carries our own offer,
    // and opening it filed that offer as though a contact had sent it.
    let alice = person("a11", "alice@example.com");
    let (m, fs) = seal(&alice, &[&alice], "note to self");
    assert!(!fs, "mail to ourselves can never be forward-secret");
    assert_eq!(open(&alice, &alice, &m).unwrap()["plaintext"], "note to self");

    let peers = std::fs::read_dir(alice_sessions_dir("a11"))
        .unwrap()
        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("peer-"))
        .count();
    assert_eq!(peers, 0, "our own offer was filed as a contact's");
}

fn alice_sessions_dir(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("cryptmail-fs-{name}-{}", std::process::id())).join("sessions")
}
