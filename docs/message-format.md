# Message Format on the Wire

This shows exactly what an encrypted CryptMail message looks like as it sits in
a mailbox — the thing that renders as ciphertext in Gmail/Outlook and as normal
mail in CryptMail. Format is **PGP/MIME** (RFC 3156) with **protected headers**.

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

### Armor headers (per-email keys)

The armored block may open with armor headers, which OpenPGP clients ignore and
`mime.ts` passes through untouched. Each value is base64 split into 64-character
lines under one repeated key, since armor headers cannot fold:

```
-----BEGIN PGP MESSAGE-----
CryptMail-Offer: AQAAAAAAAAAA…          ← every message CryptMail sends
CryptMail-Offer: …
CryptMail-Session: AQEAAAAA…            ← forward-secret messages only
CryptMail-Session: …

wcBMA…
-----END PGP MESSAGE-----
```

- **`CryptMail-Offer`** — the sending device's offer key, signed by the sender's
  identity. How a contact learns this device can receive per-email keys.
- **`CryptMail-Session`** — one entry per recipient device, each carrying the
  message's content key wrapped under a one-time key. A message with this header
  has **no key packets**: no long-term key, the sender's included, can open it.

A message carrying `CryptMail-Session` is otherwise the same PGP/MIME envelope.
Layout of both values:
[per-email keys](superpowers/specs/2026-09-19-per-email-keys-design.md#on-the-wire).

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

After decryption CryptMail reads the inner `Subject` and restores it in the UI,
so the user sees "Lunch on Friday?" while Gmail only ever saw
`[Encrypted message]`.

### Attachment parts

Implemented by `buildProtectedInner` / `parseProtectedInner` in
`app/src/core/mime.ts`, and by `attachmentPart` for one file:

- The body is always the **first** part; every attachment follows it.
- A message written with formatting (features.md 0.9) has a
  `multipart/alternative` body part instead of a bare `text/plain` one:
  `text/plain; charset=utf-8` first, then `text/html; charset=utf-8` with
  `Content-Transfer-Encoding: base64` wrapped at 76 columns — the editor writes
  a paragraph as one line, and a line past RFC 5322's 998 octets is one a
  provider may rewrap. The text is derived from the HTML (`compose/richText.ts`)
  and is not optional: it is what the search index stores and what a reader
  without an HTML renderer shows. A message with no formatting is the single
  `text/plain` part, unchanged. The same body shape is used by the deliberately
  unencrypted message (`buildPlaintext`), where both alternatives are in the
  clear like everything else in it.
- `Content-Transfer-Encoding: base64`, wrapped at 76 columns (RFC 2045) — a
  provider that rewrapped a longer line would break the signature over the tree.
- `Content-Disposition: attachment; filename="…"`, or `inline` with a
  `Content-ID` for an image the body refers to as `cid:`.
- A `text/plain` part with no filename is the body, not a file; a `text/plain`
  part *with* one is a file. That single rule is what keeps the two apart on the
  way back in, and it applies to `text/html` the same way.

**Reading is wider than writing.** The list above specifies the tree CryptMail
*emits*: at most one level of nesting, for the alternative above. `parseProtectedInner` reads trees sealed by any PGP
client, and those nest: Thunderbird and ProtonMail put a `multipart/alternative`
holding `text/plain` and `text/html` inside the mixed part, and transfer-encode
both. So the reader descends through nested multiparts and decodes each body
against its own `Content-Transfer-Encoding` — without which an HTML part arrives
with `=3D` in place of every `=`, and every link in it is malformed. Both bodies
are returned; the reader renders the HTML (features.md 0.9) and the search index
stores the text.

**Size.** A message may carry 5 MB of attachments, and a file past it is refused
before it is read. Two things set that: sizes compound (base64 +33%, then armor
+33%, so a provider's 25 MB *message* limit allows only ~14 MB of file), and
content is carried as base64 strings because that is all that crosses the core
boundary — a 25 MB file measures 21 s to seal and 45 s to open, with peak memory
in gigabytes. The streaming path that removes the second constraint (file paths,
chunked read in Rust) is Phase 1 work. A separate and much
smaller budget governs what an autosaved *draft* may hold, which is a storage
limit, not a format one. See `app/src/mail/attachment.ts` and prototype-plan.md.

An **unencrypted** message (the deliberate plaintext mode) uses the same part
shape in a top-level `multipart/mixed` — where the filenames are visible to every
hop, which is exactly what that mode means and what compose says before it is
chosen.

## Signed + encrypted

The inner content is **signed then encrypted** (OpenPGP combined
sign+encrypt operation). On decrypt, CryptMail verifies the signature against
the sender's known public key and shows the trust state
([key-management.md](key-management.md)).

## How non-CryptMail clients render this

- **Gmail / Outlook web:** show the placeholder subject and, in the body, either
  the raw `-----BEGIN PGP MESSAGE-----` text or an `encrypted.asc` attachment they
  can't open. Effectively unreadable → the intended behavior.
- **A PGP-capable client (Thunderbird, Proton, GnuPG):** can actually decrypt it
  if the user holds the key — this is the interop bonus of using a standard.

## Secure-link fallback format (recipient has no key)

For a recipient with no key, we don't produce PGP/MIME. Instead:

- The body is a normal `text/html`/`text/plain` message containing a link:
  `https://read.cryptmail.app/m/<id>#<optional-key-fragment>`.
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
