//! Two phones arriving at the same key bank by running BB84, with the three
//! legs travelling as armored blocks — exactly the strings the app would put in
//! an email body — and then using that bank for Level 2 mail.

use std::fs;

use cryptmail_core::Core;
use serde_json::Value;

const PW: &str = "keystore passphrase";
const ALICE: &str = "alice@example.com";
const BOB: &str = "bob@example.com";

fn phone(name: &str) -> Core {
    let dir = std::env::temp_dir().join(format!("cryptmail-bb84-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Core::new(&dir)
}

fn status(core: &Core, email: &str) -> Value {
    serde_json::from_str(&core.km_status(PW, email).unwrap()).unwrap()
}

/// The exchange as the app drives it: three messages, nothing else shared.
fn exchange(alice: &Core, bob: &Core) -> Result<(), cryptmail_core::CoreError> {
    let photons = alice.bb84_begin(PW, ALICE)?;
    let reply = bob.bb84_measure(PW, BOB, &photons)?;
    let verdict = alice.bb84_judge(PW, ALICE, &reply)?;
    bob.bb84_accept(PW, BOB, &verdict)?;
    Ok(())
}

#[test]
fn three_emails_leave_both_phones_holding_the_same_bank() {
    let (alice, bob) = (phone("a-link"), phone("b-link"));
    exchange(&alice, &bob).unwrap();

    let (a, b) = (status(&alice, ALICE), status(&bob, BOB));
    assert_eq!(a["role"], "Master");
    assert_eq!(b["role"], "Slave");
    assert_eq!(a["peerSaeId"], b["saeId"], "Alice is not pointed at Bob");
    assert_eq!(b["peerSaeId"], a["saeId"], "Bob is not pointed at Alice");
    // No halves: each end may send with all 100.
    assert_eq!((a["available"].as_u64(), a["remaining"].as_u64()), (Some(100), Some(100)));
    assert_eq!((b["available"].as_u64(), b["remaining"].as_u64()), (Some(100), Some(100)));
}

#[test]
fn a_bank_built_this_way_carries_level_2_mail_both_ways() {
    let (alice, bob) = (phone("a-mail"), phone("b-mail"));
    exchange(&alice, &bob).unwrap();

    let m = alice.qkd_seal(PW, ALICE, 2, "the launch is at noon").unwrap();
    let opened: Value = serde_json::from_str(&bob.qkd_open(PW, BOB, &m).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], "the launch is at noon");

    let m = bob.qkd_seal(PW, BOB, 2, "understood").unwrap();
    let opened: Value = serde_json::from_str(&alice.qkd_open(PW, ALICE, &m).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], "understood");
    assert_eq!(opened["level"], 2);
}

#[test]
fn the_two_ends_derived_the_same_key_ids_and_may_both_send_with_one() {
    // Both ends derived the bank independently, so they list the same IDs in
    // the same order and pick the same first key. Each still reads the other:
    // a use is bound to its sender (`qkd.rs`).
    let (alice, bob) = (phone("a-same"), phone("b-same"));
    exchange(&alice, &bob).unwrap();

    let id = |m: &str| m.lines().find_map(|l| l.strip_prefix("Key-ID:")).unwrap().trim().to_string();
    let hers = alice.qkd_seal(PW, ALICE, 2, "from alice").unwrap();
    let his = bob.qkd_seal(PW, BOB, 2, "from bob").unwrap();
    assert_eq!(id(&hers), id(&his));

    let read = |core: &Core, email: &str, m: &str| -> Value { serde_json::from_str(&core.qkd_open(PW, email, m).unwrap()).unwrap() };
    assert_eq!(read(&bob, BOB, &hers)["plaintext"], "from alice");
    assert_eq!(read(&alice, ALICE, &his)["plaintext"], "from bob");
}

#[test]
fn nothing_in_the_three_messages_is_the_key() {
    let (alice, bob) = (phone("a-wire"), phone("b-wire"));
    let photons = alice.bb84_begin(PW, ALICE).unwrap();
    let reply = bob.bb84_measure(PW, BOB, &photons).unwrap();
    let verdict = alice.bb84_judge(PW, ALICE, &reply).unwrap();
    bob.bb84_accept(PW, BOB, &verdict).unwrap();

    // The bank's own key IDs are derived from the material, so if any message
    // happened to carry the material itself an ID would be findable in it.
    let m = alice.qkd_seal(PW, ALICE, 2, "x").unwrap();
    let id = m.lines().find_map(|l| l.strip_prefix("Key-ID:")).unwrap().trim();
    for (what, text) in [("photons", &photons), ("reply", &reply), ("verdict", &verdict)] {
        assert!(!text.contains(id), "the {what} message carried a bank key ID");
    }
}

#[test]
fn a_verdict_cannot_be_judged_twice_into_a_second_bank() {
    let (alice, bob) = (phone("a-once"), phone("b-once"));
    let photons = alice.bb84_begin(PW, ALICE).unwrap();
    let reply = bob.bb84_measure(PW, BOB, &photons).unwrap();
    alice.bb84_judge(PW, ALICE, &reply).unwrap();

    // The sample was said out loud; a second judgement of the same reply must
    // not produce another bank.
    let err = alice.bb84_judge(PW, ALICE, &reply).unwrap_err();
    assert!(err.to_string().contains("bb84-no-exchange"), "{err}");
}

#[test]
fn a_verdict_about_nothing_is_refused() {
    let (alice, bob) = (phone("a-stray"), phone("b-stray"));
    let photons = alice.bb84_begin(PW, ALICE).unwrap();
    let reply = bob.bb84_measure(PW, BOB, &photons).unwrap();
    let verdict = alice.bb84_judge(PW, ALICE, &reply).unwrap();

    let carol = phone("c-stray");
    let err = carol.bb84_accept(PW, "carol@example.com", &verdict).unwrap_err();
    assert!(err.to_string().contains("bb84-no-exchange"), "{err}");
}

#[test]
fn a_leg_is_recognisable_without_being_parsed() {
    let (alice, bob) = (phone("a-route"), phone("b-route"));
    let photons = alice.bb84_begin(PW, ALICE).unwrap();
    let reply = bob.bb84_measure(PW, BOB, &photons).unwrap();
    let verdict = alice.bb84_judge(PW, ALICE, &reply).unwrap();

    let body = |block: &str| format!("Alice's phone is setting up a quantum link.\n\n{block}\n");
    assert_eq!(alice.bb84_leg(&body(&photons)).as_deref(), Some("photons"));
    assert_eq!(alice.bb84_leg(&body(&reply)).as_deref(), Some("measurement"));
    assert_eq!(alice.bb84_leg(&body(&verdict)).as_deref(), Some("verdict"));
    assert_eq!(alice.bb84_leg("an ordinary email"), None);
}

#[test]
fn a_damaged_transmission_builds_nothing() {
    let (alice, bob) = (phone("a-damaged"), phone("b-damaged"));
    let photons = alice.bb84_begin(PW, ALICE).unwrap();
    let cut = &photons[..photons.len() / 2];
    assert!(bob.bb84_measure(PW, BOB, cut).is_err());
    assert_eq!(status(&bob, BOB)["peerSaeId"], Value::Null, "a damaged message linked the phones");
}

#[test]
fn an_exchange_replaces_a_bank_that_was_linked_by_file() {
    // Both routes end in the same place, so one may follow the other.
    let (alice, bob) = (phone("a-relink"), phone("b-relink"));
    let link = alice.km_export_link(PW, ALICE, "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q").unwrap();
    bob.km_import_link(PW, BOB, &link, "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q").unwrap();
    let before = status(&alice, ALICE)["saeId"].clone();

    exchange(&alice, &bob).unwrap();
    assert_eq!(status(&alice, ALICE)["saeId"], before, "the exchange changed who this end is");
    assert_eq!(status(&alice, ALICE)["available"], 100);
    let m = alice.qkd_seal(PW, ALICE, 2, "after relinking").unwrap();
    let opened: Value = serde_json::from_str(&bob.qkd_open(PW, BOB, &m).unwrap()).unwrap();
    assert_eq!(opened["plaintext"], "after relinking");
}

#[test]
fn an_eavesdropper_is_caught_and_neither_phone_builds_a_bank() {
    let (alice, bob) = (phone("a-eve"), phone("b-eve"));
    let photons = alice.bb84_begin(PW, ALICE).unwrap();
    // Eve measures every state and sends on what she read.
    let resent = alice.bb84_eavesdrop(&photons).unwrap();
    let reply = bob.bb84_measure(PW, BOB, &resent).unwrap();

    let err = alice.bb84_judge(PW, ALICE, &reply).unwrap_err();
    assert!(err.to_string().contains("bb84-eavesdropper"), "{err}");
    assert!(err.to_string().contains('%'), "the refusal does not say how bad it was: {err}");

    assert_eq!(status(&alice, ALICE)["peerSaeId"], Value::Null, "Alice built a bank anyway");
    assert_eq!(status(&bob, BOB)["peerSaeId"], Value::Null, "Bob built a bank anyway");
    assert_eq!(status(&alice, ALICE)["role"], "Solo");
}

#[test]
fn one_exchange_is_about_a_hundred_kilobytes_of_email() {
    // The states are the only large thing here, and they have to fit in a
    // message a mail provider will carry.
    let alice = phone("a-size");
    let photons = alice.bb84_begin(PW, ALICE).unwrap();
    let kb = photons.len() / 1024;
    assert!((100..200).contains(&kb), "one transmission is {kb} KB");
}
