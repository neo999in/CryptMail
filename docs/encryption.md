# Encryption Design

This is the heart of the product. Read [key-management.md](key-management.md)
alongside it.

## Goals

- **Confidentiality** of message content (subject, body, attachments) against the
  mail provider and any network observer.
- **Authenticity** — the recipient can verify who sent a message.
- **Forward-ish secrecy awareness** — understand what PGP does and does *not*
  give us (see the tradeoffs section).
- **Interoperability** with the existing OpenPGP world where feasible.

## Why OpenPGP (PGP/MIME) as the primary scheme

We chose **OpenPGP** (RFC 4880 / RFC 9580) delivered as **PGP/MIME** (RFC 3156):

- ASCII-armored ciphertext is plain text, so it survives any mail system intact
  and *shows as an obvious encrypted block* in other clients — exactly the
  product behavior we want.
- Mature, audited libraries exist on every platform (Sequoia, rPGP, OpenPGP.js,
  gopenpgp).
- **Autocrypt** (see below) standardizes automatic key exchange over email — this
  is what makes CipherMail "just work" without manual key pasting.
- It interoperates: a technical recipient using Thunderbird/Proton/GnuPG can
  still read our mail, and vice versa.

> A modern non-PGP alternative (X25519 + XChaCha20-Poly1305 via libsodium) is
> discussed at the end. It's simpler and faster but sacrifices interoperability
> and Autocrypt. We recommend PGP for v1.

## Cryptographic primitives (via OpenPGP)

- **Asymmetric keypair:** Curve25519 (EdDSA for signing, ECDH/X25519 for
  encryption). Fast, small, modern. RSA-4096 supported only for interop.
- **Session key:** random symmetric key per message.
- **Symmetric cipher:** AES-256 (or AES-256-OCB / the AEAD modes in RFC 9580).
- **Hash:** SHA-256+.
- **Password-based key derivation** (for wrapping the private key at rest):
  **Argon2id** (memory-hard) — see key-management.

## How a message is encrypted (hybrid scheme)

Standard hybrid encryption, handled by the OpenPGP library:

1. Generate a random **session key** `K`.
2. Encrypt the message content (a full MIME tree — body + attachments) with `K`
   using AES-256 (AEAD).
3. For each recipient (and for the sender's own key), encrypt `K` to their
   **public** key (X25519 ECDH). The message carries one encrypted copy of `K`
   per recipient.
4. **Sign** the content with the sender's private signing key (EdDSA).
5. ASCII-armor the result and place it in a PGP/MIME structure.

Only a holder of a matching **private** key can unwrap `K` and thus decrypt the
content. See [message-format.md](message-format.md) for the exact MIME layout.

## Encrypting the subject (protected headers)

SMTP requires a `Subject:` header in the clear. We do **not** leak the real
subject:

- The visible header is set to a placeholder: `Subject: [Encrypted message]`
  (i.e. the "memory hole" / RFC-draft *protected headers* technique).
- The **real** subject is included inside the encrypted MIME part as a
  `Subject:` header, so CipherMail restores it after decryption.

Sender, recipients, date, and message size remain visible — that's metadata SMTP
inherently exposes (see [security.md](security.md)).

## Automatic key exchange: Autocrypt

The reason this feels seamless. [Autocrypt](https://autocrypt.org/) defines an
email header that carries the sender's public key:

```
Autocrypt: addr=alice@gmail.com; prefer-encrypt=mutual;
  keydata=<base64 public key>
```

- Every outgoing message includes the sender's `Autocrypt` header.
- On receipt, CipherMail caches the sender's public key in the local ring, keyed
  by address.
- After two people have exchanged **one** message each, both can encrypt to the
  other automatically — no manual step.
- `prefer-encrypt=mutual` signals the peer also wants encryption by default.

Autocrypt is opportunistic and deliberately low-friction; for stronger
guarantees we layer the key directory and optional manual verification (see
[key-management.md](key-management.md)).

## Encryption decision at send time

When the user hits Send, for **each** recipient the app determines a key source
and a resulting mode:

| Situation | Mode | UX |
|-----------|------|-----|
| Key known for every recipient | **Encrypted** | Lock icon, send normally |
| Some recipient has no key | **Blocked / choose** | Warn; offer fallbacks below |
| User explicitly opts out | **Plaintext** | Requires an explicit, logged action |

**Fail safe:** the app never silently sends plaintext when the user believed the
message was encrypted. A mixed-recipient message is never partially encrypted
silently — either all recipients can be encrypted to, or the user makes an
explicit choice.

### Fallbacks for recipients without a key

1. **Secure link:** encrypt the message to a random passphrase, upload the
   ciphertext to the backend (or attach it), and email the recipient a link to a
   web reader. Deliver the passphrase out-of-band (the sender shares it via
   another channel). The provider only ever sees the link + ciphertext.
2. **Plaintext (explicit):** the user consciously downgrades this one message.
3. **Invite:** send a normal email inviting them to install CipherMail; encrypt
   future mail once they publish a key.

## Signing and verification

- Every encrypted message is also **signed** (sign-then-encrypt inside OpenPGP).
- On decrypt, the signature is verified against the sender's known public key.
- UI trust states:
  - **Verified** — key fingerprint confirmed out-of-band by the user.
  - **Seen** — key learned via Autocrypt/directory, not manually verified.
  - **Changed** — the sender's key changed unexpectedly (possible MITM or new
    device) → prominent warning.

## Tradeoffs and honest limits

- **No perfect forward secrecy.** OpenPGP uses long-lived keys; if a private key
  is later compromised, past ciphertext it can unwrap becomes readable. True PFS
  in email requires session-ratcheting schemes not deployable over standard SMTP.
  Mitigations: key rotation, subkeys, and offering the libsodium/MLS-style path
  later.
- **Metadata is not hidden.** Envelope (To/From/Date/Size/Subject-placeholder)
  is visible to the provider.
- **Endpoint trust.** Encryption protects data in transit and at rest in the
  mailbox; it cannot protect a compromised device.

## Alternative scheme (documented, not chosen for v1)

A modern non-interoperable option:

- Keys: X25519 (ECDH) + Ed25519 (signing).
- Per message: X25519 to derive a shared secret → HKDF → XChaCha20-Poly1305 AEAD
  over the MIME tree; sign with Ed25519.
- Serialize as a custom ASCII-armored block inside PGP/MIME-shaped parts.

Pros: simpler, faster, fewer footguns than the PGP format. Cons: no Autocrypt, no
interop with existing PGP users, we own the format forever. Revisit post-v1 if
interop proves unnecessary.
