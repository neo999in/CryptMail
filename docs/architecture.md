# Architecture

## 10,000-foot view

CryptMail is a **client, and only a client**. It does all cryptography locally
and talks directly to the user's mail provider and to public key infrastructure
that already exists. **There is no CryptMail backend** — see
[api.md](api.md) for the design that was considered and dropped, and
[key-management.md](key-management.md) §Discovery for why running a key directory
would cost more than it bought.

```
┌──────────────────────────────────────────────────────────────────┐
│                          CryptMail client                         │
│  (Desktop: Electron/Tauri · Mobile: native/RN · Web: PWA)          │
│                                                                    │
│  ┌────────────┐  ┌───────────────┐  ┌────────────────────────┐    │
│  │  UI layer  │  │  Crypto core  │  │  Provider connectors     │    │
│  │  (inbox,   │◀▶│  (OpenPGP,    │◀▶│  IMAP/SMTP · Gmail API   │    │
│  │  compose)  │  │  key store)   │  │  · MS Graph API          │    │
│  └────────────┘  └───────┬───────┘  └───────────┬────────────┘    │
│                          │                       │                 │
│         ┌────────────────┼──────────┐            │                 │
│  ┌──────▼───────┐ ┌──────▼───────┐  │            │                 │
│  │ Local        │ │ Outbox:      │  │            │                 │
│  │ encrypted    │ │ scheduled +  │  │            │                 │
│  │ store        │ │ awaiting-key │  │            │                 │
│  └──────────────┘ └──────────────┘  │            │                 │
└─────────────────────────────────────┼────────────┼────────────────┘
                                       │            │
                    (HTTPS, public     │            │ IMAP/SMTP/HTTPS
                     keys only)        │            │
                                       ▼            ▼
                   ┌──────────────────────┐   ┌──────────────────────┐
                   │  Public key infra     │   │  Mail provider        │
                   │  · keys.openpgp.org   │   │  (Gmail, Outlook,     │
                   │  · WKD at the         │   │   IMAP host, …)       │
                   │    recipient's domain │   │                       │
                   │  (third-party, not    │   │  Stores ciphertext    │
                   │   operated by us)     │   │  Carries Autocrypt    │
                   └──────────────────────┘   └──────────────────────┘
```

The user's own key backup has no box on this diagram on purpose: it is a blob the
user exports and keeps. Nothing we run holds it.

## Components

### 1. Crypto core
The trust anchor. Responsible for:
- Generating and storing the user's keypair (private key never leaves the device
  unencrypted).
- Encrypting/decrypting/signing messages (OpenPGP — see [encryption.md](encryption.md)).
- Managing the local keyring of contacts' public keys.

Kept provider-agnostic and UI-agnostic so it can be reused across platforms and
independently audited. Ideally a single library (e.g. Rust core compiled to all
targets, or a shared TypeScript module).

### 2. Provider connectors
Abstraction over how mail is fetched/sent:
- **Gmail** → OAuth 2.0 + Gmail REST API (or IMAP/SMTP with XOAUTH2).
- **Outlook/Microsoft 365** → OAuth 2.0 + Microsoft Graph API (or IMAP/SMTP).
- **Everything else** → generic IMAP (read) + SMTP (send), password or OAuth.

All connectors implement one internal interface: `listMessages`, `getMessage`,
`sendMessage`, `watch/idle`, `updateFlags`. See [providers.md](providers.md).

### 3. Local encrypted store
SQLite database on the device holding message metadata, cached decrypted bodies
(optional), the contact public-key ring, and the wrapped private key. The DB file
itself is encrypted at rest (SQLCipher / OS keychain-held key). See
[data-model.md](data-model.md).

### 4. UI layer
Inbox, thread view, compose, key/trust indicators, onboarding, recovery. Renders
decrypted content only in memory. Shows explicit encryption status per recipient
before sending.

### 5. Key discovery (third-party, not ours)
No CryptMail server. Public keys are found and published through infrastructure
that already exists and that we treat as untrusted:
- **`keys.openpgp.org`** — address lookup and publication, after the address
  owner confirms by email.
- **WKD** — the same lookup against the recipient's own domain.

Neither is trusted to be honest. A key from either arrives as `seen`, and a key
that contradicts one already on file marks the contact `changed` and blocks the
send. See [key-management.md](key-management.md).

### 6. Outbox
Messages written but not yet delivered, for two different reasons: scheduled for
a time, or **held because a recipient has no key yet**. The second is what
replaces a plaintext fallback — the message waits, the recipient gets a
contentless invite, and delivery happens on its own once a key exists
([encryption.md](encryption.md)). It is client-side, which is an honest
limitation: a device that never reopens cannot deliver what it holds.

## Data flow: sending an encrypted message

1. User composes; app resolves each recipient's public key
   (local ring → Autocrypt cache → `keys.openpgp.org` → WKD).
2. If a recipient's key **changed**, the send stops — nothing is sent or held.
3. If a recipient has **no key**, the message goes to the outbox marked
   `awaiting-key`, that recipient gets a contentless invite, and the UI says
   *queued*, never *sent*.
4. Otherwise the crypto core builds a PGP/MIME message: encrypts body +
   attachments to all recipient keys (and to the sender's own key, so the sender
   can read Sent), signs with the sender's private key.
5. Real subject is moved into the encrypted payload; visible subject becomes
   `[Encrypted message]`. An Autocrypt header carrying the sender's public key is
   attached.
6. Connector sends via SMTP / Gmail API / Graph API.
7. A copy lands in the provider "Sent" folder — also as ciphertext.

## Data flow: receiving

1. Connector fetches new mail (IMAP IDLE / Gmail watch / Graph subscription).
2. Senders' public keys are harvested from the cleartext `Autocrypt` headers on
   the summaries — no decryption, nothing opened.
3. Held messages are re-checked: anything whose recipients now all have keys is
   encrypted and sent.
4. App detects PGP/MIME (content type / armor markers) when a message is opened.
5. Crypto core decrypts with the private key and verifies the signature.
6. Decrypted content rendered in the UI; optionally cached in the encrypted store.
7. In the provider's own apps, the same message stays ciphertext.

## Technology recommendations

| Concern | Recommendation | Why |
|---------|----------------|-----|
| Crypto library | [OpenPGP.js] or [Sequoia]/[rPGP] (Rust) | Mature, audited, PGP/MIME + Autocrypt support |
| Desktop shell | Tauri (Rust) or Electron | Tauri = smaller, Rust crypto core reuse |
| Mobile | Native (Swift/Kotlin) or React Native | Keychain/Keystore access for key storage |
| Local DB | SQLite + SQLCipher | Encrypted at rest, ubiquitous |
| Key at rest | OS keychain (macOS Keychain, Windows DPAPI, Android Keystore, iOS Keychain) | Hardware-backed where available |
| Key discovery | `keys.openpgp.org` (VKS) + WKD | Address-verified lookup with nothing for us to host — and no log of who is about to email whom |

Choosing a Rust crypto core (Sequoia/rPGP) that compiles to desktop, mobile, and
WASM keeps one audited implementation everywhere. That is the recommended path.

[OpenPGP.js]: https://github.com/openpgpjs/openpgpjs
[Sequoia]: https://sequoia-pgp.org/
[rPGP]: https://github.com/rpgp/rpgp
