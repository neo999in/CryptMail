# Product Overview

## Vision

Give people confidential email without asking them to leave the mailbox they
already have. You sign in with Gmail / Outlook / iCloud / any IMAP account, and
CryptMail layers end-to-end encryption on top. Your contacts, your address,
your history — unchanged. What changes is that messages between CryptMail users
are unreadable to anyone in between, including the mail providers themselves.

## The core promise

1. **Bring your own account.** No new email address. OAuth into Gmail/Outlook or
   enter IMAP/SMTP credentials for anything else.
2. **Encrypt on send.** Mail sent through CryptMail to another CryptMail user
   is end-to-end encrypted before it leaves the device.
3. **Ciphertext everywhere else.** Because the encrypted message is stored in the
   normal mailbox, the provider's own web/app UI shows only an encrypted blob.
4. **Seamless inside the app.** In CryptMail the same message renders as normal
   readable email. Decryption happens locally.

## Goals

- Zero-friction onboarding via existing providers (OAuth first).
- Automatic, opportunistic key exchange — no manual "paste my public key" step
  for the common case.
- Encrypted subject, body, and attachments.
- Works on desktop and mobile; local-first with optional multi-device sync.
- Interoperate with the OpenPGP ecosystem where practical (Autocrypt, PGP/MIME).
- Fail safe: never silently downgrade to plaintext when the user expects
  encryption.

## Non-goals (at least for v1)

- **Not** a new mail server or a new email address.
- **Not** metadata-hiding. Providers still see sender, recipient, timestamps, and
  message size. Hiding metadata requires a different architecture (see
  [security.md](security.md)). We encrypt *content*, not the *envelope*.
- **Not** a guarantee of encryption to non-users. If a recipient has no key, we
  warn and offer a fallback — we do not pretend it's encrypted.
- **Not** a compliance/archival product (eDiscovery, DLP) in v1.

## Primary user stories

- *As a privacy-conscious user*, I sign in with my Gmail account and immediately
  keep using my inbox; new mail I send to other CryptMail users is encrypted
  without me doing anything.
- *As a recipient*, I get an email that looks encrypted in Gmail; I open
  CryptMail and read it normally.
- *As a sender to a non-user*, I'm warned "this person can't receive encrypted
  mail" and can choose: send plaintext, or send a secure link.
- *As someone who lost their phone*, I recover my private key with a recovery
  code and read my history again.
- *As a multi-device user*, I add CryptMail on my laptop and my existing
  encrypted mail becomes readable there after I approve the new device.

## What "shows as encrypted in Gmail" actually means

The message body in the recipient's mailbox is a PGP/MIME structure whose
payload is an ASCII-armored ciphertext block:

```
-----BEGIN PGP MESSAGE-----

hQIMA4z... (hundreds of lines of base64) ...==
=Ab3D
-----END PGP MESSAGE-----
```

Any non-CryptMail client renders this as-is (or as an unopenable attachment).
The human-readable subject is replaced with a placeholder like
`[Encrypted message]`, and the real subject travels encrypted inside the payload
(see [message-format.md](message-format.md)).

## Success criteria for the MVP

- A user can OAuth into Gmail, send an encrypted message to another CryptMail
  user, and that user can read it — while Gmail's web UI shows ciphertext.
- Key exchange happens automatically for two users who have emailed each other.
- Losing and recovering access to the private key both work.
