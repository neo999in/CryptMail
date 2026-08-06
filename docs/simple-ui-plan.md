# Simple UI — Implementation Plan

A second, deliberately minimal UI that does four things: sign in, read mail,
read encrypted mail, send mail (encrypted or plaintext). The existing UI is
sidelined, not deleted.

Status: **implemented**. This document is the plan and the record of what was
built.

---

## Why a second UI

The current UI is ~3,900 lines across eight screens carrying threading, search,
drafts, scheduled send, star/archive, and a trust dashboard. That surface is
useful, but it makes the *core claim* — a message goes out encrypted and comes
back readable — hard to see and hard to test end-to-end.

The simple UI exists to be the thing you point at M6 of
[prototype-plan.md](prototype-plan.md) with:

> Alice sends from CryptMail to Bob. Gmail's web UI shows ciphertext. CryptMail
> on Bob's phone shows the message.

Four screens, no features that don't serve that sentence.

## Sidelining, not deleting

The existing screens keep working and keep their tests. A persisted `uiMode`
flag chooses which stack mounts:

- `simple` — **the default**. Four screens.
- `full` — the existing eight-screen stack, unchanged.

Both stacks render a toggle, so neither is a trapdoor. This is reversible in one
line of [App.tsx](../app/App.tsx) if the simple UI turns out to be the wrong
call, and no existing screen was edited to make it work.

## Architecture: nothing new below the screens

The simple screens are *only* screens. They call `useApp()` and nothing else —
no provider, no core, no store, per rule 5 in [CLAUDE.md](../CLAUDE.md). Every
capability they need already existed in
[AppState.tsx](../app/src/state/AppState.tsx) except one (plaintext send, below).

```
screens/simple/  ──▶  state/AppState.tsx  ──▶  (unchanged subsystems)
```

That is the whole point of the seam: a second UI costs four files and no
architectural change.

---

## The one real design question: plaintext send

The user asked for a UI that sends "email and encrypted emails". Plaintext send
did not exist — `deliver()` always encrypts and refuses when a recipient key is
missing.

This runs straight at rule 1 in [CLAUDE.md](../CLAUDE.md): *no plaintext
downgrade*. That rule is about **downgrade** — sending plaintext when the user
believed the message was encrypted. It is not a prohibition on plaintext mail as
such:

- [encryption.md](encryption.md) lists `User explicitly opts out → Plaintext →
  Requires an explicit, logged action` as a supported outcome.
- [features.md](features.md) 0.14 asks for exactly this, with the constraint that
  it "must be an explicit, clearly-labelled choice, never a fallback the app
  takes on its own."
- M4 of [prototype-plan.md](prototype-plan.md) *is* plaintext send.

So the rule the implementation must satisfy is not "never send plaintext" but
**"never send plaintext that the user thought was encrypted."** Four properties
enforce it:

1. **Mode is chosen before sending, never derived.** Two explicit buttons. There
   is no code path where a failed encryption becomes a plaintext send.
2. **Encrypted mode blocks on a missing key.** Unchanged `deliver()` behaviour —
   the send fails with the recipient named.
3. **Plaintext mode is visibly plaintext.** A coral banner, a `PLAINTEXT` badge,
   and button text that says "Send unencrypted".
4. **The decision is pure and tested.** `sendMode.ts` computes availability and
   reasons; it does not send anything.

`sendPlain()` is a sibling of `sendEncrypted()` in `AppState`, never called from
inside the encrypted path.

---

## What was built

### `simple/sendMode.ts` + tests · pure logic

`evaluateSendModes({ recipients, hasNativeCore, appMode })` → for each of
`encrypted` and `plain`: available, blocked reason, and the warning to display.
Framework-free, no React, no I/O. 15 tests covering every recipient status
(`ok` / `verified` / `changed` / `missing`), demo vs live, empty input, and the
invariant that a blocked encrypted mode never makes plaintext the default.

The `changed` status is treated as **blocking**, matching `deliver()`: a key that
changed fingerprint is a possible MITM ([security.md](security.md)), not a
warning to click through.

### `store/uiModeStore.ts`

`loadUiMode()` / `saveUiMode()` over AsyncStorage, key `cryptmail.uimode.v1`,
defaulting to `simple`. Same shape as the other stores in `store/`.

### `screens/simple/` — four screens

| Screen | Does | Deliberately omits |
|---|---|---|
| `SimpleInboxScreen` | List 20, pull to refresh, lock/plain badge per row, open, compose, keys, sign out | search, threads, star, archive, drafts, scheduled |
| `SimpleMessageScreen` | Decrypt, show subject/body, trust state, "what Gmail sees" raw toggle | reply, forward, actions |
| `SimpleComposeScreen` | To / subject / body, per-recipient key status, explicit encrypted-vs-plain send | drafts, autosave, scheduling, attachments |
| `SimpleKeysScreen` | Show my fingerprint + public key (copy), paste a contact's key, list contacts | QR, verification ceremony, directory lookup |

`SimpleKeysScreen` is not optional: with no key-exchange surface, encrypted send
can never succeed, since Autocrypt is out of scope for the prototype.

### `state/AppState.tsx` — one added action

`sendPlain({ to, subject, body })`, using the already-exported `buildPlaintext`
from the core barrel. ~15 lines. No existing action changed.

---

## Verification

- `npx tsc --noEmit` clean.
- `npm test -- --ci` — **77 tests across 8 suites**: the 62 that existed plus 15
  new. (features.md says 52 across 6 suites; that count is stale.)
- `npx expo export --platform web` builds, and the app was driven end-to-end in a
  browser: sign in → inbox with per-row lock badges → open an encrypted message
  (real subject restored, `ENCRYPTED · VERIFIED SENDER`) → compose. No console or
  page errors.
- The fail-safe was verified by hand in that run: with an unknown recipient,
  "Send encrypted" is disabled and names the address, "Send unencrypted" is
  offered but **left unselected**, and the send button stays disabled until the
  user picks. Nothing downgrades on its own.
- Screens are untested by convention (only logic modules get tests), which is
  precisely why the send-mode decision was extracted into a pure module rather
  than written inline in the compose screen.

## What this does not do

The simple UI is still bound by demo mode. With no native core, `demoCore`
base64-encodes and the banner says so. This UI makes the encrypted path easy to
*drive*; it does not make it real. That still needs M1/M2 —
see [post-quantum.md](post-quantum.md) for the algorithm decision due before M2
generates its first key.
