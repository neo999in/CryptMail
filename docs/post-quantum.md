# Post-Quantum Migration Plan

How CryptMail becomes quantum-safe, in what order, and what it costs.

Read alongside [encryption.md](encryption.md) (the scheme this modifies) and
[key-management.md](key-management.md) (the keys this changes the shape of).

Status: **proposed**. Nothing here is implemented. The decision it asks for is
due before M2 of [prototype-plan.md](prototype-plan.md) generates its first real
keypair.

---

## Why this is urgent for email specifically

The threat is **harvest-now-decrypt-later**, and email is unusually exposed to
it:

1. Ciphertext sits in Gmail's storage indefinitely — an adversary does not need
   to intercept anything, only to keep what the provider already keeps.
2. [encryption.md](encryption.md) concedes there is **no forward secrecy**. A key
   compromise in 2035 exposes everything that key ever unwrapped, back to 2026.
3. Mail is long-lived by nature. Nobody re-encrypts their archive.

So the useful question is not "when will a CRQC exist" but "how long must a
message stay confidential." For legal, medical, journalistic or HR mail, that
horizon plausibly exceeds any credible CRQC timeline. Under that framing the
migration is not speculative hardening — it is the difference between the
product's central claim holding for a decade or not.

## Why the timing is now, not Phase 4

The Rust core does not exist yet. That is the whole argument.

Algorithm choice is baked in at **key generation**, and keys are the one thing in
this system that cannot be changed unilaterally later:

- A user whose identity is X25519-only cannot be retrofitted. They need a new
  keypair, republication through every discovery channel, and a rotation
  ceremony ([key-management.md](key-management.md)).
- Mail encrypted to the old key stays classically-encrypted forever. Rotation
  protects future mail only. Every month of classical-only sending is a month of
  permanently harvestable archive.

Choosing hybrid before `generateIdentity` ships costs a library selection and
some MIME plumbing. Choosing it after costs a migration for every user plus an
archive that was never protected. This is why it does not belong in Phase 4
alongside the exploratory items.

## Non-goal: QKD

Quantum key distribution is explicitly **not** the path, and this section exists
so the question stops being reopened.

QKD derives a shared symmetric key from measured photon states over a dedicated
quantum channel. It cannot work here:

- It still requires an **authenticated classical channel** for basis
  reconciliation — authentication that needs a pre-shared secret or a public key.
  QKD consumes trust, it does not bootstrap it.
- It is point-to-point and synchronous over dark fibre or satellite. Email is
  asynchronous store-and-forward through a third party; you encrypt to people who
  are offline.
- It yields a two-party symmetric key, not the n-recipient scheme in
  [encryption.md](encryption.md).

NSA (CNSA 2.0) and UK NCSC both advise against QKD for general-purpose use. The
answer is post-quantum algorithms, which are ordinary software.

---

## The target: RFC 9980 composite

[RFC 9980](https://www.rfc-editor.org/info/rfc9980) — *Post-Quantum Cryptography
in OpenPGP*, Standards Track, June 2026 — extends the RFC 9580 that
[encryption.md](encryption.md) already cites. It defines exactly the construction
CryptMail needs.

**Composite, not replacement.** The mandatory encryption algorithm is
`ML-KEM-768 + X25519` — both, on every message. An attacker must break *both*.
This is a strict improvement over today's security, never a regression, which is
the point: ML-KEM rests on Module-LWE, a conjecture under active cryptanalysis
and roughly a decade old. Replacing X25519 rather than composing with it would
remove the safety net and is not an option this plan entertains.

The encryption flow, replacing step 3 of "How a message is encrypted" in
[encryption.md](encryption.md):

1. ML-KEM encapsulate against the recipient's ML-KEM key → shared secret A + ciphertext
2. X25519 ECDH against the recipient's X25519 key → shared secret B
3. A and B combined by a **KMAC-based combiner** (modelled on X-Wing, per NIST
   SP 800-56C), which folds both ciphertexts and both public keys into the
   derivation so components from different messages cannot be mixed → **KEK**
4. The AES-256 session key is wrapped under the KEK with AES key wrap (RFC 3394)

Note the shape: ML-KEM is a **KEM**, not a padlock. It generates its own shared
secret rather than encrypting one you hand it, and the session key is wrapped by
a *derived symmetric* key. Anyone implementing from the "encrypt the session key
to the public key" mental model will build the wrong thing.

## What does not change

Most of the system is algorithm-agnostic, and that is by design:

| Component | Impact |
|---|---|
| [message-format.md](message-format.md) envelope | **None.** `multipart/encrypted`, `protocol="application/pgp-encrypted"`, the `Version: 1` part, and ASCII armor carry any OpenPGP algorithm. |
| `CryptCore` interface ([core/types.ts](../app/src/core/types.ts)) | **None.** Only armored strings cross the boundary; armor is opaque to algorithm. |
| Protected headers / subject masking | **None.** |
| Session-key scheme | **None.** Still one random AES-256 key, one AEAD pass over the whole tree, one wrapped copy per recipient plus the sender. |
| Keyring, trust states, fingerprints | **None.** `seen`/`verified`/`changed` is orthogonal; fingerprint verification still defeats key substitution. |
| Screens, `AppState`, stores | **None.** |

The blast radius is key generation, the KEM step, and key *distribution* — not
the app.

---

## Recommended sequencing: confidentiality first, signatures later

The single most useful observation in this plan:

> **Post-quantum confidentiality is urgent. Post-quantum signatures are not.**

Confidentiality is a *forever* property — a message encrypted today must resist
an adversary who exists in 2040. Signature security is a *now* property: a
signature forged in 2040 does not retroactively compromise a message sent in
2026, because nobody re-verifies old mail as a security decision. Harvest-now
attacks work against encryption; there is no harvest-now attack against
authenticity.

This matters because signatures are what make PQ certificates enormous, and
CryptMail's key distribution runs through **Autocrypt headers on every message**
([encryption.md](encryption.md)) — a size-sensitive channel:

| Certificate shape | Approx. armored size | Autocrypt viable? |
|---|---|---|
| Today — Ed25519 + X25519 | ~1 KB | yes |
| **Stage 1** — Ed25519 primary + ML-KEM-768/X25519 encryption subkey | ~2.5 KB | yes |
| Stage 2 — ML-DSA-65 primary + ML-KEM composite subkey | ~17 KB | doubtful |

The bulk of Stage 2 is ML-DSA: a 1952-byte public key plus a 3309-byte signature
on *each* self-signature, binding signature and UID signature. Stage 1 pays only
for the 1184-byte ML-KEM encapsulation key.

RFC 9980 makes Stage 1 legal explicitly. All new algorithms require v6 keys with
one exception — **ML-KEM-768 + X25519 may be carried on a v4 encryption subkey**,
the format the existing OpenPGP install base already understands. That exception
exists precisely for this migration shape.

**Stage 1 buys the property that expires; Stage 2 buys the property that
doesn't.** Do them in that order.

---

## Work items

Tagged with the readiness scheme from [features.md](features.md).

### PQ.1 Library spike · 🟡 Needs core · Impact L · Effort S

**What.** Determine whether rPGP or Sequoia implements RFC 9980 today, at what
maturity, and whether it exposes the v4-subkey path Stage 1 depends on.

**Why.** This is the only true unknown in the plan and it gates every other item.
It is also the cheapest thing here — a day of reading and a Rust binary that
generates one hybrid key and round-trips one message. [prototype-plan.md](prototype-plan.md)
already flags rPGP API churn as the top M1 risk; this folds into that risk
budget rather than adding to it.

**Done when.** A standalone Rust program generates an `Ed25519 + ML-KEM-768/X25519`
certificate, encrypts to it, decrypts it, and GnuPG can at minimum parse the
public key without erroring.

### PQ.2 Adopt hybrid in the core · 🟡 Needs core · Impact L · Effort M

**What.** Stage 1 as the **default and only** algorithm for new identities in
`generateIdentity`. No user-facing toggle.

**Why.** A "use post-quantum crypto?" setting is a way of shipping the wrong
default to most users. Hybrid is never worse than classical, so there is no
tradeoff to expose. Under the no-plaintext-downgrade principle in
[CONTRIBUTING.md](../CONTRIBUTING.md), the safe option is the only option.

**Build sketch.** Lands inside the Rust core; `CryptCore` is untouched. Decryption
must accept **both** hybrid and classical-only ciphertext indefinitely, or
existing mail and non-CryptMail PGP correspondents become unreadable. Encryption
picks hybrid when the recipient's key offers an ML-KEM subkey and falls back to
X25519 when it does not — this is a *confidentiality-horizon* downgrade, not a
plaintext downgrade, and is permitted.

**Done when.** Two CryptMail installs exchange a hybrid-encrypted message; a key
with no ML-KEM subkey still receives mail; a classical message from a prior build
still decrypts.

### PQ.3 Surface the recipient's protection level · 🟢 Ready · Impact M · Effort S

**What.** Extend `PublicKeyInfo` with the algorithm profile and show, per
recipient at compose time, whether the message will be quantum-resistant.

**Why.** [security.md](security.md) makes honesty a stated feature, and the
encryption-status-per-recipient pattern already exists for the key fail-safe.
Silently sending X25519-only to a legacy correspondent while the UI implies
quantum safety is exactly the kind of gap the fail-safe rules exist to close.

**Build sketch.** Buildable against the demo core today — the field can be
stubbed and the UI finished before M2. Reuse the existing per-recipient badge
row; do not invent a second status surface.

**Done when.** Composing to a hybrid-key contact and a legacy contact shows
visibly different protection, and the difference has a text equivalent for screen
readers (per 0.16 in [features.md](features.md)).

### PQ.4 Autocrypt size validation · 🟡 Needs core · Impact M · Effort S

**What.** Send a Stage 1 Autocrypt header through Gmail, Outlook, Fastmail and a
generic Postfix, and confirm it survives intact.

**Why.** Autocrypt is the mechanism that makes CryptMail "just work." A ~2.5 KB
header should be unremarkable, but "should be" is not a test result, and this
number is the assumption the entire Stage 1 recommendation rests on. Cheap to
falsify, expensive to discover late.

**Done when.** A round-trip through each provider yields a byte-identical
`keydata` value, recorded in the interop suite.

### PQ.5 Stage 2 — post-quantum signatures · 🟡 Needs core · Impact M · Effort M

**What.** v6 keys with `ML-DSA-65 + Ed25519` composite signing.

**Why.** Completes the migration. Deliberately deferred: it is the expensive half
and buys the non-urgent property.

**Blocked on** one of — the key directory (Tier 2 in [features.md](features.md))
taking over as the primary discovery path so ~17 KB certificates never ride an
email header; or a resolution of the Autocrypt-size question upstream; or
evidence from PQ.4 that large headers are fine after all.

**Done when.** Signature verification and the `seen`/`verified`/`changed` trust
states behave identically on a v6 composite key, and old v4 signatures still
verify.

---

## Open questions

1. **rPGP maturity.** PQ.1 answers this. If neither library is ready, the
   fallback is Sequoia or a delay — not hand-rolled lattice code. No custom
   primitives, per [security.md](security.md).
2. **Interop reality.** RFC 9980 is new. Thunderbird/Proton/GnuPG support is a
   moving target, and a hybrid key that older clients reject would undercut the
   interop argument for choosing OpenPGP in the first place. Feed results into
   the Tier 4 interop suite.
3. **Migration for existing users.** Moot today — there are no real keys, because
   `demoCore` has never generated one. This is precisely the window in which the
   decision is free, and it closes when M2 ships.
4. **Fingerprint stability.** Stage 1 → Stage 2 changes the primary key, so
   fingerprints change and every verification ceremony is invalidated. Either
   accept it as a one-time cost before there is a user base, or sign the new key
   with the old (the self-authenticating-updates path in
   [security.md](security.md)). Decide before Stage 2, not during.

## Documentation this changes

Per the repo rule that docs are the source of truth, adopting this plan requires
updating in the same change:

- [encryption.md](encryption.md) — primitives list; step 3 of the hybrid scheme;
  the tradeoffs section, which currently does not mention quantum adversaries at
  all.
- [key-management.md](key-management.md) — the keypair shape in "The user's keypair".
- [message-format.md](message-format.md) — no envelope change, but a note that
  the armored payload may be composite.
- [features.md](features.md) — add PQ.1–PQ.5 to Tier 1.
- [roadmap.md](roadmap.md) — hybrid PQC into Phase 1 as a core-algorithm decision;
  it does **not** belong in Phase 4.
- [security.md](security.md) — a quantum adversary row in the actors table.
