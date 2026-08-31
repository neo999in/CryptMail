# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CryptMail — a cross-platform email client that signs into an existing Gmail/IMAP
account and end-to-end encrypts outgoing mail (PGP/MIME), so the provider's own
apps show ciphertext while CryptMail shows the message. It is a client, never a
mail provider.

The repo currently holds **design docs + a Phase 0 prototype frontend**. The Rust
crypto core (M1/M2) and the Google OAuth client (M3) do not exist yet, so the app
boots in **demo mode**.

## Layout and commands

```
docs/     design docs — the source of truth for behaviour
app/      the Expo / React Native / TypeScript client (all code lives here)
.github/  CI, PR and issue templates
```

There is **no root `package.json`**. Run every npm command from `app/`. Node 22+.

```bash
cd app
npm install
npm run web            # fastest way to see the UI
npm run android        # needs a dev build; Expo Go will not load the native core
npm test               # jest-expo
npx tsc --noEmit       # typecheck — no separate lint step exists
```

Single test file / single case:

```bash
npx jest src/search                       # by path fragment
npx jest -t "adds a draft by id"          # by test name
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs exactly
`npx tsc --noEmit` then `npm test -- --ci` from `app/`. Both must pass before a PR.

Tests live in a sibling `__tests__/<name>-test.ts` next to the code — that is the
jest `testMatch` pattern in [app/package.json](app/package.json), so a test placed
anywhere else silently never runs. Logic modules get tests; screens currently
don't.

## Expo SDK 57

This is Expo SDK 57 / React Native 0.86 / React 19, which changed substantially
from earlier SDKs. Read the exact versioned docs at
https://docs.expo.dev/versions/v57.0.0/ before writing Expo code — do not rely on
remembered API shapes.

[app/babel.config.js](app/babel.config.js) lists `react-native-worklets/plugin`,
which must stay **last** in the plugin array for Reanimated 4 to work.

## Architecture

```
screens/  ──▶  state/           ──▶  core/    (crypto + PGP/MIME)
                                ──▶  mail/    (Gmail REST | demo fixtures)
                                ──▶  auth/    (Google OAuth PKCE | demo)
                                ──▶  keys/    (Autocrypt harvest, keys.openpgp.org | demo directory)
                                ──▶  store/   (AsyncStorage: keyring, drafts, outbox, index, publish, invites)
```

[app/src/state/](app/src/state/) is the **only** layer aware of all five
subsystems. Screens never call a provider, the core, or a store directly — they
call actions on `useApp()`. Keep that seam; it is what makes the demo/live swap
and the future Rust core a drop-in.

Inside it, React and the work are kept apart:

- [app/src/state/AppState.tsx](app/src/state/AppState.tsx) is the React end —
  the context, the two effects, and the object `useApp()` returns. Nothing else.
- [app/src/state/store.ts](app/src/state/store.ts) holds the state. `patch()`
  updates it **synchronously** and then re-renders, so async work that resumes
  after an `await` reads current values through `store.get()` rather than a
  render-time snapshot. Do not reintroduce `useRef` mirrors of state fields.
- `session` · `mailbox` · `contacts` · `identity` · `publish` · `send` ·
  `scheduler` · `drafts` are plain TypeScript service modules — no React, so
  they are directly testable. Each takes a `Ctx` and reaches siblings through
  `ctx.services.*` at call time, which is what lets a sync trigger a drain, a
  drain deliver, and a delivery trigger a sync without ordering games.
  [app/src/state/contracts.ts](app/src/state/contracts.ts) declares that surface;
  [app/src/state/services.ts](app/src/state/services.ts) assembles it.

Every action `useApp()` exposes is stable for the life of the app, *except*
`encryptionFor`, `resolveRecipients` and `publishStatus`: screens read those
during render and memoise on their identity, so they are re-created when the
state they read changes. See [app/src/state/derive.ts](app/src/state/derive.ts).

Two interfaces define the swappable edges:

- [app/src/core/types.ts](app/src/core/types.ts) — `CryptCore`. The exact surface
  the Rust `cryptmail-core` will expose via UniFFI → Kotlin → turbo module.
- [app/src/mail/types.ts](app/src/mail/types.ts) — `MailClient`. Everything above
  this line is provider-agnostic.

[app/src/core/index.ts](app/src/core/index.ts) picks the implementation once:
`getNativeCore() ?? demoCore`. [app/src/config.ts](app/src/config.ts) derives
`appMode` from whether an OAuth client id **and** a native core are both present,
and `demoReason()` explains a downgrade to the user rather than hiding it.

| | demo | live |
|---|---|---|
| Trigger | no OAuth client **or** no native core | both present |
| Mail | fixtures in `src/mail/demoMail.ts` | Gmail REST |
| Crypto | `demoCore` (encoded, **not** encrypted) | Rust core |
| Key directory | in-memory `demoDirectory` (no network) | `keys.openpgp.org`, then WKD |

To reach live mode: build the native core (M2), register the Kotlin module as
`CryptMailCore` with the five methods in
[app/src/core/nativeCore.ts](app/src/core/nativeCore.ts) — nothing else changes —
then `cp app/.env.example app/.env` and fill in the **Web** client id as
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. Sign-in goes through Google Play services
(`@react-native-google-signin/google-signin`), so there is no redirect scheme —
Google refuses custom URI schemes from an Android OAuth client.

[app/src/core/mime.ts](app/src/core/mime.ts) implements
[docs/message-format.md](docs/message-format.md) exactly — `multipart/encrypted`,
`protocol="application/pgp-encrypted"`, the `Version: 1` part, the placeholder
`Subject: [Encrypted message]`, and the protected-headers inner tree. Change the
doc and this file together.

Attachments are parts of that inner tree, so a filename is ciphertext like the
subject is: [app/src/mail/attachment.ts](app/src/mail/attachment.ts) is the model
(base64 content, and the 1 MB / 4 MB caps that exist because everything crosses
the bridge as a string), and
[app/src/lib/files.ts](app/src/lib/files.ts) is the only module that touches the
platform's file APIs. Inbound *unencrypted* mail is read by `attachmentsOf` in
[app/src/mail/plainBody.ts](app/src/mail/plainBody.ts) — that file reads what the
world sends, `mime.ts` writes what we send, and the two stay separate.

Trust state is derived, not stored twice: inbox rows call `encryptionFor()`
(headers only, no network, no decryption), while opening a message upgrades trust
using the signature and the keyring. Decrypted subjects/bodies are indexed into
`searchIndex` so encrypted mail is searchable — only content decrypted on this
device is ever stored.

Key discovery runs *before* the pure resolver, never inside it:
`resolveRecipientStates` ([app/src/state/recipients.ts](app/src/state/recipients.ts))
stays synchronous and network-free because it decides whether a send is allowed.
`discoverRecipients` ([app/src/state/contacts.ts](app/src/state/contacts.ts))
fetches missing keys first, then delegates to it.
Directory keys land as `trust: 'seen'`, never `verified`.

## Rules that are not style preferences

These are enforced in review (see [CONTRIBUTING.md](CONTRIBUTING.md)):

1. **No plaintext downgrade.** Never "send unencrypted just this once".
   Two cases, and neither of them puts the message on the wire in the clear:
   - a recipient whose key **changed fingerprint** blocks the send outright —
     nothing is sent and nothing is queued, because waiting cannot resolve a
     possible key substitution;
   - a recipient with **no key yet** has the message *held* in the outbox
     (`awaiting-key`) while a contentless invite goes to them; it delivers itself
     once a key exists. The UI must say *queued*, never *sent*.

   Enforced in `deliver`/`sendEncrypted` in
   [app/src/state/send.ts](app/src/state/send.ts) and covered by
   [app/src/state/__tests__/send-test.ts](app/src/state/__tests__/send-test.ts),
   which asserts it against the bytes a fake provider was handed. It holds in
   demo mode too. `sendPlain` is the user's separate, explicit choice to write an
   unencrypted email; nothing on the encrypted path may reach it — including the
   invite, which builds its own message.
2. **The demo core is not crypto.** [app/src/core/demoCore.ts](app/src/core/demoCore.ts)
   base64-encodes the inner MIME tree into a correctly-shaped armor block. Never
   remove the `kind: 'demo'` reporting or the UI banners that surface it, and
   never present demo output as secure.
3. **Nothing crosses the core boundary but strings**, and a private key is never
   returned from it.
4. **No secrets in the repo.** OAuth client ids go in `app/.env` (gitignored).
5. **Screens don't call providers or the core directly** — they go through `AppState`.

Docs in [docs/](docs/) are the source of truth for behaviour: if a change
contradicts a doc, update the doc in the same PR or don't make the change.
[docs/features.md](docs/features.md) lists what is buildable now versus blocked
on the Rust core.

## UI conventions

[app/src/theme.ts](app/src/theme.ts) holds design tokens ported 1:1 from
[docs/design/system-design.html](docs/design/system-design.html); keep the names
aligned with that file's CSS custom properties. Build screens out of
[app/src/ui/primitives.tsx](app/src/ui/primitives.tsx) (`Glass`, `Badge`,
`PrimaryButton`, `Field`, …) rather than raw styled `View`s.

- Address a weight by its **font family** (`font.sansSemibold`), never
  `fontWeight` — custom faces don't synthesize weights reliably.
- Use `shadow.*` (`boxShadow`) — the RN `shadow*` props are deprecated in 0.81+
  and warn on every render.
- Every surface is transparent so `AppBackground` shows through; `frost()` in
  primitives is the web fallback for `expo-blur`, which does not blur on web.
- The ground is **true black** and carries no ambient light — the aurora glows
  and film grain were removed for AMOLED, where `#000000` means the pixel is
  off. Don't reintroduce a background wash to make glass "read as glass": the
  `glass.*` fills are opaque enough to stand alone, which is why they exist.

## Git — never run write commands, run only if permission is granted

no Claude trailers on commits

This is a shared repo. **Claude never runs a git command that changes history,
the index, the working tree, or anything on the remote.** A human runs those.
Run only if permission is granted

Run only if permission is granted
Forbidden, without exception:

```
git commit    git push      git merge      git rebase
git reset     git revert    git checkout/switch/restore (that discards work)
git stash     git clean     git cherry-pick
git branch -D/-d/-m         git tag        git remote
git add                     git rm         git mv
gh pr create/merge/close    gh release     gh repo
```
Run only if permission is granted
Never `--force`, `--force-with-lease`, `--hard`, `--no-verify`, or `-f` on any
git command, for any reason.

Run only if permission is granted
Read-only git is fine and encouraged — `git status`, `git diff`, `git log`,
`git show`, `git blame`, `git branch --list`, `gh pr view` — use them freely to
understand the current state.

When work is done: leave the changes in the working tree, say plainly what
changed and which files, and if a command would help, print it for a human to
run. Do not offer to run it.

## Branches and commits

These are the conventions a human follows — documented here so Claude's edits
fit them, not so Claude executes them.

Branch off `main` as `feat/…`, `fix/…`, `docs/…`; never commit straight to
`main`. Conventional-ish commit subjects, imperative, one concern each:
`feat(compose): block send when a recipient key changed fingerprint`. PRs need
one review and the "does this touch the send path?" box filled in.

[commit.md](commit.md) spells this out — identity, branch prefixes, subject
format, and the pre-commit checks. It is gitignored and local-only, so it may
not be present in every checkout.
