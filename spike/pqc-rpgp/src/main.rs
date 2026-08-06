//! PQ.1 — does rPGP actually implement RFC 9980?
//!
//! Generates both staging options from docs/post-quantum.md, encrypts and
//! decrypts with each, and prints the armored sizes the Autocrypt argument
//! depends on.
//!
//!   Stage 1  Ed25519 primary            + ML-KEM-768/X25519 subkey
//!   Stage 2  ML-DSA-65+Ed25519 primary  + ML-KEM-768/X25519 subkey
//!
//! Run with `cargo run`. Requires the `draft-pqc` feature (see Cargo.toml) and
//! V6 keys — RFC 9980 permits ML-KEM-768+X25519 on v4 encryption subkeys, but
//! rPGP 0.20 exposes it through the V6 path.

use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType, Message, MessageBuilder, SecretKeyParamsBuilder,
    SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::aead::{AeadAlgorithm, ChunkSize};
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::types::{KeyDetails, KeyVersion, Password};
use rand::thread_rng;
use smallvec::smallvec;

const PLAINTEXT: &[u8] = b"Hey Bob, are we still on for lunch Friday at noon?";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("PQ.1 — RFC 9980 support in rPGP 0.20\n");

    let s1 = stage("Stage 1", KeyType::Ed25519, HashAlgorithm::Sha256)?;
    let s2 = stage("Stage 2", KeyType::MlDsa65Ed25519, HashAlgorithm::Sha3_256)?;

    println!("\n{:<9} {:<26} {:>11} {:>11}", "", "primary", "cert bytes", "msg bytes");
    for (name, primary, cert, msg) in [&s1, &s2] {
        println!("{name:<9} {primary:<26} {cert:>11} {msg:>11}");
    }
    println!(
        "\nStage 2 certificate is {:.1}x larger — why signatures are staged second.",
        s2.2 as f64 / s1.2 as f64
    );
    Ok(())
}

/// Build a keypair with `primary` for signing and an ML-KEM-768+X25519 subkey
/// for encryption, then round-trip a message through it.
fn stage(
    name: &'static str,
    primary: KeyType,
    hash: HashAlgorithm,
) -> Result<(&'static str, String, usize, usize), Box<dyn std::error::Error>> {
    let mut rng = thread_rng();

    let params = SecretKeyParamsBuilder::default()
        .version(KeyVersion::V6)
        .key_type(primary)
        .can_certify(true)
        .can_sign(true)
        .primary_user_id("Alice <alice@example.com>".into())
        .preferred_symmetric_algorithms(smallvec![SymmetricKeyAlgorithm::AES256])
        .preferred_hash_algorithms(smallvec![hash])
        .subkey(
            SubkeyParamsBuilder::default()
                .version(KeyVersion::V6)
                .key_type(KeyType::MlKem768X25519)
                .can_encrypt(EncryptionCaps::All)
                .build()?,
        )
        .build()?;

    let skey = params.generate(&mut rng)?;
    skey.verify_bindings()?;

    let primary_alg = format!("{:?}", KeyDetails::algorithm(&skey.primary_key));
    let subkey_alg = format!("{:?}", KeyDetails::algorithm(&skey.secret_subkeys[0].key));
    println!("{name}: {primary_alg} primary / {subkey_alg} subkey");

    let cert = skey.to_public_key();
    let cert_armor = cert.to_armored_string(None.into())?;

    // Sign with the primary, encrypt to the ML-KEM subkey.
    let mut builder = MessageBuilder::from_bytes("", PLAINTEXT).seipd_v2(
        &mut rng,
        SymmetricKeyAlgorithm::AES256,
        AeadAlgorithm::Ocb,
        ChunkSize::default(),
    );
    builder.sign(&skey.primary_key, Password::empty(), hash);
    builder.encrypt_to_key(&mut rng, &cert.public_subkeys[0])?;
    let msg_armor = builder.to_armored_string(&mut rng, Default::default())?;

    let (parsed, _) = Message::from_armor(msg_armor.as_bytes())?;
    let mut decrypted = parsed.decrypt(&Password::empty(), &skey)?;
    assert_eq!(decrypted.as_data_vec()?, PLAINTEXT, "{name}: round-trip mismatch");

    // A serialised key must survive a re-parse, or it cannot be stored.
    let (reparsed, _) = SignedSecretKey::from_string(&skey.to_armored_string(None.into())?)?;
    reparsed.verify_bindings()?;

    println!("  encrypt / decrypt / re-parse: OK");
    Ok((name, primary_alg, cert_armor.len(), msg_armor.len()))
}
