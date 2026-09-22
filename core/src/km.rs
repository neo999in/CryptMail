//! A simulated Key Manager (KM): the bank of symmetric "quantum" keys that
//! Levels 2 and 3 encrypt with.
//!
//! In a real QKD deployment each end has a KM, fed by a quantum link, and the
//! email client asks it for keys over the ETSI GS QKD 014 API: `enc_keys`
//! hands the sender fresh keys with their IDs, `dec_keys` hands the receiver
//! the same keys by ID. This module is that API, simulated inside the app:
//! `enc_keys` and `dec_keys` below have the standard's shape, so a client for a
//! real KM would replace this file and nothing that calls it.
//!
//! **It is a simulation, and gives no quantum security.** The keys come from
//! the operating system's random generator, not from a quantum channel. What it
//! demonstrates is the integration: a bank of 100 keys of 1 Kb each, keys
//! handed out once and deleted once used, and two ends that hold the same keys.
//!
//! # One login
//!
//! The KM account **is** the mailbox account: each signed-in address has its
//! own bank, and signing in to the mailbox is what opens it. There is no second
//! username or password to forget. The bank is sealed with AES-256-GCM under a
//! key derived from this install's Keystore passphrase and the address, so it
//! opens only on this phone and only for that mailbox; signing out of the
//! mailbox leaves nothing in the app that can ask for it.
//!
//! # Two ends
//!
//! Real KMs share keys because the quantum link produced them at both ends.
//! Here the "link" is a file: `export_link` seals this bank under a one-time
//! code, `import_link` adopts it on the other phone. The two banks then hold the
//! same keys, and each side encrypts only from its own half — ETSI's master and
//! slave roles — so the two never pick the same key, which would be fatal for
//! a one-time pad.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use rand::{thread_rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{recovery, CoreError, Result};

/// 1 Kb — 1024 bits — per key, as the baseline setup asks.
pub const KEY_BYTES: usize = 128;
/// Keys in a fresh bank.
pub const BANK_SIZE: usize = 100;
/// The key material one bank is made of, for whatever produces it.
pub const MATERIAL_BYTES: usize = BANK_SIZE * KEY_BYTES;

const LINK_BEGIN: &str = "-----BEGIN CRYPTMAIL KM LINK-----";
const LINK_END: &str = "-----END CRYPTMAIL KM LINK-----";

/// Which half of the bank this end encrypts from. `Solo` is a bank that has
/// never been linked: it encrypts from all of it, which is only ever read back
/// by this same phone (mail to yourself, and your Sent copy).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    Solo,
    Master,
    Slave,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum KeyState {
    Fresh,
    /// Handed to this end's sender by `enc_keys`; still readable once by `dec_keys`.
    Issued,
}

#[derive(Clone, Serialize, Deserialize)]
struct BankKey {
    id: String,
    #[serde(with = "hex_bytes")]
    key: Vec<u8>,
    state: KeyState,
}

#[derive(Serialize, Deserialize)]
struct Bank {
    sae_id: String,
    peer_sae_id: Option<String>,
    role: Role,
    keys: Vec<BankKey>,
    /// This bank has gone to another phone. It still opens mail — reading only
    /// deletes keys, and each phone deletes its own copy — but it never issues
    /// another, because two ends issuing from one half would reuse a pad.
    #[serde(default)]
    handed_over: bool,
    /// When it was handed over, in Unix seconds. Absent in a bank handed over
    /// before this was kept.
    #[serde(default)]
    handed_over_at: Option<i64>,
}

/// What the app may know about the KM. No key material, ever.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The mailbox this bank belongs to — the one login.
    pub account: String,
    pub sae_id: String,
    pub peer_sae_id: Option<String>,
    pub role: Role,
    /// Keys this end can still encrypt with.
    pub available: usize,
    /// Keys still in the bank, either half, not yet consumed.
    pub remaining: usize,
    pub bank_size: usize,
    pub key_bits: usize,
    /// Moved to another phone: it can still read, but not send.
    pub handed_over: bool,
}

/// One key as ETSI GS QKD 014 returns it: an ID, and the key itself.
pub struct QKey {
    pub id: String,
    pub key: Zeroizing<Vec<u8>>,
}

pub struct KeyManager {
    dir: PathBuf,
    account: String,
    key: Zeroizing<[u8; 32]>,
}

impl KeyManager {
    /// The KM for the signed-in mailbox `email`, its bank created on first use.
    pub fn for_account(core_dir: &Path, passphrase: &str, email: &str) -> Result<Self> {
        if passphrase.is_empty() {
            return Err(CoreError::Unavailable("refusing to keep a key bank without a passphrase".into()));
        }
        let account = email.trim().to_lowercase();
        if !account.contains('@') {
            return Err(CoreError::NoKey("km-signed-out: sign in to a mailbox to use the Key Manager".into()));
        }
        let dir = core_dir.join("km").join(hex::encode(&Sha256::digest(account.as_bytes())[..8]));
        fs::create_dir_all(&dir).map_err(io)?;
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(b"cryptmail/v1/km-bank"), passphrase.as_bytes())
            .expand(account.as_bytes(), &mut *key)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        let km = Self { dir, account, key };
        if !km.bank_path().exists() {
            km.write_bank(&fresh_bank(new_sae_id()))?;
        }
        Ok(km)
    }

    /// This end's identifier, as ETSI GS QKD 014 uses it.
    pub fn sae_id(&self) -> Result<String> {
        Ok(self.read_bank()?.sae_id)
    }

    /// Build the bank out of key material two ends arrived at together —
    /// `bb84.rs` — rather than by copying one bank to the other.
    ///
    /// Both ends run this on the same material and must land on the same key
    /// IDs, so the IDs are derived from the material too. The slot still rides
    /// in the last four hex digits, which is what keeps master's half and
    /// slave's apart once keys start being deleted.
    pub fn fill_from(&self, material: &[u8], role: Role, peer_sae_id: &str) -> Result<()> {
        if material.len() != MATERIAL_BYTES {
            return Err(CoreError::Malformed(format!(
                "a bank is {MATERIAL_BYTES} bytes of key material, not {}",
                material.len()
            )));
        }
        let ids = Hkdf::<Sha256>::new(Some(b"cryptmail/v1/bb84-key-ids"), material);
        let keys = (0..BANK_SIZE)
            .map(|slot| {
                let mut seed = [0u8; 14];
                ids.expand(&(slot as u32).to_be_bytes(), &mut seed)
                    .expect("14 bytes is a valid HKDF-SHA256 output length");
                BankKey {
                    id: id_from(&seed, slot),
                    key: material[slot * KEY_BYTES..(slot + 1) * KEY_BYTES].to_vec(),
                    state: KeyState::Fresh,
                }
            })
            .collect();
        let sae_id = self.read_bank()?.sae_id;
        self.write_bank(&Bank {
            sae_id,
            peer_sae_id: Some(peer_sae_id.to_string()),
            role,
            keys,
            handed_over: false,
            handed_over_at: None,
        })
    }

    /// Seal `plain` beside the bank under the same key, for a half-finished key
    /// exchange to be picked up when the other end answers.
    pub fn keep(&self, name: &str, plain: &[u8]) -> Result<()> {
        let sealed = seal(&self.key, name.as_bytes(), plain)?;
        fs::write(self.side_path(name), sealed).map_err(io)
    }

    /// Take back what `keep` put there, if it is still around.
    pub fn kept(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        match fs::read(self.side_path(name)) {
            Ok(sealed) => Ok(Some(Zeroizing::new(open(&self.key, name.as_bytes(), &sealed)?))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io(e)),
        }
    }

    pub fn forget(&self, name: &str) -> Result<()> {
        match fs::remove_file(self.side_path(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
            _ => Ok(()),
        }
    }

    fn side_path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.bin"))
    }

    pub fn status(&self) -> Result<Status> {
        let bank = self.read_bank()?;
        Ok(Status {
            account: self.account.clone(),
            sae_id: bank.sae_id.clone(),
            peer_sae_id: bank.peer_sae_id.clone(),
            role: bank.role,
            available: own_fresh(&bank).count(),
            remaining: bank.keys.len(),
            bank_size: BANK_SIZE,
            key_bits: KEY_BYTES * 8,
            handed_over: bank.handed_over,
        })
    }

    /// A new bank of 100, replacing this one. A linked bank must be linked again.
    pub fn regenerate(&self) -> Result<()> {
        let sae_id = self.read_bank()?.sae_id;
        self.write_bank(&fresh_bank(sae_id))
    }

    /// ETSI GS QKD 014 `enc_keys`: `number` fresh keys from this end's half,
    /// marked issued. Refuses rather than hand out fewer than asked.
    pub fn enc_keys(&self, number: usize) -> Result<(String, Vec<QKey>)> {
        let mut bank = self.read_bank()?;
        if bank.handed_over {
            return Err(CoreError::NoKey(
                "km-handed-over: this key bank was moved to another phone, which now sends with it".into(),
            ));
        }
        let picked: Vec<usize> = own_fresh(&bank).take(number).collect();
        if picked.len() < number {
            return Err(CoreError::NoKey(format!(
                "no-qkd-keys: this needs {number} quantum keys and the bank has {} left for sending",
                picked.len()
            )));
        }
        let mut out = Vec::with_capacity(number);
        for &i in &picked {
            bank.keys[i].state = KeyState::Issued;
            out.push(QKey { id: bank.keys[i].id.clone(), key: Zeroizing::new(bank.keys[i].key.clone()) });
        }
        // Persisted before the keys are used: a crash afterwards wastes them,
        // where the other order could hand the same key out twice.
        self.write_bank(&bank)?;
        Ok((bank.sae_id.clone(), out))
    }

    /// ETSI GS QKD 014 `dec_keys`: the keys with these IDs. They are **deleted**
    /// from the bank — a message opens once, and the app keeps its copy.
    pub fn dec_keys(&self, ids: &[String]) -> Result<Vec<QKey>> {
        let mut bank = self.read_bank()?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let found = bank.keys.iter().find(|k| &k.id == id).ok_or_else(|| {
                CoreError::DecryptFailed(
                    "a quantum key this message needs is not in this Key Manager — it was already used, or the banks are not linked".into(),
                )
            })?;
            out.push(QKey { id: id.clone(), key: Zeroizing::new(found.key.clone()) });
        }
        // Only once every key was found: a message that cannot open must not
        // cost the keys it could not use.
        bank.keys.retain(|k| !ids.contains(&k.id));
        self.write_bank(&bank)?;
        Ok(out)
    }

    /// Seal this bank for the other end under `code`, and become its master:
    /// from now on this end encrypts from the first half only.
    pub fn export_link(&self, code: &str) -> Result<String> {
        let code = link_code(code)?;
        let mut bank = self.read_bank()?;
        bank.role = Role::Master;
        let mut peer = Bank {
            sae_id: new_sae_id(),
            peer_sae_id: Some(bank.sae_id.clone()),
            role: Role::Slave,
            keys: bank.keys.clone(),
            handed_over: false,
            handed_over_at: None,
        };
        bank.peer_sae_id = Some(peer.sae_id.clone());
        // Keys this end already issued are its own; the other end never sends with them.
        for k in &mut peer.keys {
            k.state = KeyState::Fresh;
        }
        let plain = Zeroizing::new(serde_json::to_vec(&peer).map_err(json)?);
        let sealed = seal(&link_key(&code), b"cryptmail/v1/km-link", &plain)?;
        self.write_bank(&bank)?;
        let mut out = format!("{LINK_BEGIN}\nComment: simulated QKD link — useless without its code\n\n");
        for line in B64.encode(sealed).as_bytes().chunks(64) {
            out.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
            out.push('\n');
        }
        out.push_str(LINK_END);
        out.push('\n');
        Ok(out)
    }

    /// Adopt the other end's link, replacing this bank.
    pub fn import_link(&self, armored: &str, code: &str) -> Result<()> {
        let code = link_code(code).map_err(|_| wrong_link_code())?;
        let start = armored.find(LINK_BEGIN).ok_or_else(not_a_link)? + LINK_BEGIN.len();
        let end = armored[start..].find(LINK_END).ok_or_else(not_a_link)? + start;
        let body: String = armored[start..end]
            .lines()
            .filter(|l| !l.contains(':'))
            .flat_map(|l| l.chars().filter(|c| !c.is_whitespace()))
            .collect();
        let sealed = B64.decode(body).map_err(|_| not_a_link())?;
        let plain =
            Zeroizing::new(open(&link_key(&code), b"cryptmail/v1/km-link", &sealed).map_err(|_| wrong_link_code())?);
        let mut bank: Bank = serde_json::from_slice(&plain).map_err(|_| not_a_link())?;
        if bank.role != Role::Slave || bank.keys.iter().any(|k| k.key.len() != KEY_BYTES) {
            return Err(not_a_link());
        }
        bank.handed_over = false;
        bank.handed_over_at = None;
        self.write_bank(&bank)
    }

    // ------------------------------------------------- device transfer --
    //
    // A bank is state, not a key that can be re-derived, so a phone that leaves
    // it behind loses every quantum message it had not yet opened and its link
    // with the other end. It travels in the transfer file (`transfer.rs`),
    // moved rather than copied for the same reason the sessions are.

    /// This bank as plain JSON, for the transfer file to seal. `None` if this
    /// mailbox has no bank — nothing to carry.
    pub fn export_bank(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        if !self.bank_path().exists() {
            return Ok(None);
        }
        Ok(Some(Zeroizing::new(serde_json::to_vec(&self.read_bank()?).map_err(json)?)))
    }

    /// Would `adopt_bank` take this? Lets a caller find out before it changes
    /// anything else.
    pub fn check_bank(plain: &[u8]) -> Result<()> {
        let bank: Bank = serde_json::from_slice(plain).map_err(|_| damaged_bank())?;
        if bank.keys.iter().any(|k| k.key.len() != KEY_BYTES) {
            return Err(damaged_bank());
        }
        Ok(())
    }

    /// Adopt a bank from another phone, replacing whatever this mailbox held.
    /// It arrives ready to send: the phone it came from is the one that stopped.
    pub fn adopt_bank(&self, plain: &[u8]) -> Result<()> {
        Self::check_bank(plain)?;
        let mut bank: Bank = serde_json::from_slice(plain).map_err(|_| damaged_bank())?;
        bank.handed_over = false;
        bank.handed_over_at = None;
        self.write_bank(&bank)
    }

    /// Stop issuing keys: another phone sends with this bank now. Reading is
    /// untouched, so mail already on the way still opens here.
    pub fn hand_over(&self, now: i64) -> Result<()> {
        self.set_handed_over(Some(now))
    }

    /// When this bank went to another phone, if it did. `Some(0)` for a bank
    /// handed over before the time was kept.
    pub fn handed_over_at(&self) -> Result<Option<i64>> {
        if !self.bank_path().exists() {
            return Ok(None);
        }
        let bank = self.read_bank()?;
        Ok(bank.handed_over.then(|| bank.handed_over_at.unwrap_or(0)))
    }

    /// Take the bank back after a transfer that was never used.
    pub fn resume(&self) -> Result<()> {
        self.set_handed_over(None)
    }

    fn set_handed_over(&self, at: Option<i64>) -> Result<()> {
        if !self.bank_path().exists() {
            return Ok(());
        }
        let mut bank = self.read_bank()?;
        bank.handed_over = at.is_some();
        bank.handed_over_at = at;
        self.write_bank(&bank)
    }

    // ------------------------------------------------------------ plumbing --

    fn bank_path(&self) -> PathBuf {
        self.dir.join("bank.bin")
    }

    fn read_bank(&self) -> Result<Bank> {
        let bytes = fs::read(self.bank_path()).map_err(io)?;
        let plain = Zeroizing::new(open(&self.key, self.account.as_bytes(), &bytes)?);
        serde_json::from_slice(&plain).map_err(json)
    }

    fn write_bank(&self, bank: &Bank) -> Result<()> {
        let plain = Zeroizing::new(serde_json::to_vec(bank).map_err(json)?);
        let sealed = seal(&self.key, self.account.as_bytes(), &plain)?;
        let path = self.bank_path();
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, sealed).map_err(io)?;
        fs::rename(&tmp, &path).map_err(io)
    }
}

/// Fresh keys this end may encrypt with, in bank order.
fn own_fresh(bank: &Bank) -> impl Iterator<Item = usize> + '_ {
    let half = BANK_SIZE / 2;
    bank.keys.iter().enumerate().filter_map(move |(i, k)| {
        let slot = slot_of(&k.id);
        let mine = match bank.role {
            Role::Solo => true,
            Role::Master => slot < half,
            Role::Slave => slot >= half,
        };
        (mine && k.state == KeyState::Fresh).then_some(i)
    })
}

fn fresh_bank(sae_id: String) -> Bank {
    let keys: Vec<BankKey> = (0..BANK_SIZE)
        .map(|slot| BankKey { id: key_id(slot), key: random(KEY_BYTES), state: KeyState::Fresh })
        .collect();
    Bank { sae_id, peer_sae_id: None, role: Role::Solo, keys, handed_over: false, handed_over_at: None }
}

fn new_sae_id() -> String {
    format!("sae-{}", hex::encode(random(6)))
}

/// A UUID-shaped key ID, as ETSI GS QKD 014 uses, whose last four hex digits
/// record the key's slot in the original bank, so the halves survive keys
/// being deleted.
fn key_id(slot: usize) -> String {
    id_from(&random(14), slot)
}

/// A UUID-shaped ID from 14 bytes, with the slot in the last four digits.
fn id_from(seed: &[u8], slot: usize) -> String {
    let r = hex::encode(seed);
    format!("{}-{}-4{}-{}-{}{:04x}", &r[..8], &r[8..12], &r[12..15], &r[15..19], &r[19..27], slot)
}

fn slot_of(id: &str) -> usize {
    usize::from_str_radix(&id[id.len().saturating_sub(4)..], 16).unwrap_or(usize::MAX)
}

fn random(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    thread_rng().fill_bytes(&mut out);
    out
}

fn link_code(code: &str) -> Result<String> {
    let code = recovery::normalise(code);
    if code.len() < 26 {
        return Err(CoreError::Malformed("a link code is 32 characters".into()));
    }
    Ok(code)
}

fn link_key(code: &str) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(b"cryptmail/v1/km-link"), code.as_bytes())
        .expand(b"link key", &mut *key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let nonce = random(12);
    let sealed = Aes256Gcm::new_from_slice(key)
        .expect("32-byte key")
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| CoreError::Unavailable("could not seal the key bank".into()))?;
    Ok([nonce, sealed].concat())
}

fn open(key: &[u8; 32], aad: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 12 {
        return Err(damaged_bank());
    }
    let (nonce, sealed) = bytes.split_at(12);
    Aes256Gcm::new_from_slice(key)
        .expect("32-byte key")
        .decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad })
        .map_err(|_| damaged_bank())
}

fn damaged_bank() -> CoreError {
    CoreError::Unavailable("this Key Manager's bank is damaged or was sealed by another install".into())
}

fn wrong_link_code() -> CoreError {
    CoreError::DecryptFailed("that code does not open this Key Manager link".into())
}

fn not_a_link() -> CoreError {
    CoreError::Malformed("this is not a Key Manager link file, or it is damaged".into())
}

fn io(e: std::io::Error) -> CoreError {
    CoreError::Unavailable(format!("key manager storage: {e}"))
}

fn json(e: serde_json::Error) -> CoreError {
    CoreError::Unavailable(format!("key manager record: {e}"))
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

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cryptmail-km-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn km(name: &str, email: &str) -> KeyManager {
        KeyManager::for_account(&dir(name), "keystore passphrase", email).unwrap()
    }

    #[test]
    fn a_fresh_bank_is_100_keys_of_1_kb() {
        let km = km("fresh", "alice@example.com");
        let status = km.status().unwrap();
        assert_eq!((status.available, status.remaining, status.key_bits), (100, 100, 1024));
        let (_, keys) = km.enc_keys(3).unwrap();
        assert!(keys.iter().all(|k| k.key.len() == 128));
        assert_eq!(km.status().unwrap().available, 97);
    }

    #[test]
    fn each_mailbox_has_its_own_bank_and_no_mailbox_has_none() {
        let d = dir("accounts");
        let alice = KeyManager::for_account(&d, "pw", "Alice@Example.com").unwrap();
        let bob = KeyManager::for_account(&d, "pw", "bob@example.com").unwrap();
        assert_ne!(alice.status().unwrap().sae_id, bob.status().unwrap().sae_id);
        // The same mailbox, however it is spelled, is the same bank.
        let again = KeyManager::for_account(&d, "pw", "alice@example.com").unwrap();
        assert_eq!(again.status().unwrap().sae_id, alice.status().unwrap().sae_id);
        assert!(KeyManager::for_account(&d, "pw", "").is_err(), "a KM opened with nobody signed in");
        // Another install's passphrase cannot open it.
        assert!(KeyManager::for_account(&d, "other", "alice@example.com").unwrap().status().is_err());
    }

    #[test]
    fn a_key_is_issued_once_and_read_back_once() {
        let km = km("once", "alice@example.com");
        let (_, a) = km.enc_keys(1).unwrap();
        let (_, b) = km.enc_keys(1).unwrap();
        assert_ne!(a[0].id, b[0].id, "the same key went out twice");
        let back = km.dec_keys(&[a[0].id.clone()]).unwrap();
        assert_eq!(*back[0].key, *a[0].key);
        assert!(km.dec_keys(&[a[0].id.clone()]).is_err(), "a used key came back");
    }

    #[test]
    fn a_linked_pair_holds_the_same_keys_and_never_sends_with_the_same_one() {
        let (a, b) = (km("link-a", "alice@example.com"), km("link-b", "bob@example.com"));
        let code = "K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-1N8Q";
        let link = a.export_link(code).unwrap();
        assert!(b.import_link(&link, "0000-0000-0000-0000-0000-0000-0000-0000").is_err());
        b.import_link(&link, code).unwrap();

        assert_eq!(a.status().unwrap().available, 50);
        assert_eq!(b.status().unwrap().available, 50);

        let (_, from_a) = a.enc_keys(50).unwrap();
        let (_, from_b) = b.enc_keys(50).unwrap();
        for k in &from_a {
            assert!(from_b.iter().all(|o| o.id != k.id), "both ends sent with one key");
        }
        // B reads what A sent, by ID, and gets the same bytes.
        let ids: Vec<String> = from_a.iter().take(3).map(|k| k.id.clone()).collect();
        let got = b.dec_keys(&ids).unwrap();
        for (x, y) in got.iter().zip(&from_a) {
            assert_eq!(*x.key, *y.key);
        }
        assert!(a.enc_keys(1).is_err(), "the master's half ran past its end");
    }
}
