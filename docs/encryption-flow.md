# Encryption Flow, End to End

One message, from key generation to a decrypted subject on screen — as the code
actually works today.

[encryption.md](encryption.md) states the design; this file traces the
implementation, naming the functions so you can follow along. For how strongly
each part is verified, see
[implementation-status.md](implementation-status.md).

```
screens ──▶ AppState ──▶ nativeCore.ts ──┬──▶ mime.ts        (envelope, TypeScript)
                                          └──▶ CryptMailCore  (crypto, Rust)
```

The split is the design decision everything else follows from: **TypeScript
assembles the envelope, Rust does only what must not happen in JavaScript.**

---

## Phase 0 — Identity, once per device

`attach()` (`app/src/state/session.ts`) calls `core.loadIdentity(email)`;
generation is a separate, explicit step on the setup screen.

In [`identity::generate`](../core/src/identity.rs), rPGP builds a **V6** key:

| Role | Algorithm |
|---|---|
| Primary — certify + sign | `Ed25519` |
| Encryption subkey | **`MlKem768X25519`** — RFC 9980 algorithm 35 |

This is Stage 1 of [post-quantum.md](post-quantum.md): post-quantum
confidentiality, classical signatures. V6 because RFC 9980 requires it.
Certificates come out at ~2.4 KB, small enough for an `Autocrypt:` header on
every message — a full post-quantum signing key would be ~18.5 KB and would
break that.

Both halves are S2K-encrypted under a passphrase the **Kotlin side** supplies
from the Android Keystore. It is taken once at construction and never appears in
a JavaScript-visible signature — that is the whole reason for a native core.

The armored secret key goes to `identity-<hash>.asc` in app-private storage. The
filename is hashed so the directory listing does not leak which accounts this
device holds keys for.

What crosses back into JavaScript is:

```json
{ "email": "...", "fingerprint": "...", "publicKeyArmored": "...", "createdAt": "..." }
```

**No secret material** — asserted by test, including that neither the private key
nor the passphrase appears anywhere in the serialised document.

---

## Phase 1 — Learning the recipient's key

Encryption cannot start until you hold a public key for the recipient. Two
routes:

**Manual** — `KeysScreen`. You copy your armored key to them; you paste
theirs. `core.importPublicKey()` → [`keys::import`](../core/src/keys.rs) parses
the block, runs `verify_bindings()`, and extracts the address from the User ID.
`upsertKey` stores it in the keyring.

**Autocrypt** — every outgoing message carries your public key in an
`Autocrypt:` header. When you open a message, `parseEncrypted` returns the
sender's `autocryptKey` and AppState caches it. After one message each way, both
sides can encrypt with no manual step.

`upsertKey` marks an address `changed` if it presents a **different fingerprint**
than before. That is the key-substitution signal from
[security.md](security.md), and it blocks sending rather than warning.

---

## Phase 2 — Sending

### In the UI

`resolveRecipients()` returns a per-recipient status — `verified`, `ok`,
`changed`, or `missing` — and `evaluateSendModes()` turns that into whether
encrypted send is available:

- any recipient **missing** a key → blocked, address named
- any recipient's key **changed** → blocked, re-verification required
- otherwise available, with a warning if keys are only trust-on-first-use

This device's own address is the one case resolved outside the keyring: it comes
from the identity and reports `verified`, since a key you hold the private half
of needs no out-of-band comparison. See `app/src/state/recipients.ts`.

Plaintext is a separate, explicitly chosen mode. It is never preselected, and
`defaultSendMode()` returns `null` rather than falling back to it.

### In `deliver()`

The fail-safe is re-checked in `AppState`, not trusted from the UI. A missing key
throws `CoreError('no-key')` before anything is built.

### In `nativeCore.buildEncrypted()`

Three steps.

**1 — TypeScript builds the inner tree** (`buildProtectedInner`). The real
subject lives *inside*, as a protected header:

```
Content-Type: multipart/mixed; protected-headers="v1"
Subject: Lunch on Friday?
From: Alice <alice@example.com>
To: Bob <bob@example.com>

Are we still on for noon?
```

**2 — Rust encrypts and signs it** ([`message::encrypt_sign`](../core/src/message.rs)):

1. Generate a random **AES-256 session key**.
2. Encrypt the whole tree with it — AEAD, OCB, SEIPDv2.
3. **Sign** with the Ed25519 primary (sign-then-encrypt).
4. For every recipient **and yourself**, find their encryption subkey and wrap
   the session key to it.

Step 4 is where post-quantum happens. Inside rPGP, per RFC 9980:

```
ML-KEM-768 encapsulate  ─┐
                          ├─▶ KMAC combiner ─▶ KEK ─▶ AES-key-wrap(session key)
X25519 ECDH             ─┘
```

Composite, not replacement: an attacker must break **both** the lattice problem
and the elliptic curve. That is why this is never weaker than classical
CryptMail, only stronger.

Encrypting to yourself as well is what keeps the copy in Sent readable.

If a recipient's certificate has no encryption-capable subkey, `encryption_subkey`
returns `NoKey` and the send fails — it never falls back to something weaker.

**3 — TypeScript wraps the envelope** (`buildEncryptedEnvelope`), and
`gmail.ts` posts it to `users.messages.send`.

---

## Cryptographic detail

Everything in this section marked *measured* comes from
`cd core && cargo run --example sizes`, which reproduces it.

### Key material

| | Public / encapsulation | Private | Ciphertext | Shared secret |
|---|---|---|---|---|
| **ML-KEM-768** (FIPS 203) | 1,184 B | 2,400 B | 1,088 B | 32 B |
| **X25519** | 32 B | 32 B | 32 B (ephemeral) | 32 B |
| **Ed25519** | 32 B | 32 B | — signature 64 B | — |
| **AES-256** session key | — | 32 B | — | — |

A whole Stage 1 certificate is **≈2.4 KB armored** *(measured: 2,419 B for a
14-character address)* — dominated by the 1,184-byte ML-KEM encapsulation key,
then base64-expanded by ~4/3. It is not a fixed constant: the address is
embedded in the User ID, so the certificate grows by roughly the length of the
address. Quote it as "about 2.4 KB", not as an exact figure.

That is what has to fit in an `Autocrypt:` header on every message, and why
post-quantum signatures are staged separately: ML-DSA-65 would add a 1,952-byte
key plus a 3,309-byte signature to *each* of the three self-signatures, taking
the same certificate to ~18.5 KB.

### The composite KEM step, precisely

This is the one place "post-quantum" actually happens. Per RFC 9980, for each
recipient:

```
                   recipient ML-KEM-768 encapsulation key
                                 │
      ML-KEM.Encaps() ───────────┴──▶  ss_ML-KEM (32 B) + ct_ML-KEM (1088 B)
                                                    │
      X25519(eph_sk, recipient_pk) ──▶ ss_X25519 (32 B) + eph_pk (32 B)
                                                    │
                                                    ▼
              KMAC-based combiner  (SP 800-56C, modelled on X-Wing)
              inputs: ss_ML-KEM ‖ ss_X25519 ‖ ct_ML-KEM ‖ eph_pk ‖ recipient pk
                                                    │
                                                    ▼
                              KEK  ──▶  AES-KeyWrap (RFC 3394)
                                                    │
                                                    ▼
                        wrapped AES-256 session key → PKESK packet
```

Three properties follow from that shape:

1. **Composite, not replacement.** Recovering the session key requires *both*
   `ss_ML-KEM` and `ss_X25519`. Breaking the lattice alone is not enough, and
   neither is breaking the curve — so this is never weaker than classical
   CryptMail.
2. **The ciphertexts and public keys are folded into the derivation**, so
   components from two different messages cannot be mixed and matched.
3. **ML-KEM is a KEM, not a padlock.** It *generates* `ss_ML-KEM`; you do not
   hand it the session key to encrypt. The session key is wrapped under a
   *derived symmetric* KEK. Implementing from the "encrypt the session key to
   the public key" mental model produces the wrong thing.

### The bulk layer

One symmetric encryption of the whole inner MIME tree, regardless of recipient
count:

| | Value |
|---|---|
| Container | SEIPDv2 (RFC 9580) |
| Cipher | AES-256 |
| Mode | **OCB** — AEAD, so tampering is detected, not just decrypted to garbage |
| Chunk size | **4 KiB** *(measured — `ChunkSize::default()`)* |
| Signature | Ed25519 over SHA-256, **inside** the encryption |

Chunking means a long message is a sequence of independently authenticated
4 KiB units rather than one monolithic tag.

### Packet layout on the wire

```
-----BEGIN PGP MESSAGE-----
  PKESK v6   ← recipient 1: ct_ML-KEM ‖ eph_pk ‖ wrapped session key
  PKESK v6   ← recipient 2: same, different KEK
  PKESK v6   ← the sender, so Sent stays readable
  SEIPDv2    ← AES-256-OCB over: [ signature ‖ literal data = inner MIME tree ]
-----END PGP MESSAGE-----
```

One SEIPD, N PKESKs. That is the hybrid scheme: bulk data encrypted once,
session key wrapped N times.

### Measured sizes

500-byte plaintext, armored:

| Recipients | Message | Delta |
|---|---|---|
| 1 | 2,735 B | — |
| 2 | 4,360 B | **+1,625 B** |
| 3 | 5,985 B | **+1,625 B** |

**Each additional recipient costs a flat ~1,625 B armored** — that is one PKESK
carrying the 1,088-byte ML-KEM ciphertext plus the X25519 ephemeral and the
wrapped key, base64-expanded. Fixed overhead for one recipient over the
plaintext is 2,235 B.

Practical consequence: a short note to five people is dominated by key
encapsulation, not content. Attachments change that ratio entirely — the bulk
layer scales with content while PKESKs stay flat.

### Secret key at rest

The stored key is a passphrase-protected OpenPGP secret key: **S2K**-derived
key, applied to both the primary and the ML-KEM subkey. The passphrase comes
from the Android Keystore and is held only inside the Rust core. Tests assert
that neither the passphrase nor an unprotected key ever reaches disk.

Note this is OpenPGP's own S2K, **not** the Argon2id wrapping described in
[key-management.md](key-management.md). Aligning the two is outstanding work.

### What each algorithm is doing, and its quantum status

| Layer | Algorithm | Quantum-safe? |
|---|---|---|
| Bulk content | AES-256-OCB | ✅ Grover halves it to ~2¹²⁸ — still infeasible |
| Session-key transport | ML-KEM-768 **+** X25519 | ✅ Composite; needs both broken |
| Authenticity | Ed25519 | ❌ **Shor breaks this** |
| Key at rest | S2K + AES | ✅ symmetric |

The single red cell is the honest summary of Stage 1: these messages cannot be
**decrypted** by a future quantum computer, but they could be **forged** by one.

---

## What the provider stores

```
From: alice@gmail.com
To: bob@outlook.com
Date: Wed, 05 Aug 2026 10:00:00 +0000
Subject: [Encrypted message]                    ← placeholder
Autocrypt: addr=alice@gmail.com; prefer-encrypt=mutual; keydata=<base64>
MIME-Version: 1.0
Content-Type: multipart/encrypted;
  protocol="application/pgp-encrypted"; boundary="..."

--boundary
Content-Type: application/pgp-encrypted

Version: 1

--boundary
Content-Type: application/octet-stream; name="encrypted.asc"

-----BEGIN PGP MESSAGE-----
hQIMA4z7...          ← ML-KEM-wrapped session key + AEAD payload
-----END PGP MESSAGE-----
--boundary--
```

Google sees sender, recipients, date, size, and the placeholder subject.
The real subject, the body, and any attachment filenames are all inside the
ciphertext. Gmail's own web UI renders this as an unreadable block — which is
the product working, not failing.

---

## Phase 3 — Receiving

1. **Inbox rows.** `encryptionFor()` decides the lock badge from **headers
   alone** — no decryption, no network.
2. **Open.** `getRaw()` fetches the source; `looksEncrypted()` checks the
   structure.
3. **`parseEncrypted()`** extracts the armor and decodes the sender's Autocrypt
   key, handing it to the core as a verification candidate — so a first message
   can be checked rather than reading as `unknown`.
4. **Rust** ([`message::decrypt_verify`](../core/src/message.rs)):
   - finds *its own* identity via `stored_identity_email()` — **not** from the
     envelope. Your address might be in `Cc`, or `To` may list several people, so
     reading it from headers breaks on ordinary multi-recipient mail.
   - unlocks the secret key with the Keystore passphrase
   - ML-KEM-decapsulates + X25519 → KEK → unwraps the session key → AEAD-decrypts
   - verifies the signature
5. **Signature state** — four outcomes, deliberately distinct:

   | State | Meaning |
   |---|---|
   | `valid` | checked against a key we hold, and correct |
   | `invalid` | checked, and **wrong** |
   | `unknown` | we hold no key to check against |
   | `none` | not signed |

   `unknown` and `invalid` must never collapse together, or a forgery reads as
   merely unverified.
6. **TypeScript** restores the real subject with `parseProtectedInner()`.
7. **AppState** caches the Autocrypt key, indexes the decrypted content so
   encrypted mail is searchable, and derives the trust badge.

---

## Where it refuses to proceed

| Condition | Behaviour |
|---|---|
| Recipient has no key | Encrypted send blocked, address named |
| Recipient's fingerprint changed | Blocked; re-verification required |
| Recipient cert has no encryption subkey | `NoKey` error |
| Encryption fails for any reason | **Never** becomes a plaintext send |
| Demo core in use | Flow works, but labelled "encoded, not encrypted" |

`sendPlain()` is a sibling of `sendEncrypted()` that nothing in the encrypted
path can reach. That separation is the whole of the no-downgrade rule.

---

## Two things this flow does not give you

**Signatures are not quantum-safe.** Stage 1 signs with Ed25519, which Shor's
algorithm breaks. So a future quantum computer **cannot decrypt** these messages
but **could forge** one. Deliberate: harvested ciphertext is a permanent problem,
forged future signatures are not. Stage 2 (ML-DSA-65) closes it at the cost of
18.5 KB certificates.

**Metadata is not hidden.** Sender, recipients, timestamps and message size stay
visible to the provider. SMTP requires them.

---

## Status of each leg

| Leg | Verified? |
|---|---|
| Key generation, algorithms, encrypt/decrypt, signature states | ✅ 27 Rust tests |
| Envelope assembly, TS composition, demo/native parity | ✅ 101 TS tests |
| Interop with a second OpenPGP implementation | ✅ 9 checks against Sequoia-PGP, both directions |
| The Kotlin bridge between them | ⛔ bindings generate; **never built for Android** |
| Gmail transport | ⛔ never run against Google |

Everything above the bridge is tested against a stub; everything below is tested
headless. The two halves have never met.
