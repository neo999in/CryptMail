# Contributing

Small team, informal process — but this project encrypts people's mail, so the
rules around the crypto boundary and the send path are not negotiable.

## Setup

```bash
git clone <this repo>
cd mailer/app
npm install
npm run web     # fastest way to see the UI
npm test        # 52 unit tests, must pass before you push
```

All app code lives in [app/](app/). Design docs live in [docs/](docs/) and are
the source of truth — if your change contradicts a doc, update the doc in the
same PR or don't make the change.

Node 22+ is expected. There is no root `package.json`; run every npm command
from `app/`.

## Branches and PRs

- Branch off `main`: `feat/<thing>`, `fix/<thing>`, `docs/<thing>`.
- Never commit straight to `main`. One PR per logical change.
- Every PR needs one review from someone who didn't write it.
- Fill in the PR template — especially the "does this touch the send path?" box.

Before you open a PR:

```bash
cd app
npx tsc --noEmit    # no type errors
npm test            # all green
```

## Commits

Conventional-ish prefixes, imperative mood, one concern per commit:

```
feat(compose): block send when a recipient key changed fingerprint
fix(threads): sort by internalDate, not received header
docs(security): note the metadata that stays visible to the provider
```

## Rules that are not style preferences

1. **No plaintext downgrade.** If a recipient has no usable key, sending must
   fail with an explanation. Never "send unencrypted just this once". This is
   enforced in `sendEncrypted` in [app/src/state/send.ts](app/src/state/send.ts)
   and it holds in demo mode too.
2. **The demo core is not crypto.** [app/src/core/demoCore.ts](app/src/core/demoCore.ts)
   base64-encodes; it does not encrypt. Never remove the `kind: 'demo'` reporting
   or the UI banners that surface it, and never present demo output as secure.
3. **Nothing crosses the core boundary but strings**, and a private key is never
   returned from it. See [app/src/core/types.ts](app/src/core/types.ts).
4. **No secrets in the repo.** OAuth client ids go in `app/.env` (gitignored).
   No keys, tokens, `.p12`, `.jks`, or real mailbox exports — ever.
5. **Screens don't call providers or the core directly.** They go through
   `AppState`. Keep that seam.

## Adding a feature

Check [docs/features.md](docs/features.md) first — it lists what's buildable now
and what's blocked on the Rust core (M1/M2). Claim the item in an issue so two
people don't build it twice.

Tests go in `__tests__/<name>-test.ts` next to the code (that's the jest
`testMatch` pattern). Logic gets a test; screens currently don't.

## Reporting bugs

Open an issue with the template. If it's a security problem in the crypto
design or the send path, say so in the title — those jump the queue.
