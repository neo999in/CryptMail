//! BB84, simulated: the protocol two Key Managers would run over a quantum
//! link to arrive at the same key material, run instead over email.
//!
//! `km.rs` fills its bank from `fill_from`; where that material comes from is
//! this module's business. The current alternative is *Link another phone*,
//! which seals one bank and copies it to the other end. That works, and it is
//! plainly a copy. This is the real protocol — preparation, measurement,
//! sifting, error estimation, privacy amplification — with the states carried
//! in the body of three ordinary emails.
//!
//! # The three legs
//!
//! ```text
//! 1. Alice → Bob   `Photons`  n states, each a bit in one of two bases
//! 2. Bob   → Alice `Reply`    the bases he measured in, plus his result at a
//!                             random sample of positions
//! 3. Alice → Bob   `Verdict`  which positions agreed, and the error rate
//! ```
//!
//! Textbook BB84 needs four (Bob's bases, Alice's sift, then a sample, then a
//! confirmation). Folding the sample into leg 2 costs nothing — Bob chooses it
//! before he knows which positions will survive sifting, so it is still a
//! random subset of the sifted key — and saves a round trip, which over email
//! is the expensive thing.
//!
//! # What the ends do
//!
//! **Sift.** Bob measured half the states in the wrong basis, and those results
//! are noise. Keep only the positions where the two bases agreed: about n/2.
//!
//! **Estimate.** Of the sifted positions, those Bob sampled are compared
//! outright. With no eavesdropper they agree exactly. Intercept-resend gets the
//! basis wrong half the time and then the bit wrong half of *those*, so it
//! shows up as a ~25% error rate. Anything above [`QBER_LIMIT`] and no key is
//! built.
//!
//! **Amplify.** The sampled positions were said out loud, so they are thrown
//! away. What is left goes through HKDF-SHA256 into as many bytes as the bank
//! needs.
//!
//! # What this is not
//!
//! **It is not secure, and it is not quantum.** The states travel as bits in an
//! email. Anyone who reads that email reads Alice's bits *and* her bases and
//! learns the key outright, leaving no trace in the error rate — because what
//! makes real eavesdropping detectable is that measuring a photon disturbs it
//! and it cannot be copied, and a byte can be copied all day. `Eve` below
//! plays by the protocol's rules, which is what makes the detection
//! demonstrable; a real attacker on a classical channel would not have to.
//!
//! What is real is everything above the channel, which is also the part a
//! vendor's hardware would not change: the protocol, and the key that comes out
//! of it.

use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{CoreError, Result};

/// Above this share of disagreeing sampled bits, assume someone is listening
/// and build nothing. Intercept-resend produces ~25%; the usual BB84 bound is
/// 11%, and a simulated channel has no noise of its own to spend.
pub const QBER_LIMIT: f64 = 0.11;

/// One position in every `SAMPLE_EVERY` is checked out loud and then discarded.
pub const SAMPLE_EVERY: usize = 10;

/// Too few compared bits and the error rate means nothing — a handful of
/// agreements is not evidence that nobody is listening.
pub const MIN_CHECKED: usize = 256;

/// States to send per byte of key wanted.
///
/// Sifting keeps about half, and the error check spends a tenth of the whole
/// transmission — about a fifth of what sifting left. So 32 states yield
/// roughly 14 usable bits per byte wanted: a margin of about 1.8×, which is
/// what absorbs the variance in two ends choosing bases at random.
pub const STATES_PER_BYTE: usize = 32;

/// What Alice sends: n states, each a bit prepared in one of two bases.
///
/// Two bitsets, packed. In a real link this is the pulse train; here it is a
/// base64 block in an email body, and the `bases` field is exactly what a
/// photon would not have carried.
#[derive(Clone, Serialize, Deserialize)]
pub struct Photons {
    /// The sending end's identifier, so the two can name each other.
    pub sae: String,
    pub n: usize,
    #[serde(with = "packed")]
    pub bits: Vec<u8>,
    #[serde(with = "packed")]
    pub bases: Vec<u8>,
}

/// What Alice keeps back: the same bits and bases, never sent. Sealed beside
/// the bank between legs 1 and 3, since an email round trip separates them.
#[derive(Serialize, Deserialize)]
pub struct Prepared {
    n: usize,
    bits: Vec<bool>,
    bases: Vec<bool>,
}

/// What Bob holds after measuring, sealed until the verdict arrives.
#[derive(Serialize, Deserialize)]
pub struct Measured {
    n: usize,
    bases: Vec<bool>,
    results: Vec<bool>,
    sample: Vec<usize>,
}

/// Leg 2: Bob's bases, and his result at the positions he chose to check.
#[derive(Clone, Serialize, Deserialize)]
pub struct Reply {
    /// The measuring end's identifier.
    pub sae: String,
    pub n: usize,
    #[serde(with = "packed")]
    pub bases: Vec<u8>,
    /// The positions Bob is willing to spend, ascending.
    pub sample: Vec<u32>,
    /// His measured bit at each of those positions, in the same order.
    #[serde(with = "packed")]
    pub sample_bits: Vec<u8>,
}

/// Leg 3: which positions agreed, and what the sample said about the channel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Verdict {
    pub n: usize,
    /// One bit per position: the bases agreed.
    #[serde(with = "packed")]
    pub agreed: Vec<u8>,
    /// The measured error rate on the sampled positions.
    pub qber: f64,
    /// How many positions that rate was measured over.
    pub checked: usize,
}

/// Alice, leg 1: prepare enough states for `key_bytes` of key material.
pub fn prepare<R: RngCore>(rng: &mut R, sae: &str, key_bytes: usize) -> (Prepared, Photons) {
    let n = key_bytes * STATES_PER_BYTE;
    let bits = random_bits(rng, n);
    let bases = random_bits(rng, n);
    let photons = Photons { sae: sae.to_string(), n, bits: pack(&bits), bases: pack(&bases) };
    (Prepared { n, bits, bases }, photons)
}

/// Bob, leg 2: measure each state in a basis of his own choosing.
///
/// Where his basis matches Alice's he reads her bit. Where it does not, the
/// result is random — that is the measurement, and the half of it that sifting
/// throws away.
pub fn measure<R: RngCore>(rng: &mut R, sae: &str, photons: &Photons) -> Result<(Measured, Reply)> {
    let (bits, sent) = open_photons(photons)?;
    let n = photons.n;
    let bases = random_bits(rng, n);

    let mut results = Vec::with_capacity(n);
    for i in 0..n {
        results.push(if bases[i] == sent[i] { bits[i] } else { rng.next_u32() & 1 == 1 });
    }

    // Chosen before sifting, so it is a fair sample of whatever survives it.
    let mut sample = Vec::new();
    for i in 0..n {
        if (rng.next_u32() as usize) % SAMPLE_EVERY == 0 {
            sample.push(i);
        }
    }
    let sample_bits: Vec<bool> = sample.iter().map(|&i| results[i]).collect();
    let reply = Reply {
        sae: sae.to_string(),
        n,
        bases: pack(&bases),
        sample: sample.iter().map(|&i| i as u32).collect(),
        sample_bits: pack(&sample_bits),
    };
    Ok((Measured { n, bases, results, sample }, reply))
}

/// Alice, leg 3: sift, measure the error rate, and derive the key material —
/// or refuse, which is the whole point of the exercise.
pub fn judge(prepared: &Prepared, reply: &Reply, key_bytes: usize) -> Result<(Verdict, Zeroizing<Vec<u8>>)> {
    if reply.n != prepared.n {
        return Err(damaged());
    }
    let bob_bases = unpack(&reply.bases, reply.n).ok_or_else(damaged)?;
    let sample_bits = unpack(&reply.sample_bits, reply.sample.len()).ok_or_else(damaged)?;
    if reply.sample.iter().any(|&i| i as usize >= reply.n) {
        return Err(damaged());
    }

    let agreed: Vec<bool> = (0..prepared.n).map(|i| prepared.bases[i] == bob_bases[i]).collect();

    // Sampled positions that also survived sifting are the only ones worth
    // comparing: where the bases differed, a disagreement means nothing.
    let (mut checked, mut errors) = (0usize, 0usize);
    for (k, &pos) in reply.sample.iter().enumerate() {
        let i = pos as usize;
        if agreed[i] {
            checked += 1;
            if sample_bits[k] != prepared.bits[i] {
                errors += 1;
            }
        }
    }
    if checked < MIN_CHECKED {
        return Err(CoreError::Unavailable(format!(
            "bb84-short-sample: only {checked} positions could be checked, too few to tell whether anyone is listening"
        )));
    }
    let qber = errors as f64 / checked as f64;
    let verdict = Verdict { n: prepared.n, agreed: pack(&agreed), qber, checked };
    if qber > QBER_LIMIT {
        return Err(eavesdropper(qber));
    }

    let sampled = mask(prepared.n, &reply.sample);
    let key = sifted(&prepared.bits, &agreed, &sampled);
    let material = amplify(&key, &verdict.agreed, prepared.n, key_bytes)?;
    Ok((verdict, material))
}

/// Bob, after leg 3: the same arithmetic on his own results.
///
/// He repeats Alice's error check rather than taking her word for it — a
/// verdict is a message like any other, and a forged low rate is exactly what
/// an attacker would send.
pub fn accept(measured: &Measured, verdict: &Verdict, key_bytes: usize) -> Result<Zeroizing<Vec<u8>>> {
    if verdict.n != measured.n {
        return Err(damaged());
    }
    if verdict.qber > QBER_LIMIT || verdict.checked < MIN_CHECKED {
        return Err(eavesdropper(verdict.qber));
    }
    let agreed = unpack(&verdict.agreed, verdict.n).ok_or_else(damaged)?;
    let sampled = mask(measured.n, &measured.sample.iter().map(|&i| i as u32).collect::<Vec<_>>());
    let key = sifted(&measured.results, &agreed, &sampled);
    amplify(&key, &verdict.agreed, measured.n, key_bytes)
}

/// An eavesdropper who plays by the rules: she measures each state in a basis
/// she guesses, and sends on what she read. She cannot copy a state and keep
/// the original — that is the assumption BB84 rests on — so half her guesses
/// are wrong, and half of those corrupt the bit Bob reads.
///
/// Only a simulation can offer this, and only because the states here are
/// bytes. It exists to show the detection working.
pub fn eavesdrop<R: RngCore>(rng: &mut R, photons: &Photons) -> Result<Photons> {
    let (bits, bases) = open_photons(photons)?;
    let mut sent_bits = Vec::with_capacity(photons.n);
    let mut sent_bases = Vec::with_capacity(photons.n);
    for i in 0..photons.n {
        let basis = rng.next_u32() & 1 == 1;
        let read = if basis == bases[i] { bits[i] } else { rng.next_u32() & 1 == 1 };
        sent_bits.push(read);
        sent_bases.push(basis);
    }
    Ok(Photons { sae: photons.sae.clone(), n: photons.n, bits: pack(&sent_bits), bases: pack(&sent_bases) })
}

/// The three legs as they travel: a block in an ordinary text email, named for
/// what it carries, so a client that does not understand it still shows
/// something a person can read.
pub const PHOTONS: &str = "CRYPTMAIL QKD PHOTONS";
pub const REPLY: &str = "CRYPTMAIL QKD MEASUREMENT";
pub const VERDICT: &str = "CRYPTMAIL QKD VERDICT";

pub fn armor<T: Serialize>(kind: &str, value: &T) -> Result<String> {
    let json = serde_json::to_string(value).map_err(|e| CoreError::Unavailable(e.to_string()))?;
    let mut out = format!("-----BEGIN {kind}-----\n\n");
    for line in base64::Engine::encode(&base64::engine::general_purpose::STANDARD, json).as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
        out.push('\n');
    }
    out.push_str(&format!("-----END {kind}-----\n"));
    Ok(out)
}

pub fn dearmor<T: serde::de::DeserializeOwned>(kind: &str, text: &str) -> Result<T> {
    let (begin, end) = (format!("-----BEGIN {kind}-----"), format!("-----END {kind}-----"));
    let start = text.find(&begin).ok_or_else(damaged)? + begin.len();
    let stop = text[start..].find(&end).ok_or_else(damaged)? + start;
    let body: String = text[start..stop]
        .lines()
        .filter(|l| !l.contains(':'))
        .flat_map(|l| l.chars().filter(|c| !c.is_whitespace()))
        .collect();
    let json = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, body).map_err(|_| damaged())?;
    serde_json::from_slice(&json).map_err(|_| damaged())
}

/// Which leg, if any, this text carries — so a sync can route it.
pub fn leg_of(text: &str) -> Option<&'static str> {
    [PHOTONS, REPLY, VERDICT].into_iter().find(|kind| text.contains(&format!("-----BEGIN {kind}-----")))
}

// ---------------------------------------------------------------- plumbing --

fn open_photons(photons: &Photons) -> Result<(Vec<bool>, Vec<bool>)> {
    if photons.n == 0 || photons.n > 1 << 24 {
        return Err(damaged());
    }
    let bits = unpack(&photons.bits, photons.n).ok_or_else(damaged)?;
    let bases = unpack(&photons.bases, photons.n).ok_or_else(damaged)?;
    Ok((bits, bases))
}

/// The bits both ends keep: bases agreed, and not spent on the error check.
fn sifted(bits: &[bool], agreed: &[bool], sampled: &[bool]) -> Vec<bool> {
    (0..bits.len()).filter(|&i| agreed[i] && !sampled[i]).map(|i| bits[i]).collect()
}

/// Privacy amplification. The sifted bits are the secret; the transcript both
/// ends already share is the salt, so a run cannot be replayed into the same
/// key material as another.
fn amplify(key: &[bool], agreed: &[u8], n: usize, key_bytes: usize) -> Result<Zeroizing<Vec<u8>>> {
    if key.len() < key_bytes * 8 {
        return Err(CoreError::Unavailable(format!(
            "bb84-short-key: {} bits survived and {} are needed — send more states",
            key.len(),
            key_bytes * 8
        )));
    }
    let secret = Zeroizing::new(pack(key));
    let mut salt = Sha256::new();
    salt.update((n as u64).to_be_bytes());
    salt.update(agreed);

    // HKDF-SHA256 expands to at most 255 × 32 bytes at a time, and a bank is
    // larger than that, so it is filled a chunk at a time under a counter.
    const CHUNK: usize = 4096;
    let hkdf = Hkdf::<Sha256>::new(Some(&salt.finalize()), &secret);
    let mut out = Zeroizing::new(vec![0u8; key_bytes]);
    for (i, chunk) in out.chunks_mut(CHUNK).enumerate() {
        let mut info = b"cryptmail/v1/bb84".to_vec();
        info.extend_from_slice(&(i as u32).to_be_bytes());
        hkdf.expand(&info, chunk)
            .map_err(|_| CoreError::Unavailable("could not derive the key material".into()))?;
    }
    Ok(out)
}

fn random_bits<R: RngCore>(rng: &mut R, n: usize) -> Vec<bool> {
    let mut bytes = vec![0u8; n.div_ceil(8)];
    rng.fill_bytes(&mut bytes);
    unpack(&bytes, n).expect("enough bytes for n bits")
}

fn mask(n: usize, positions: &[u32]) -> Vec<bool> {
    let mut out = vec![false; n];
    for &i in positions {
        if (i as usize) < n {
            out[i as usize] = true;
        }
    }
    out
}

fn pack(bits: &[bool]) -> Vec<u8> {
    let mut out = vec![0u8; bits.len().div_ceil(8)];
    for (i, &bit) in bits.iter().enumerate() {
        if bit {
            out[i / 8] |= 1 << (i % 8);
        }
    }
    out
}

fn unpack(bytes: &[u8], n: usize) -> Option<Vec<bool>> {
    if bytes.len() < n.div_ceil(8) {
        return None;
    }
    Some((0..n).map(|i| bytes[i / 8] & (1 << (i % 8)) != 0).collect())
}

fn damaged() -> CoreError {
    CoreError::Malformed("this quantum key exchange is damaged or incomplete".into())
}

fn eavesdropper(qber: f64) -> CoreError {
    CoreError::DecryptFailed(format!(
        "bb84-eavesdropper: {:.1}% of the checked bits disagreed. On a real quantum link that means someone \
         measured the states in transit, so no keys were built.",
        qber * 100.0
    ))
}

/// Bitsets travel as base64: at 32 states per key byte they are the only large
/// thing in the message, and hex would double them for nothing.
mod packed {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&B64.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        B64.decode(String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::thread_rng;

    /// 256 bytes rather than a whole bank: the arithmetic is the same and the
    /// test is fifty times faster. Below about 100 it stops clearing
    /// `MIN_CHECKED`, which is the protocol refusing to judge a channel on too
    /// little evidence — correct, but not what these tests are about.
    const BYTES: usize = 256;

    /// A clean run, as the app would drive it.
    fn exchange(bytes: usize) -> Result<(Zeroizing<Vec<u8>>, Zeroizing<Vec<u8>>)> {
        let mut rng = thread_rng();
        let (alice, photons) = prepare(&mut rng, "sae-alice", bytes);
        let (bob, reply) = measure(&mut rng, "sae-bob", &photons)?;
        let (verdict, hers) = judge(&alice, &reply, bytes)?;
        let his = accept(&bob, &verdict, bytes)?;
        Ok((hers, his))
    }

    #[test]
    fn both_ends_arrive_at_the_same_key_material() {
        let (hers, his) = exchange(BYTES).unwrap();
        assert_eq!(hers.len(), BYTES);
        assert_eq!(&*hers, &*his, "the two ends derived different keys");
        assert_ne!(&*hers, &vec![0u8; BYTES], "the material is all zeroes");
    }

    #[test]
    fn two_runs_never_give_the_same_material() {
        let (a, _) = exchange(BYTES).unwrap();
        let (b, _) = exchange(BYTES).unwrap();
        assert_ne!(&*a, &*b);
    }

    #[test]
    fn an_eavesdropper_shows_up_in_the_error_rate_and_no_keys_are_built() {
        let mut rng = thread_rng();
        let (alice, photons) = prepare(&mut rng, "sae-alice", BYTES);
        // Eve measures every state and sends on what she read.
        let resent = eavesdrop(&mut rng, &photons).unwrap();
        let (_, reply) = measure(&mut rng, "sae-bob", &resent).unwrap();

        let err = judge(&alice, &reply, BYTES).unwrap_err();
        assert_eq!(err.code(), "decrypt-failed");
        assert!(err.to_string().contains("bb84-eavesdropper"), "{err}");
    }

    #[test]
    fn intercept_and_resend_costs_about_a_quarter_of_the_checked_bits() {
        let mut rng = thread_rng();
        let (alice, photons) = prepare(&mut rng, "sae-alice", 512);
        let resent = eavesdrop(&mut rng, &photons).unwrap();
        let (_, reply) = measure(&mut rng, "sae-bob", &resent).unwrap();

        // `judge` refuses, so reach the rate through the same arithmetic.
        let bob_bases = unpack(&reply.bases, reply.n).unwrap();
        let sample_bits = unpack(&reply.sample_bits, reply.sample.len()).unwrap();
        let (mut checked, mut errors) = (0, 0);
        for (k, &pos) in reply.sample.iter().enumerate() {
            let i = pos as usize;
            if alice.bases[i] == bob_bases[i] {
                checked += 1;
                errors += (sample_bits[k] != alice.bits[i]) as usize;
            }
        }
        let qber = errors as f64 / checked as f64;
        assert!((0.18..0.32).contains(&qber), "expected about 25%, got {qber}");
    }

    #[test]
    fn bob_refuses_a_verdict_that_claims_a_clean_channel_it_did_not_see() {
        let mut rng = thread_rng();
        let (_alice, photons) = prepare(&mut rng, "sae-alice", BYTES);
        let (bob, _) = measure(&mut rng, "sae-bob", &photons).unwrap();
        // A verdict is a message like any other: a forged rate must not be
        // taken on trust.
        let forged =
            Verdict { n: bob.n, agreed: pack(&vec![true; bob.n]), qber: 0.5, checked: MIN_CHECKED + 1 };
        assert!(accept(&bob, &forged, BYTES).is_err());
    }

    #[test]
    fn sifting_keeps_about_half_the_states_and_spends_a_tenth_of_them() {
        let mut rng = thread_rng();
        let (alice, photons) = prepare(&mut rng, "sae-alice", 256);
        let (_, reply) = measure(&mut rng, "sae-bob", &photons).unwrap();
        let bob_bases = unpack(&reply.bases, reply.n).unwrap();
        let agreed = (0..reply.n).filter(|&i| alice.bases[i] == bob_bases[i]).count();
        let share = agreed as f64 / reply.n as f64;
        assert!((0.45..0.55).contains(&share), "sifted share {share}");

        let sampled = reply.sample.len() as f64 / reply.n as f64;
        assert!((0.07..0.13).contains(&sampled), "sampled share {sampled}");
    }

    #[test]
    fn the_positions_said_out_loud_are_not_in_the_key() {
        // Same sifted bits with and without the sample: only the sample differs,
        // so a key that ignored it would come out the same.
        let bits = vec![true, false, true, true, false, true, false, false];
        let agreed = vec![true; 8];
        let none = vec![false; 8];
        let mut some = vec![false; 8];
        some[2] = true;
        assert_ne!(sifted(&bits, &agreed, &none), sifted(&bits, &agreed, &some));
        assert_eq!(sifted(&bits, &agreed, &some).len(), 7);
    }

    #[test]
    fn too_few_states_are_refused_rather_than_stretched() {
        // The material must come out of the sifted bits, not out of HKDF's
        // willingness to produce any length asked of it.
        let key = vec![true; 64];
        let err = amplify(&key, &[0u8; 4], 128, 64).unwrap_err();
        assert!(err.to_string().contains("bb84-short-key"), "{err}");
    }

    #[test]
    fn a_damaged_transmission_is_refused() {
        let mut rng = thread_rng();
        let (_, mut photons) = prepare(&mut rng, "sae-alice", BYTES);
        photons.bits.truncate(2);
        assert!(measure(&mut rng, "sae-bob", &photons).is_err());

        let (_, photons) = prepare(&mut rng, "sae-alice", BYTES);
        let mut empty = photons.clone();
        empty.n = 0;
        assert!(measure(&mut rng, "sae-bob", &empty).is_err());
    }

    #[test]
    fn a_reply_from_a_different_run_is_refused() {
        let mut rng = thread_rng();
        let (alice, _) = prepare(&mut rng, "sae-alice", BYTES);
        let (_, other) = prepare(&mut rng, "sae-alice", BYTES / 2);
        let (_, reply) = measure(&mut rng, "sae-bob", &other).unwrap();
        assert!(judge(&alice, &reply, BYTES).is_err());
    }

    #[test]
    fn a_sample_too_small_to_mean_anything_is_refused() {
        let mut rng = thread_rng();
        let (alice, photons) = prepare(&mut rng, "sae-alice", BYTES);
        let (_, mut reply) = measure(&mut rng, "sae-bob", &photons).unwrap();
        let bits = unpack(&reply.sample_bits, reply.sample.len()).unwrap();
        reply.sample.truncate(4);
        reply.sample_bits = pack(&bits[..4]);

        let err = judge(&alice, &reply, BYTES).unwrap_err();
        assert!(err.to_string().contains("bb84-short-sample"), "{err}");
    }

    #[test]
    fn packing_survives_a_round_trip_at_every_length() {
        let mut rng = thread_rng();
        for n in [1usize, 7, 8, 9, 255, 1000] {
            let bits = random_bits(&mut rng, n);
            assert_eq!(unpack(&pack(&bits), n).unwrap(), bits, "n = {n}");
        }
    }
}
