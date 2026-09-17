# Contributing

Small team, informal process — but this project encrypts people's mail, so the
rules around the crypto boundary and the send path are not negotiable.

## Setup

```bash
git clone <this repo>
cd mailer/app
npm install
npm run web     # fastest way to see the UI
npm test        # jest-expo; must pass before you push
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
npm test -- --ci    # all green — CI runs exactly these two
```

## Commits

Conventional-ish prefixes, imperative mood, one concern per commit:

```
feat(compose): block send when a recipient key changed fingerprint
fix(threads): sort by internalDate, not received header
docs(security): note the metadata that stays visible to the provider
```

## Rules that are not style preferences

1. **No plaintext downgrade.** Never "send unencrypted just this once". A
   recipient whose key **changed fingerprint** blocks the send outright, and
   nothing is sent or queued. A recipient with **no key yet** has the message
   held in the outbox (`awaiting-key`) while a contentless invite goes to them,
   and the UI says *queued*, never *sent*. Enforced in `deliver`/`sendEncrypted`
   in [app/src/state/send.ts](app/src/state/send.ts), covered by
   [send-test.ts](app/src/state/__tests__/send-test.ts), and it holds in demo
   mode too.
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
`testMatch` pattern, so a test anywhere else silently never runs). Logic gets a
test; screens currently don't.

UI changes: read [Design.md](Design.md) first. It holds the tokens, the
primitives and the traps (runtime accent, fixed trust colours, true-black
ground).

## Reporting bugs

Open an issue with the template. If it's a security problem in the crypto
design or the send path, say so in the title — those jump the queue.
