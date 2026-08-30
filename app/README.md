# CryptMail — prototype frontend

The React Native (Expo, TypeScript) client for the Phase 0 prototype described
in [../docs/prototype-plan.md](../docs/prototype-plan.md). Visual language is
ported from [../docs/design/system-design.html](../docs/design/system-design.html).

This is the **frontend only**. The mailbox is **real Gmail** — there is no fixture
mail path. The Rust crypto core (M1/M2) does not exist yet, so the app runs with
**demo crypto**: real mail, encoded-not-encrypted payloads, and a banner saying so.
See [Modes](#modes).

## Run it

```bash
npm install
npm run web        # fastest way to look at the UI
npm run android    # needs a dev build; Expo Go will not load the native core
npm test           # jest-expo
```

## What is implemented

| Screen | File | Notes |
|---|---|---|
| Connect | [src/screens/ConnectScreen.tsx](src/screens/ConnectScreen.tsx) | Gmail OAuth entry, least-privilege scopes, demo-crypto disclosure, and the reason when sign-in cannot run |
| Inbox | [src/screens/InboxScreen.tsx](src/screens/InboxScreen.tsx) | Encryption + trust badge on every row, derived from headers only |
| Message | [src/screens/MessageScreen.tsx](src/screens/MessageScreen.tsx) | Decrypt, restore the protected subject, "What Gmail sees" raw view |
| Compose | [src/screens/ComposeScreen.tsx](src/screens/ComposeScreen.tsx) | Per-recipient key resolution and the fail-safe send gate |
| Keys | [src/screens/KeysScreen.tsx](src/screens/KeysScreen.tsx) | Show my key, paste theirs, mark verified, forget — the prototype's whole key exchange |
| Conversation | [src/screens/ConversationScreen.tsx](src/screens/ConversationScreen.tsx) | A whole thread, decrypted, oldest first |
| Drafts | [src/screens/DraftsScreen.tsx](src/screens/DraftsScreen.tsx) | Autosaved drafts, resume or discard |
| Scheduled | [src/screens/ScheduledScreen.tsx](src/screens/ScheduledScreen.tsx) | Queued sends, with cancel before the send fires |

Supporting modules: [src/search/](src/search/) (over decrypted mail, in memory),
[src/threads/](src/threads/) (grouping by `References`/`In-Reply-To`),
[src/drafts/](src/drafts/) (autosave), [src/outbox/](src/outbox/) (scheduled
send), [src/pgp/](src/pgp/) (parsing real armored OpenPGP public keys), and
[src/mail/flags.ts](src/mail/flags.ts) (star / archive / read). Each has tests in
a sibling `__tests__/` directory.

Outlook / IMAP, the secure-link fallback, recovery codes and QR verification are
deliberately out of scope for Phase 0; the buttons that would lead there are
absent or marked `PHASE 1`.

## Architecture

```
screens/  ──▶  state/AppState.tsx  ──▶  core/    (crypto + PGP/MIME)
                                    ──▶  mail/    (Gmail REST)
                                    ──▶  auth/    (Google sign-in via Play services)
                                    ──▶  store/   (keyring)
```

`AppState` is the only place that knows about all four. Screens never call a
provider or the core directly.

### The core boundary

[src/core/types.ts](src/core/types.ts) is the contract the Rust library will
implement through UniFFI → Kotlin → turbo module. Only strings cross it, and no
private key is ever returned. When M2 lands, register the Kotlin module as
`CryptMailCore` with the five methods in
[src/core/nativeCore.ts](src/core/nativeCore.ts) — nothing else changes.

Until then [src/core/demoCore.ts](src/core/demoCore.ts) stands in. **It is not
cryptography**: it base64-encodes the inner MIME tree into a correctly-shaped
armor block so the envelope, the placeholder subject, the Autocrypt round trip
and every UI state are real, while the payload is not secret. It reports
`kind: 'demo'` and the UI says so on the Connect screen, the inbox strip and the
send bar.

[src/core/mime.ts](src/core/mime.ts) implements the envelope from
[../docs/message-format.md](../docs/message-format.md) exactly — `multipart/encrypted`,
`protocol="application/pgp-encrypted"`, the `Version: 1` part, the placeholder
`Subject: [Encrypted message]`, and the protected-headers inner tree.

## Modes

Mail is not a mode — Gmail is the only mailbox, and a build that cannot reach it
says so on the Connect screen instead of serving invented mail. One thing is still
switchable:

| | demo crypto (today) | live |
|---|---|---|
| Trigger | no native core | native core linked |
| Mail | real Gmail REST | real Gmail REST |
| Crypto | `demoCore` (encoded, not encrypted) | Rust core |

To reach live: build the native core (M2). For mail, add a Google **Web** client
id:

```bash
cp .env.example .env     # then fill in EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
```

Expo inlines `EXPO_PUBLIC_*` at bundle time, so restart Metro after editing it.
Sign-in runs through Google Play services, not a browser redirect — there is no
redirect scheme, and the web build cannot sign in at all. A separate Android OAuth
client (package + signing SHA-1) must exist in the console but is never named in
code. Full setup: [docs/running-it.md](../docs/running-it.md).

## The fail-safe

`sendEncrypted` in [src/state/AppState.tsx](src/state/AppState.tsx) refuses to
build a message when any recipient has no key, and Compose blocks the send with
an explanation rather than offering a plaintext downgrade. A key that changes
fingerprint is marked `changed` in the keyring and also blocks sending. This is
the rule from [../docs/encryption.md](../docs/encryption.md) and it holds with the
demo core too.

## Known gaps (frontend)

- Keyring lives in AsyncStorage, not SQLite/SQLCipher — matches the "known
  debt" list in the prototype plan.
- No attachment UI (text bodies only).
- No pagination beyond the last 20 inbox messages.
- Expired-refresh-token handling surfaces an error instead of re-prompting.
