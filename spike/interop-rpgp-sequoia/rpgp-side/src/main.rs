//! The `cryptmail-core` end of the interop harness.
//!
//! Deliberately a *separate process* from `sequoia-side`: rPGP and Sequoia
//! cannot be linked into one binary (see ../README.md), and exchanging armored
//! files is what interop actually means anyway.
//!
//! Every subcommand writes its result to stdout and exits non-zero on failure,
//! so `interop.sh` can drive it without parsing prose.

use std::process::exit;

use cryptmail_core::Core;

const PW: &str = "interop-harness-passphrase";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: rpgp-side <gen|encrypt|decrypt|seal|handshake|open> ...";

    let result = match args.get(1).map(String::as_str) {
        // gen <dir> <email>  → armored public cert on stdout
        Some("gen") => gen(&args[2], &args[3]),
        // encrypt <dir> <email> <recipient-cert> <plaintext-file> → armored message
        Some("encrypt") => encrypt(&args[2], &args[3], &args[4], &args[5]),
        // decrypt <dir> <email> <sender-cert> <message-file> → Decrypted JSON
        Some("decrypt") => decrypt(&args[2], &args[3], &args[4], &args[5]),
        // seal / open: the path the app uses, which picks per-email keys when it
        // can. To a foreign client it can never have a session with, so it must
        // produce an ordinary message — plus armor headers a foreign parser has
        // to tolerate.
        Some("seal") => seal(&args[2], &args[3], &args[4], &args[5]),
        Some("handshake") => handshake(&args[2], &args[3], &args[4], &args[5]),
        Some("open") => open(&args[2], &args[3], &args[4], &args[5]),
        _ => {
            eprintln!("{usage}");
            exit(2);
        }
    };

    match result {
        Ok(out) => println!("{out}"),
        Err(e) => {
            eprintln!("rpgp-side: {e}");
            exit(1);
        }
    }
}

fn gen(dir: &str, email: &str) -> Result<String, String> {
    let core = Core::new(dir);
    let json = core.generate_identity(email, PW).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    value["publicKeyArmored"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "identity JSON had no publicKeyArmored".into())
}

fn encrypt(dir: &str, email: &str, recipient_cert: &str, plaintext: &str) -> Result<String, String> {
    let core = Core::new(dir);
    let cert = read(recipient_cert)?;

    // The core validates a foreign key before it will encrypt to it; if this
    // rejects a Sequoia certificate, that is itself an interop failure.
    core.import_public_key(&cert)
        .map_err(|e| format!("rejected the recipient's certificate: {e}"))?;

    core.encrypt_sign(email, PW, &read(plaintext)?, &[cert]).map_err(|e| e.to_string())
}

fn decrypt(dir: &str, email: &str, sender_cert: &str, message: &str) -> Result<String, String> {
    let core = Core::new(dir);
    core.decrypt_verify(email, PW, &read(message)?, &[read(sender_cert)?])
        .map_err(|e| e.to_string())
}

/// Per-email keys only: sealing to a client that cannot hold a session must be
/// refused, never quietly sent to its long-term key. Succeeds (prints the
/// refusal) only when the core refused.
fn seal(dir: &str, email: &str, recipient_cert: &str, plaintext: &str) -> Result<String, String> {
    let core = Core::new(dir);
    match core.seal(email, PW, &read(plaintext)?, &[read(recipient_cert)?]) {
        Ok(_) => Err("seal went ahead with a client that cannot hold a session".into()),
        Err(e) => Ok(format!("refused: {e}")),
    }
}

/// The one long-term-key message the core still makes: contentless, carrying
/// this device's offer. The only thing a foreign client ever receives.
fn handshake(dir: &str, email: &str, recipient_cert: &str, plaintext: &str) -> Result<String, String> {
    let core = Core::new(dir);
    core.handshake(email, PW, &read(plaintext)?, &[read(recipient_cert)?]).map_err(|e| e.to_string())
}

fn open(dir: &str, email: &str, sender_cert: &str, message: &str) -> Result<String, String> {
    let core = Core::new(dir);
    core.open(email, PW, &read(message)?, &[read(sender_cert)?]).map_err(|e| e.to_string())
}

fn read(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}
