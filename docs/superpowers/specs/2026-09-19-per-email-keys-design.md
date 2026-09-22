# Per-email keys — design

> **Removed on 2026-09-22.** Per-email keys (Level 4) are no longer in the core
> or the app, and Level 1 is the default. Only the device-transfer part still
> applies, minus the sessions: it now moves the identity, the Key Manager bank
> and the archive. Kept as history.

Written 2026-09-19. Adds forward secrecy between CryptMail users: each message
gets its own key, destroyed once used, so no long-term key — stolen, seized, or
broken by a future quantum computer — can reopen it.

[encryption.md](../../encryption.md) conceded "no perfect forward secrecy", and
[post-quantum.md](../../post-quantum.md) named it as what compounds
harvest-now-decrypt-later: Gmail keeps every ciphertext indefinitely, and one
long-term key opened all of it. This closes that for mail between CryptMail
users. Mail with anyone else is unchanged.

> **Per-email keys only** — on `main` since 2026-09-20. Nothing the user writes
> is ever sealed to a long-term key, unless they choose Level 1
> ([QKD levels](2026-09-20-qkd-levels-design.md)). See
> [§Per-email keys only](#per-email-keys-only) — it overrides decisions 1, 3 and
> 4 below, and "the first message is not forward-secret" under *What this does
> not do*. `feat/per-email-keys` keeps the default-on design with the
> long-term-key fallback.

## Status

| | |
|---|---|
| Ratchet, storage, send/receive in the Rust core | **built** — `core/src/{session,session_store,forward}.rs` |
| FFI, Kotlin module, regenerated bindings | **built** — `seal` / `open` |
| TypeScript wiring and the archive | **built** — `nativeCore.ts`, `store/archiveStore.ts`, `state/mailbox.ts`, `state/send.ts` |
| Tests | `cargo test` 82 (incl. 13 in `forward_secrecy.rs`, 8 in `transfer.rs`); app suite 1,783 (incl. 11 in `perEmailOnly-test.ts`) |
| Interop | `spike/interop-rpgp-sequoia` **14/14**: `seal` refuses a client with no session; Sequoia reads the handshake |
| Per-email keys only: handshake, `awaiting-session`, strict `seal` | **built** on `feat/per-email-keys-only` — `state/handshake.ts`, `store/handshakeStore.ts`, `core/handshake.ts` |
| On a device | **emulator, one install**: seal → Gmail → open round trip, offer header survives Gmail, transfer export + resume. Two installs exchanging per-email keys: **not yet run** |
| Device transfer | **built** — `core/src/transfer.rs`, `screens/TransferScreen.tsx`; the restore field takes a transfer file. Not yet run on a device |
| QR pairing | **not built** |
| Compose knowing about sessions before Send | **not built** — compose checks keys only, so a message to someone without a session briefly looks like it is sending before it moves to Scheduled |

Where the work stands and how to pick it up: [handoff](../../handoff-2026-09-19-per-email-keys.md).

The construction is ours and **unaudited**. The primitives are not (ML-KEM-768,
X25519, HKDF-SHA256, HMAC-SHA256, AES-256-GCM — all through the crates rPGP
already uses), but their composition is new code on the most sensitive path in
the product. Treat it accordingly.

## Decisions

1. **Keep OpenPGP.** The message is still a signed SEIPDv2 message; only how its
   content key reaches the reader changes. Mail with non-CryptMail users is
   byte-for-byte the old path.
2. **The ratchet lives in Rust.** Chain keys are private key material, and
   CLAUDE.md rule 3 keeps those out of JavaScript. `state/send.ts` never sees
   one.
3. **Per-email keys are the default** between CryptMail users, not an opt-in —
   a decision taken after weighing the loss of history on a new device, which
   device transfer is meant to cover.
4. **All or nothing per message.** One message has one content key; a single
   long-term-key packet would let that key open it for everyone. So a message
   is forward-secret only when *every* recipient device can take it by
   session, and `seal` says which happened.
5. **No copy for the sender.** A copy under our own long-term key would reopen
   everything we ever sent. The app archives what it sent instead.

### Where this departs from the plan, and why

- **No SKESK, no password S2K.** rPGP's builder has `set_session_key`, and
  `Message::decrypt_with_session_key` is its inverse (`pgp-0.20.0`,
  `composed/message/builder.rs:545`). The message carries **no key packets at
  all**; the key travels in the session entries. Cleaner than smuggling a raw
  key through a password S2K, which the plan had already ruled out.
- **Armor headers, not an `X-CryptMail-Session` mail header.** The session data
  rides inside the armored block, which `mime.ts` already forwards untouched,
  so the envelope and `docs/message-format.md`'s structure do not change and
  nothing depends on a provider preserving a custom header. Headers are split
  into 64-character lines under a repeated key: armor headers cannot fold, and
  one long line invites a mail system to re-encode the part.
- **Every message carries a signed offer.** The plan assumed a session could
  bootstrap from the first key-encrypted message. It needs more: the recipient
  of a session's first message must know who opened it *before* decrypting, and
  an attacker must not be able to advertise keys in someone else's name. A
  device-level offer key, signed by the identity, solves both.

## The protocol

### Offers

Each device holds a random device id and an **offer keypair** (hybrid ML-KEM-768
+ X25519). Every message it sends — forward-secret or not — carries

```
CryptMail-Offer: version | device id | created | offer public key | signature
```

signed (detached, Ed25519, `DetachedSignature`) by the sender's identity. A
recipient stores an offer only when it verifies against the sender's key **and**
the message's own signature is valid and by the same key — so a relayed offer
cannot attach itself to someone else's mail
(`an_offer_signed_by_someone_else_is_not_adopted`).

Offers rotate every 30 days; the current and previous are kept. That bounds how
long a conversation's *first* message stays openable by someone who seizes the
device — it was encapsulated to the offer key, not to a per-message key.

### Sessions

A KEM double ratchet with a hybrid KEM (`core/src/session.rs`):

- **Epochs.** A sender opens an epoch by encapsulating to the receiving key the
  peer last advertised: ML-KEM-768 encapsulation **and** an X25519 exchange,
  combined with HKDF over both secrets, the ML-KEM ciphertext, the ephemeral
  key, the recipient's public keys, the session id and both identities.
  `(root, chain) = HKDF(root, shared secret)`.
- **Epochs alternate.** A side opens a new epoch only after reading the peer's
  newest; otherwise it keeps sending on its current chain. That is what keeps
  the root keys in step when both people write at once.
- **Chains.** `message key = HMAC(chain, 1)`, `next chain = HMAC(chain, 2)`.
  One message key per message, zeroized after use.
- **Receiving keys rotate.** Each epoch the sender generates a fresh receiving
  keypair and advertises it; three are kept for late mail, older ones deleted.
- **Skipped keys.** Out-of-order mail is opened from keys kept for it — at most
  256, and a gap wider than that is refused rather than precomputed. These are
  the one set of keys that are not yet forward-secret.

### On the wire

```
CryptMail-Session: 1 | count | entry…
entry = step | nonce | AES-256-GCM(message key, content key; aad = step ‖ sender)
step  = session id | receiving-key id | ML-KEM ciphertext | X25519 ephemeral
        | sender's receiving key | n | pn
```

One entry per recipient device. The step is the AEAD associated data of the
key it carries, so altering any of it — swapping the advertised key for an
attacker's, say — makes the entry fail to open rather than decrypt to something
else (`a_tampered_step_does_not_open`). The nonce is random even though a
message key is used once, so a bug that re-derived one would not also be a GCM
nonce reuse.

**Size.** An entry is 2,428 bytes (≈3.3 KB armored) per recipient device, and the
offer ≈1.7 KB armored on every message. A forward-secret message to one person
is therefore somewhat *larger* than a long-term-key one, not smaller as the plan
guessed: the entry repeats the epoch's encapsulation and advertised key so that
any single message can open its epoch if earlier ones are lost.

### Transactions

`send`, `receive` and `accept` never mutate. The core persists the next state:

- on **send**, before returning the message — a crash after costs the recipient
  a skipped key, the other order would re-derive a spent one;
- on **receive**, only after the message decrypts and, for a first message, after
  its inner signature is confirmed to be from the offer's owner — a forged header
  must not advance the state.

Session files live in `sessions/` beside the identity, AES-256-GCM under a key
HKDF-derived from the Keystore-held passphrase, each record's name as its
associated data, written by rename. They are never backed up (`allowBackup:
false`): restored state rewinds and re-derives keys it already used.

## In the app

- `nativeCore` calls `seal` / `open` when the installed `.so` has them and falls
  back to `encryptSign` / `decryptVerify` when it does not — a JS bundle can be
  newer than the native library.
- **`store/archiveStore.ts`** keeps the decrypted copy of every forward-secret
  message, because nothing can decrypt it a second time. Keyed by a hash of the
  armored block with whitespace stripped (providers rewrite line endings), so
  the copy we built and the copy Gmail returns match, and a borrowed
  `Message-ID` cannot claim another message's entry. Durable storage, never
  evicted, cleared only by removing the account.
- `openMessage` reads the archive before asking the core and writes it, awaited,
  on a first open. If writing fails the message is still shown, with a notice
  that it will not open again — it has just been decrypted for the last time.
- `deliver` archives a forward-secret message **before** sending it and does
  not send if that fails.

## What this does not do

- **The first message to someone is not forward-secret.** You hold no offer from
  a person until they have written to you from that device, so the first
  message goes the old way. Every one after is per-email.
- **Only devices that have written to you receive per-email mail.** There is no
  server listing a person's devices. A phone that has sent you mail gets its own
  entry; a laptop that never has cannot open a forward-secret message sent to
  that person. This is the sharpest usability cost here, and the reason device
  transfer (moving sessions to a replacement phone, below) exists.
- **The archive is exactly as safe as the device.** Anyone who can unlock the app
  can read it. What forward secrecy still buys is everything off the device.
- **A crash between the core consuming a key and the archive write loses that
  message.** The window is small; it is not zero.
- **Signatures are still Ed25519**, which a quantum computer could forge — Stage 2
  of `post-quantum.md`, unchanged.
- **Metadata.** The provider sees that a message is CryptMail, the sender's device
  id and offer key, session ids, receiving-key ids, message counters, and how
  many recipient devices a message went to.
- **Both people opening a session at once** leaves two sessions for that pair of
  devices. Both work; each message then carries one more entry than it needs.

## Per-email keys only

The `feat/per-email-keys-only` branch removes the long-term-key fallback.
Every message the user writes is sealed with a per-email key or not sent.

**The core.**
- `seal` refuses (`no-key`, detail `no-session: …`) unless every recipient
  other than the sender has a session or an offer. It never builds a
  long-term-key message.
- `handshake` builds the one long-term-key message that is left: a
  contentless first-contact message carrying this device's signed offer.
- `session_status` reports each recipient as `self`, `session`, `offer` or
  `none`.
- A handed-over phone refuses all three (`unavailable`, `handed-over: …`).
- `open` still reads long-term-key mail. What other people send is not ours
  to choose, and older mail must stay readable.

**First contact.**
1. Alice writes to Bob, who has a key but no session with her.
   `deliver` holds the message (`awaiting-session`) and sends Bob a handshake:
   the fixed text in `core/handshake.ts`, sealed to his long-term key, with
   Alice's offer in the armor. The outer subject is `HANDSHAKE_SUBJECT`, so a
   sync can find it from headers alone.
2. Bob's sync (`state/handshake.ts`, after the Autocrypt harvest) opens it.
   That files Alice's offer under the key that signed it. Bob's app then
   answers with an acknowledgement sealed with a **per-email key**, which
   opens a session. It answers only if the signature is valid, the signer is
   the keyring key for the sender's address, and the status is `offer` (so
   there is exactly one answer).
3. Alice's sync opens the acknowledgement. `open` accepts the session and the
   app archives it, since it opens once. The next drain sends the held
   message, sealed with a per-email key.

**Limits.**
- A handshake that went out is not sent again by a drain for a week; one that
  failed is retried after five minutes, and its reason is kept. The outbox
  shows, per address, whether a handshake went out, when, or why it failed,
  and offers **Resend handshake** to send one now regardless
  (`store/handshakeStore.ts`).
- A handshake says nothing the user wrote, and a test holds that promise
  against the bytes on the wire (`state/__tests__/perEmailOnly-test.ts`).

**Consequences.**
- **Contacts who don't use CryptMail can't receive encrypted mail.** They get
  a handshake, readable in any OpenPGP client, that explains why. The
  message waits. The only other choice is the user's explicit, separate
  "send unencrypted".
- **Mail only to yourself can't be sent encrypted.** There is no session
  with yourself. `deliver` says so.
- **The first message is delayed** until the other side's app syncs and
  answers. Nothing about it is weaker.
- **The demo core** reports everyone as `session`: it has no sessions to
  enforce, and it already says on every screen that it isn't crypto.

## Device transfer

Moving to a replacement phone, from Settings → *Move to a new phone*. A recovery
backup brings back the key; a transfer brings back everything this design made
device-bound as well.

**What travels.** One text file (`-----BEGIN CRYPTMAIL TRANSFER-----`), sealed
with AES-256-GCM under a key HKDF-derived from a 32-character code the old phone
shows once. Inside:

- the identity key, re-locked under the code exactly as a recovery backup is
  (Argon2id S2K), so it is never unlocked outside a core;
- every session-store record — this device's id and offers, each session, each
  contact's offer — opened from the old install's store key and resealed under
  the new one's on arrival;
- the archive, opened by the app (its device key stays behind) and handed to
  the core as an opaque string to seal with the rest.

HKDF rather than Argon2 for the outer layer because the code is 160 random bits
the app generated, never a human choice; the core refuses a code under 26
characters, since that argument only holds for a random one.

**Moved, never copied.** Making a transfer marks the old phone's store *handed
over*. From then on it sends the old way — no offer header, no sessions — and
reads without creating or rotating its device record, so it never forks the
offers the new phone carries on. It can still **read**: a receive step takes no
randomness, so both copies reach the same state from the same message
(`tests/transfer.rs::the_old_phone_stops_sending_by_session_but_still_reads`).
Only sending forks a session. *Keep using this phone* clears the mark, and says
it is safe only if the new phone never sent.

**Arriving.** The new phone's restore field (setup, and the Recovery screen)
takes the transfer file as readily as a backup, and tells them apart by the
armor line. The core refuses a transfer for an address other than the signed-in
mailbox before it changes anything, then adopts the key, then replaces the
session store; the app then writes the archive, and says so loudly if it
cannot — the key is already in place, and loading the file again is safe until
the new phone sends.

**Limits.** One identity and the active mailbox's archive per transfer. A
transfer is a move to *one* phone: an additional device (both in use) is still
not supported, because two senders in one session is exactly what the hand-over
prevents. The file can be large — it carries attachments of archived mail — and
is read up to 64 MB.

## Not built yet

1. **Additional devices** — both phones in use at once. Needs per-device
   sessions for your own devices (each an ordinary participant), not a copy.
2. **QR pairing** — in person, to verify fingerprints and fold off-network
   entropy into a session.
3. **Compose** — showing, per recipient, whether a message will be forward-secret,
   and saying plainly when a mixed recipient list makes it not.
4. **On-device verification** — two installs through Gmail.

## Verification

```bash
cd core && cargo test                                   # 80, incl. forward_secrecy.rs and transfer.rs
cd spike/interop-rpgp-sequoia && ./interop.sh           # 13/13 (needs python3)
cd app && npx tsc --noEmit && npm test -- --ci          # 1,766
```

Rebuilding the Android library and bindings after any change to `core/`:
`app/modules/cryptmail-core/README.md`, steps 2 and 3.
