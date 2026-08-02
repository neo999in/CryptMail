# Message Format on the Wire

This shows exactly what an encrypted CipherMail message looks like as it sits in
a mailbox — the thing that renders as ciphertext in Gmail/Outlook and as normal
mail in CipherMail. Format is **PGP/MIME** (RFC 3156) with **protected headers**.

## Anatomy of an encrypted message

```
From: alice@gmail.com
To: bob@outlook.com
Date: Wed, 22 Jul 2026 10:00:00 +0000
Subject: [Encrypted message]
Message-ID: <...>
Autocrypt: addr=alice@gmail.com; prefer-encrypt=mutual; keydata=<base64 pubkey>
MIME-Version: 1.0
Content-Type: multipart/encrypted;
  protocol="application/pgp-encrypted";
  boundary="=-=-=boundary=-=-="

--=-=-=boundary=-=-=
Content-Type: application/pgp-encrypted
Content-Description: PGP/MIME version identification

Version: 1

--=-=-=boundary=-=-=
Content-Type: application/octet-stream; name="encrypted.asc"
Content-Description: OpenPGP encrypted message
Content-Disposition: inline; filename="encrypted.asc"

-----BEGIN PGP MESSAGE-----

hQIMA4z7... (base64 ciphertext: encrypted session key + AEAD payload) ...==
=Ab3D
-----END PGP MESSAGE-----

--=-=-=boundary=-=-=--
```

### What each part does

- **Visible `Subject`** is the placeholder `[Encrypted message]`. The real
  subject is hidden inside the ciphertext (protected headers, below).
- **`Autocrypt` header** carries Alice's public key so Bob's client can encrypt
  back automatically. (Optional; the key directory/WKD are alternatives.)
- **`multipart/encrypted`** with `protocol="application/pgp-encrypted"` tells any
  PGP-aware client this is PGP/MIME.
- **First part** is the fixed `Version: 1` marker.
- **Second part** is the ASCII-armored `-----BEGIN PGP MESSAGE-----` block — the
  encrypted session key(s) + the AEAD-encrypted MIME tree.

## The encrypted inner MIME tree (after decryption)

The armored block decrypts to a complete MIME message. Using **protected
headers**, it carries its own `Subject`, and holds the body + attachments:

```
Content-Type: multipart/mixed; boundary="inner-boundary"; protected-headers="v1"
Subject: Lunch on Friday?
From: Alice <alice@gmail.com>
To: Bob <bob@outlook.com>

--inner-boundary
Content-Type: text/plain; charset=utf-8

Hey Bob, are we still on for lunch Friday at noon?

--inner-boundary
Content-Type: application/pdf; name="menu.pdf"
Content-Disposition: attachment; filename="menu.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKJ... (encrypted-at-rest because the whole tree was encrypted) ...
--inner-boundary--
```

After decryption CipherMail reads the inner `Subject` and restores it in the UI,
so the user sees "Lunch on Friday?" while Gmail only ever saw
`[Encrypted message]`.

## Signed + encrypted

The inner content is **signed then encrypted** (OpenPGP combined
sign+encrypt operation). On decrypt, CipherMail verifies the signature against
the sender's known public key and shows the trust state
([key-management.md](key-management.md)).

## How non-CipherMail clients render this

- **Gmail / Outlook web:** show the placeholder subject and, in the body, either
  the raw `-----BEGIN PGP MESSAGE-----` text or an `encrypted.asc` attachment they
  can't open. Effectively unreadable → the intended behavior.
- **A PGP-capable client (Thunderbird, Proton, GnuPG):** can actually decrypt it
  if the user holds the key — this is the interop bonus of using a standard.

## Secure-link fallback format (recipient has no key)

For a recipient with no key, we don't produce PGP/MIME. Instead:

- The body is a normal `text/html`/`text/plain` message containing a link:
  `https://read.ciphermail.app/m/<id>#<optional-key-fragment>`.
- The ciphertext is stored on the backend (or attached, encrypted to a random
  passphrase). The decryption passphrase travels **out-of-band** (never in the
  email).
- Opening the link loads a zero-knowledge web reader; the recipient enters the
  passphrase to decrypt locally in the browser. See [encryption.md](encryption.md).

## Design notes

- We keep `Content-Type: multipart/encrypted` rather than dumping armor into a
  plain-text body, so standards-aware clients treat it correctly and our own
  detection is unambiguous.
- Attachment filenames and types live *inside* the encrypted tree, so the provider
  cannot see them — only the outer `encrypted.asc` name.
- Threading: `In-Reply-To`/`References` stay in the clear (needed for provider
  threading), so conversation structure is metadata the provider can observe.
