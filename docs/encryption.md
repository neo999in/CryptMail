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
  is what makes CryptMail "just work" without manual key pasting.
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
  `Subject:` header, so CryptMail restores it after decryption.

Sender, recipients, date, and message size remain visible — that's metadata SMTP
inherently exposes (see [security.md](security.md)).

## Automatic key exchange: Autocrypt

The reason this feels seamless. [Autocrypt](https://autocrypt.org/) defines an
email header that carries the sender's public key:

```
Autocrypt: addr=alice@gmail.com; prefer-encrypt=mutual;
  keydata=<base64 public key>
```

- Every outgoing message includes the sender's `Autocrypt` header — encrypted
  mail and the plaintext invite alike.
- On receipt, CryptMail caches the sender's public key in the local ring, keyed
  by address. The header is cleartext, so this happens during **inbox sync**, on
  every message, without decrypting anything and without the user opening it.
  A header whose `addr=` is not the message's sender is ignored: otherwise
  anyone could push a key for any address into a recipient's keyring.
- After two people have exchanged **one** message each, both can encrypt to the
  other automatically — no manual step.
- `prefer-encrypt=mutual` signals the peer also wants encryption by default.

Autocrypt is opportunistic and deliberately low-friction; for stronger
guarantees we layer keyserver discovery and optional manual verification (see
[key-management.md](key-management.md)).

## Encryption decision at send time

When the user hits Send, the app resolves a key for **each** recipient — local
keyring, then Autocrypt cache, then the directory
([key-management.md](key-management.md) §Discovery) — and the outcome is one of
three. Plaintext is not among them.

| Situation | Outcome | UX |
|-----------|---------|-----|
| Key known for every recipient | **Encrypted, sent** | Lock icon, sends normally |
| A recipient has no published key | **Encrypted, queued** | Message is held; that recipient is invited; it delivers itself when they have a key |
| A recipient's key **changed** fingerprint | **Blocked** | Nothing is sent and nothing is held — see below |
| User explicitly chooses a plaintext message | **Plaintext** | A separate action, chosen up front, never a fallback |

**Fail safe:** the app never silently sends plaintext when the user believed the
message was encrypted. A mixed-recipient message is never partially encrypted
silently — either all recipients can be encrypted to, or the message waits.

A **changed** fingerprint is deliberately *not* queued. A missing key is
something waiting resolves; a changed key is a possible key substitution, and
waiting resolves nothing. Only a person re-verifying the key clears it.

### The only path for recipients without a key: invite and queue

Earlier drafts of this document listed three fallbacks — a secure link, an
explicit plaintext downgrade, and an invite. The first two are **out**:

- **Secure link** (ciphertext behind a hosted web reader) would make CryptMail a
  service rather than a client, which is the project's first architectural
  commitment. The variants that avoid a server — a password-protected PDF, an
  HTML attachment that asks for a passphrase — were rejected too: the last of
  those trains people to open HTML attachments and type secrets into them, which
  is indistinguishable from phishing.
- **Plaintext downgrade for this one message** is the behaviour rule 1 exists to
  forbid. It survives only as the independent "send an unencrypted email"
  action, which the user picks up front for a message they never believed was
  encrypted.

  **Built, and the shape is the point.** Compose carries an
  encrypted / not-encrypted choice at the very top, defaulting to encrypted,
  and it is the *only* way to reach `sendPlain`. Three properties keep it from
  becoming the downgrade it resembles:

  - it appears **before** the message is written, never after a send is
    refused — there is no unencrypted button beside "their key changed", and
    none beside a queued message;
  - switching into it asks first, and the screen then says plainly, everywhere
    it can — placeholders, status line, send button — that this message is not
    private;
  - while it is selected, Compose looks up **no keys and reads no recipient key
    state**. Nothing here may depend on one, because a send that becomes
    possible precisely when a key is *absent* is the downgrade under another
    name.

  The message still carries the sender's `Autocrypt` header, so an unencrypted
  email is still a way for the recipient to learn how to answer encrypted.

What remains:

1. The message is **held in the outbox**, encrypted-to-nobody-yet, marked
   `awaiting-key`.
2. The recipient gets a **contentless invite**: a plaintext email saying only
   that someone sent them an encrypted message and how to read it. No subject,
   no body, no hint of either. It carries the sender's `Autocrypt` header, so a
   fresh install can reply encrypted with no setup step. At most one invite per
   address per week.
3. On every app launch, every scheduler tick and every inbox sync, the app looks
   again for a key for the pending addresses. When one appears, the held message
   is encrypted and sent — once.
4. The outbox also offers that check on demand. The control on an `awaiting-key`
   hold is **"Check for a key"**, not "Send now": the message is not waiting on a
   clock, and a button promising to send it now would be promising something the
   whole design forbids. It reports one of three answers, because a check whose
   result is discarded is indistinguishable from a button that does nothing —
   *they have not published a key yet*, *we could not reach the directory* (a
   fault on our side, not a fact about them — see
   [key-management.md](key-management.md)), or the refusal a **changed**
   fingerprint produces.

**Why hold rather than send now.** Encryption is not retroactive. A message
sealed before the recipient had a key could never be opened by them afterwards,
so "send it and let them catch up" is not a thing that can work. Holding it is
the only alternative to the downgrade.

**What this does not solve, stated plainly in the UI as well as here:** delivery
to a non-user is not instant and cannot be time-bounded — it happens when they
install. If they never install, they never receive it. The compose screen
therefore says *queued*, never *sent*.

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
