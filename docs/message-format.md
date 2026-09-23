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

### Armor headers from removed per-email keys

Builds from 2026-09-19 to 2026-09-22 added `CryptMail-Offer` and
`CryptMail-Session` armor headers for per-email keys, and sent handshakes under
the subject `[CryptMail] Setting up per-email keys`. That feature was removed;
this build writes neither header. OpenPGP clients ignore armor headers, so such
mail still parses. A message carrying `CryptMail-Session` has no key packets
and can no longer be decrypted anywhere — only an archived copy opens.

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

## Quantum level on the wire (Level 2)

A Level 2 message is **not** PGP/MIME. It is an ordinary `text/plain`
email: a sentence saying what it is, then an armored block. Any mail system
carries it and any client shows something a person can read, which is the point
— this level is what the QKD integration looks like to the existing mail
infrastructure.

```
Subject: [Encrypted message]
X-CryptMail-Security: Level 2 — Quantum

This message is encrypted with quantum keys from a Key Manager.

-----BEGIN CRYPTMAIL QKD MESSAGE-----
Level: 2
Cipher: AES-256-GCM, key from HKDF-SHA256 over a QKD key and the sender
SAE: sae-7af975536f00
Key-ID: 3f9a01c2-b7d4-4e51-9c02-1a2b3c4d0007

base64 of (nonce ‖ ciphertext ‖ tag)
-----END CRYPTMAIL QKD MESSAGE-----
```

- **The AES key is bound to the sender.** It is
  `HKDF-SHA256(salt = Key-ID, ikm = the 1 Kb quantum key, info = "cryptmail/v2/qkd-aes" ‖ 0x00 ‖ SAE)`.
  Both ends of a link send from the whole bank, so both may pick the same key
  before either has seen the other's message; with the sender's `SAE:` in the
  derivation that is two unrelated AES keys, not one used twice. The `Cipher:`
  line names the derivation. `…over a QKD key` with nothing after it is the
  earlier one — `info = "cryptmail/v1/qkd-aes"`, no SAE — from while each end
  sent only from its half of the bank; mail sealed that way still opens, and
  nothing sends it now.
- **Level 3 (one-time pad) was removed.** A pad cannot be bound to its sender —
  the key bytes are the cipher — so it was the only reason for the halves. A
  block saying `Level: 3` is refused before any key is fetched; copies opened
  before the removal stay in the archive and still open.

- The **outer subject is the same placeholder** as every encrypted message, so
  the inbox, rules and notifications treat it as encrypted without being told.
- **Key IDs travel in the clear, deliberately** — that is what ETSI GS QKD 014
  intends, and an ID without the bank is worthless. Level 2 names exactly one.
- **Every header line is authenticated**: it is the AEAD's associated data, so
  changing `Level:`, `Cipher:`, `SAE:` or the `Key-ID:` fails the open.
- **The body is transfer-decoded before the block is read.** The envelope is
  sent as `7bit`, but that is a claim about what leaves, not a promise about
  what arrives: a provider may re-encode the body, and Gmail does. The failure
  is silent, which is why this is a rule rather than a note — `BEGIN` and `END`
  contain no character quoted-printable escapes, so the markers survive intact
  while the base64 between them is rewritten (`=` padding becomes `=3D`, long
  lines gain soft breaks). The block is then found, looks well-formed, and fails
  to open. Observed between two installs on 2026-09-21: every Level 2 and 3
  message opened on the sender and failed on the receiver (Level 3 still existed then).
  Decoding must use the part's **declared** encoding and can never be guessed
  after the fact — a base64 line ending in `=` and a quoted-printable soft break
  are the same two bytes.
- Written and read by `core/src/qkd.rs`; the envelope is
  `app/src/core/qkd.ts`. Change them and this section together.

### Sealed to recipient keys as well

When every recipient's key is held and none has changed fingerprint, the block
above is not sent as it stands. It becomes the **plaintext of an ordinary
Level 1 message**: signed, encrypted to every recipient's key and the sender's
(ML-KEM-768 + X25519), and carried in the same PGP/MIME envelope as any other
encrypted mail. On the wire it cannot be told from Level 1; the level is known
only once the outer layer is open.

- The decrypted plaintext **begins** with `-----BEGIN CRYPTMAIL QKD MESSAGE-----`
  — not the protected-headers tree. That is how the reader knows to open a
  second layer; a Level 1 message whose text merely quotes such a block does
  not start with it.
- The outer signature is the message's signature; the level is the inner
  block's.
- The archive key is the outer PGP block, as for any PGP/MIME message.
- Otherwise, with a missing or changed key, the bare text envelope above goes
  as before. Built in `app/src/core/nativeCore.ts`, chosen in `deliver`
  (`app/src/state/send.ts`).

## Quantum link setup on the wire (BB84)

Three PGP/MIME messages — the same envelope as Level 1, sealed to the
recipient's ML-KEM-768 + X25519 key and signed — told apart by their outer
subject (`Setting up a quantum link (n of 3)`, in the clear so a sync can route
them) and confirmed by the block inside the decrypted body:

| Block | Carries |
|---|---|
| `-----BEGIN CRYPTMAIL QKD PHOTONS-----` | the sending SAE, `n`, and two packed bitsets — the states and the bases they were prepared in |
| `-----BEGIN CRYPTMAIL QKD MEASUREMENT-----` | the measuring SAE, its bases, and its result at a random sample of positions |
| `-----BEGIN CRYPTMAIL QKD VERDICT-----` | which positions agreed, the measured error rate, and how many positions it was measured over |

Each block is base64 JSON. Leg 1 is the only large one — at 32 states per key
byte a full bank is ~130 KB, verified through Gmail. The bodies are fixed text
(`app/src/core/bb84.ts`), so nothing a user wrote is ever an argument to them.
The protocol itself is `core/src/bb84.rs`.

A leg that arrives unencrypted, unsigned, or signed by any key but the
contact's known one is refused (`app/src/state/bb84.ts`): the states in a plain
leg were readable on the way, so a bank built from them would not be secret.
Starting a link therefore needs the other end's key first.

## Design notes

- We keep `Content-Type: multipart/encrypted` rather than dumping armor into a
  plain-text body, so standards-aware clients treat it correctly and our own
  detection is unambiguous.
- Attachment filenames and types live *inside* the encrypted tree, so the provider
  cannot see them — only the outer `encrypted.asc` name.
- Threading: `In-Reply-To`/`References` stay in the clear (needed for provider
  threading), so conversation structure is metadata the provider can observe.
