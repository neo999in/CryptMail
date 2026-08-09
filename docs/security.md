# Security Model & Threat Analysis

Honesty is a feature. This documents what CryptMail protects, what it does not,
and the assumptions behind each guarantee.

## What we protect

- **Message content** (subject, body, attachments) is end-to-end encrypted.
  Neither the mail provider, network observers, nor the CryptMail backend can
  read it.
- **Authenticity:** messages are signed; recipients can verify the sender's key.
- **Private keys at rest** are wrapped (Argon2id + AES-256-GCM) and held in the OS
  keychain; they never leave the device in usable form.

## What we explicitly do NOT protect (in v1)

- **Metadata.** Sender, recipients, timestamps, message size, and the placeholder
  subject are visible to the provider — SMTP requires them in the clear. If you
  need metadata privacy, email is the wrong transport; that requires a different
  system (mixnets, sealed-sender messaging).
- **Forward secrecy.** Long-lived PGP keys mean compromise of a private key
  exposes past ciphertext it can unwrap. Mitigated by rotation, not eliminated.
- **The endpoint.** A compromised/malware-infected device sees plaintext because
  that's where decryption happens. No email crypto can fix a hostile endpoint.
- **Recipients who aren't users** get an invite and a wait, not a downgrade. The
  message is never sent in the clear, but it is also not delivered until they
  have a key — and it may never be. We say so before sending.

## Actors and adversaries

| Adversary | Can they read content? | Notes |
|-----------|------------------------|-------|
| Mail provider (Google/MS) | ❌ | Stores/serves only ciphertext |
| Passive network observer | ❌ | TLS + E2EE |
| CryptMail backend operator | ❌ | Sees public keys + opaque backups only |
| Malicious CryptMail backend | ⚠️ *key substitution* | See below — defeated by verification |
| Attacker with the device, locked | ❌ (if keychain/passphrase strong) | Wrapped key |
| Attacker with the device, unlocked | ✅ | Endpoint compromise |
| Attacker with provider password only | ❌ | Gets ciphertext, not the private key |

## The central risk: key substitution (MITM)

Any system with automatic key discovery has one core attack: the discovery source
lies about someone's public key, handing you the attacker's key instead. Then the
attacker can decrypt/re-encrypt in the middle.

CryptMail's discovery sources (directory, Autocrypt, WKD) are all trust-on-
first-use by default. Mitigations, strongest last:

1. **Fingerprint verification.** Users can compare a key's fingerprint / safety
   number out-of-band (in-person QR scan, phone call). Verified keys are immune to
   silent substitution.
2. **Change detection.** A previously-seen address suddenly presenting a new key
   triggers a prominent warning and requires re-acknowledgement.
3. **Key transparency (roadmap).** Publish directory contents to an append-only,
   verifiable log (à la CONIKS / Key Transparency) so the directory can't hand
   different keys to different people without detection.
4. **Self-authenticating updates.** New keys for an existing identity are signed by
   the old key where possible, so rotations are cryptographically linked.

## Backend trust boundary

The backend is designed so a breach doesn't break confidentiality:

- Stores only **public** keys and **opaque** (passphrase-wrapped) private-key
  backups. Neither yields plaintext.
- Does not store OAuth tokens, passwords, or message plaintext.
- Worst case of a fully malicious backend = key-substitution attacks on
  *unverified* keys + denial of service, not mass decryption. Key transparency is
  the durable fix.

## Client-side hardening

- Private key material zeroized from memory on lock/quit; auto-lock timer.
- Optional "no plaintext cache" mode (store only ciphertext locally).
- DB encrypted at rest (SQLCipher), key in OS keychain (hardware-backed where
  available — Secure Enclave / TPM / StrongBox). *Prototype: local records are
  sealed individually with XChaCha20-Poly1305 under a device key in
  `expo-secure-store` rather than by SQLCipher — see
  [data-model.md](data-model.md). Encrypted at rest, different engine.*
- Constant-time crypto via vetted libraries (Sequoia/rPGP/OpenPGP.js); no custom
  crypto primitives.
- Strict TLS to providers and backend; certificate validation, no plaintext ports.

## Fail-safe UX rules

- Never silently send plaintext when the user expects encryption.
- Encryption status shown per recipient **before** send.
- "Signature changed / could not verify" is loud, not a footnote.
- Recovery limitations stated plainly at onboarding (lose the recovery code +
  all devices = unrecoverable mail).

## Abuse & compliance considerations

- E2EE limits provider-side spam/malware scanning; scanning of decrypted content
  can happen client-side (locally) if desired.
- Some jurisdictions/organizations mandate mail archival or lawful-access; a true
  E2EE product cannot provide server-side plaintext access. Document this posture
  clearly for enterprise buyers.
- Provider ToS: sending encrypted mail through Gmail/Graph is allowed, but
  restricted OAuth scopes require Google/Microsoft app verification and security
  assessment. Plan compliance work early.

## Audit & disclosure

- The crypto core should be an independently auditable module with a published
  spec (this doc set is the starting point).
- Establish a responsible-disclosure policy and a security contact before launch.
