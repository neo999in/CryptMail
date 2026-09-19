//! Where sessions live between messages.
//!
//! Beside the identity file, under a `sessions/` directory, one file per
//! record, each sealed with AES-256-GCM under a key derived from the same
//! Keystore-held passphrase that locks the secret key. The passphrase is 32
//! random bytes, never a human secret, so HKDF is the right derivation — an
//! Argon2 pass per write would cost ~64 MiB and a noticeable pause on every
//! message sent, and buy nothing against a key that was never guessable.
//!
//! Three kinds of record:
//!
//! - **this device** — a random device id and its offer keypairs, which any
//!   contact may encapsulate to in order to open a session with it;
//! - **sessions** — one per (contact, contact's device);
//! - **contacts' offers** — the newest verified offer from each of their devices.
//!
//! None of this may be backed up or synced (see `docs/`): a restored session
//! rewinds and re-derives keys it already used. Android auto-backup is already
//! off for the whole app (`allowBackup: false`), which is what keeps it out.
//!
//! The one sanctioned way out is device transfer (`transfer.rs`), which
//! *moves* the whole store: the phone it leaves is marked handed over, and from
//! then on it never sends by session. Receiving is deterministic, so the two
//! copies stay in step for as long as only one of them writes.
//!
//! Filenames are hashes, and each record's name is its AEAD associated data, so
//! a file copied over another's name does not open.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand::{CryptoRng, RngCore};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::session::{KeyPair, PublicBundle, Session};
use crate::{CoreError, Result};

/// How long an offer keypair is handed out before a fresh one replaces it.
/// A contact who opens a session against an offer is protected from the moment
/// that offer's secret half is deleted, so this bounds how long the *first*
/// message of a conversation stays openable by someone who seizes the device.
const OFFER_LIFETIME_SECS: i64 = 30 * 24 * 60 * 60;
/// Offer keypairs kept: the current one and the one it replaced, so a first
/// message that was in flight across a rotation still opens.
const OFFERS_KEPT: usize = 2;

#[derive(Clone, Serialize, Deserialize)]
pub struct OfferKey {
    pub keypair: KeyPair,
    pub created: i64,
}

/// This device, as the rest of the world sees it.
#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    #[serde(with = "hex_bytes")]
    pub id: Vec<u8>,
    /// Newest first.
    pub offers: Vec<OfferKey>,
}

impl Device {
    pub fn current_offer(&self) -> &OfferKey {
        self.offers.first().expect("a device always holds at least one offer")
    }

    pub fn offer_keypairs(&self) -> Vec<KeyPair> {
        self.offers.iter().map(|o| o.keypair.clone()).collect()
    }
}

/// A contact's device, and the key to encapsulate to when opening a session
/// with it. Only ever stored after its signature checked out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerOffer {
    pub fingerprint: String,
    #[serde(with = "hex_bytes")]
    pub device: Vec<u8>,
    pub bundle: PublicBundle,
    pub created: i64,
}

pub struct SessionStore {
    dir: PathBuf,
    key: Zeroizing<[u8; 32]>,
}

impl SessionStore {
    pub fn open(core_dir: &Path, passphrase: &str) -> Result<Self> {
        if passphrase.is_empty() {
            return Err(CoreError::Unavailable("refusing to store sessions without a passphrase".into()));
        }
        let dir = core_dir.join("sessions");
        fs::create_dir_all(&dir).map_err(io)?;
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(b"cryptmail/v1/session-store"), passphrase.as_bytes())
            .expand(b"store key", &mut *key)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        Ok(Self { dir, key })
    }

    /// This device's record as it stands — never created, never rotated. What a
    /// handed-over phone reads with: rotating there would fork the offers the
    /// new phone carries on from.
    pub fn existing_device(&self) -> Result<Option<Device>> {
        self.read("device")
    }

    /// This device's record, created on first use, with its offer rotated when
    /// it has been handed out long enough.
    pub fn device<R: RngCore + CryptoRng>(&self, rng: &mut R, now: i64) -> Result<Device> {
        let mut device = match self.read::<Device>("device")? {
            Some(device) => device,
            None => {
                let mut id = vec![0u8; 16];
                rng.fill_bytes(&mut id);
                Device { id, offers: Vec::new() }
            }
        };
        let stale = device.offers.first().map_or(true, |o| now - o.created >= OFFER_LIFETIME_SECS);
        if stale {
            device.offers.insert(0, OfferKey { keypair: KeyPair::generate(rng), created: now });
            device.offers.truncate(OFFERS_KEPT);
            self.write("device", &device)?;
        }
        Ok(device)
    }

    pub fn session(&self, id: &[u8]) -> Result<Option<Session>> {
        self.read(&session_name(id))
    }

    /// Every session with any of this contact's devices.
    pub fn sessions_with(&self, fingerprint: &str) -> Result<Vec<Session>> {
        let mut found = Vec::new();
        for name in self.names("session-")? {
            if let Some(session) = self.read::<Session>(&name)? {
                if session.their_fingerprint() == fingerprint {
                    found.push(session);
                }
            }
        }
        Ok(found)
    }

    pub fn save_session(&self, session: &Session) -> Result<()> {
        self.write(&session_name(session.id()), session)
    }

    pub fn peer_offers(&self, fingerprint: &str) -> Result<Vec<PeerOffer>> {
        let mut found = Vec::new();
        for name in self.names("peer-")? {
            if let Some(offer) = self.read::<PeerOffer>(&name)? {
                if offer.fingerprint == fingerprint {
                    found.push(offer);
                }
            }
        }
        Ok(found)
    }

    /// Keep a contact's offer unless we already hold a newer one for that device.
    pub fn save_peer_offer(&self, offer: &PeerOffer) -> Result<()> {
        let name = format!("peer-{}", short_hash(&[offer.fingerprint.as_bytes(), &offer.device]));
        if let Some(existing) = self.read::<PeerOffer>(&name)? {
            if existing.created >= offer.created {
                return Ok(());
            }
        }
        self.write(&name, offer)
    }

    // ------------------------------------------------------------ transfer --

    /// When this store was handed to another phone, if it was.
    pub fn handed_over(&self) -> Result<Option<i64>> {
        Ok(self.read::<HandedOver>(HANDED_OVER)?.map(|h| h.at))
    }

    /// Mark the store handed over. From then on `seal` sends the old way, and
    /// `open` reads without creating or rotating anything.
    pub fn hand_over(&self, now: i64) -> Result<()> {
        self.write(HANDED_OVER, &HandedOver { at: now })
    }

    /// Take the store back. Only safe if the phone it went to never sent by
    /// session — the caller says so to the user.
    pub fn resume(&self) -> Result<()> {
        match fs::remove_file(self.path(HANDED_OVER)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
            _ => Ok(()),
        }
    }

    /// Every record but the handed-over mark, opened, as `(name, JSON)`. The
    /// caller seals them for the journey: they hold secret keys.
    pub fn export_records(&self) -> Result<Vec<(String, Zeroizing<Vec<u8>>)>> {
        let mut records = Vec::new();
        for name in self.names("")? {
            if name == HANDED_OVER {
                continue;
            }
            if let Some(plain) = self.read_raw(&name)? {
                records.push((name, plain));
            }
        }
        records.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(records)
    }

    /// Replace everything this store holds with records from another phone,
    /// resealed under this install's key.
    ///
    /// Every record is checked before anything is removed, so a damaged
    /// transfer leaves the store as it was.
    pub fn replace_records(&self, records: &[(String, Vec<u8>)]) -> Result<()> {
        self.check_records(records)?;
        for name in self.names("")? {
            fs::remove_file(self.path(&name)).map_err(io)?;
        }
        for (name, plain) in records {
            self.write_raw(name, plain)?;
        }
        Ok(())
    }

    /// Would `replace_records` take these? Lets a caller find out before it
    /// changes anything else.
    pub fn check_records(&self, records: &[(String, Vec<u8>)]) -> Result<()> {
        for (name, plain) in records {
            let known = name == "device" || name.starts_with("session-") || name.starts_with("peer-");
            if !known || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(CoreError::Malformed(format!("a transfer carried an unknown record ({name})")));
            }
            if serde_json::from_slice::<serde_json::Value>(plain).is_err() {
                return Err(CoreError::Malformed(format!("a transfer carried a damaged record ({name})")));
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ plumbing --

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.bin"))
    }

    fn names(&self, prefix: &str) -> Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.dir).map_err(io)? {
            let file = entry.map_err(io)?.file_name();
            let file = file.to_string_lossy();
            if let Some(name) = file.strip_suffix(".bin") {
                if name.starts_with(prefix) {
                    names.push(name.to_string());
                }
            }
        }
        Ok(names)
    }

    fn read<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        match self.read_raw(name)? {
            Some(plain) => serde_json::from_slice(&plain).map(Some).map_err(|_| corrupt(name)),
            None => Ok(None),
        }
    }

    fn read_raw(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let bytes = match fs::read(self.path(name)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io(e)),
        };
        if bytes.len() < 12 {
            return Err(corrupt(name));
        }
        let (nonce, sealed) = bytes.split_at(12);
        let plain = Aes256Gcm::new_from_slice(&*self.key)
            .expect("the store key is 32 bytes")
            .decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad: name.as_bytes() })
            .map_err(|_| corrupt(name))?;
        Ok(Some(Zeroizing::new(plain)))
    }

    /// Seal and write, replacing the file in one rename, so a crash leaves the
    /// old record or the new one — never half of either.
    fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let plain = Zeroizing::new(
            serde_json::to_vec(value).map_err(|e| CoreError::Unavailable(e.to_string()))?,
        );
        self.write_raw(name, &plain)
    }

    fn write_raw(&self, name: &str, plain: &[u8]) -> Result<()> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let sealed = Aes256Gcm::new_from_slice(&*self.key)
            .expect("the store key is 32 bytes")
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: name.as_bytes() })
            .map_err(|_| CoreError::Unavailable("could not seal a session record".into()))?;

        let path = self.path(name);
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, [&nonce[..], &sealed[..]].concat()).map_err(io)?;
        fs::rename(&tmp, &path).map_err(io)
    }
}

const HANDED_OVER: &str = "handed-over";

#[derive(Serialize, Deserialize)]
struct HandedOver {
    at: i64,
}

fn session_name(id: &[u8]) -> String {
    format!("session-{}", short_hash(&[id]))
}

fn short_hash(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part);
    }
    hex::encode(&hasher.finalize()[..12])
}

fn io(e: std::io::Error) -> CoreError {
    CoreError::Unavailable(format!("session storage: {e}"))
}

fn corrupt(name: &str) -> CoreError {
    CoreError::Unavailable(format!("a stored session record ({name}) is corrupt or was sealed by another install"))
}

mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        hex::decode(String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::thread_rng;

    fn store(name: &str) -> (SessionStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("cryptmail-session-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        (SessionStore::open(&dir, "passphrase").unwrap(), dir)
    }

    #[test]
    fn a_device_is_created_once_and_keeps_its_id() {
        let (store, _) = store("device");
        let a = store.device(&mut thread_rng(), 1_000).unwrap();
        let b = store.device(&mut thread_rng(), 2_000).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.current_offer().keypair.id(), b.current_offer().keypair.id());
    }

    #[test]
    fn offers_rotate_and_only_the_last_two_are_kept() {
        let (store, _) = store("rotate");
        let first = store.device(&mut thread_rng(), 0).unwrap().current_offer().keypair.id();
        let second = store.device(&mut thread_rng(), OFFER_LIFETIME_SECS).unwrap();
        assert_ne!(second.current_offer().keypair.id(), first);
        assert_eq!(second.offers.len(), 2);
        let third = store.device(&mut thread_rng(), 2 * OFFER_LIFETIME_SECS).unwrap();
        assert!(third.offers.iter().all(|o| o.keypair.id() != first), "a retired offer survived");
    }

    #[test]
    fn records_are_sealed_on_disk() {
        let (store, dir) = store("sealed");
        let device = store.device(&mut thread_rng(), 0).unwrap();
        let raw = fs::read(dir.join("sessions").join("device.bin")).unwrap();
        let id_hex = hex::encode(&device.id);
        assert!(!String::from_utf8_lossy(&raw).contains(&id_hex), "device record stored in the clear");
    }

    #[test]
    fn a_record_does_not_open_under_another_install_s_passphrase() {
        let (store, dir) = store("other-install");
        store.device(&mut thread_rng(), 0).unwrap();
        let other = SessionStore::open(&dir, "a different passphrase").unwrap();
        assert!(other.device(&mut thread_rng(), 0).is_err());
    }

    #[test]
    fn records_move_to_another_install_and_open_under_its_key() {
        let (from, _) = store("export-from");
        let device = from.device(&mut thread_rng(), 0).unwrap();
        from.hand_over(5).unwrap();
        let records: Vec<_> = from.export_records().unwrap().into_iter().map(|(n, p)| (n, p.to_vec())).collect();
        assert_eq!(records.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["device"], "the mark travelled");

        let (_, dir) = store("export-to");
        let to = SessionStore::open(&dir, "another install").unwrap();
        to.device(&mut thread_rng(), 0).unwrap();
        to.replace_records(&records).unwrap();
        assert_eq!(to.existing_device().unwrap().unwrap().id, device.id);
        assert_eq!(to.handed_over().unwrap(), None);
    }

    #[test]
    fn a_transfer_with_an_unknown_record_changes_nothing() {
        let (store, _) = store("bad-import");
        let device = store.device(&mut thread_rng(), 0).unwrap();
        for bad in ["../identity", "handed-over", "session-a.b"] {
            assert!(store.replace_records(&[(bad.into(), b"{}".to_vec())]).is_err(), "{bad} accepted");
        }
        assert!(store.replace_records(&[("device".into(), b"not json".to_vec())]).is_err());
        assert_eq!(store.existing_device().unwrap().unwrap().id, device.id);
    }

    #[test]
    fn handing_over_and_resuming() {
        let (store, _) = store("hand-over");
        assert_eq!(store.handed_over().unwrap(), None);
        store.hand_over(42).unwrap();
        assert_eq!(store.handed_over().unwrap(), Some(42));
        store.resume().unwrap();
        store.resume().unwrap();
        assert_eq!(store.handed_over().unwrap(), None);
    }

    #[test]
    fn an_older_offer_does_not_replace_a_newer_one() {
        let (store, _) = store("peer-offer");
        let bundle = KeyPair::generate(&mut thread_rng()).public.clone();
        let newer = PeerOffer { fingerprint: "BOB".into(), device: vec![1; 16], bundle: bundle.clone(), created: 20 };
        let older = PeerOffer { created: 10, ..newer.clone() };
        store.save_peer_offer(&newer).unwrap();
        store.save_peer_offer(&older).unwrap();
        assert_eq!(store.peer_offers("BOB").unwrap(), vec![newer]);
        assert!(store.peer_offers("CAROL").unwrap().is_empty());
    }
}
