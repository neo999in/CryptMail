//! The independent end of the interop harness: Sequoia-PGP.
//!
//! Genuinely independent of rPGP — different authors, different parser,
//! different primitives — which is the only reason this test is worth
//! anything. Mirrors `rpgp-side`'s CLI so `interop.sh` can drive either.
//!
//! Certificates it generates have the same Stage 1 shape as `cryptmail-core`:
//! Ed25519 primary, ML-KEM-768+X25519 encryption subkey, RFC 9580 profile
//! (which is what makes the key v6, as RFC 9980 requires).

use std::io::Write;
use std::process::exit;

use sequoia_openpgp as openpgp;

use openpgp::cert::prelude::*;
use openpgp::crypto::SessionKey;
use openpgp::parse::{stream::*, Parse};
use openpgp::policy::{Policy, StandardPolicy};
use openpgp::serialize::stream::*;
use openpgp::serialize::SerializeInto;
use openpgp::types::{KeyFlags, PublicKeyAlgorithmSpecification, SymmetricAlgorithm};
use openpgp::{Cert, KeyHandle, Profile};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let result = match args.get(1).map(String::as_str) {
        // gen <secret-out> <email> [no-signing-subkey] → armored public cert
        //
        // The optional third argument exists to isolate one specific interop
        // failure: most OpenPGP clients sign with a *signing subkey*, but a
        // verifier that only ever checks the primary key still passes when the
        // sender happens to sign with its primary. Being able to generate both
        // shapes is what turns "it failed" into "it failed *because of this*".
        Some("gen") => gen(&args[2], &args[3], args.get(4).map(String::as_str) != Some("no-signing-subkey")),
        // encrypt <secret> <recipient-cert> <plaintext-file> → armored message
        Some("encrypt") => encrypt(&args[2], &args[3], &args[4]),
        // decrypt <secret> <sender-cert> <message-file> → JSON {plaintext, signature}
        Some("decrypt") => decrypt(&args[2], &args[3], &args[4]),
        // inspect <cert> → JSON describing the algorithms, as a *foreign* parser sees them
        Some("inspect") => inspect(&args[2]),
        _ => {
            eprintln!("usage: sequoia-side <gen|encrypt|decrypt|inspect> ...");
            exit(2);
        }
    };

    match result {
        Ok(out) => println!("{out}"),
        Err(e) => {
            eprintln!("sequoia-side: {e}");
            exit(1);
        }
    }
}

fn policy() -> StandardPolicy<'static> {
    StandardPolicy::new()
}

fn gen(secret_out: &str, email: &str, signing_subkey: bool) -> Result<String, String> {
    let mut builder = CertBuilder::new()
        .set_profile(Profile::RFC9580)
        .map_err(|e| e.to_string())?
        .add_userid(email)
        // Stated explicitly rather than leaning on a cipher-suite default, so
        // this stays the Stage 1 shape if sequoia's defaults ever move.
        .set_signing_algorithm(PublicKeyAlgorithmSpecification::ed25519())
        .set_encryption_algorithm(PublicKeyAlgorithmSpecification::mlkem768_x25519())
        .add_transport_encryption_subkey();

    if signing_subkey {
        builder = builder.add_signing_subkey();
    } else {
        // Sequoia's primary is certification-only by default; make it able to
        // sign data so this variant has a usable signing key at all.
        builder = builder
            .set_primary_key_flags(KeyFlags::empty().set_certification().set_signing());
    }

    let (cert, _revocation) = builder.generate().map_err(|e| e.to_string())?;

    let secret = cert.as_tsk().armored().to_vec().map_err(|e| e.to_string())?;
    std::fs::write(secret_out, secret).map_err(|e| e.to_string())?;

    armor(&cert)
}

/// What a foreign parser makes of a certificate. Run against a
/// `cryptmail-core` cert, this is the cheapest interop check there is: if the
/// algorithm IDs disagree, every recipient rejects our key.
fn inspect(cert_path: &str) -> Result<String, String> {
    let cert = load_cert(cert_path)?;
    let policy = policy();

    let encryption: Vec<String> = cert
        .keys()
        .with_policy(&policy, None)
        .for_transport_encryption()
        .map(|k| format!("{:?}", k.key().pk_algo()))
        .collect();

    Ok(serde_json::json!({
        "primary": format!("{:?}", cert.primary_key().key().pk_algo()),
        "primaryVersion": cert.primary_key().key().version(),
        "encryptionSubkeys": encryption,
        "fingerprint": cert.fingerprint().to_hex(),
    })
    .to_string())
}

fn encrypt(secret: &str, recipient_cert: &str, plaintext: &str) -> Result<String, String> {
    let signer_cert = load_cert(secret)?;
    let recipient = load_cert(recipient_cert)?;
    let body = std::fs::read(plaintext).map_err(|e| e.to_string())?;
    let policy = policy();

    let recipients = recipient
        .keys()
        .with_policy(&policy, None)
        .supported()
        .alive()
        .revoked(false)
        .for_transport_encryption();

    let signing_key = signer_cert
        .keys()
        .with_policy(&policy, None)
        .secret()
        .for_signing()
        .next()
        .ok_or("the signing certificate has no usable signing key")?
        .key()
        .clone()
        .into_keypair()
        .map_err(|e| e.to_string())?;

    let mut sink = Vec::new();
    {
        let message = Armorer::new(Message::new(&mut sink)).build().map_err(|e| e.to_string())?;
        let message =
            Encryptor::for_recipients(message, recipients).build().map_err(|e| e.to_string())?;
        let message = Signer::new(message, signing_key)
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?;
        let mut message = LiteralWriter::new(message).build().map_err(|e| e.to_string())?;
        message.write_all(&body).map_err(|e| e.to_string())?;
        message.finalize().map_err(|e| e.to_string())?;
    }

    String::from_utf8(sink).map_err(|e| e.to_string())
}

fn decrypt(secret: &str, sender_cert: &str, message: &str) -> Result<String, String> {
    let secret_cert = load_cert(secret)?;
    let sender = load_cert(sender_cert)?;
    let ciphertext = std::fs::read(message).map_err(|e| e.to_string())?;
    let policy = policy();

    let helper =
        Helper { secret: &secret_cert, policy: &policy, senders: vec![sender], verified: false };

    let mut decryptor = DecryptorBuilder::from_bytes(&ciphertext)
        .map_err(|e| e.to_string())?
        .with_policy(&policy, None, helper)
        .map_err(|e| format!("could not start decrypting: {e}"))?;

    let mut plaintext = Vec::new();
    std::io::copy(&mut decryptor, &mut plaintext).map_err(|e| format!("decrypt failed: {e}"))?;

    // Report the signature with the same vocabulary the core uses, so
    // interop.sh can compare the two sides directly.
    let signature = if decryptor.helper_ref().verified { "valid" } else { "unknown" };

    Ok(serde_json::json!({
        "plaintext": String::from_utf8_lossy(&plaintext),
        "signature": signature,
    })
    .to_string())
}

fn load_cert(path: &str) -> Result<Cert, String> {
    Cert::from_file(path).map_err(|e| format!("{path}: {e}"))
}

fn armor(cert: &Cert) -> Result<String, String> {
    let bytes = cert.armored().to_vec().map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

struct Helper<'a> {
    secret: &'a Cert,
    policy: &'a dyn Policy,
    senders: Vec<Cert>,
    verified: bool,
}

impl VerificationHelper for Helper<'_> {
    fn get_certs(&mut self, _ids: &[KeyHandle]) -> openpgp::Result<Vec<Cert>> {
        Ok(self.senders.clone())
    }

    fn check(&mut self, structure: MessageStructure) -> openpgp::Result<()> {
        for layer in structure.into_iter() {
            if let MessageLayer::SignatureGroup { results } = layer {
                if results.iter().any(|r| r.is_ok()) {
                    self.verified = true;
                }
            }
        }
        Ok(())
    }
}

impl DecryptionHelper for Helper<'_> {
    fn decrypt(
        &mut self,
        pkesks: &[openpgp::packet::PKESK],
        _skesks: &[openpgp::packet::SKESK],
        sym_algo: Option<SymmetricAlgorithm>,
        decrypt: &mut dyn FnMut(Option<SymmetricAlgorithm>, &SessionKey) -> bool,
    ) -> openpgp::Result<Option<Cert>> {
        let key = self
            .secret
            .keys()
            .unencrypted_secret()
            .with_policy(self.policy, None)
            .for_transport_encryption()
            .next()
            .ok_or_else(|| openpgp::Error::InvalidOperation("no encryption key".into()))?
            .key()
            .clone();

        let mut pair = key.into_keypair()?;
        for pkesk in pkesks {
            if pkesk
                .decrypt(&mut pair, sym_algo)
                .map(|(algo, session_key)| decrypt(algo, &session_key))
                .unwrap_or(false)
            {
                return Ok(Some(self.secret.clone()));
            }
        }
        Ok(None)
    }
}
