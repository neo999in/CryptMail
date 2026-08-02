# Architecture

## 10,000-foot view

CryptMail is a **local-first client** plus a **thin optional backend**. The
client does all cryptography and talks directly to the user's mail provider. The
backend exists only for things a pure client can't do well: publishing/finding
public keys, encrypted key backup, and push notifications.

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
│                 ┌────────▼────────┐              │                 │
│                 │ Local encrypted │              │                 │
│                 │ store (SQLite)  │              │                 │
│                 └─────────────────┘              │                 │
└──────────────────────────────┬───────────────────┼────────────────┘
                                │                   │
              (HTTPS, public    │                   │ IMAP/SMTP/HTTPS
               keys + backup)   │                   │
                                ▼                   ▼
                   ┌──────────────────────┐   ┌──────────────────────┐
                   │  CryptMail backend  │   │  Mail provider        │
                   │  · Key directory     │   │  (Gmail, Outlook,     │
                   │  · Encrypted key     │   │   IMAP host, …)       │
                   │    backup store      │   │                       │
                   │  · Push relay        │   │  Stores ciphertext    │
                   └──────────────────────┘   └──────────────────────┘
```

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

### 5. Backend (optional but recommended)
Stateless-ish services:
- **Key directory** — maps `email → verified public key(s)`. Enables discovery
  when Autocrypt headers aren't available yet.
- **Encrypted key backup** — stores the user's *passphrase-encrypted* private key
  so a new device can restore it. The server cannot read it.
- **Push relay** — mobile push notifications for new mail without keeping IMAP
  IDLE alive in the background.

The backend never sees plaintext and never sees usable private keys. If it is
compromised, message confidentiality is preserved (integrity of key discovery is
the thing at risk — see [security.md](security.md)).

## Data flow: sending an encrypted message

1. User composes; app resolves each recipient's public key
   (local ring → Autocrypt cache → key directory → WKD).
2. If any recipient has no key, UI shows a warning and offers fallbacks.
3. Crypto core builds a PGP/MIME message: encrypts body + attachments to all
   recipient keys (and to the sender's own key, so the sender can read Sent),
   signs with the sender's private key.
4. Real subject is moved into the encrypted payload; visible subject becomes
   `[Encrypted message]`. An Autocrypt header carrying the sender's public key is
   attached.
5. Connector sends via SMTP / Gmail API / Graph API.
6. A copy lands in the provider "Sent" folder — also as ciphertext.

## Data flow: receiving

1. Connector fetches new mail (IMAP IDLE / Gmail watch / Graph subscription).
2. App detects PGP/MIME (content type / armor markers).
3. Crypto core decrypts with the private key and verifies the signature.
4. Sender's public key from the Autocrypt header is cached to the local ring.
5. Decrypted content rendered in the UI; optionally cached in the encrypted store.
6. In the provider's own apps, the same message stays ciphertext.

## Technology recommendations

| Concern | Recommendation | Why |
|---------|----------------|-----|
| Crypto library | [OpenPGP.js] or [Sequoia]/[rPGP] (Rust) | Mature, audited, PGP/MIME + Autocrypt support |
| Desktop shell | Tauri (Rust) or Electron | Tauri = smaller, Rust crypto core reuse |
| Mobile | Native (Swift/Kotlin) or React Native | Keychain/Keystore access for key storage |
| Local DB | SQLite + SQLCipher | Encrypted at rest, ubiquitous |
| Key at rest | OS keychain (macOS Keychain, Windows DPAPI, Android Keystore, iOS Keychain) | Hardware-backed where available |
| Backend | Any (Go/Node/Rust) + Postgres | Small surface; mostly a key/value directory |

Choosing a Rust crypto core (Sequoia/rPGP) that compiles to desktop, mobile, and
WASM keeps one audited implementation everywhere. That is the recommended path.

[OpenPGP.js]: https://github.com/openpgpjs/openpgpjs
[Sequoia]: https://sequoia-pgp.org/
[rPGP]: https://github.com/rpgp/rpgp
