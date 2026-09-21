//! CryptMail crypto core.
//!
//! Implements the crypto half of the `CryptCore` contract in
//! `app/src/core/types.ts`. **MIME assembly deliberately lives in TypeScript**
//! (`app/src/core/mime.ts`), which already implements `docs/message-format.md`
//! and is covered by tests — reimplementing it here would duplicate the one
//! piece of the envelope that is fiddly and already correct. This crate does
//! only what must not happen in JavaScript: hold the private key and perform
//! the operations that use it.
//!
//! # Invariants
//!
//! 1. **A private key never appears in a return value.** Every public function
//!    returns either a `String` (armored public material or ciphertext) or a
//!    JSON document containing no secret material. This is exit criterion 4 of
//!    `docs/prototype-plan.md`, and the reason a native core exists at all.
//! 2. **Secret keys are encrypted at rest**, S2K-protected with a passphrase the
//!    caller supplies. On Android that passphrase comes from the Keystore; in
//!    tests it is supplied directly.
//! 3. **Algorithms are Stage 1 of `docs/post-quantum.md`**: an Ed25519 primary
//!    with an ML-KEM-768 + X25519 encryption subkey (RFC 9980). Post-quantum
//!    confidentiality, classical signatures — see that document for why the two
//!    are staged apart.

use std::path::{Path, PathBuf};

// Emits the UniFFI scaffolding into the cdylib. Without this the `.so` carries
// no UniFFI metadata and `uniffi-bindgen generate --library` has nothing to
// read, however correct the Rust looks.
uniffi::setup_scaffolding!();

mod bb84;
mod ffi;
mod forward;
mod identity;
mod keys;
mod km;
mod message;
mod qkd;
mod recovery;
pub mod session;
mod session_store;
mod transfer;

pub use ffi::{CryptMailCore, FfiError};
pub use identity::Identity;
pub use keys::PublicKeyInfo;
pub use forward::{Opened, Sealed};
pub use message::Decrypted;

/// Everything that can go wrong, mapped onto the `CoreError` codes the
/// TypeScript side already understands (`app/src/core/types.ts`).
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("no key: {0}")]
    NoKey(String),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("decrypt-failed: {0}")]
    DecryptFailed(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
}

impl CoreError {
    /// The `code` field of the TypeScript `CoreError`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoKey(_) => "no-key",
            Self::Malformed(_) => "malformed",
            Self::DecryptFailed(_) => "decrypt-failed",
            Self::Unavailable(_) => "unavailable",
        }
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

/// The core, bound to a directory holding this device's encrypted secret keys.
///
/// On Android that directory is app-private storage and the passphrase is
/// Keystore-wrapped; the crate itself is platform-agnostic so it can be tested
/// headlessly (M1 of `docs/prototype-plan.md`).
pub struct Core {
    dir: PathBuf,
}

impl Core {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self { dir: dir.as_ref().to_path_buf() }
    }

    /// Generate this device's identity and store the secret key encrypted.
    /// Returns the public half as JSON — never the secret key.
    pub fn generate_identity(&self, email: &str, passphrase: &str) -> Result<String> {
        let identity = identity::generate(&self.dir, email, passphrase)?;
        json(&identity)
    }

    /// The identity created on a previous run, or `Ok(None)` on a fresh install.
    pub fn load_identity(&self, email: &str) -> Result<Option<String>> {
        match identity::load_public(&self.dir, email)? {
            Some(identity) => Ok(Some(json(&identity)?)),
            None => Ok(None),
        }
    }

    /// Parse and validate an armored public key. Errors if it is not usable.
    pub fn import_public_key(&self, armored: &str) -> Result<String> {
        json(&keys::import(armored)?)
    }

    /// Sign with this device's key and encrypt to every recipient.
    ///
    /// `recipient_keys` are armored public keys; the caller is responsible for
    /// including the sender's own key so the message stays readable in Sent.
    /// Returns an armored OpenPGP message for the TypeScript side to wrap in a
    /// PGP/MIME envelope.
    pub fn encrypt_sign(
        &self,
        email: &str,
        passphrase: &str,
        plaintext: &str,
        recipient_keys: &[String],
    ) -> Result<String> {
        if recipient_keys.is_empty() {
            return Err(CoreError::NoKey("no recipient keys supplied".into()));
        }
        let secret = identity::load_secret(&self.dir, email)?;
        message::encrypt_sign(&secret, passphrase, plaintext, recipient_keys)
    }

    /// Decrypt an armored OpenPGP message and report the signature state.
    pub fn decrypt_verify(
        &self,
        email: &str,
        passphrase: &str,
        armored: &str,
        sender_keys: &[String],
    ) -> Result<String> {
        let secret = identity::load_secret(&self.dir, email)?;
        json(&message::decrypt_verify(&secret, passphrase, armored, sender_keys)?)
    }

    /// Sign and encrypt with a new, destroyable key per email. Refuses
    /// (`no-key`, message starting `no-session:`) unless every recipient can
    /// take one — there is no long-term-key fallback. Returns
    /// `{ armored, forwardSecret }`, where `forwardSecret` is always true.
    ///
    /// Unlike `encrypt_sign`, the caller should **not** include the sender's own
    /// key: a forward-secret message must not be openable by any long-term key,
    /// ours included. The app keeps its own sealed copy of what it sent.
    pub fn seal(
        &self,
        email: &str,
        passphrase: &str,
        plaintext: &str,
        recipient_keys: &[String],
    ) -> Result<String> {
        if recipient_keys.is_empty() {
            return Err(CoreError::NoKey("no recipient keys supplied".into()));
        }
        let secret = identity::load_secret(&self.dir, email)?;
        let store = session_store::SessionStore::open(&self.dir, passphrase)?;
        json(&forward::seal(&store, &secret, passphrase, plaintext, recipient_keys, now())?)
    }

    /// A contentless first-contact message carrying this device's offer, sealed
    /// to long-term keys. `plaintext` is fixed by the caller and must hold
    /// nothing the user wrote. Returns the armored message.
    pub fn handshake(&self, email: &str, passphrase: &str, plaintext: &str, recipient_keys: &[String]) -> Result<String> {
        let secret = identity::load_secret(&self.dir, email)?;
        let store = session_store::SessionStore::open(&self.dir, passphrase)?;
        forward::handshake(&store, &secret, passphrase, plaintext, recipient_keys, now())
    }

    /// JSON array, one entry per key in order: `"self"`, `"session"`, `"offer"`
    /// or `"none"`.
    pub fn session_status(&self, email: &str, passphrase: &str, recipient_keys: &[String]) -> Result<String> {
        let secret = identity::load_secret(&self.dir, email)?;
        let store = session_store::SessionStore::open(&self.dir, passphrase)?;
        json(&forward::session_status(&store, &secret, recipient_keys)?)
    }

    /// Open a message sealed either way. Returns the `decrypt_verify` document
    /// plus `forwardSecret`.
    pub fn open(
        &self,
        email: &str,
        passphrase: &str,
        armored: &str,
        sender_keys: &[String],
    ) -> Result<String> {
        let secret = identity::load_secret(&self.dir, email)?;
        let store = session_store::SessionStore::open(&self.dir, passphrase)?;
        json(&forward::open(&store, &secret, passphrase, armored, sender_keys, now())?)
    }

    /// Wrap this device's secret key under a recovery code the user holds.
    ///
    /// The code is generated in TypeScript (`app/src/core/recoveryCode.ts`) and
    /// passed in, so there is only ever one implementation of the alphabet.
    /// Returns an armored OpenPGP secret key — opaque to the caller, and the
    /// only form in which secret material may leave this crate.
    pub fn export_recovery_backup(&self, email: &str, passphrase: &str, code: &str) -> Result<String> {
        recovery::export(&self.dir, email, passphrase, code)
    }

    /// Adopt an identity from a backup. Returns the public identity as JSON.
    ///
    /// Whatever key this device held is replaced — on a fresh device that is the
    /// throwaway identity generated at sign-in, which nothing was ever sent to.
    pub fn import_recovery_backup(&self, passphrase: &str, blob: &str, code: &str) -> Result<String> {
        json(&recovery::import(&self.dir, passphrase, blob, code)?)
    }

    /// Seal this phone's identity, conversations, key bank and `archive` for
    /// another phone under `code`, and hand the conversations and the bank
    /// over: from now on this phone reads but does not send with either.
    /// Returns the armored transfer file.
    ///
    /// `archive` is the app's own, opaque here. The code is generated by the app
    /// (`app/src/core/recoveryCode.ts`), as a recovery code is.
    pub fn export_transfer(&self, email: &str, passphrase: &str, code: &str, archive: &str) -> Result<String> {
        transfer::export(&self.dir, email, passphrase, code, archive, now())
    }

    /// Adopt a transfer, replacing this phone's identity, conversations and
    /// key bank.
    /// Returns `{ identity, archive }`. A non-empty `expected_email` refuses a
    /// transfer for any other address before anything is changed.
    pub fn import_transfer(&self, passphrase: &str, armored: &str, code: &str, expected_email: &str) -> Result<String> {
        json(&transfer::import(&self.dir, passphrase, armored, code, expected_email)?)
    }

    /// `{ handedOverAt }`: when this phone's conversations went to another, in
    /// Unix seconds, or null.
    pub fn transfer_status(&self, passphrase: &str) -> Result<String> {
        let at = session_store::SessionStore::open(&self.dir, passphrase)?.handed_over()?;
        Ok(serde_json::json!({ "handedOverAt": at }).to_string())
    }

    /// Take the conversations back — and the key bank with them — after a
    /// transfer that was never used. Only safe if the other phone never sent by
    /// session or with a quantum key; the app says so first.
    pub fn resume_sessions(&self, passphrase: &str) -> Result<()> {
        session_store::SessionStore::open(&self.dir, passphrase)?.resume()?;
        if let Some(email) = identity::stored_email(&self.dir)? {
            km::KeyManager::for_account(&self.dir, passphrase, &email)?.resume()?;
        }
        Ok(())
    }

    // ------------------------------------------------ Key Manager (Levels 2–3) --
    //
    // One login: the KM account is the mailbox account. Every call names the
    // signed-in address, whose bank is created on first use (`km.rs`).

    /// `{ account, saeId, peerSaeId, role, available, remaining, bankSize,
    /// keyBits, handedOver }` — never a key.
    pub fn km_status(&self, passphrase: &str, email: &str) -> Result<String> {
        json(&km::KeyManager::for_account(&self.dir, passphrase, email)?.status()?)
    }

    /// A new bank of 100 keys. A linked bank has to be linked again.
    pub fn km_regenerate(&self, passphrase: &str, email: &str) -> Result<String> {
        km::KeyManager::for_account(&self.dir, passphrase, email)?.regenerate()?;
        self.km_status(passphrase, email)
    }

    /// The simulated QKD link: this bank, sealed under `code`, for the other end.
    pub fn km_export_link(&self, passphrase: &str, email: &str, code: &str) -> Result<String> {
        km::KeyManager::for_account(&self.dir, passphrase, email)?.export_link(code)
    }

    pub fn km_import_link(&self, passphrase: &str, email: &str, armored: &str, code: &str) -> Result<String> {
        km::KeyManager::for_account(&self.dir, passphrase, email)?.import_link(armored, code)?;
        self.km_status(passphrase, email)
    }

    // ------------------------------------------- BB84 over email (`bb84.rs`) --
    //
    // Three legs, each an armored block in an ordinary email, and each one a
    // step of the protocol rather than a copy of a bank. Between legs the
    // half-finished exchange is sealed beside the bank, because an email round
    // trip separates them.

    /// Leg 1, the sender: the states, for the other phone to measure.
    pub fn bb84_begin(&self, passphrase: &str, email: &str) -> Result<String> {
        let km = km::KeyManager::for_account(&self.dir, passphrase, email)?;
        let (prepared, photons) = bb84::prepare(&mut rand::thread_rng(), &km.sae_id()?, km::MATERIAL_BYTES);
        km.keep(PREPARED, &serde_json::to_vec(&prepared).map_err(|e| CoreError::Unavailable(e.to_string()))?)?;
        bb84::armor(bb84::PHOTONS, &photons)
    }

    /// Leg 2, the receiver: measure them, and answer with the bases and a
    /// sample. Nothing is built yet — the channel has not been judged.
    pub fn bb84_measure(&self, passphrase: &str, email: &str, armored: &str) -> Result<String> {
        let km = km::KeyManager::for_account(&self.dir, passphrase, email)?;
        let photons: bb84::Photons = bb84::dearmor(bb84::PHOTONS, armored)?;
        let (measured, reply) = bb84::measure(&mut rand::thread_rng(), &km.sae_id()?, &photons)?;
        km.keep(
            MEASURED,
            &serde_json::to_vec(&(&measured, &photons.sae)).map_err(|e| CoreError::Unavailable(e.to_string()))?,
        )?;
        bb84::armor(bb84::REPLY, &reply)
    }

    /// Leg 3, the sender: sift, judge the channel, and — if it was clean —
    /// build this end's half of the bank as master. Returns the verdict to
    /// send back. A rate above the limit builds nothing and says so.
    pub fn bb84_judge(&self, passphrase: &str, email: &str, armored: &str) -> Result<String> {
        let km = km::KeyManager::for_account(&self.dir, passphrase, email)?;
        let kept = km.kept(PREPARED)?.ok_or_else(|| {
            CoreError::Unavailable("bb84-no-exchange: this phone has no key exchange waiting for an answer".into())
        })?;
        let prepared: bb84::Prepared =
            serde_json::from_slice(&kept).map_err(|e| CoreError::Malformed(e.to_string()))?;
        let reply: bb84::Reply = bb84::dearmor(bb84::REPLY, armored)?;

        let (verdict, material) = bb84::judge(&prepared, &reply, km::MATERIAL_BYTES).inspect_err(|_| {
            // A judged exchange is spent either way: the sample was said out
            // loud, so it must not be judged a second time into a key.
            let _ = km.forget(PREPARED);
        })?;
        km.fill_from(&material, km::Role::Master, &reply.sae)?;
        km.forget(PREPARED)?;
        bb84::armor(bb84::VERDICT, &verdict)
    }

    /// After leg 3, the receiver: check the verdict against what it measured
    /// itself, and build the other half of the bank as slave. Returns the KM
    /// status.
    pub fn bb84_accept(&self, passphrase: &str, email: &str, armored: &str) -> Result<String> {
        let km = km::KeyManager::for_account(&self.dir, passphrase, email)?;
        let kept = km.kept(MEASURED)?.ok_or_else(|| {
            CoreError::Unavailable("bb84-no-exchange: this phone measured no states this verdict could be about".into())
        })?;
        let (measured, peer_sae): (bb84::Measured, String) =
            serde_json::from_slice(&kept).map_err(|e| CoreError::Malformed(e.to_string()))?;
        let verdict: bb84::Verdict = bb84::dearmor(bb84::VERDICT, armored)?;

        let material = bb84::accept(&measured, &verdict, km::MATERIAL_BYTES).inspect_err(|_| {
            let _ = km.forget(MEASURED);
        })?;
        km.fill_from(&material, km::Role::Slave, &peer_sae)?;
        km.forget(MEASURED)?;
        self.km_status(passphrase, email)
    }

    /// **Demonstration only.** Stand between the two phones as an eavesdropper
    /// who plays by the protocol's rules: measure every state in a guessed
    /// basis and send on what was read. Half the guesses are wrong, so about a
    /// quarter of the checked bits disagree and `bb84_judge` refuses.
    ///
    /// A real attacker reading this channel would not have to do any of that —
    /// the states are bytes in an email and copy freely. This exists to show
    /// the detection working, which is the one thing a real quantum link buys.
    pub fn bb84_eavesdrop(&self, armored: &str) -> Result<String> {
        let photons: bb84::Photons = bb84::dearmor(bb84::PHOTONS, armored)?;
        bb84::armor(bb84::PHOTONS, &bb84::eavesdrop(&mut rand::thread_rng(), &photons)?)
    }

    /// Which leg of a key exchange this text carries, if any: `"photons"`,
    /// `"measurement"`, `"verdict"`, or null. Lets a sync route a message
    /// without parsing it.
    pub fn bb84_leg(&self, text: &str) -> Option<String> {
        bb84::leg_of(text).map(|kind| match kind {
            bb84::PHOTONS => "photons".to_string(),
            bb84::REPLY => "measurement".to_string(),
            _ => "verdict".to_string(),
        })
    }

    /// Level 2 (quantum-aided AES) or 3 (one-time pad). Returns the armored block.
    pub fn qkd_seal(&self, passphrase: &str, email: &str, level: u8, plaintext: &str) -> Result<String> {
        qkd::seal(&km::KeyManager::for_account(&self.dir, passphrase, email)?, level, plaintext)
    }

    /// `{ plaintext, level, senderSae }`. The keys are deleted from the bank.
    pub fn qkd_open(&self, passphrase: &str, email: &str, armored: &str) -> Result<String> {
        json(&qkd::open(&km::KeyManager::for_account(&self.dir, passphrase, email)?, armored)?)
    }

    /// The address of the identity this device holds, if any. Used by the FFI
    /// layer, which cannot learn it from an incoming envelope.
    pub fn stored_identity_email(&self) -> Result<Option<String>> {
        identity::stored_email(&self.dir)
    }
}

/// Names for the half-finished exchange, sealed beside the bank.
const PREPARED: &str = "exchange-sent";
const MEASURED: &str = "exchange-measured";

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|e| CoreError::Unavailable(e.to_string()))
}
