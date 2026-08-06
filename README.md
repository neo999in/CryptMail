# CryptMail (working title)

A cross-platform email client that connects to your **existing** Gmail, Outlook,
or any IMAP/SMTP account and transparently **end-to-end encrypts** the mail you
send through it.

The key idea: mail you send from CryptMail to another CryptMail user is
encrypted on your device and only ever decrypted on the recipient's device.
The encrypted message physically lives in the recipient's normal mailbox — so
if they open Gmail, Outlook, or any other client, they see an unreadable
ciphertext block. Inside CryptMail, it reads as a normal message.

```
You (CryptMail)  ──encrypt──▶  [ciphertext email]  ──▶  Recipient's Gmail inbox
                                        │
                    Gmail web UI shows: "-----BEGIN PGP MESSAGE----- ..."
                    CryptMail shows:   "Hey, are we still on for lunch?"
```

CryptMail is a **client**, not a mail provider. It never runs your mailbox; it
signs into the one you already have. That is exactly why the ciphertext shows up
in the provider's own apps — it's a real email sitting in a real inbox.

---

## Documentation

| Doc | What's in it |
|-----|--------------|
| [docs/overview.md](docs/overview.md) | Product vision, goals, non-goals, user stories |
| [docs/architecture.md](docs/architecture.md) | System components, data flow, tech choices |
| [docs/encryption.md](docs/encryption.md) | The cryptographic design (the core of the product) |
| [docs/key-management.md](docs/key-management.md) | Keypairs, discovery, recovery, device sync |
| [docs/providers.md](docs/providers.md) | OAuth + IMAP/SMTP / Gmail API / Graph API integration |
| [docs/message-format.md](docs/message-format.md) | Exactly what an encrypted email looks like on the wire |
| [docs/data-model.md](docs/data-model.md) | Entities, local store, key-directory schema |
| [docs/security.md](docs/security.md) | Threat model, guarantees, and honest limitations |
| [docs/api.md](docs/api.md) | Optional backend: key directory + push |
| [docs/roadmap.md](docs/roadmap.md) | MVP scope, phased plan, and the candidate-feature backlog |
| [docs/prototype-plan.md](docs/prototype-plan.md) | Concrete build plan for the Phase 0 prototype |
| [docs/features.md](docs/features.md) | Feature register: everything buildable next, by what's blocking it |
| **[docs/implementation-status.md](docs/implementation-status.md)** | **What is actually built and verified, plus every flagged issue and unverified claim** |
| [docs/encryption-flow.md](docs/encryption-flow.md) | One message end to end: keygen → key exchange → send → wire → receive |
| [docs/post-quantum.md](docs/post-quantum.md) | RFC 9980 hybrid migration plan, with measured certificate sizes |
| [docs/running-it.md](docs/running-it.md) | Turning on real Gmail and real encryption — what you must do |
| [docs/simple-ui-plan.md](docs/simple-ui-plan.md) | The four-screen UI and the plaintext-send decision |

## Repo layout

```
docs/     design docs — the source of truth for behaviour
app/      the Expo / React Native / TypeScript client (all code lives here)
.github/  CI, PR and issue templates
```

There is no root `package.json` — run every npm command from `app/`.

## Working on this

```bash
cd app && npm install && npm run web
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before your first PR — it covers the
branch/review flow and the five rules around the send path and the crypto
boundary that reviews will hold you to.

## Status

**Design docs + a working prototype app** in [app/](app/) — Expo / React Native /
TypeScript. It runs in **demo mode**: mail comes from fixtures and the crypto
core is a clearly-labelled non-cryptographic stand-in, so nothing it produces is
actually encrypted. The real Rust core (M1/M2 of
[docs/prototype-plan.md](docs/prototype-plan.md)) and Google OAuth client are not
wired up yet; every send path checks for them rather than silently downgrading.

On top of that base the client has search over decrypted mail, threading, drafts
with autosave, star/archive/read actions, scheduled send, and import of real
OpenPGP public keys — covered by 52 unit tests (`cd app && npm test`).

New here? Read [docs/overview.md](docs/overview.md), then
[docs/encryption.md](docs/encryption.md). Looking for what to build next?
[docs/features.md](docs/features.md). Wondering what actually works today, and
what is merely written down? [docs/implementation-status.md](docs/implementation-status.md)
— it is deliberately pessimistic and lists every unverified claim.

## The one-paragraph summary for skeptics

There is no magic. CryptMail generates an OpenPGP-style keypair on your device,
publishes your **public** key so other users can find it, and uses recipients'
public keys to encrypt outgoing mail (PGP/MIME). Only the matching private key —
which never leaves your device unencrypted — can decrypt it. Providers store and
transport the ciphertext exactly like any other email, which is why their apps
display gibberish. If a recipient isn't a CryptMail user and has no published
key, CryptMail tells you before you send and offers a passphrase-protected
"secure link" fallback instead of silently sending plaintext.
