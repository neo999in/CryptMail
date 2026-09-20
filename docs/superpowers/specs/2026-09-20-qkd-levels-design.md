# QKD integration and the three security levels — design

Written 2026-09-20 on `feat/qkd` (cut from `feat/per-email-keys-only`), merged
into `main` the same day.

Answers a problem statement: integrate Quantum Key Distribution into an
existing email infrastructure, take the keys from a Key Manager (KM) at each
end, keep full interoperability with ordinary mail, encrypt in the client, and
let the user switch between three security levels.

## Status

| | |
|---|---|
| Simulated KM: bank of 100 × 1 Kb keys, ETSI-014-shaped `enc_keys`/`dec_keys`, link between two ends | **built** — [`core/src/km.rs`](../../../core/src/km.rs) |
| Level 2 (quantum-aided AES) and Level 3 (one-time pad) | **built** — [`core/src/qkd.rs`](../../../core/src/qkd.rs) |
| FFI, Kotlin, TypeScript bridge, envelope | **built** — `ffi.rs`, `CryptMailCoreModule.kt`, [`app/src/core/qkd.ts`](../../../app/src/core/qkd.ts) |
| Level picker in compose, Key Manager screen, level shown on an opened message | **built** — `ComposeScreen`, [`KeyManagerScreen`](../../../app/src/screens/KeyManagerScreen.tsx), `MessageScreen` |
| Tests | `cargo test` **95** (9 in `tests/qkd.rs`, 4 KM unit); app suite **1,795** (8 in `core/__tests__/qkd-test.ts`, 4 more in `perEmailOnly-test.ts`) |
| On a device | ✅ emulator, one install: the KM screen, and a Level 2 and a Level 3 message each sent through Gmail, opened with its level named, and reopened from the archive. Keys spent as expected (3 per Level 3 message here, 1 per Level 2). ⛔ **opening through the Key Manager rather than the archive** — on one install the sender's own archived copy always answers first, so that needs two linked phones |
| Real KM hardware | **not built** — the simulator implements the same call shape |

**The Key Manager is simulated and gives no quantum security.** Its keys come
from the OS random generator, not a quantum channel. What is real is the
integration: the same call shape a vendor KM exposes, keys spent once, and two
ends holding the same bank.

## The levels

| Level | Seals with | Keys from | Size cost |
|---|---|---|---|
| 1 — No quantum security | OpenPGP (ML-KEM-768 + X25519 hybrid, as before) | the recipient's long-term public key | — |
| 2 — Quantum-aided AES | AES-256-GCM, key = HKDF-SHA256(quantum key, key id) | one 1 Kb key from the KM | 1 key per message |
| 3 — Quantum secure (OTP) | one-time pad (XOR), HMAC-SHA256 to authenticate | one 1 Kb key per 128 bytes, plus one for the MAC | 1 key per 128 bytes + 1 |
| 4 — Post-quantum per-email keys (**default**) | a per-email key over the ratchet | the session with that contact | — |

Level 4 is what this branch's parent already sent
([per-email keys](2026-09-19-per-email-keys-design.md)); it is the additional
"other post-quantum standard" the problem statement allows, and stays the
default. Level 1 is the explicit "no quantum security" option, and is the one
place this branch still seals to a long-term key.

**Why the MAC on Level 3.** A pad alone is malleable: anyone can flip bits and
the receiver cannot tell. So one further quantum key authenticates the
ciphertext and the header with HMAC-SHA256. The pad is
information-theoretically secure; the MAC is computational. A Wegman–Carter MAC
would make that half information-theoretic too, at the cost of more key.

**Why HKDF on Level 2.** The quantum key is the entropy; AES does the bulk
work, so one 1 Kb key covers a message of any size, attachments included. The
key id salts the derivation, so two messages never share an AES key.

## The Key Manager

**One login.** The KM account *is* the signed-in mailbox: each address gets its
own bank, created on first use, and signing in to the mail signs you in to its
Key Manager. The problem statement asks for independent logins; this is the
deliberate departure, chosen for one less password to lose. The bank is sealed
with AES-256-GCM under a key derived (HKDF) from this install's Keystore
passphrase *and* the address, so it opens only on this phone, only for that
mailbox. Restoring the separate login means adding a password to the key
derivation in `km.rs` and a login screen; nothing above that layer changes.

**ETSI GS QKD 014 shape.** `enc_keys(number)` hands the sender fresh keys with
their IDs and marks them issued; `dec_keys(ids)` returns the same keys to the
receiver and **deletes** them. A vendor KM would replace `km.rs` and nothing
that calls it. Key IDs are UUID-shaped, and their last four hex digits record
the key's slot, which is what keeps the two halves apart as keys are deleted.

**Two ends.** Real KMs share keys because the quantum link produced them at
both ends. Here, *Link another phone* seals this bank under a one-time code
(HKDF → AES-256-GCM) for the other phone to adopt. The exporter becomes
**master** and sends only from the first 50 keys; the importer is **slave** and
sends only from the last 50 — ETSI's roles — so the two ends can never pick the
same key, which for a one-time pad would be fatal. Before any link, a bank is
**solo** and sends from all 100: that is mail to yourself, and the sender's own
copy.

## On the wire

A Level 2/3 email is an ordinary `text/plain` message: one sentence saying what
it is, then an armor block. Any mail system carries it, any client displays it.

```text
Subject: [Encrypted message]
X-CryptMail-Security: Level 3 — Quantum secure (one-time pad)

This message is encrypted with quantum keys (Level 3 …).
Open it in CryptMail on a device whose Key Manager holds the matching keys.

-----BEGIN CRYPTMAIL QKD MESSAGE-----
Level: 3
Cipher: one-time pad, HMAC-SHA256 with a QKD key
SAE: sae-7af975536f00
Key-ID: 1c0e…-0000
Key-ID: 9b21…-0001

<base64: ciphertext ‖ MAC>
-----END CRYPTMAIL QKD MESSAGE-----
```

The subject is the same placeholder every encrypted message uses, so the inbox,
rules, notifications and the spam engine treat it as encrypted with no change.
Key IDs travel in the clear, as ETSI intends: an ID without the bank is
worthless. Every header line is authenticated — the GCM AAD at Level 2, the
HMAC at Level 3 — so nobody can swap the level or the key list.

## In the app

- **Compose** has a level picker (`L1 · PGP`, `L2 · Q-AES`, `L3 · OTP`,
  `L4 · PQC`). It reads the KM when a quantum level is picked and says how many
  keys the message will spend of how many are left. Level 3 blocks Send when
  the message needs more keys than the bank has, and says so.
- **`deliver`** branches on the level: 2/3 need no recipient key at all, so the
  key checks are skipped; 1 keeps the key checks but no session check; 4 is the
  per-email-key path with its handshake. The chosen level rides with a held
  message so a drain sends it the way it was written.
- **Opening** — `looksEncrypted` recognises the QKD block, and `parseEncrypted`
  passes the signed-in mailbox so the right bank opens it. The keys are deleted
  as it opens, so a Level 2/3 message **opens once**: it is archived exactly as
  a per-email-key message is (`store/archiveStore.ts`), before sending and on
  first open.
- **Key Manager screen** (Settings → Quantum Key Manager): account, SAE ID,
  link state, keys left, key size, refill, and both halves of linking.

## What this does not do

- **No quantum hardware, and no real QKD.** The simulator says so on its own
  screen.
- **No network KM.** A vendor KM speaks ETSI 014 over HTTPS; this one is
  in-process, which is what the user chose so two phones need no server.
- **Level 3 is small.** 50 keys per end is 6,272 bytes of pad — short text, no
  attachments. That is inherent to a one-time pad, not a shortcut here.
- **Levels 2 and 3 authenticate, but do not sign.** Holding the bank is what
  proves the sender, so `signature` is reported as `none` rather than claimed.
- **A refilled or relinked bank abandons unopened mail**, since its keys are
  gone. The refill dialog says so.
- **Not yet run on a device end to end.** The KM screen and the compose flow
  were seen on the emulator; sending and reopening a Level 2/3 message was not.

## Verification

```bash
cd core && cargo test                      # 95, incl. tests/qkd.rs
cd app  && npx tsc --noEmit && npm test -- --ci   # 1,795
```

Next: link two installs and exchange one message each way. That is what
exercises `dec_keys` on the receiving side — sending to yourself always reads
the archived copy back, so it never gets there.
