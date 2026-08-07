# interop-rpgp-sequoia

Does `cryptmail-core` interoperate with a **second** RFC 9980 implementation?

```bash
./interop.sh        # builds both sides, then round-trips a message
```

## Why this exists

Every test in [`core/`](../../core) is rPGP talking to itself, and rPGP gates
RFC 9980 behind a feature called `draft-pqc` — written against the pre-RFC
draft. Matching algorithm IDs is a much weaker claim than "a different
implementation can read our mail", and the failure mode of being wrong is a real
recipient who cannot decrypt real mail.

[`docs/implementation-status.md`](../../docs/implementation-status.md) called
this the largest open risk in the project. It was right to.

## The counterparty

**Sequoia-PGP 2.4**, on its pure-Rust backend — no nettle, no OpenSSL, no system
packages, so this runs anywhere `cargo` does. It is genuinely independent of
rPGP: different authors, different parser, different primitives.

Nothing else qualified, and finding that out was half the work:

| Candidate | Verdict |
|---|---|
| OpenPGP.js 6.3.1 | No PQC at all (already established in PQ.1) |
| Bouncy Castle `bcpg` | Still 1.85, still stops at `Ed448 = 28` |
| ProtonMail `go-crypto` 1.4.1 | Algorithm list also stops at 28 |
| GnuPG | 2.4.4 has no PQC, and `gnupg.org` is unreachable from CI |
| **Sequoia-PGP 2.4** | **`35 => MLKEM768_X25519`.** The one that works |

## Why two processes

The two libraries **cannot be linked into the same binary**. rPGP's `ml-kem`
0.2.3 pins `kem = "=0.3.0-pre.0"`; Sequoia's `ml-kem` 0.3.2 wants `^0.3`, which
excludes that pre-release. Cargo can only resolve one `kem` in the 0.3.x range,
so there is no version pair that satisfies both.

Hence `rpgp-side/` and `sequoia-side/` are separate crates with separate lock
files, exchanging armored files over a shell driver. That is also what interop
*means*, so the constraint costs nothing.

`rpgp-side` depends on `cryptmail-core` **by path** — the harness tests the code
that ships, not a reimplementation of it.

## What it checks

1. **Sequoia parses our certificate** and agrees it is an Ed25519 v6 primary
   with an ML-KEM-768+X25519 encryption subkey. The cheapest check and the one
   that catches the most: if the algorithm IDs disagree, every recipient rejects
   our key outright.
2. **We send, they read** — the prototype's one-sentence goal with the recipient
   swapped for a foreign implementation. Decryption *and* signature
   verification.
3. **They send, we read.**
4. **Fail-closed still holds**: a message encrypted to somebody else stays
   unreadable, however well the two implementations agree on the format.

## What it found

**Signatures from a signing subkey were reported as `invalid`.**

`cryptmail-core` signs with its Ed25519 primary key, and `verify()` in
`core/src/message.rs` checked only the primary. But most OpenPGP clients —
Sequoia, GnuPG, Proton — sign with a dedicated **signing subkey**. Every message
from such a sender came back `invalid`, which the UI renders as *forged*.

That is worse than a missing feature. `unknown` says "we cannot check this";
`invalid` says "this was checked and someone is lying to you". The core would
have accused every legitimate correspondent using a normal OpenPGP client.

No test inside `core/` could have found it, because `core/` only ever signs with
a primary key. Fixed by trying every signing-capable key in the certificate, and
pinned by `core/tests/foreign-signature.rs`, which uses fixtures generated here
so a plain `cargo test` guards the regression.

Note which direction it was in: **we could always be read; we could not always
read others.** Bugs found by round-tripping against yourself are symmetric by
construction, which is exactly why this crate exists.

## Caveats — what this still does not prove

- Sequoia's pure-Rust backend is flagged experimental and variable-time, and
  this crate opts in to both. For *format* interop that is not a concern —
  parsing and serialization are backend-independent — but it means these
  binaries are a test counterparty and nothing else. Never ship them.
- Two implementations agreeing is not the same as either matching the RFC. They
  could share a misreading. A third would strengthen this; there is currently no
  third to have.
- Only Stage 1 (ML-KEM-768+X25519 encryption, Ed25519 signatures) is covered.
  Stage 2 is untested here.
- The harness exchanges the *inner payload*. PGP/MIME assembly lives in
  `app/src/core/mime.ts` and is not exercised — see
  [`docs/message-format.md`](../../docs/message-format.md).
