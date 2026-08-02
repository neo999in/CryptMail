## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What in docs/ or features.md does this come from? -->

## Checks

- [ ] `cd app && npx tsc --noEmit` passes
- [ ] `cd app && npm test` passes
- [ ] Docs in `docs/` updated if this changes behaviour they describe
- [ ] No secrets, keys, tokens, or real mailbox data in the diff

## Does this touch the send path, the keyring, or `src/core/`?

- [ ] No
- [ ] Yes — and I confirm:
  - [ ] A recipient without a usable key still **blocks** the send
  - [ ] A changed fingerprint still **blocks** the send
  - [ ] Demo mode still reports `kind: 'demo'` and the UI still says so
  - [ ] No private key crosses the core boundary

## How I tested it

<!-- Screens touched, platform (web/android), anything a reviewer should re-run. -->
