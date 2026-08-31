# Prototype Implementation Plan

Concrete build plan for **Phase 0** ([roadmap.md](roadmap.md)), revised for a
**mobile-first, zero-cost** target.

## The one thing this prototype must prove

> Alice sends from CryptMail on Android to Bob. Gmail's web UI shows Bob
> `-----BEGIN PGP MESSAGE-----`. CryptMail on Bob's phone shows
> "Hey, are we still on for lunch?"

Everything below exists to reach that sentence. Anything that doesn't serve it is
cut — see [Deliberately out of scope](#deliberately-out-of-scope).

---

## Shape of the prototype

**Android only. Gmail only. No backend. No push. Manual key exchange.**

```
┌─────────────────────────────────────────────┐
│  React Native app (TypeScript)              │
│  · OAuth screen  · Inbox  · Compose         │
│  · Key screen (show mine / paste theirs)    │
└───────────────────┬─────────────────────────┘
                    │  UniFFI-generated Kotlin → RN turbo module
┌───────────────────▼─────────────────────────┐
│  cryptmail-core (Rust)                     │
│  · keygen / keyring   (rpgp)                │
│  · encrypt+sign / decrypt+verify            │
│  · PGP/MIME build + parse  (mail-builder,   │
│                             mail-parser)    │
└─────────────────────────────────────────────┘
                    │  HTTPS (from the RN side)
                    ▼
              Gmail REST API
```

The RN layer owns networking and UI. Rust owns every byte of crypto and MIME.
Nothing crosses the bridge except strings and file paths.

### Why no backend

The key directory, encrypted key backup, and push relay in
[architecture.md](architecture.md) are all Phase 1. The prototype swaps them for
one screen: "here's my public key (QR + copy)" / "paste your contact's key". That
removes an entire deployable service, its hosting, and its auth story from the
critical path — and proves the same claim.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Core | Rust, `pgp` (rPGP) + `mail-builder` + `mail-parser` | Pure Rust, permissive licences, no OpenSSL |
| Bindings | `uniffi` → Kotlin | Generated; hand-write only the thin RN turbo module |
| App | React Native via **Expo prebuild** + TypeScript | Not Expo Go — custom native module from day one |
| OAuth | `react-native-app-auth`, PKCE, no client secret | System Custom Tab |
| Mail | Gmail REST (`users.messages` list/get/send) | HTTPS only; no IMAP sockets |
| Store | Plain SQLite (`op-sqlite`) | **Prototype only** — see [Known debt](#known-debt) |
| Private key at rest | Android Keystore-wrapped, in app-private storage | Real from the start; hard to retrofit |
| Cost | $0 | No servers. Debug APK sideloaded to two phones |

---

## Milestones

Each is independently verifiable. Don't start the next until the check passes.

### M0 — Skeleton and toolchain
Repo layout, Rust cross-compilation to `aarch64-linux-android`, Expo prebuild
producing a debug APK that boots on a device.

**Check:** blank app launches on a physical Android phone.

### M1 — Crypto core, headless
`cryptmail-core` as a plain Rust library, tested with `cargo test` and no app
involved:
- Generate a Curve25519 keypair (EdDSA sign + X25519 encrypt subkey).
- Export/import ASCII-armored public keys.
- Encrypt+sign a byte slice to N recipients; decrypt+verify.

**Check:** a round-trip unit test passes, and `gpg --decrypt` on the desktop can
read a message the core produced for a GnuPG-generated key. That second check
catches format errors early, when they're cheap.

### M2 — Core on the phone
UniFFI scaffolding, Kotlin bindings, RN turbo module wrapping four calls:
`generateKeypair`, `exportPublicKey`, `importPublicKey`, `encrypt`, `decrypt`.

**Check:** a debug screen generates a keypair on-device and displays its
fingerprint. Private key is written Keystore-wrapped, never to JS.

### M3 — Gmail OAuth
`react-native-app-auth`, PKCE, scopes `gmail.readonly` + `gmail.send`. Google
Cloud project in testing mode with both test accounts added.

**Check:** sign in, and a raw call to `users.getProfile` returns your address.
Tokens land in encrypted storage, and refresh works after force-quitting.

### M4 — Gmail read + send, plaintext
Thin TypeScript client: list recent message IDs, fetch `format=RAW`, send a
`base64url` RFC 5322 message.

**Check:** app lists your last 20 subjects; app sends a plaintext email that
arrives in Gmail.

### M5 — PGP/MIME assembly and detection
In Rust, build the exact envelope from [message-format.md](message-format.md):
`multipart/encrypted`, `protocol="application/pgp-encrypted"`, `Version: 1`
part, armored part, placeholder `Subject: [Encrypted message]`, real subject as
a protected header inside. And the inverse: detect + parse + restore the inner
subject.

**Check:** `buildEncrypted` → `parseEncrypted` round-trips subject and body
through a full RFC 5322 string, tested in Rust.

### M6 — Full wire-up
Compose screen → resolve recipient key from the local ring → M5 → M4 send.
Inbox → fetch raw → detect PGP/MIME → decrypt → render with a lock badge and
signature state. **Fail-safe:** if the recipient has no key, Send is disabled
with an explanation. No silent plaintext, ever — that rule from
[encryption.md](encryption.md) applies to the prototype too.

**Check:** the sentence at the top of this document, on two real phones.

### M7 — Capture the proof
Screenshots: Gmail web showing ciphertext beside CryptMail showing plaintext.
This is your demo, your README hero image, and your regression baseline.

---

## Ordering rationale

M1 before M2, and M1 verified against GnuPG, because **OpenPGP format bugs are
the highest-risk unknown** and the only one that invalidates the product claim.
Finding them in `cargo test` costs minutes; finding them after the RN bridge
exists costs days of ambiguity about which layer is wrong.

M4 (plaintext send) before M5/M6 for the same reason: prove Gmail transport
independently, so that when an encrypted send fails you already know transport
works.

---

## Risks

| Risk | Mitigation |
|---|---|
| **rPGP API churn / missing PGP-MIME helpers** | rPGP does crypto, not MIME — you assemble the envelope yourself in M5. Budget real time for it; it's fiddly, not hard |
| **Rust ⇄ Android NDK cross-compilation** | Historically the biggest time sink. Use `cargo-ndk`; pin NDK version. Solve it in M0 while the surface is trivial |
| **Gmail restricted scopes** | `gmail.readonly` is restricted. Testing mode caps you at 100 users — fine for the prototype, but verification + CASA gates public launch. Start that clock early |
| **Large attachments over the bridge** | Attachments ship as base64 strings, capped at the provider's own 25 MB and refused before they are read (`mail/attachment.ts`); a 25 MB file is a ~33 MB string copied several times. Autosaved drafts hold far less and name what they could not keep. Real fix (file paths, streaming in Rust) is Phase 1 |
| **Protected-headers interop** | Non-CryptMail PGP clients vary in support. Prototype only needs CryptMail↔CryptMail; note deviations, don't chase them |

---

## Deliberately out of scope

Autocrypt auto-key-exchange · key directory · WKD · encrypted key backup and
recovery codes · push notifications · SQLCipher · attachments · Outlook/Graph ·
generic IMAP · iOS · multi-device · key rotation and revocation · secure-link
fallback · search · threading.

All of these are Phase 1+ in [roadmap.md](roadmap.md). Adding any one of them to
the prototype delays the proof without strengthening it.

**Closest call:** Autocrypt. Emitting and parsing the header is genuinely cheap
in Rust and it removes the manual key-paste step entirely. If M6 lands early,
this is the single best thing to pull forward.

---

## Known debt

Things the prototype does wrong on purpose, to be paid down in Phase 1:

- **Plain SQLite, not SQLCipher.** Cached plaintext bodies sit unencrypted on
  disk. The private key is Keystore-wrapped, so this is a cache-confidentiality
  gap, not a key-compromise one — but it directly contradicts
  [security.md](security.md) and must not ship to users.
- **No key verification UI.** Every imported key is trusted on first use. No
  fingerprint comparison, no "key changed" warning.
- **No token revocation handling.** Expired refresh tokens crash rather than
  re-prompt.
- **Debug-signed APK.** Sideload only.

---

## Exit criteria

The prototype is done when all of the following hold:

1. Two Gmail accounts on two Android phones exchange an encrypted message.
2. Gmail web shows ciphertext for that message; CryptMail shows plaintext and a
   valid signature.
3. Sending to a recipient with no known key is blocked with a clear explanation.
4. The private key is never present in JavaScript memory and never written
   unwrapped to disk.
5. `cargo test` covers keygen, encrypt/decrypt round-trip, and PGP/MIME
   build/parse round-trip.

Then, and only then, start Phase 1 — and start with the backend key directory,
because manual key pasting is the prototype's most obviously unshippable seam.
