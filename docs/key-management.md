# Key Management

Key management is where E2EE products live or die. This covers key generation,
storage at rest, discovery of others' keys, recovery, multi-device sync, and
rotation.

## The user's keypair

On first setup, CryptMail generates an OpenPGP keypair **on the device**:

- Primary key: Ed25519 (certification + signing).
- Encryption subkey: X25519 (Curve25519 ECDH).
- User ID bound to the account's email address.

The **public** key is published (see Discovery). The **private** key is never
transmitted or stored anywhere in usable form.

## Private key at rest

The private key is protected in layers:

1. **Wrapped with a passphrase.** The user's passphrase (or a generated recovery
   passphrase) is stretched with **Argon2id** (memory-hard) into a wrapping key;
   that key encrypts the private key with AES-256-GCM.
2. **Held by the OS keychain.** The wrapped key (and/or the unlock secret) is
   stored in the platform secure store:
   - macOS/iOS → Keychain
   - Windows → DPAPI / Credential Manager
   - Android → Keystore (hardware-backed where available)
   - Linux → Secret Service (libsecret)
3. **In memory only when unlocked.** Decrypted private key material stays in RAM,
   zeroized on lock/quit.

The passphrase is never sent to the backend. There is no server-side password
that can decrypt mail.

## Discovery: finding recipients' public keys

Resolved in priority order at send time. All four sources are built
([`app/src/keys/`](../app/src/keys/)):

1. **Local keyring** — keys already cached from prior messages/verification.
2. **Autocrypt cache** — keys learned from `Autocrypt` headers on received mail
   (see [encryption.md](encryption.md)). Harvested during inbox sync, so a key
   arrives without the user opening anything.
3. **VKS — `keys.openpgp.org`** — lookup by address
   (`GET /vks/v1/by-email/<address>`). It serves a key by address only after the
   address owner has clicked a confirmation link, and it strips third-party
   signatures, so an answer is a claim about that address rather than an
   unauthenticated blob anyone could upload. Publishing is
   `POST /vks/v1/upload` then `POST /vks/v1/request-verify`.
4. **WKD (Web Key Directory)** — RFC-shaped lookup at the recipient's *own*
   domain (`https://openpgpkey.<domain>/.well-known/openpgpkey/…`, plus the
   direct form). It cannot help for `@gmail.com` — nobody but Google can publish
   under that domain — so it is a supplement for people on their own domains,
   never the primary path.
5. **Manual import** — paste/scan a key or fingerprint.

If none resolve, the recipient has no key: the message is held and they are
invited ([encryption.md](encryption.md), invite-and-queue).

**"No key" and "could not find out" are different answers.** A definite "nothing
published" is the only thing reported as *the recipient has no key*; a lookup
that failed, or a key that came back and would not import, is reported as a
fault on our side that may clear on the next attempt. Neither ever downgrades
the send — rule 1 holds throughout — but only one of them is a fact about the
recipient. Only VKS can speak for an address — it serves a key only after the owner confirmed it, so its 404
is a real answer and yields "no key". WKD is a supplement: most domains publish
none, so a 404 there is the norm and settles nothing. A VKS lookup that fails or
times out is reported as a failure even when every WKD host answered 404,
because the alternative is telling the user that someone does not use encryption
whenever the keyserver is slow — and holding their message against a key that
was published all along.

**A key is accepted for any address it claims, not just its primary User ID.**
One key commonly carries several addresses (`dkg@debian.org` and
`dkg@fifthhorseman.net` are one key), and VKS serves it for each. The answer is
accepted when any User ID matches the address that was asked about, and the key
is filed in the keyring under *that* address; the fingerprint still identifies
the single underlying key. Judging the answer by the primary User ID alone would
discard a valid key and report the recipient as having none.

### Decision: CryptMail does not run a key directory

Earlier revisions of this document listed a CryptMail-operated directory as
source 3, and [api.md](api.md) specified it. It is **not being built**, and the
user-visible result is the same either way.

Running one would mean hosting and uptime — a directory that is down means users
cannot send — plus abuse limits, an address-verification flow, and a database of
`email → key` mappings that is personal data. It would also produce a real-time
log of who is about to email whom: the social graph, which is precisely what the
product exists to protect. `keys.openpgp.org` already provides the same lookup
with none of that on our side.

Worth revisiting only for key-transparency proofs (§ below) or an enterprise
deployment that wants its own namespace.

### Publishing your own key

Discovery is symmetric: a lookup only finds a key someone published. The app
uploads the user's public key to VKS — but **only after asking**, on the setup
screen or the keys screen. The listing is public: anyone who tries the address
learns that it has a key. That is stated before anything is uploaded, and
declining is remembered rather than re-asked on every launch.

VKS then emails a confirmation link and will not serve the key by address until
it is opened. The app does not parse that mail; it asks the directory the same
question a stranger would — *is this key served for this address yet?* — on each
sync, and a yes is the confirmation, whichever device opened the link.

#### The key must be v4, or it cannot be published at all

Measured against the live service on 2026-08-09. `keys.openpgp.org` refuses a v6
key outright:

```
POST /vks/v1/upload   →  400  {"error": "OpenPGP v6 (RFC 9580) is not yet supported."}
```

The identity is therefore **v4**, with the ML-KEM-768+X25519 encryption subkey
the PQC spec permits there (see [post-quantum.md](post-quantum.md)). Uploading
that key is accepted, and the keyserver serves it back with the post-quantum
subkey intact — confirmed by round-tripping a throwaway key through
`/vks/v1/upload` and `/vks/v1/by-fingerprint`:

```
uploaded → primary v4 alg=22 (EdDSALegacy)   subkey v4 alg=35 (ML-KEM-768+X25519)
served   → primary v4 alg=22 (EdDSALegacy)   subkey v4 alg=35 (ML-KEM-768+X25519)
```

So publication and post-quantum confidentiality are **not** a trade-off. They
looked like one only while the identity was v6.

The stakes are higher than one screen. An unpublishable key makes its owner
undiscoverable, so two CryptMail users writing to each other for the first time
would *both* fall into invite-and-queue even though both are running the app —
the directory would only ever have helped when writing to someone using other
PGP software.

### Trust levels

- **Seen (TOFU):** learned via Autocrypt or a keyserver, trust-on-first-use.
  Fine for the default, opportunistic experience. A keyserver key is **always**
  `seen` and never anything more.
- **Verified:** the user compared the key **fingerprint** out-of-band (QR scan in
  person, phone call, safety-number comparison). Upgrades UI to "verified".
- **Changed:** a previously-seen address presents a new key → sending stops;
  could be a new device (benign) or an attacker (not). Require re-verification.

A keyserver being honest is a trust assumption, and automatic discovery makes it
a load-bearing one: once every client fetches every key, a directory that swaps
one has a much wider reach. Two things bound that. `upsertKey` marks a key that
arrives with a *different* fingerprint for a known address `changed` and blocks
the send, whatever source it came from — so a swap can only affect a
correspondent you have never heard from before. And the safety-number comparison
defeats it outright. See [security.md](security.md) for key-substitution risk and
mitigations (key transparency log, self-signed key changes).

## Recovery

Losing the private key means losing access to all past encrypted mail. Two
supported paths, user chooses at onboarding (can enable both):

### A. Recovery code (recommended, zero-knowledge) — ✅ implemented

- At setup, generate a high-entropy **recovery code** (e.g. a BIP39-style
  mnemonic or a base32 code).
- Use it (via Argon2id) as an alternate wrapping key for the private key.
- Store the resulting encrypted blob in the **encrypted key backup** on the
  backend. The server cannot read it.
- To recover on a new device: sign in, download the blob, enter the recovery
  code, unwrap the private key.
- If the user loses the recovery code **and** all devices → mail is
  unrecoverable. This is stated plainly during onboarding.

**As built**, with three divergences from the above:

1. **No backend, and none needed.** The blob described here is opaque to the
   server, so the server only ever bought convenience. The user exports the blob
   themselves. Storing it as a self-addressed message in the user's own mailbox
   is the next increment — durable, opaque to the provider, no new
   infrastructure — and needs the Gmail transport first.
2. **The wrapping is an OpenPGP Argon2id S2K**, not a bespoke AES-256-GCM
   envelope: the secret key is re-locked from the Keystore passphrase to one
   derived from the code, primary and every subkey. The blob is therefore a
   **standard armored OpenPGP secret key** — GnuPG or Sequoia could open it with
   the code — and the S2K packet carries its own Argon2 parameters, so raising
   them later cannot strand an existing backup. Parameters are RFC 9106 choice 2:
   64 MiB, 3 passes, 4 lanes, AES-256-OCB.

   The KDF is **chosen explicitly, not inherited from the key's version.** It
   used to be read from rPGP's default for whatever version the key happened to
   be, which quietly tied the strength of every backup to an unrelated decision:
   moving the identity to a v4 key swapped Argon2id for iterated-and-salted
   SHA-256 under CFB, and nothing failed — backups still restored, and the guard
   test asked rPGP about V6 while production had moved on. The guard now reads
   the S2K out of a blob that was actually produced
   (`tests/recovery.rs::the_blob_is_wrapped_with_argon2id_whatever_version_the_key_is`).
3. **The code is 160 bits of Crockford base32**, generated (never chosen), so
   option B below is deliberately not implemented — it is strictly weaker and a
   second path to maintain.

The identity is unchanged by all of this: same key, same fingerprint, so senders
never have to do anything. See
[the design spec](superpowers/specs/2026-08-08-key-recovery-rust-design.md).

### B. Passphrase backup
- Same as above but wrapped with the user's chosen passphrase instead of a
  generated code. More memorable, weaker if the passphrase is weak.

### Non-goal: server-side recovery of readable keys
The backend never holds anything it can decrypt. We do not offer "we'll reset it
for you" recovery, because that would mean the server could read mail.

### As built

Option A only. Option B is **deliberately not implemented**: it is strictly
weaker than a generated code and would be a second path to maintain for no
security gain. The code is generated, never chosen, so there is no
weak-passphrase failure mode to design around.

The contract is two methods on `CryptCore`
([`app/src/core/types.ts`](../app/src/core/types.ts)):

```ts
exportRecoveryBackup(email): Promise<{ code, blob }>
importRecoveryBackup(blob, code): Promise<Identity>
```

Both sides are strings and `blob` is ciphertext, so the "no private key leaves
the core" rule holds. A wrong code is `decrypt-failed`; a blob that is not a
backup is `malformed` — distinguished so the UI can say which of the two the
user got wrong, rather than sending someone to look for a piece of paper that
was fine all along.

The code is 160 bits in **Crockford base32** — no `I`, `L`, `O` or `U` — shown as
eight groups of four. Confusables are folded on input rather than rejected: a
code written by hand and typed back with `O` for `0` still opens the backup.
See [`app/src/core/recoveryCode.ts`](../app/src/core/recoveryCode.ts).

Three divergences from the plan above, all deliberate:

1. **There is no backend, so the user holds the blob.** The server described
   above is zero-knowledge and therefore contributes nothing cryptographically —
   removing it costs convenience, not security. Building one would also make
   CryptMail a service rather than a client, which is the project's first
   architectural commitment. The app exports the blob and the user stores it.

   The intended next step is storing the blob as a **self-addressed message in
   the user's own mailbox**: durable, fetchable after sign-in on a new device,
   opaque to the provider, and no new infrastructure. It drops onto the contract
   above unchanged. Deferred until the Gmail transport has run against Google.

2. **Device approval is not built.** See Multi-device below — it genuinely needs
   a server to coordinate, and it is marked optional there.

3. **Recovery is offered before an identity is generated.** `AppState.attach`
   used to generate one at sign-in, so a fresh device held a throwaway key by the
   time the user reached the Recovery screen, and restoring discarded it — a
   fingerprint change every correspondent saw, caused by the app, for nothing.
   It now loads an identity and stops. A signed-in account with no key lands on
   [`SetupScreen`](../app/src/screens/SetupScreen.tsx), which offers *restore
   from a recovery code* first and generates only when the user declines it.
   This matters more once discovery is live: with every client fetching every
   key automatically, one avoidable rotation blocks compose for every contact.

**Status:** the contract, the demo implementation, the UI and the tests exist.
The Argon2id wrapping itself is Rust and is **not implemented** — see §4.1 of
[implementation-status.md](implementation-status.md). Until it lands, recovery
works in demo mode only, and a native build reports `unavailable`.

## Multi-device

- **New device enrollment:** the new device downloads the encrypted key backup
  and unwraps it with the recovery code/passphrase → same identity, same private
  key on all devices.
- **Device approval (optional hardening):** require an existing device to approve
  the new one before the backup is released, to resist a stolen-password attacker.
- **Public key stays the same** across devices, so senders don't need to change
  anything.

## Key rotation and expiry

- Keys carry an expiration; subkeys can be rotated without changing the primary
  identity/fingerprint.
- On rotation, the new public key is republished (keyserver + Autocrypt) and the
  old private key is retained locally (marked non-preferred) so historical mail
  stays readable.
- Compromise → revoke: publish a revocation certificate and a fresh key; warn
  contacts on next contact.

### Self-authenticated rotation — partly built

A key change signed by the key it replaces is something only that key's holder
could produce, so it is a rotation and not a substitution. Accepting one keeps a
legitimate key change from hard-blocking every correspondent's compose screen.

The **trust transition** is built and tested: `upsertKey` takes a
`rotation: 'self-signed' | 'none'` and accepts a changed fingerprint as `seen`
(never `verified` — the signature says the same person made this key, not that
anyone compared its safety number). Without the evidence it stays `changed` and
the send is blocked, which is today's behaviour exactly.

**Verifying** the signature is a core operation and needs the Rust core, so
every caller passes `none` for now and nothing yet carries such a signature in
the message path. Until then, §Recovery above — restoring the same key rather
than minting a new one — is what actually keeps fingerprints stable, and it is
the larger practical win because it prevents most rotations from happening.

## Summary of what is stored where

There is no CryptMail backend, so the middle column is the public keyserver —
which holds public keys and nothing else.

| Item | Device (encrypted store / keychain) | `keys.openpgp.org` | Mail provider |
|------|-------------------------------------|--------------------|---------------|
| Private key (usable) | ✅ (wrapped, RAM when unlocked) | ❌ | ❌ |
| Private key (code-wrapped backup) | ✅ (user exports it) | ❌ | ❌ |
| Own public key | ✅ | ✅ (if the user published it) | ✅ (Autocrypt headers) |
| Contacts' public keys | ✅ (keyring) | ✅ (public listings) | ✅ (headers on their mail) |
| Passphrase / recovery code | ❌ (memorized / on paper) | ❌ | ❌ |
| Who you correspond with | ✅ | ❌ (no account, no log we hold) | ✅ (envelope metadata) |
| Message ciphertext | cached | ❌ | ✅ |
| Message plaintext | RAM / optional cache | ❌ | ❌ |
