//! Per-email keys only, end to end, through the same `Core` API the app calls.
//!
//! Each person is a directory — a device. Nothing is shared between them but
//! the armored strings that would travel through Gmail.

use std::fs;

use cryptmail_core::Core;
use serde_json::Value;

const PW: &str = "correct horse battery staple";
const HANDSHAKE: &str = "Subject: Setting up per-email keys\n\n(no content)";

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

/// Seal from `from` to `to`. Every successful seal is per-email.
fn seal(from: &Person, to: &[&Person], text: &str) -> String {
    try_seal(from, to, text).unwrap()
}

fn try_seal(from: &Person, to: &[&Person], text: &str) -> Result<String, cryptmail_core::CoreError> {
    let keys: Vec<String> = to.iter().map(|p| p.key.clone()).collect();
    from.core.seal(from.email, PW, text, &keys).map(|json| {
        let sealed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(sealed["forwardSecret"], true, "a seal that was not per-email");
        sealed["armored"].as_str().unwrap().to_string()
    })
}

fn handshake(from: &Person, to: &[&Person]) -> String {
    let keys: Vec<String> = to.iter().map(|p| p.key.clone()).collect();
    from.core.handshake(from.email, PW, HANDSHAKE, &keys).unwrap()
}

fn open(reader: &Person, sender: &Person, armored: &str) -> Result<Value, String> {
    reader
        .core
        .open(reader.email, PW, armored, &[sender.key.clone()])
        .map(|json| serde_json::from_str(&json).unwrap())
        .map_err(|e| e.to_string())
}

fn status(of: &Person, about: &[&Person]) -> Vec<String> {
    let keys: Vec<String> = about.iter().map(|p| p.key.clone()).collect();
    serde_json::from_str(&of.core.session_status(of.email, PW, &keys).unwrap()).unwrap()
}

/// First contact as the app does it: Alice's handshake, Bob's CryptMail
/// answering with a per-email-keyed acknowledgement, Alice opening it.
fn introduce(alice: &Person, bob: &Person) {
    let hello = handshake(alice, &[bob]);
    open(bob, alice, &hello).unwrap();
    let ack = seal(bob, &[alice], "ack");
    open(alice, bob, &ack).unwrap();
}

#[test]
fn without_a_session_seal_refuses_and_a_handshake_is_the_way_in() {
    let (alice, bob) = (person("a1", "alice@example.com"), person("b1", "bob@example.com"));
    assert_eq!(status(&alice, &[&bob, &alice]), ["none", "self"]);

    let err = try_seal(&alice, &[&bob], "hello").unwrap_err();
    assert_eq!(err.code(), "no-key");
    assert!(err.to_string().contains("no-session"), "{err}");

    // The handshake says nothing but its fixed text, and opens the old way.
    let hello = handshake(&alice, &[&bob]);
    let opened = open(&bob, &alice, &hello).unwrap();
    assert_eq!(opened["forwardSecret"], false);
    assert_eq!(opened["plaintext"], HANDSHAKE);
    assert_eq!(status(&bob, &[&alice]), ["offer"], "Bob did not keep Alice's offer");

    let ack = seal(&bob, &[&alice], "ack");
    assert_eq!(status(&bob, &[&alice]), ["session"]);
    assert_eq!(open(&alice, &bob, &ack).unwrap()["forwardSecret"], true);
    assert_eq!(status(&alice, &[&bob]), ["session"]);
}

#[test]
fn once_introduced_every_message_in_both_directions_gets_its_own_key() {
    let (alice, bob) = (person("a2", "alice@example.com"), person("b2", "bob@example.com"));
    introduce(&alice, &bob);

    for i in 0..4 {
        let text = format!("alice {i}");
        let m = seal(&alice, &[&bob], &text);
        let opened = open(&bob, &alice, &m).unwrap();
        assert_eq!(opened["plaintext"], text.as_str());
        assert_eq!(opened["forwardSecret"], true);
        assert_eq!(opened["signature"], "valid");

        let text = format!("bob {i}");
        let m = seal(&bob, &[&alice], &text);
        assert_eq!(open(&alice, &bob, &m).unwrap()["plaintext"], text.as_str());
    }
}

#[test]
fn a_message_once_read_cannot_be_opened_again_by_the_device_that_read_it() {
    let (alice, bob) = (person("a3", "alice@example.com"), person("b3", "bob@example.com"));
    introduce(&alice, &bob);

    let secret = seal(&alice, &[&bob], "the password is swordfish");
    open(&bob, &alice, &secret).unwrap();
    assert!(open(&bob, &alice, &secret).is_err(), "a per-email-keyed message reopened");
}

#[test]
fn no_long_term_key_opens_a_sealed_message_not_even_the_senders() {
    let (alice, bob) = (person("a4", "alice@example.com"), person("b4", "bob@example.com"));
    introduce(&alice, &bob);

    // The caller includes Alice's own key, as it does for normal mail. It must
    // be dropped: a copy under her long-term key would reopen everything.
    let m = seal(&alice, &[&bob, &alice], "private");
    assert!(bob.core.decrypt_verify(bob.email, PW, &m, &[alice.key.clone()]).is_err());
    assert!(alice.core.decrypt_verify(alice.email, PW, &m, &[alice.key.clone()]).is_err());
}

#[test]
fn one_recipient_without_a_session_stops_the_whole_message() {
    let (alice, bob, carol) = (
        person("a5", "alice@example.com"),
        person("b5", "bob@example.com"),
        person("c5", "carol@example.com"),
    );
    introduce(&alice, &bob);

    let err = try_seal(&alice, &[&bob, &carol], "to both of you").unwrap_err();
    assert!(err.to_string().contains("no-session"), "{err}");
    // Refusing did not spend a key on Bob's side of the conversation.
    let m = seal(&alice, &[&bob], "just you");
    assert_eq!(open(&bob, &alice, &m).unwrap()["plaintext"], "just you");

    introduce(&alice, &carol);
    let m = seal(&alice, &[&bob, &carol], "to both of you");
    assert_eq!(open(&bob, &alice, &m).unwrap()["plaintext"], "to both of you");
    assert_eq!(open(&carol, &alice, &m).unwrap()["plaintext"], "to both of you");
}

#[test]
fn mail_to_yourself_alone_is_refused() {
    let alice = person("a6", "alice@example.com");
    let err = try_seal(&alice, &[&alice], "note to self").unwrap_err();
    assert!(err.to_string().contains("other than yourself"), "{err}");
}

#[test]
fn someone_else_cannot_open_a_sealed_message() {
    let (alice, bob, mallory) = (
        person("a7", "alice@example.com"),
        person("b7", "bob@example.com"),
        person("m7", "mallory@example.com"),
    );
    introduce(&alice, &bob);
    let m = seal(&alice, &[&bob], "for bob");
    assert!(open(&mallory, &alice, &m).is_err());
}

#[test]
fn messages_arriving_out_of_order_all_open() {
    let (alice, bob) = (person("a8", "alice@example.com"), person("b8", "bob@example.com"));
    introduce(&alice, &bob);

    let sent: Vec<(String, String)> = (0..4)
        .map(|i| {
            let text = format!("message {i}");
            (seal(&alice, &[&bob], &text), text)
        })
        .collect();
    for i in [2, 0, 3, 1] {
        assert_eq!(open(&bob, &alice, &sent[i].0).unwrap()["plaintext"], sent[i].1.as_str());
    }
}

#[test]
fn both_writing_at_once_keeps_the_conversation_intact() {
    let (alice, bob) = (person("a9", "alice@example.com"), person("b9", "bob@example.com"));
    introduce(&alice, &bob);

    let from_alice = seal(&alice, &[&bob], "crossing 1");
    let from_bob = seal(&bob, &[&alice], "crossing 2");
    assert_eq!(open(&bob, &alice, &from_alice).unwrap()["plaintext"], "crossing 1");
    assert_eq!(open(&alice, &bob, &from_bob).unwrap()["plaintext"], "crossing 2");

    let after = seal(&alice, &[&bob], "and after");
    assert_eq!(open(&bob, &alice, &after).unwrap()["plaintext"], "and after");
}

#[test]
fn both_handshaking_at_once_still_ends_in_a_conversation() {
    let (alice, bob) = (person("a10", "alice@example.com"), person("b10", "bob@example.com"));
    let from_alice = handshake(&alice, &[&bob]);
    let from_bob = handshake(&bob, &[&alice]);
    open(&bob, &alice, &from_alice).unwrap();
    open(&alice, &bob, &from_bob).unwrap();

    // Both hold an offer now, so both can write at once.
    let a = seal(&alice, &[&bob], "hi bob");
    let b = seal(&bob, &[&alice], "hi alice");
    assert_eq!(open(&bob, &alice, &a).unwrap()["plaintext"], "hi bob");
    assert_eq!(open(&alice, &bob, &b).unwrap()["plaintext"], "hi alice");
    let more = seal(&alice, &[&bob], "and more");
    assert_eq!(open(&bob, &alice, &more).unwrap()["plaintext"], "and more");
}

#[test]
fn an_offer_signed_by_someone_else_is_not_adopted() {
    let (alice, bob, mallory) = (
        person("a11", "alice@example.com"),
        person("b11", "bob@example.com"),
        person("m11", "mallory@example.com"),
    );
    // Mallory handshakes Bob; Bob checks it against Alice's key. The offer
    // Mallory signed must not be filed under Alice.
    let m = handshake(&mallory, &[&bob]);
    assert_eq!(open(&bob, &alice, &m).unwrap()["signature"], "invalid");
    assert_eq!(status(&bob, &[&alice]), ["none"]);
    assert!(try_seal(&bob, &[&alice], "hi alice").is_err(), "Bob wrote to Alice on Mallory's offer");
}

#[test]
fn a_handshake_is_readable_by_the_old_api_and_other_clients() {
    // Other OpenPGP clients take this path. Armor headers must not stop it.
    let (alice, bob) = (person("a12", "alice@example.com"), person("b12", "bob@example.com"));
    let m = handshake(&alice, &[&bob]);
    let opened: Value =
        serde_json::from_str(&bob.core.decrypt_verify(bob.email, PW, &m, &[alice.key.clone()]).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], HANDSHAKE);
    assert_eq!(opened["signature"], "valid");
}

#[test]
fn opening_a_handshake_we_sent_ourselves_does_not_file_our_own_offer() {
    // Found on the emulator: a self-addressed message carries our own offer,
    // and opening it filed that offer as though a contact had sent it.
    let alice = person("a13", "alice@example.com");
    let m = handshake(&alice, &[&alice]);
    open(&alice, &alice, &m).unwrap();

    let peers = fs::read_dir(sessions_dir("a13"))
        .unwrap()
        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("peer-"))
        .count();
    assert_eq!(peers, 0, "our own offer was filed as a contact's");
}

fn sessions_dir(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("cryptmail-fs-{name}-{}", std::process::id())).join("sessions")
}
