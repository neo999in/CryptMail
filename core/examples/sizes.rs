//! Reproduces every measured figure in `docs/encryption-flow.md`.
//!
//!     cargo run --example sizes
//!
//! Numbers in a document that nobody can re-derive rot silently. This exists so
//! the certificate size, the per-recipient cost, and the AEAD chunk size can be
//! checked against the code rather than trusted.

use cryptmail_core::Core;
use pgp::crypto::aead::ChunkSize;
use serde_json::Value;

const PW: &str = "example-passphrase";

fn main() {
    let base = std::env::temp_dir().join("cryptmail-example-sizes");
    let _ = std::fs::remove_dir_all(&base);

    // Four identities: one sender, three recipients.
    let mut cores = Vec::new();
    let mut certs: Vec<String> = Vec::new();
    for i in 0..4 {
        let core = Core::new(base.join(format!("p{i}")));
        let id: Value =
            serde_json::from_str(&core.generate_identity(&format!("p{i}@example.com"), PW).unwrap()).unwrap();
        certs.push(id["publicKeyArmored"].as_str().unwrap().to_string());
        cores.push(core);
    }

    println!("Stage 1 certificate, armored : {} bytes", certs[0].len());
    println!("AEAD chunk size              : {:?}", ChunkSize::default());
    println!();

    // Per-recipient cost is the size of one PKESK — dominated by the
    // 1088-byte ML-KEM ciphertext — and should be flat.
    let body = "x".repeat(500);
    let mut previous = 0usize;
    for n in 1..=3 {
        let msg = cores[0].encrypt_sign("p0@example.com", PW, &body, &certs[1..=n]).unwrap();
        match previous {
            0 => println!("{n} recipient  : {:>6} bytes", msg.len()),
            p => println!("{n} recipients : {:>6} bytes   (+{} per recipient)", msg.len(), msg.len() - p),
        }
        previous = msg.len();
    }

    let one = cores[0].encrypt_sign("p0@example.com", PW, &body, &certs[1..=1]).unwrap();
    println!();
    println!("plaintext                    : {} bytes", body.len());
    println!("fixed overhead, 1 recipient  : {} bytes", one.len() - body.len());
}
