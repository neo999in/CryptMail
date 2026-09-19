//! Per-email keys **only**: every message this core seals for someone gets its
//! own key, or it is not sealed at all.
//!
//! `seal` refuses whenever a recipient has no session and no offer to open one
//! with — there is no fallback to long-term keys. What bridges first contact is
//! `handshake`: a contentless message that carries this device's signed offer
//! and nothing the user wrote. The contact's CryptMail answers it with a
//! per-email-keyed acknowledgement, and from then on both directions have a
//! session. `session_status` tells the caller which of those states each
//! recipient is in, so a message can be held rather than refused.
//!
//! `open` still reads long-term-key mail: what other people send is not ours to
//! choose, and mail from before this mode must stay readable.
//!
//! # On the wire
//!
//! Everything rides in the armor block the TypeScript side already forwards
//! untouched, as armor headers split into short lines — so `mime.ts` and the
//! envelope do not change, and nothing depends on a mail provider preserving a
//! custom message header.
//!
//! - `CryptMail-Offer` — on **every** message: this device's current offer,
//!   signed by the sender's identity. It is how a contact learns this device
//!   can hold a session, and how the recipient of a session's first message
//!   learns who opened it before anything is decrypted.
//! - `CryptMail-Session` — on forward-secret messages: one entry per recipient
//!   device, each carrying a step and the content key wrapped under that step's
//!   message key. There are no key packets, so no long-term key opens it.
//!
//! Other OpenPGP clients ignore armor headers, so a handshake is readable to
//! them as any OpenPGP message is — which is all it ever says.
//!
//! # The all-or-nothing rule
//!
//! One message has one content key. A single long-term-key packet on it would
//! let that key open it for everyone, so a message is sealed only when
//! **every** recipient can take it through a session; otherwise `seal` refuses,
//! and the caller holds the message while handshakes go out.
//!
//! The sender gets no entry. Encrypting to our own long-term key would reopen
//! every forward-secret message we ever sent — the app keeps its own sealed
//! copy of what was sent instead.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use pgp::armor::Headers;
use pgp::composed::SignedSecretKey;
use rand::{thread_rng, RngCore};
use serde::Serialize;

use crate::message::{self, Decrypted, KeyTransport};
use crate::session::{self, Entry, PublicBundle, Session, KEY_LEN};
use crate::session_store::{Device, PeerOffer, SessionStore};
use crate::{CoreError, Result};

pub const OFFER_HEADER: &str = "CryptMail-Offer";
pub const SESSION_HEADER: &str = "CryptMail-Session";
const LINE: usize = 64;
const OFFER_VERSION: u8 = 1;

#[derive(Debug, Serialize)]
pub struct Sealed {
    pub armored: String,
    /// True when every recipient device got a per-email key and no long-term key
    /// can open the message.
    #[serde(rename = "forwardSecret")]
    pub forward_secret: bool,
}

#[derive(Debug, Serialize)]
pub struct Opened {
    #[serde(flatten)]
    pub decrypted: Decrypted,
    #[serde(rename = "forwardSecret")]
    pub forward_secret: bool,
}

pub fn seal(
    store: &SessionStore,
    secret: &SignedSecretKey,
    passphrase: &str,
    plaintext: &str,
    recipient_keys: &[String],
    now: i64,
) -> Result<Sealed> {
    refuse_if_handed_over(store)?;

    let mut rng = thread_rng();
    let our_fp = message::fingerprint(secret);
    let device = store.device(&mut rng, now)?;

    let mut headers = Headers::new();
    put(&mut headers, OFFER_HEADER, &signed_offer(secret, passphrase, &device)?);

    // Everyone but ourselves, each with every device we can reach by session.
    let mut plans: Vec<Vec<Session>> = Vec::new();
    let mut unreachable = Vec::new();
    for armored in recipient_keys {
        let fp = message::public_fingerprint(armored)?;
        if fp == our_fp {
            continue;
        }
        let mut sessions = store.sessions_with(&fp)?;
        for offer in store.peer_offers(&fp)? {
            if !sessions.iter().any(|s| s.their_device() == offer.device.as_slice()) {
                sessions.push(Session::initiate(&mut rng, &our_fp, &fp, &offer.device, &offer.bundle));
            }
        }
        if sessions.is_empty() {
            unreachable.push(fp);
        }
        plans.push(sessions);
    }

    if plans.is_empty() {
        return Err(CoreError::NoKey(
            "no-session: per-email keys need a recipient other than yourself".into(),
        ));
    }
    if !unreachable.is_empty() {
        return Err(CoreError::NoKey(format!(
            "no-session: no per-email keys yet with {} — send a handshake first",
            unreachable.join(", ")
        )));
    }

    let mut content_key = zeroize::Zeroizing::new([0u8; KEY_LEN]);
    rng.fill_bytes(&mut *content_key);

    let mut entries = Vec::new();
    let mut advanced = Vec::new();
    for session in plans.iter().flatten() {
        let (next, step, message_key) = session.send(&mut rng)?;
        entries.push(Entry::seal(&mut rng, step, &*message_key, &our_fp, &*content_key)?);
        advanced.push(next);
    }
    put(&mut headers, SESSION_HEADER, &session::encode_entries(&entries)?);

    let armored = message::build(secret, passphrase, plaintext, KeyTransport::Supplied(&*content_key), &headers)?;

    // Persisted before the caller can hand the message to anyone. A crash after
    // this and before sending costs the recipient a skipped key; the other
    // order would re-derive a spent one.
    for session in &advanced {
        store.save_session(session)?;
    }
    Ok(Sealed { armored, forward_secret: true })
}

/// A contentless first-contact message: this device's signed offer, sealed to
/// the recipients' long-term keys around a `plaintext` the caller fixes.
///
/// The one thing this core still seals to long-term keys, and the reason it is
/// safe to: the caller (`app/src/state/handshake.ts`) never puts anything the
/// user wrote in it. The offer rides in an armor header, the same as on every
/// sealed message, so the contact's CryptMail can open a session back.
pub fn handshake(
    store: &SessionStore,
    secret: &SignedSecretKey,
    passphrase: &str,
    plaintext: &str,
    recipient_keys: &[String],
    now: i64,
) -> Result<String> {
    refuse_if_handed_over(store)?;
    if recipient_keys.is_empty() {
        return Err(CoreError::NoKey("no recipient keys supplied".into()));
    }
    let device = store.device(&mut thread_rng(), now)?;
    let mut headers = Headers::new();
    put(&mut headers, OFFER_HEADER, &signed_offer(secret, passphrase, &device)?);
    message::build(secret, passphrase, plaintext, KeyTransport::ToKeys(recipient_keys), &headers)
}

/// Where each recipient stands, in the order given: `"self"`, `"session"` (a
/// conversation exists), `"offer"` (we hold their offer and can open one), or
/// `"none"` (a handshake is needed first).
pub fn session_status(
    store: &SessionStore,
    secret: &SignedSecretKey,
    recipient_keys: &[String],
) -> Result<Vec<&'static str>> {
    refuse_if_handed_over(store)?;
    let our_fp = message::fingerprint(secret);
    let mut out = Vec::with_capacity(recipient_keys.len());
    for armored in recipient_keys {
        let fp = message::public_fingerprint(armored)?;
        out.push(if fp == our_fp {
            "self"
        } else if !store.sessions_with(&fp)?.is_empty() {
            "session"
        } else if !store.peer_offers(&fp)?.is_empty() {
            "offer"
        } else {
            "none"
        });
    }
    Ok(out)
}

/// A handed-over phone sends nothing sealed: its conversations belong to the
/// phone it handed them to, and per-email keys are the only kind there is.
fn refuse_if_handed_over(store: &SessionStore) -> Result<()> {
    if store.handed_over()?.is_some() {
        return Err(CoreError::Unavailable(
            "handed-over: this phone handed its conversations to another phone".into(),
        ));
    }
    Ok(())
}

pub fn open(
    store: &SessionStore,
    secret: &SignedSecretKey,
    passphrase: &str,
    armored: &str,
    sender_keys: &[String],
    now: i64,
) -> Result<Opened> {
    let (msg, headers) = message::parse(armored)?;
    let offer = take(&headers, OFFER_HEADER).and_then(|bytes| verify_offer(&bytes, sender_keys));

    let our_fp = message::fingerprint(secret);

    let Some(entries) = take(&headers, SESSION_HEADER) else {
        drop(msg);
        let decrypted = message::decrypt_verify(secret, passphrase, armored, sender_keys)?;
        remember(store, &our_fp, offer.as_ref(), &decrypted)?;
        return Ok(Opened { decrypted, forward_secret: false });
    };
    // Handed over: read with what is there, and never rotate — the new phone
    // carries these offers on, and a rotation here would fork them.
    let offers = if store.handed_over()?.is_some() {
        store.existing_device()?.map(|d| d.offer_keypairs()).unwrap_or_default()
    } else {
        store.device(&mut thread_rng(), now)?.offer_keypairs()
    };

    for entry in session::decode_entries(&entries)? {
        let attempt = match store.session(&entry.step.session)? {
            // A session we hold: the wrapped key opening is proof enough — only
            // the other holder of this state could have produced it.
            Some(existing) => existing.receive(&entry.step, &[]).map(|(next, mk)| (next, mk, false)),
            // A first message. Anyone can encapsulate to an offer, so who opened
            // it comes from the signed offer riding alongside, and is confirmed
            // below by the signature inside.
            None => match &offer {
                Some(o) => Session::accept(&our_fp, &o.fingerprint, &o.device, &offers, &entry.step)
                    .map(|(next, mk)| (next, mk, true)),
                None => continue,
            },
        };
        let Ok((next, message_key, first)) = attempt else { continue };
        let Ok(content_key) = entry.open(&*message_key, next.their_fingerprint()) else { continue };

        let decrypted = message::decrypt_with_key(msg, &*content_key, sender_keys)?;
        if first && decrypted.signer_fingerprint.as_deref() != Some(next.their_fingerprint()) {
            return Err(CoreError::DecryptFailed(
                "could not confirm who started this conversation — its signature does not match".into(),
            ));
        }
        // Only now: a message that did not decrypt must not move the state.
        store.save_session(&next)?;
        remember(store, &our_fp, offer.as_ref(), &decrypted)?;
        return Ok(Opened { decrypted, forward_secret: true });
    }

    Err(CoreError::DecryptFailed(
        "this message was sealed for another device, or its key no longer exists on this one".into(),
    ))
}

/// Keep a contact's offer — but only one signed by the same key that signed the
/// message, so a relayed offer cannot attach itself to someone else's mail.
///
/// Never our own: mail we sent ourselves carries our offer too, and `seal`
/// never opens a session with ourselves, so filing it would only be clutter.
/// Found on the emulator, where opening a self-addressed message did exactly that.
fn remember(store: &SessionStore, our_fp: &str, offer: Option<&PeerOffer>, decrypted: &Decrypted) -> Result<()> {
    match offer {
        Some(o)
            if o.fingerprint != our_fp
                && decrypted.signature == "valid"
                && decrypted.signer_fingerprint.as_deref() == Some(&o.fingerprint) =>
        {
            store.save_peer_offer(o)
        }
        _ => Ok(()),
    }
}

// ----------------------------------------------------------------- offers --

/// `version | device id (16) | created (8) | public bundle | signature`
fn signed_offer(secret: &SignedSecretKey, passphrase: &str, device: &Device) -> Result<Vec<u8>> {
    let current = device.current_offer();
    let mut body = vec![OFFER_VERSION];
    body.extend_from_slice(&device.id);
    body.extend_from_slice(&current.created.to_be_bytes());
    body.extend_from_slice(&current.keypair.public.to_bytes());
    let signature = message::sign_detached(secret, passphrase, &body)?;
    Ok([body, signature].concat())
}

fn verify_offer(bytes: &[u8], sender_keys: &[String]) -> Option<PeerOffer> {
    const BODY: usize = 1 + 16 + 8 + 32 + 1184;
    if bytes.len() <= BODY || bytes[0] != OFFER_VERSION {
        return None;
    }
    let (body, signature) = bytes.split_at(BODY);
    let fingerprint = message::verify_detached(signature, body, sender_keys)?;
    Some(PeerOffer {
        fingerprint,
        device: body[1..17].to_vec(),
        created: i64::from_be_bytes(body[17..25].try_into().ok()?),
        bundle: PublicBundle::from_bytes(&body[25..]).ok()?,
    })
}

// ---------------------------------------------------------- armor headers --

/// Base64 split into short lines under one repeated key: armor headers have no
/// folding, and one long line invites a mail system to re-encode the part.
fn put(headers: &mut Headers, key: &str, bytes: &[u8]) {
    let encoded = B64.encode(bytes);
    let lines = encoded.as_bytes().chunks(LINE).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
    headers.insert(key.to_string(), lines);
}

fn take(headers: &Headers, key: &str) -> Option<Vec<u8>> {
    B64.decode(headers.get(key)?.concat()).ok()
}
