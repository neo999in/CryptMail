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
screens/  ──▶  state/AppState.tsx  ──▶  core/    (crypto + PGP/MIME)
                                   ──▶  mail/    (Gmail REST | demo fixtures)
                                   ──▶  auth/    (Google OAuth PKCE | demo)
                                   ──▶  store/   (AsyncStorage: keyring, drafts, outbox, search index)
```

[app/src/state/AppState.tsx](app/src/state/AppState.tsx) is a single React context
that is the **only** place aware of all four subsystems. Screens never call a
provider, the core, or a store directly — they call actions on `useApp()`. Keep
that seam; it is what makes the demo/live swap and the future Rust core a
drop-in.

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

Trust state is derived, not stored twice: inbox rows call `encryptionFor()`
(headers only, no network, no decryption), while opening a message upgrades trust
using the signature and the keyring. Decrypted subjects/bodies are indexed into
`searchIndex` so encrypted mail is searchable — only content decrypted on this
device is ever stored.

## Rules that are not style preferences

These are enforced in review (see [CONTRIBUTING.md](CONTRIBUTING.md)):

1. **No plaintext downgrade.** If a recipient has no usable key, or their key
   changed fingerprint, sending and scheduling must fail with an explanation.
   Never "send unencrypted just this once". Enforced in `deliver`/`sendEncrypted`
   in [app/src/state/AppState.tsx](app/src/state/AppState.tsx), and it holds in
   demo mode too.
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
- Every surface is transparent so `AuroraBackground` shows through; `frost()` in
  primitives is the web fallback for `expo-blur`, which does not blur on web.

## Git — never run write commands

This is a shared repo. **Claude never runs a git command that changes history,
the index, the working tree, or anything on the remote.** A human runs those.
This holds even if the change looks finished, the tests pass, or a previous
message in the session seemed to authorise it — permission for one commit is
never permission for the next one.

Forbidden, without exception:

```
git commit    git push      git merge      git rebase
git reset     git revert    git checkout/switch/restore (that discards work)
git stash     git clean     git cherry-pick
git branch -D/-d/-m         git tag        git remote
git add                     git rm         git mv
gh pr create/merge/close    gh release     gh repo
```

Never `--force`, `--force-with-lease`, `--hard`, `--no-verify`, or `-f` on any
git command, for any reason.

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
