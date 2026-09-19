//! Per-email keys: the ratchet behind forward-secret conversations.
//!
//! Today every message gets a fresh AES session key, but each one is wrapped to
//! the recipient's long-term key, so that one key opens everything they ever
//! received. A session replaces the wrap: both sides hold matching state, each
//! message's key is derived from it and then deleted, and nothing that survives
//! on either device can reopen an earlier message.
//!
//! This module is the state machine only. It touches no files and no OpenPGP —
//! it takes bytes and returns bytes — so every property below is testable
//! without a message builder, a keyring or a disk. `message.rs` puts its output
//! on the wire; `session_store.rs` keeps it.
//!
//! # Shape
//!
//! A KEM double ratchet with a hybrid KEM, the same composition RFC 9980 uses
//! for long-term keys: ML-KEM-768 **and** X25519, so breaking one is not enough.
//!
//! - **Epochs.** A sender starts an epoch by encapsulating to the receiving key
//!   the peer most recently advertised. Both sides fold the shared secret into
//!   the root key, which yields that epoch's chain key. Epochs strictly
//!   alternate: a side starts a new one only after receiving the peer's newest,
//!   and otherwise keeps sending on its current chain. That is what keeps the
//!   two root keys in step when both people write at once.
//! - **Chains.** Within an epoch, `(next chain key, message key) = KDF(chain)`.
//!   One message key per message, deleted after use.
//! - **Receiving keys rotate.** Each epoch a sender generates a fresh receiving
//!   keypair and advertises it. The previous few are kept only so a late
//!   message can still be opened; older ones are deleted, and with them the
//!   ability to decapsulate anything addressed to them.
//!
//! # Binding
//!
//! The combiner here is ours, not rPGP's (that one is unreachable from
//! `encrypt_to_key`), so it binds what RFC 9980's does: both shared secrets,
//! the ML-KEM ciphertext, the ephemeral X25519 key, the recipient's public keys,
//! and the session and both identities. On the wire, every step is also the
//! AEAD associated data of the key it carries, so a tampered header does not
//! decrypt to something else — it does not decrypt.
//!
//! # Transactions
//!
//! `send`, `receive` and `accept` never mutate. Each returns the next state
//! alongside the key, and the caller persists that state:
//!
//! - **before** handing a message to the provider, or a crash between the two
//!   re-derives a spent key for a different message;
//! - **only after** the message decrypts, or a forged header would advance the
//!   state and strand every genuine message behind it.

use std::collections::VecDeque;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use ml_kem::kem::{Decapsulate, Encapsulate};
use ml_kem::{EncodedSizeUser, KemCore, MlKem768};
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as XPublic, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

use crate::{CoreError, Result};

type Ek = <MlKem768 as KemCore>::EncapsulationKey;
type Dk = <MlKem768 as KemCore>::DecapsulationKey;
type Ct = ml_kem::Ciphertext<MlKem768>;

pub const KEY_LEN: usize = 32;
const X_LEN: usize = 32;
const EK_LEN: usize = 1184;
const CT_LEN: usize = 1088;
const ID_LEN: usize = 8;
const SESSION_ID_LEN: usize = 16;
const PUBLIC_LEN: usize = X_LEN + EK_LEN;
const NONCE_LEN: usize = 12;
const WRAPPED_LEN: usize = KEY_LEN + 16;

/// Receiving keypairs a session keeps. The newest is what the peer encapsulates
/// to next; the older ones exist only for messages still in flight.
const OUR_KEYPAIRS: usize = 3;
/// Receiving chains kept, newest first.
const RECV_CHAINS: usize = 3;
/// Message keys held for mail that has not arrived yet. These are the one set
/// of keys that are *not* yet forward-secret, which is why the cache is bounded
/// and a gap wider than it is refused rather than precomputed.
pub const MAX_SKIPPED: usize = 256;

pub type Key = [u8; KEY_LEN];

// ---------------------------------------------------------------- keypairs --

/// The public half of a hybrid receiving key: what a peer encapsulates to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicBundle {
    #[serde(with = "b64")]
    pub x: Vec<u8>,
    #[serde(with = "b64")]
    pub ek: Vec<u8>,
}

impl PublicBundle {
    /// A short identifier, so a message can say which of our keys it used
    /// without repeating 1,216 bytes of it.
    pub fn id(&self) -> Vec<u8> {
        digest(&[b"cryptmail/v1/keypair-id", &self.x, &self.ek])[..ID_LEN].to_vec()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        [&self.x[..], &self.ek[..]].concat()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != PUBLIC_LEN {
            return Err(malformed("a session public key has the wrong length"));
        }
        Ok(Self { x: bytes[..X_LEN].to_vec(), ek: bytes[X_LEN..].to_vec() })
    }
}

/// A hybrid receiving keypair. The secret halves are wiped when it is dropped.
#[derive(Clone, Serialize, Deserialize)]
pub struct KeyPair {
    #[serde(with = "b64")]
    x_secret: Vec<u8>,
    #[serde(with = "b64")]
    dk: Vec<u8>,
    pub public: PublicBundle,
}

impl Drop for KeyPair {
    fn drop(&mut self) {
        self.x_secret.zeroize();
        self.dk.zeroize();
    }
}

impl KeyPair {
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let x = StaticSecret::random_from_rng(&mut *rng);
        let (dk, ek) = MlKem768::generate(rng);
        let public = PublicBundle {
            x: XPublic::from(&x).as_bytes().to_vec(),
            ek: ek.as_bytes().to_vec(),
        };
        Self { x_secret: x.to_bytes().to_vec(), dk: dk.as_bytes().to_vec(), public }
    }

    pub fn id(&self) -> Vec<u8> {
        self.public.id()
    }
}

// ------------------------------------------------------------ the hybrid KEM --

/// The encapsulation that opens an epoch. Repeated on every message of the
/// epoch, so any one of them can open it even if the first is lost.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Encapsulation {
    /// Which of the recipient's receiving keys this was encapsulated to.
    #[serde(with = "b64")]
    pub to: Vec<u8>,
    #[serde(with = "b64")]
    pub ct: Vec<u8>,
    /// The sender's ephemeral X25519 key.
    #[serde(with = "b64")]
    pub e: Vec<u8>,
}

impl Encapsulation {
    fn chain_id(&self) -> Vec<u8> {
        digest(&[b"cryptmail/v1/chain-id", &self.to, &self.ct, &self.e])[..ID_LEN].to_vec()
    }
}

fn encapsulate<R: RngCore + CryptoRng>(
    rng: &mut R,
    to: &PublicBundle,
    context: &[u8],
) -> Result<(Encapsulation, Zeroizing<Key>)> {
    let encoded = <ml_kem::Encoded<Ek>>::try_from(&to.ek[..])
        .map_err(|_| malformed("a session public key is not ML-KEM-768"))?;
    let (ct, ss_mlkem) = Ek::from_bytes(&encoded)
        .encapsulate(rng)
        .map_err(|_| CoreError::Unavailable("ML-KEM encapsulation failed".into()))?;

    let e = StaticSecret::random_from_rng(&mut *rng);
    let ss_x25519 = e.diffie_hellman(&XPublic::from(array32(&to.x)?));
    if !ss_x25519.was_contributory() {
        return Err(malformed("a session public key is a low-order X25519 point"));
    }

    let enc = Encapsulation {
        to: to.id(),
        ct: ct.to_vec(),
        e: XPublic::from(&e).as_bytes().to_vec(),
    };
    let ss = combine(&ss_mlkem, ss_x25519.as_bytes(), &enc, to, context);
    Ok((enc, ss))
}

fn decapsulate(ours: &KeyPair, enc: &Encapsulation, context: &[u8]) -> Result<Zeroizing<Key>> {
    let dk = <ml_kem::Encoded<Dk>>::try_from(&ours.dk[..])
        .map_err(|_| CoreError::Unavailable("a stored session key is corrupt".into()))?;
    let ct = Ct::try_from(&enc.ct[..]).map_err(|_| malformed("an ML-KEM ciphertext has the wrong length"))?;
    // ML-KEM rejects implicitly: a wrong ciphertext yields an unrelated secret,
    // not an error. The mismatch surfaces when the wrapped key fails to open.
    let ss_mlkem = Dk::from_bytes(&dk)
        .decapsulate(&ct)
        .map_err(|_| CoreError::DecryptFailed("ML-KEM decapsulation failed".into()))?;

    let x = StaticSecret::from(array32(&ours.x_secret)?);
    let ss_x25519 = x.diffie_hellman(&XPublic::from(array32(&enc.e)?));
    if !ss_x25519.was_contributory() {
        return Err(malformed("an ephemeral key is a low-order X25519 point"));
    }

    Ok(combine(&ss_mlkem, ss_x25519.as_bytes(), enc, &ours.public, context))
}

/// Both secrets, bound to everything that produced them. Change the recipient,
/// either ciphertext, the session, or who is sending, and the output is
/// unrelated — which is what stops components of two messages being spliced.
fn combine(
    ss_mlkem: &[u8],
    ss_x25519: &[u8],
    enc: &Encapsulation,
    to: &PublicBundle,
    context: &[u8],
) -> Zeroizing<Key> {
    let mut ikm = Zeroizing::new(Vec::with_capacity(2 * KEY_LEN));
    ikm.extend_from_slice(ss_mlkem);
    ikm.extend_from_slice(ss_x25519);

    let info = digest(&[b"cryptmail/v1/hybrid", &enc.ct, &enc.e, &to.x, &to.ek, context]);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    Hkdf::<Sha256>::new(Some(b"cryptmail/v1/hybrid"), &ikm)
        .expand(&info, &mut *out)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

// ------------------------------------------------------------------- KDFs --

/// `(root, chain) = KDF(root, shared secret)`
fn kdf_root(rk: &[u8], ss: &[u8], context: &[u8]) -> (Zeroizing<Key>, Zeroizing<Key>) {
    let mut okm = Zeroizing::new([0u8; 2 * KEY_LEN]);
    Hkdf::<Sha256>::new(Some(rk), ss)
        .expand_multi_info(&[b"cryptmail/v1/root", context], &mut *okm)
        .expect("64 bytes is a valid HKDF-SHA256 output length");
    split(&okm)
}

/// `(next chain, message key) = KDF(chain)`. One-way: the next chain key says
/// nothing about this one, so deleting it deletes the message key for good.
fn kdf_chain(ck: &[u8]) -> (Zeroizing<Key>, Zeroizing<Key>) {
    let tag = |label: u8| -> Zeroizing<Key> {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(ck).expect("HMAC takes any key length");
        mac.update(&[label]);
        Zeroizing::new(mac.finalize().into_bytes().into())
    };
    (tag(0x02), tag(0x01))
}

// ------------------------------------------------------------------ steps --

/// What a sender puts on the wire for one session: enough for the recipient to
/// derive the same message key, and nothing that helps anyone else derive it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub session: Vec<u8>,
    pub enc: Encapsulation,
    /// The sender's current receiving key — what the recipient encapsulates to
    /// when it next starts an epoch.
    pub advertised: PublicBundle,
    /// This message's index within its chain.
    pub n: u32,
    /// How long the sender's previous chain was, so its unseen tail can be kept.
    pub pn: u32,
}

const STEP_LEN: usize = SESSION_ID_LEN + ID_LEN + CT_LEN + X_LEN + PUBLIC_LEN + 4 + 4;

impl Step {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(STEP_LEN);
        out.extend_from_slice(&self.session);
        out.extend_from_slice(&self.enc.to);
        out.extend_from_slice(&self.enc.ct);
        out.extend_from_slice(&self.enc.e);
        out.extend_from_slice(&self.advertised.to_bytes());
        out.extend_from_slice(&self.n.to_be_bytes());
        out.extend_from_slice(&self.pn.to_be_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != STEP_LEN {
            return Err(malformed("a session step has the wrong length"));
        }
        let (session, rest) = bytes.split_at(SESSION_ID_LEN);
        let (to, rest) = rest.split_at(ID_LEN);
        let (ct, rest) = rest.split_at(CT_LEN);
        let (e, rest) = rest.split_at(X_LEN);
        let (advertised, rest) = rest.split_at(PUBLIC_LEN);
        let (n, pn) = rest.split_at(4);
        Ok(Self {
            session: session.to_vec(),
            enc: Encapsulation { to: to.to_vec(), ct: ct.to_vec(), e: e.to_vec() },
            advertised: PublicBundle::from_bytes(advertised)?,
            n: u32::from_be_bytes(n.try_into().expect("split at 4")),
            pn: u32::from_be_bytes(pn.try_into().expect("4 bytes remain")),
        })
    }
}

/// One recipient-device's share of a message: its step, and the message's
/// content key wrapped under the message key that step derives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub step: Step,
    nonce: Vec<u8>,
    wrapped: Vec<u8>,
}

impl Entry {
    /// Wrap `content_key` for one recipient. The step and the sender are the
    /// associated data, so neither can be altered without the unwrap failing.
    ///
    /// The nonce is random even though a message key is used exactly once: if
    /// that ever fails — a crash that re-derives a spent key — a fixed nonce
    /// would turn one bug into a GCM nonce reuse.
    pub fn seal<R: RngCore + CryptoRng>(
        rng: &mut R,
        step: Step,
        message_key: &[u8],
        sender_fp: &str,
        content_key: &[u8],
    ) -> Result<Self> {
        let mut nonce = [0u8; NONCE_LEN];
        rng.fill_bytes(&mut nonce);
        let aad = [step.to_bytes(), sender_fp.as_bytes().to_vec()].concat();
        let wrapped = Aes256Gcm::new_from_slice(message_key)
            .expect("message keys are 32 bytes")
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: content_key, aad: &aad })
            .map_err(|_| CoreError::Unavailable("could not wrap a message key".into()))?;
        Ok(Self { step, nonce: nonce.to_vec(), wrapped })
    }

    pub fn open(&self, message_key: &[u8], sender_fp: &str) -> Result<Zeroizing<Key>> {
        let aad = [self.step.to_bytes(), sender_fp.as_bytes().to_vec()].concat();
        let plain = Aes256Gcm::new_from_slice(message_key)
            .expect("message keys are 32 bytes")
            .decrypt(Nonce::from_slice(&self.nonce), Payload { msg: &self.wrapped, aad: &aad })
            .map_err(|_| CoreError::DecryptFailed("this message's key did not open — it was altered, or is not for this session".into()))?;
        let plain = Zeroizing::new(plain);
        Ok(Zeroizing::new(array32(&plain)?))
    }

    fn to_bytes(&self) -> Vec<u8> {
        [self.step.to_bytes(), self.nonce.clone(), self.wrapped.clone()].concat()
    }

    fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != STEP_LEN + NONCE_LEN + WRAPPED_LEN {
            return Err(malformed("a session entry has the wrong length"));
        }
        Ok(Self {
            step: Step::from_bytes(&bytes[..STEP_LEN])?,
            nonce: bytes[STEP_LEN..STEP_LEN + NONCE_LEN].to_vec(),
            wrapped: bytes[STEP_LEN + NONCE_LEN..].to_vec(),
        })
    }
}

/// Every entry a message carries — one per recipient device.
pub fn encode_entries(entries: &[Entry]) -> Result<Vec<u8>> {
    let count = u8::try_from(entries.len())
        .map_err(|_| CoreError::Unavailable("too many recipient devices for one message".into()))?;
    let mut out = vec![1u8, count];
    for entry in entries {
        out.extend_from_slice(&entry.to_bytes());
    }
    Ok(out)
}

pub fn decode_entries(bytes: &[u8]) -> Result<Vec<Entry>> {
    const ENTRY_LEN: usize = STEP_LEN + NONCE_LEN + WRAPPED_LEN;
    match bytes {
        [1, count, rest @ ..] if rest.len() == *count as usize * ENTRY_LEN => {
            rest.chunks(ENTRY_LEN).map(Entry::from_bytes).collect()
        }
        [1, ..] => Err(malformed("session data is truncated")),
        _ => Err(malformed("unknown session data version")),
    }
}

// ---------------------------------------------------------------- session --

#[derive(Clone, Serialize, Deserialize)]
struct SendChain {
    enc: Encapsulation,
    #[serde(with = "b64")]
    ck: Vec<u8>,
    n: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct RecvChain {
    #[serde(with = "b64")]
    id: Vec<u8>,
    #[serde(with = "b64")]
    ck: Vec<u8>,
    /// The next index expected.
    n: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct Skipped {
    #[serde(with = "b64")]
    chain: Vec<u8>,
    n: u32,
    #[serde(with = "b64")]
    mk: Vec<u8>,
}

/// The state two devices keep in step. Never transmitted; each side derives
/// its own.
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    #[serde(with = "b64")]
    id: Vec<u8>,
    our_fp: String,
    their_fp: String,
    /// Which of the peer's devices this session is with — each device is its
    /// own participant, so a person with a phone and a laptop has two.
    #[serde(with = "b64")]
    their_device: Vec<u8>,
    #[serde(with = "b64")]
    rk: Vec<u8>,
    send: Option<SendChain>,
    pn: u32,
    /// Our receiving keypairs, newest first.
    ours: VecDeque<KeyPair>,
    /// The newest receiving key the peer has advertised.
    theirs: PublicBundle,
    /// True when the peer has started an epoch since our last one, so our next
    /// send starts a new epoch rather than continuing the current chain.
    our_turn: bool,
    recv: VecDeque<RecvChain>,
    skipped: VecDeque<Skipped>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.rk.zeroize();
        if let Some(chain) = self.send.as_mut() {
            chain.ck.zeroize();
        }
        for chain in self.recv.iter_mut() {
            chain.ck.zeroize();
        }
        for skipped in self.skipped.iter_mut() {
            skipped.mk.zeroize();
        }
    }
}

impl Session {
    /// Start a session with someone whose offer we hold. Nothing is sent yet —
    /// the first `send` opens the first epoch against their offer.
    pub fn initiate<R: RngCore + CryptoRng>(
        rng: &mut R,
        our_fp: &str,
        their_fp: &str,
        their_device: &[u8],
        their_offer: &PublicBundle,
    ) -> Self {
        let mut id = vec![0u8; SESSION_ID_LEN];
        rng.fill_bytes(&mut id);
        Self {
            id,
            our_fp: our_fp.to_string(),
            their_fp: their_fp.to_string(),
            their_device: their_device.to_vec(),
            rk: vec![0u8; KEY_LEN],
            send: None,
            pn: 0,
            ours: VecDeque::new(),
            theirs: their_offer.clone(),
            our_turn: true,
            recv: VecDeque::new(),
            skipped: VecDeque::new(),
        }
    }

    /// The session a first message opens on our side. `offers` are this
    /// device's offer keypairs; the step says which one it was encapsulated to.
    pub fn accept(
        our_fp: &str,
        their_fp: &str,
        their_device: &[u8],
        offers: &[KeyPair],
        step: &Step,
    ) -> Result<(Self, Zeroizing<Key>)> {
        let fresh = Self {
            id: step.session.clone(),
            our_fp: our_fp.to_string(),
            their_fp: their_fp.to_string(),
            their_device: their_device.to_vec(),
            rk: vec![0u8; KEY_LEN],
            send: None,
            pn: 0,
            ours: VecDeque::new(),
            theirs: step.advertised.clone(),
            our_turn: true,
            recv: VecDeque::new(),
            skipped: VecDeque::new(),
        };
        fresh.receive(step, offers)
    }

    pub fn id(&self) -> &[u8] {
        &self.id
    }

    pub fn their_fingerprint(&self) -> &str {
        &self.their_fp
    }

    pub fn their_device(&self) -> &[u8] {
        &self.their_device
    }

    /// The next message key, the step that lets the peer derive it, and the
    /// state to persist **before** the message leaves the device.
    pub fn send<R: RngCore + CryptoRng>(&self, rng: &mut R) -> Result<(Self, Step, Zeroizing<Key>)> {
        let mut next = self.clone();

        if next.our_turn || next.send.is_none() {
            let (enc, ss) = encapsulate(rng, &next.theirs, &next.direction(&next.our_fp))?;
            let (rk, ck) = kdf_root(&next.rk, &*ss, &next.context());
            next.rk = rk.to_vec();
            next.pn = next.send.as_ref().map_or(0, |chain| chain.n);
            next.ours.push_front(KeyPair::generate(rng));
            next.ours.truncate(OUR_KEYPAIRS);
            next.send = Some(SendChain { enc, ck: ck.to_vec(), n: 0 });
            next.our_turn = false;
        }

        let advertised = next.ours.front().expect("an epoch always has a receiving key").public.clone();
        let chain = next.send.as_mut().expect("a sending chain was just ensured");
        let (ck, mk) = kdf_chain(&chain.ck);
        let step = Step {
            session: next.id.clone(),
            enc: chain.enc.clone(),
            advertised,
            n: chain.n,
            pn: next.pn,
        };
        chain.ck.zeroize();
        chain.ck = ck.to_vec();
        chain.n += 1;

        Ok((next, step, mk))
    }

    /// The message key for an incoming step, and the state to persist **only
    /// after** the message it belongs to has decrypted.
    pub fn receive(&self, step: &Step, offers: &[KeyPair]) -> Result<(Self, Zeroizing<Key>)> {
        if step.session != self.id {
            return Err(CoreError::DecryptFailed("this message belongs to a different session".into()));
        }
        let mut next = self.clone();
        let chain_id = step.enc.chain_id();

        // A message that arrived after later ones: its key was kept for it.
        if let Some(at) = next.skipped.iter().position(|s| s.chain == chain_id && s.n == step.n) {
            let skipped = next.skipped.remove(at).expect("position is in range");
            let mk = Zeroizing::new(array32(&skipped.mk)?);
            return Ok((next, mk));
        }

        // A chain we already know.
        if let Some(at) = next.recv.iter().position(|c| c.id == chain_id) {
            let mk = next.advance(at, step.n)?;
            return Ok((next, mk));
        }

        // A new epoch. Whatever the peer sent on their previous chain and we
        // have not seen yet is now final: keep those keys before moving on.
        if !next.recv.is_empty() {
            next.advance_to(0, step.pn)?;
        }

        let ours = next
            .ours
            .iter()
            .chain(offers.iter())
            .find(|k| k.id() == step.enc.to)
            .ok_or_else(|| {
                CoreError::DecryptFailed(
                    "this message was sealed to a key this device no longer holds — it can no longer be opened".into(),
                )
            })?
            .clone();
        let ss = decapsulate(&ours, &step.enc, &next.direction(&next.their_fp))?;
        let (rk, ck) = kdf_root(&next.rk, &*ss, &next.context());
        next.rk = rk.to_vec();
        next.recv.push_front(RecvChain { id: chain_id, ck: ck.to_vec(), n: 0 });
        next.recv.truncate(RECV_CHAINS);
        next.theirs = step.advertised.clone();
        next.our_turn = true;

        let mk = next.advance(0, step.n)?;
        Ok((next, mk))
    }

    /// Step receiving chain `at` to index `n`, keeping the keys it passes over.
    fn advance(&mut self, at: usize, n: u32) -> Result<Zeroizing<Key>> {
        if n < self.recv[at].n {
            return Err(CoreError::DecryptFailed(
                "this message was already opened, or arrived too late to open".into(),
            ));
        }
        self.advance_to(at, n)?;
        let chain = &mut self.recv[at];
        let (ck, mk) = kdf_chain(&chain.ck);
        chain.ck.zeroize();
        chain.ck = ck.to_vec();
        chain.n += 1;
        Ok(mk)
    }

    /// Derive and keep every key of chain `at` below index `n`.
    fn advance_to(&mut self, at: usize, n: u32) -> Result<()> {
        let gap = n.saturating_sub(self.recv[at].n) as usize;
        if gap > MAX_SKIPPED {
            return Err(CoreError::DecryptFailed(
                "too many messages in this conversation are missing to open this one".into(),
            ));
        }
        while self.recv[at].n < n {
            let chain = &mut self.recv[at];
            let (ck, mk) = kdf_chain(&chain.ck);
            self.skipped.push_back(Skipped { chain: chain.id.clone(), n: chain.n, mk: mk.to_vec() });
            chain.ck.zeroize();
            chain.ck = ck.to_vec();
            chain.n += 1;
        }
        while self.skipped.len() > MAX_SKIPPED {
            if let Some(mut oldest) = self.skipped.pop_front() {
                oldest.mk.zeroize();
            }
        }
        Ok(())
    }

    /// The same bytes on both sides: the session and both identities, ordered
    /// so neither side's view of "us" and "them" matters.
    fn context(&self) -> Vec<u8> {
        let (a, b) = if self.our_fp <= self.their_fp {
            (&self.our_fp, &self.their_fp)
        } else {
            (&self.their_fp, &self.our_fp)
        };
        [&self.id[..], a.as_bytes(), &b"|"[..], b.as_bytes()].concat()
    }

    /// The context plus who is sending, so an epoch A opened can never be
    /// mistaken for one B opened.
    fn direction(&self, sender_fp: &str) -> Vec<u8> {
        [self.context(), b">".to_vec(), sender_fp.as_bytes().to_vec()].concat()
    }
}

// ----------------------------------------------------------------- helpers --

fn digest(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn split(okm: &[u8; 2 * KEY_LEN]) -> (Zeroizing<Key>, Zeroizing<Key>) {
    let mut a = Zeroizing::new([0u8; KEY_LEN]);
    let mut b = Zeroizing::new([0u8; KEY_LEN]);
    a.copy_from_slice(&okm[..KEY_LEN]);
    b.copy_from_slice(&okm[KEY_LEN..]);
    (a, b)
}

fn array32(bytes: &[u8]) -> Result<[u8; 32]> {
    bytes.try_into().map_err(|_| malformed("expected a 32-byte key"))
}

fn malformed(message: &str) -> CoreError {
    CoreError::Malformed(message.into())
}

mod b64 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

// ------------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;
    use rand::thread_rng;

    const ALICE: &str = "AAAA";
    const BOB: &str = "BBBB";
    const DEVICE: &[u8] = &[9; 16];

    /// Alice has Bob's offer; Bob holds the offer keypair.
    fn pair() -> (Session, Vec<KeyPair>) {
        let mut rng = thread_rng();
        let bob_offer = KeyPair::generate(&mut rng);
        let alice = Session::initiate(&mut rng, ALICE, BOB, DEVICE, &bob_offer.public);
        (alice, vec![bob_offer])
    }

    /// Send one message from `from`, returning the new sender state, the step and key.
    fn send(from: &Session) -> (Session, Step, Zeroizing<Key>) {
        from.send(&mut thread_rng()).expect("send")
    }

    #[test]
    fn a_first_message_opens_a_session_and_both_sides_agree_on_the_key() {
        let (alice, offers) = pair();
        let (alice, step, sent) = send(&alice);
        let (bob, received) = Session::accept(BOB, ALICE, DEVICE, &offers, &step).expect("accept");
        assert_eq!(*sent, *received);
        assert_eq!(alice.id(), bob.id());
    }

    #[test]
    fn every_message_gets_a_different_key() {
        let (alice, offers) = pair();
        let (alice, s1, k1) = send(&alice);
        let (_, s2, k2) = send(&alice);
        assert_ne!(*k1, *k2);

        let (bob, r1) = Session::accept(BOB, ALICE, DEVICE, &offers, &s1).unwrap();
        let (_, r2) = bob.receive(&s2, &offers).unwrap();
        assert_eq!((*k1, *k2), (*r1, *r2));
    }

    #[test]
    fn replies_alternate_epochs_and_stay_in_step() {
        let (mut alice, offers) = pair();
        let (a, step, k) = send(&alice);
        alice = a;
        let (mut bob, r) = Session::accept(BOB, ALICE, DEVICE, &offers, &step).unwrap();
        assert_eq!(*k, *r);

        for _ in 0..5 {
            let (b, step, k) = send(&bob);
            bob = b;
            let (a, r) = alice.receive(&step, &[]).unwrap();
            alice = a;
            assert_eq!(*k, *r, "bob → alice");

            let (a, step, k) = send(&alice);
            alice = a;
            let (b, r) = bob.receive(&step, &offers).unwrap();
            bob = b;
            assert_eq!(*k, *r, "alice → bob");
        }
    }

    /// Email is not a conversation taken in turns. Both write before either
    /// reads, and each keeps sending on its current chain until it has read the
    /// other's newest epoch.
    #[test]
    fn both_sides_writing_at_once_does_not_desync() {
        let (alice, offers) = pair();
        let (alice, step, _) = send(&alice);
        let (bob, _) = Session::accept(BOB, ALICE, DEVICE, &offers, &step).unwrap();

        let (alice, a_step, a_key) = send(&alice);
        let (bob, b_step, b_key) = send(&bob);

        let (bob, r) = bob.receive(&a_step, &offers).unwrap();
        assert_eq!(*a_key, *r);
        let (alice, r) = alice.receive(&b_step, &[]).unwrap();
        assert_eq!(*b_key, *r);

        // And the conversation carries on from there.
        let (_, step, k) = send(&alice);
        let (_, r) = bob.receive(&step, &offers).unwrap();
        assert_eq!(*k, *r);
    }

    #[test]
    fn out_of_order_mail_still_opens() {
        let (alice, offers) = pair();
        let (alice, s0, k0) = send(&alice);
        let (alice, s1, k1) = send(&alice);
        let (_, s2, k2) = send(&alice);

        let (bob, r2) = Session::accept(BOB, ALICE, DEVICE, &offers, &s2).unwrap();
        let (bob, r0) = bob.receive(&s0, &offers).unwrap();
        let (_, r1) = bob.receive(&s1, &offers).unwrap();
        assert_eq!((*k0, *k1, *k2), (*r0, *r1, *r2));
    }

    #[test]
    fn a_late_message_from_a_previous_epoch_still_opens() {
        let (alice, offers) = pair();
        let (alice, s0, _) = send(&alice);
        let (alice, late, late_key) = send(&alice); // held up in transit
        let (bob, _) = Session::accept(BOB, ALICE, DEVICE, &offers, &s0).unwrap();

        let (bob, reply, _) = send(&bob);
        let (alice, _) = alice.receive(&reply, &[]).unwrap();
        let (_, next_epoch, _) = send(&alice);
        let (bob, _) = bob.receive(&next_epoch, &offers).unwrap();

        let (_, r) = bob.receive(&late, &offers).unwrap();
        assert_eq!(*late_key, *r);
    }

    /// The point of the whole module.
    #[test]
    fn a_key_once_used_cannot_be_derived_again_from_the_state_that_remains() {
        let (alice, offers) = pair();
        let (_, step, _) = send(&alice);
        let (bob, _) = Session::accept(BOB, ALICE, DEVICE, &offers, &step).unwrap();

        // Someone takes Bob's phone after he has read the message: the state on
        // it cannot reopen that message.
        assert!(bob.receive(&step, &offers).is_err());
    }

    #[test]
    fn stale_receiving_keys_are_deleted() {
        let (mut alice, offers) = pair();
        let (a, step, _) = send(&alice);
        alice = a;
        let (mut bob, _) = Session::accept(BOB, ALICE, DEVICE, &offers, &step).unwrap();

        // Alice's first receiving key, which Bob will encapsulate to.
        let first_key = alice.ours.back().unwrap().id();
        for _ in 0..(OUR_KEYPAIRS + 2) {
            let (b, step, _) = send(&bob);
            bob = b;
            alice = alice.receive(&step, &[]).unwrap().0;
            let (a, step, _) = send(&alice);
            alice = a;
            bob = bob.receive(&step, &offers).unwrap().0;
        }
        assert!(alice.ours.len() <= OUR_KEYPAIRS);
        assert!(alice.ours.iter().all(|k| k.id() != first_key), "an old receiving key survived");
    }

    #[test]
    fn a_gap_wider_than_the_cache_is_refused_not_precomputed() {
        let (mut alice, offers) = pair();
        let (a, first, _) = send(&alice);
        alice = a;
        let (bob, _) = Session::accept(BOB, ALICE, DEVICE, &offers, &first).unwrap();
        let mut far = None;
        for _ in 0..=(MAX_SKIPPED + 1) {
            let (a, step, _) = send(&alice);
            alice = a;
            far = Some(step);
        }
        assert!(bob.receive(&far.unwrap(), &offers).is_err());
    }

    #[test]
    fn an_offer_bob_does_not_hold_cannot_start_a_session() {
        let (alice, _) = pair();
        let (_, step, _) = send(&alice);
        let stranger = vec![KeyPair::generate(&mut thread_rng())];
        assert!(Session::accept(BOB, ALICE, DEVICE, &stranger, &step).is_err());
    }

    #[test]
    fn a_session_bound_to_other_identities_derives_a_different_key() {
        let (alice, offers) = pair();
        let (_, step, sent) = send(&alice);
        // Mallory relays the step to Bob claiming to be someone else.
        let (_, received) = Session::accept(BOB, "MMMM", DEVICE, &offers, &step).unwrap();
        assert_ne!(*sent, *received);
    }

    #[test]
    fn a_wrapped_key_opens_with_its_message_key_and_nothing_else() {
        let mut rng = thread_rng();
        let (alice, offers) = pair();
        let (_, step, mk) = send(&alice);
        let content = [7u8; KEY_LEN];

        let entry = Entry::seal(&mut rng, step, &*mk, ALICE, &content).unwrap();
        let bytes = encode_entries(std::slice::from_ref(&entry)).unwrap();
        let decoded = decode_entries(&bytes).unwrap();
        assert_eq!(decoded, vec![entry.clone()]);

        let (_, received) = Session::accept(BOB, ALICE, DEVICE, &offers, &decoded[0].step).unwrap();
        assert_eq!(*decoded[0].open(&*received, ALICE).unwrap(), content);
        assert!(decoded[0].open(&[0u8; KEY_LEN], ALICE).is_err(), "opened with the wrong key");
        assert!(decoded[0].open(&*received, "MMMM").is_err(), "opened as a different sender");
    }

    #[test]
    fn a_tampered_step_does_not_open() {
        let mut rng = thread_rng();
        let (alice, offers) = pair();
        let (_, step, mk) = send(&alice);
        let entry = Entry::seal(&mut rng, step, &*mk, ALICE, &[7u8; KEY_LEN]).unwrap();

        // Swap the advertised key for one Mallory controls. The step still
        // parses and Bob still derives the same message key — but the key it
        // carries is bound to the original step, so it refuses to open.
        let mut forged = entry.clone();
        forged.step.advertised = KeyPair::generate(&mut rng).public.clone();
        let (_, mk) = Session::accept(BOB, ALICE, DEVICE, &offers, &forged.step).unwrap();
        assert!(forged.open(&*mk, ALICE).is_err());
    }

    #[test]
    fn a_session_survives_a_round_trip_through_storage() {
        let (alice, offers) = pair();
        let (alice, _, _) = send(&alice);
        let restored: Session = serde_json::from_str(&serde_json::to_string(&alice).unwrap()).unwrap();
        let (_, step, k) = send(&restored);
        let (_, r) = Session::accept(BOB, ALICE, DEVICE, &offers, &step).unwrap();
        assert_eq!(*k, *r);
    }
}
