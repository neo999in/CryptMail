# Handoff — per-email keys and device transfer (2026-09-19)

Read this first if you are picking up the encryption work in a new session.
This file says what state the work is in, what was decided, how to build and
check it, and what is next. The design itself — protocol, wire format, threat
model — is in
[superpowers/specs/2026-09-19-per-email-keys-design.md](superpowers/specs/2026-09-19-per-email-keys-design.md).

**Branches** (created with the user's permission; not pushed, not merged):

| Branch | What it is |
|---|---|
| `feat/per-email-keys` | Per-email keys on by default, with a long-term-key fallback for first contact and non-CryptMail recipients. Device transfer. Three commits on `main`. |
| `feat/per-email-keys-only` | Cut from the branch above. **Per-email keys only**: `seal` never falls back, first contact goes through a contentless handshake, and messages wait (`awaiting-session`) until it is answered. See [§8](#8-per-email-keys-only-branch). |

Claude runs git write commands in this repo only with the user's explicit
permission, as given for these branches.

---

## 1. In one paragraph

Between two CryptMail users, every email now gets its own key, and that key is
destroyed after one use (forward secrecy). So no long-term key opens that mail
again: not a stolen one, not the sender's, not one broken later by a quantum
computer. Because such a message decrypts only once, the app keeps the
decrypted copy, sealed, in a durable archive. Moving to a new phone is covered
by **device transfer**: one sealed file plus a one-time code carries the key,
the conversations and the archive.

The two branches differ on everyone else:
- **`feat/per-email-keys`:** first contact and mail to anyone who doesn't use
  CryptMail go out under long-term keys, as before.
- **`feat/per-email-keys-only`:** they never do. First contact is a
  contentless handshake, the message waits until the other app answers, and
  someone without CryptMail can't be sent encrypted mail at all (§8).

## 2. What was built

### Per-email keys (the "ratchet")

| Piece | Where |
|---|---|
| KEM double ratchet: hybrid ML-KEM-768 + X25519, HKDF/HMAC chains, skipped-key cache | [`core/src/session.rs`](../core/src/session.rs) |
| Encrypted on-disk session store (device offers, sessions, contacts' offers) | [`core/src/session_store.rs`](../core/src/session_store.rs) |
| `seal` / `open`: chooses per-email keys or long-term keys for each message; armor headers | [`core/src/forward.rs`](../core/src/forward.rs) |
| Message building with a supplied content key, detached signatures | [`core/src/message.rs`](../core/src/message.rs) |
| FFI + Kotlin | [`core/src/ffi.rs`](../core/src/ffi.rs), [`CryptMailCoreModule.kt`](../app/modules/cryptmail-core/android/src/main/java/app/cryptmail/core/CryptMailCoreModule.kt) |
| TypeScript bridge: uses `seal`/`open` when the native core has them, otherwise `encryptSign`/`decryptVerify` | [`app/src/core/nativeCore.ts`](../app/src/core/nativeCore.ts) |
| Archive of decrypted forward-secret mail (durable, never evicted, keyed by ciphertext hash) | [`app/src/store/archiveStore.ts`](../app/src/store/archiveStore.ts) |
| Archive read/write when opening and sending | [`state/mailbox.ts`](../app/src/state/mailbox.ts) (`openMessage`), [`state/send.ts`](../app/src/state/send.ts) (`deliver`, which archives **before** sending) |
| Notice when a message couldn't be archived | `OpenedMessage.notice`, shown as a Banner in `MessageScreen` |

On the wire: `CryptMail-Offer` (on every message) and `CryptMail-Session` (on
forward-secret ones) are **armor headers** inside the PGP block. `mime.ts` and
the envelope did not change, and other OpenPGP clients ignore the headers.

### Device transfer

| Piece | Where |
|---|---|
| Transfer file: sealed (AES-256-GCM, HKDF from the code); key re-locked with Argon2id; session records; archive | [`core/src/transfer.rs`](../core/src/transfer.rs) |
| Handed-over state: `hand_over`, `resume`, `export_records`, `check_records`/`replace_records`, `existing_device` | `core/src/session_store.rs` |
| A handed-over phone sends the old way and never rotates its offers | `core/src/forward.rs` |
| Core API `export_transfer`, `import_transfer`, `transfer_status`, `resume_sessions` | `core/src/lib.rs`, `ffi.rs`, Kotlin module |
| `CryptCore.exportTransfer / importTransfer / transferStatus / resumeSessions` | [`app/src/core/types.ts`](../app/src/core/types.ts), `nativeCore.ts`, `demoCore.ts` |
| Archive export/import (opens entries here, core seals them for the journey) | `archiveStore.ts`: `exportArchive`, `importArchive` |
| Service actions; the restore path recognises a transfer file | [`state/identity.ts`](../app/src/state/identity.ts): `exportTransfer`, `transferStatus`, `resumeSessions`, `restoreFromRecovery` → `receiveTransfer` |
| Old-phone UI | [`screens/TransferScreen.tsx`](../app/src/screens/TransferScreen.tsx) — Settings → *Move to a new phone*, also linked from Key recovery |
| New-phone UI | The existing restore fields in `SetupScreen` and `RecoveryScreen` take a transfer file. [`ui/restoreFile.tsx`](../app/src/ui/restoreFile.tsx) holds a large file beside the text field |
| Telling files apart, file name | [`app/src/core/transferFile.ts`](../app/src/core/transferFile.ts) |
| Larger read cap for transfer files (64 MB) | `lib/files.ts`: `TRANSFER_FILE_CAP`, `pickTextFile(cap)` |

## 3. Decisions already made — don't reopen them

The user made these explicitly. Build on them. On `feat/per-email-keys-only`,
decisions 3, 4, 6 and 9 are overridden by the user's later "per message key
mode only" — see §8.

1. **No simulated "qubits".** The user first asked for quantum concepts (qubits,
   teleportation, binding, entanglement). A simulated qubit gives no security,
   so it was not built. What each concept maps to:
   - **teleport + binding**: already provided by rPGP's RFC 9980 hybrid
     (`encrypt_to_key`, ML-KEM-768 + X25519).
   - **entanglement**: the shared ratchet state between sender and receiver.
2. **Added to the existing Rust core**, not a new core and not TypeScript.
3. **Per-email keys are on by default** between CryptMail users ("I want new
   key per email"). The user can't pick the old flow for a CryptMail contact.
4. **The first message to someone is not forward-secret.** First contact with
   someone who isn't a CryptMail user goes through the invite path.
5. **The archive is re-encrypted locally under the device key.** It is the only
   exception to "only `searchIndex` holds decrypted mail" (see CLAUDE.md).
6. **All or nothing per message.** If any recipient lacks a session, the whole
   message goes the old way. The sender's own key is never added to a
   forward-secret message.
7. **Transfer moves sessions, it never copies them.** Two phones sending in one
   session breaks it. Receiving is deterministic, so the old phone can still
   read.
8. **No backend.** Transfer is a file plus a code. The user chooses how the file
   travels.
9. **Old flow kept intact** as the fallback. Pre-existing mail opens through it
   unchanged.

## 4. What is verified

The numbers here are for `feat/per-email-keys`. The strict branch's are in §8:
82 Rust, 1,783 app, 14/14 interop.

| Claim | How | Level |
|---|---|---|
| Ratchet, store, seal/open, transfer logic | `cd core && cargo test` → **80 pass**: 31 unit, 3 foreign-signature, 11 `forward_secrecy.rs`, 9 recovery, 18 roundtrip, 8 `transfer.rs` | ✅ |
| After a transfer, the conversation continues from the new phone in both directions, and the old and new phones stay in step when reading | `tests/transfer.rs` | ✅ |
| TypeScript wiring, archive, transfer state | `cd app && npx tsc --noEmit && npm test -- --ci` → **1,766 tests, 104 suites** | ✅ |
| Interop with Sequoia, including the seal path | `spike/interop-rpgp-sequoia/interop.sh` → 13/13 (run earlier this session; needs a `python3` on PATH) | ✅ |
| Native build loads on the emulator; real crypto, no demo banner | emulator | ✅ |
| `seal` → Gmail → `open` round trip (self-sent); offer header survives Gmail; signature verifies | emulator | ✅ |
| Transfer screen: make a transfer through the native core; code shown; `handed-over.bin` written; banner; *Keep using this phone* removes the marker | emulator | ✅ |
| **Importing a transfer on a second phone** | Only Rust e2e and TS tests | ⛔ not on a device |
| **A real per-email-key exchange between two installs over Gmail** | Needs a second device and account | ⛔ |
| Physical phone | — | ⛔ emulator only this round |

Bugs the emulator found, both fixed and tested:
- The one-time-key error wording appeared for ordinary failures. It now shows
  only for messages carrying `CryptMail-Session`.
- The phone filed its own offer as a contact's. `forward::remember` now skips
  our own fingerprint.

Known on the emulator: the old messages from *Bails On Top18* and
*Parthrathod050606* don't open because they were sealed to an **older key**,
not the current `ACD3·E5C4·D6BC`. That isn't a regression. One stale
`peer-*.bin` left over from before the self-offer fix is harmless.

## 5. Building and checking it

```bash
# Tests
cd core && cargo test
cd app  && npx tsc --noEmit && npm test -- --ci

# Native library + Kotlin bindings — after ANY change under core/
cd core
cargo ndk -t arm64-v8a -t x86_64 -o ../app/android/app/src/main/jniLibs build --release
cargo run --bin uniffi-bindgen -- generate \
  --library ../app/android/app/src/main/jniLibs/arm64-v8a/libcryptmail_core.so \
  --language kotlin --out-dir ../app/modules/cryptmail-core/android/src/main/java

# APK for the emulator (x86_64 only — see traps)
cd app/android && ./gradlew assembleDebug -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Drive it — see app/.claude/skills/run-cryptmail/SKILL.md
cd app && D=.claude/skills/run-cryptmail/driver.sh
bash $D metro && bash $D launch && bash $D shot home
```

Traps hit this session:
- **`adb` is not on the Git Bash PATH.** Use
  `/c/Users/intel/AppData/Local/Android/Sdk/platform-tools/adb.exe`. The driver
  script finds it by itself.
- **The emulator runs out of storage** with a full APK (318 MB with both ABIs).
  Build x86_64 only (about 105 MB). `adb install -r` keeps app data.
  `pm trim-caches` frees cache only and doesn't touch the identity key.
- **Generate bindings from the `.so` that ships**, never a host build.
  UniFFI-generated Kotlin is untracked and gitignored, as is `jniLibs`.
- **Metro can hang** in a compile loop after Gradle writes into `app/android`
  (it ran 35 minutes). Kill the process on :8081 and run `bash $D metro` again.
  Check with `bash $D bundle-has "<string literal from your change>"`.
- **Opening Settings on the emulator:** tap the avatar top-left (device ≈108,255),
  then `tapdesc "^settings$"`.
- **`interop.sh` needs `python3`.** This machine has only `python`, so add a
  shim on PATH.
- The app lock may ask for a PIN. The emulator test install's PIN is in
  Claude's local memory, not in the repo.

## 6. What's next, in order

1. **Two-device check.** A second emulator image or a phone, signed into a
   second throwaway Gmail. On the strict branch:
   1. A writes to B. A's message waits and B gets a handshake.
   2. B's app answers on its next sync.
   3. A's next sync opens the answer, and the held message goes out.

   Then transfer one side to a third install and keep writing. This is the
   only unverified path that matters.
2. **Compose knows about sessions.** Compose checks keys only (the
   `resolveRecipients` path). On the strict branch it should also ask
   `sessionStatus`, show per recipient "needs a handshake", and say *queued*
   up front instead of briefly looking like a send. On `feat/per-email-keys`,
   show which recipients get per-email keys and when a mixed list turns them
   off.
3. **Physical phone run** of all of the above.
4. **Additional devices** (both in use at once). Needs per-device sessions for
   your own devices, not a copy. A transfer can't do this by design.
5. **QR pairing** in person: verify fingerprints and add off-network entropy.
6. Update [docs/features.md](features.md) and
   [docs/implementation-status.md](implementation-status.md) whenever any of
   the above lands.
7. **Stale docs on `feat/per-email-keys`.** Its CLAUDE.md and this handoff
   still say "uncommitted on `main`"; the strict branch's copies are current.
   Fix them on that branch if it is the one that ships.

Limits worth knowing (from the design doc):
- the construction is **unaudited**
- metadata is visible to the provider
- a crash between the core using up a key and the archive write loses that
  message
- the archive is only as safe as the unlocked device
- a device that has never written to a contact can't open that contact's
  forward-secret mail

## 7. Git state

Committed on the two branches listed at the top of this file; nothing is
pushed. Still untracked and **not part of this work** — leave them out unless
you mean to include them:
- `assets/logo-transperant.png`
- `docs/contributions.md`
- `docs/contributions.docx`
- `docs/contributions-summary.docx`

To publish, a human runs `git push -u origin feat/per-email-keys-only` (or
the other branch) and opens a PR. It touches **the send path**, so tick that
box.

## 8. Per-email keys only (branch)

`feat/per-email-keys-only` overrides decisions 3, 4, 6 and 9 of §3 at the
user's request ("per message key mode only"): no message the user writes is
ever sealed to a long-term key. The protocol and its consequences are in the
design doc, [§Per-email keys only](superpowers/specs/2026-09-19-per-email-keys-design.md#per-email-keys-only).

| Piece | Where |
|---|---|
| Strict `seal`, `handshake`, `session_status`; handed-over phone refuses all three | `core/src/forward.rs`, `lib.rs`, `ffi.rs`, Kotlin module |
| Handshake text (fixed, contentless) and the outer-subject marker | `app/src/core/handshake.ts`, `core/mime.ts` (`HANDSHAKE_SUBJECT`) |
| `CryptCore.buildHandshake`, `sessionStatus`; `buildEncrypted` refuses without `seal`, no `encryptSign` fallback | `core/types.ts`, `nativeCore.ts`, `demoCore.ts` |
| Hold `awaiting-session`, handshake, refuse self-only, refuse anything not sealed with a per-email key | `state/send.ts` (`deliver`) |
| Send handshakes (rate-limited), answer them during sync | `state/handshake.ts`, `store/handshakeStore.ts`, `state/mailbox.ts` (`refreshInbox`) |
| Release held messages when a session appears | `state/scheduler.ts` (`drainSessions`) |
| UI wording | `ComposeScreen` (queued text), `ScheduledScreen` ("setting up keys", "Check again") |

Verified:
- `cargo test`: 82 pass, including 13 in `forward_secrecy.rs` rewritten for
  strict mode.
- interop: **14/14**. `seal` refuses a Sequoia recipient, and Sequoia reads
  the handshake.
- App suite: **1,783 tests, 105 suites**, including
  `state/__tests__/perEmailOnly-test.ts` (11).

Not verified: two installs completing a handshake over Gmail. That is the
first thing to run on this branch (§6 step 1).

### How to try it

On `feat/per-email-keys-only` (rebuild the native core first, §5):

1. **Mail only to yourself.** Compose disables Send and says a per-email key
   needs someone else. Checked on the emulator.
2. **Mail to a key with no session.** The message moves to Scheduled as
   "setting up keys". One email goes out with subject
   `[CryptMail] Setting up per-email keys` and none of the message's words.
   *Check again* reports "still waiting". Needs a second account with a key.
3. **The other side.** On its next sync it answers automatically: a second
   `[CryptMail] …` email, sealed with a per-email key. When the first side
   syncs, the held message sends. Needs two installs.
4. **After *Move to a new phone*.** The old phone refuses every encrypted send
   and says why. *Keep using this phone* restores it.

### Where the rules are enforced

| Rule | Code | Test |
|---|---|---|
| `seal` never falls back to long-term keys | `forward::seal` | `forward_secrecy.rs::without_a_session_seal_refuses_and_a_handshake_is_the_way_in`, `one_recipient_without_a_session_stops_the_whole_message` |
| A handshake carries nothing the user wrote | `core/handshake.ts` (fixed text), `state/handshake.ts` | `perEmailOnly-test.ts`: "holds a message … sends them only a contentless handshake" (asserts on the wire bytes) |
| Nothing unsealed by a per-email key reaches the wire | `state/send.ts` (`isForwardSecret` check) | "refuses to put anything on the wire the core did not seal with a per-email key" |
| One answer per first contact, only to the signing key | `state/handshake.ts` (`answer`) | the four "answering handshakes" tests |
| At most one handshake per address per day | `store/handshakeStore.ts` | "sends one handshake a day per address…" |
| A handed-over phone sends nothing | `forward::refuse_if_handed_over` | `transfer.rs::the_old_phone_stops_sending_but_still_reads` |
| Other clients can read a handshake; `seal` refuses them | — | `interop.sh` §4 |
