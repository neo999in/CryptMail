# CryptMail — handoff after the v4 migration

**Written 2026-08-09**, same day as `CryptMailhandoffkeydiscovery.md` and one day
after `docs/handoff.md`. Read those first for project state; this one covers a
single day's work: verifying key discovery against the *real* `keys.openpgp.org`
for the first time, the three bugs that fell out, and the key-version migration
that unblocked publishing.

**Nothing is committed.** All of it is in the working tree on top of `b81ad1b`.

---

## 1. Start here

> Continue work on CryptMail. Read `docs/handoff.md` for project state,
> `CryptMailhandoffkeydiscovery.md` for the key-discovery workstream, and this
> file for the v4 migration. Start with §6 — two designed, unimplemented
> features. Everything in §2–§4 is done and verified; do not redo it.

Ground rules are in `CLAUDE.md`. The one that bites: docs in `docs/` are the
source of truth, so a change contradicting one updates it in the same PR.

---

## 2. What landed

### The identity is now a v4 key — this is the headline

`keys.openpgp.org` refuses v6 outright:

```
POST /vks/v1/upload  →  400  {"error": "OpenPGP v6 (RFC 9580) is not yet supported."}
```

`core/src/identity.rs` generated **v6** keys, so **no CryptMail user could ever
publish**, which means no user could be *found*. Two CryptMail users writing to
each other for the first time both fell into invite-and-queue even though both
ran the app. The directory only ever helped when writing to someone using other
PGP software.

The fix was not a trade-off. `docs/post-quantum.md` §Stage 1 already specified a
v4 encryption subkey; the code had drifted from its own design doc on the
mistaken reading that RFC 9980 required v6. It does not: ML-KEM-768+X25519
(algorithm 35) is the **single exception** the PQC draft permits on a v4
encryption subkey, precisely for this migration shape.

So the identity is now:

```
primary: v4  alg=22 (EdDSALegacy)
subkey:  v4  alg=35 (ML-KEM-768+X25519)
```

**Two details that are easy to get wrong and that no size or round-trip test
catches:**

1. The primary must be `KeyType::Ed25519Legacy` (**alg 22**), not
   `KeyType::Ed25519` (**alg 27**). 27 is RFC 9580's codepoint; VKS accepts it
   happily, but v4-era GnuPG cannot read it — you would ship a "compatible" key
   the install base still can't use, with green tests. rPGP's own source calls
   alg 22 "the v4-only key format variants".
2. The **subkey must be v4 too**. A v6 subkey under a v4 primary is still
   refused on upload.

`core/tests/roundtrip.rs::the_identity_is_stage_one_hybrid` pins both.

### Recovery S2K is now stated, not inherited

`recovery.rs::rewrap` used `S2kParams::new_default(rng, key.version())`, which
ties backup strength to the *key's version*:

```
V6 → Aead + Argon2id(t=3, p=4, m=64MiB)      ← what recovery relies on
V4 → Cfb  + IteratedAndSalted(SHA-256, 224)  ← what it silently became
```

Changing the key version for an unrelated reason downgraded every recovery blob,
**and every test stayed green** — the old guard asked rPGP for the *V6* default
while production had moved to v4. That is the exact failure its own comment
warned about, arriving through a different door.

Now `recovery_s2k()` names Argon2id explicitly, and
`tests/recovery.rs::the_blob_is_wrapped_with_argon2id_whatever_version_the_key_is`
reads the S2K **out of a blob that was actually produced**. Verified by
reverting: it fails with the CFB output.

Note the *at-rest* key (`identity::generate`) still inherits S2K and is now
CFB+SHA-256. That one is fine and was checked, not assumed:
`KeystorePassphrase.kt` feeds it `SecureRandom` bytes sealed in the Android
Keystore, and KDF hardening exists to slow brute force against *human-chosen*
passphrases. The recovery blob is the case that genuinely needed Argon2id.

### Three discovery bugs, found by pointing the app at the real keyserver

1. **A lookup failure was reported as "nobody has a key."** `lookupKey` let a
   404 from *any* source mask a *failure* of another, so a WKD 404 (the norm —
   most domains publish none) converted a VKS timeout into a definite "no key".
   Now only **VKS** can answer definitively; WKD is a supplement. The asymmetry
   is deliberate and commented.
2. **Our own timeout wasn't recognised as one.** `isAbort` matched only
   `name === 'AbortError'`; React Native rejects an aborted fetch as a plain
   `Error` reading `"Fetch request has been canceled"`, so the raw platform
   string reached the user. Fixed by recording that *we* fired the deadline
   (`expired` flag) rather than inferring it from the error's shape.
3. **Multi-UID keys were rejected.** `AppState.discover` compared the queried
   address against the core's single `info.email` — the *primary* User ID. One
   key routinely carries several addresses (`dkg@debian.org` and
   `dkg@fifthhorseman.net` are one key) and VKS serves it for each. New
   `addressesInKey()` reads every UID packet; the key is filed under the address
   that was **asked about**, since that is what keyring lookups use.

Plus two supporting fixes: publish errors rendered in the **wrong card**
(`KeysScreen` shared one `error` state whose only `Callout` lived inside "Add
someone's key", below the fold — so publishing appeared to do nothing), and
`publishKey` now repeats the keyserver's own `error` field rather than a bare
status code. That last one is how the v6 rejection was finally diagnosed.

### Timeouts were set against no measurement

Sampled: `1.1s, 7.8s, 9.8s` on three consecutive VKS lookups, tail past 20s.
The old 6s budget timed out often — and a timed-out lookup leaves the recipient
`missing`, so rule 1 **emails a stranger an invite** to install CryptMail when
they had a published key all along. Now `LOOKUP_TIMEOUT_MS = 15_000` and
`PUBLISH_TIMEOUT_MS = 45_000` (publish uploads a large PQ key and is a button
press whose whole purpose is the round trip).

---

## 3. Verified end to end on the emulator

Live mode, real Gmail, real keyserver. `neotestmail9@gmail.com` is a **throwaway**
test account — see §7.

| Check | Result |
|---|---|
| New identity is v4 | on-device key reads `secret-primary: v4`, `secret-subkey: v4` |
| Fingerprint | `CA7C 3C2C … 794E 8111` — 40 hex chars (v6 was 64) |
| Publish | **Uploaded** → confirmed → **Listed** |
| Independent check from host | `by-fingerprint` 200: `primary v4 alg=22` + `subkey v4 alg=35` |
| Address searchable | `by-email` 200, byte-identical (same SHA-256) |
| App noticed unaided | `refreshPublish` flipped pending → published on sync |
| Lookup of a real published key | `security@python.org` → **KEY FOUND** |

**The post-quantum subkey survives publication intact** — the thing that would
have made the whole migration pointless.

Release APK built and verified: `app/android/app/build/outputs/apk/release/app-release.apk`,
104 MB. Native library confirmed **by hash** (arm64 `9b56902d…`, x86_64
`3e6a961d…` — sizes are misleading, the stripped new lib is byte-identical in
size to the old unstripped one) and the JS bundle contains all four new strings.

**Not verified:** anything on a physical phone. StrongBox and `arm64-v8a` remain
untouched — the emulator is `x86_64`.

---

## 4. Traps worth carrying forward

1. **Background build tasks get torn down silently**, leaving 0-byte logs. Two
   `expo run:android` runs died that way. Run long builds in the **foreground**,
   or verify the artifact afterwards rather than trusting the task.
2. **Never compare `.so` files by size.** The stripped new library was
   `5,593,184` bytes — the same as the old one. Hash them, and check the
   intermediate timestamps run forward: `jniLibs → merged_native_libs →
   stripped_native_libs → apk`.
3. **`libcryptmail_core.so` never appears in `/proc/maps` or `nativeloader`
   logs.** JNA `dlopen`s it directly. Do not conclude the core is missing from
   that; the only reliable signal is behaviour (or a `CryptMailCore.*` error).
4. **`run-as` fails on release builds** (`package not debuggable`), so on-device
   file inspection needs the debug build.
5. **An existing identity does not migrate itself.** `load_identity` returns the
   stored key, so a device holding a v6 identity keeps failing to publish. On
   debug: delete `files/cryptmail-core/identity-*.asc` via `run-as`. On release:
   clear app data. Either way it mints a **new fingerprint**.
6. **`sendOut` mtimes lie after a checkout** — a `.rs` newer than the `.so` does
   not mean the core is stale. Check `git log` for the last commit touching
   `core/`.

---

## 5. Where things stand

```
core   39 tests   (was 38)
app   275 tests / 26 suites   ·   npx tsc --noEmit clean
```

The app count *dropped* from 291/27 — that is `app/src/simple/`, tracked in HEAD
but absent from the working tree. It was already deleted in the session-start
snapshot: **a pre-existing in-flight simple-UI removal, not a regression from
this work.** Nothing here references it. Whoever picks this up should decide
whether to finish or revert that removal; right now the tree has deleted files
(`SimpleComposeScreen`, `sendMode.ts`, `uiModeStore.ts`, `docs/simple-ui-plan.md`)
that HEAD still tracks.

**⚠️ `sendMode.ts` was the one place `sendPlain` was reachable from** — the
"sendPlain is unreachable from the encrypted path" invariant in
`CryptMailhandoffkeydiscovery.md` §3 needs re-checking once that removal settles.

Modified: `core/src/{identity,recovery}.rs`, `core/tests/{recovery,roundtrip}.rs`,
`app/src/keys/discovery.ts`, `app/src/pgp/parseArmoredKey.ts`,
`app/src/state/AppState.tsx`, `app/src/screens/{ComposeScreen,KeysScreen}.tsx`,
their tests, and `docs/{key-management,post-quantum}.md`.

---

## 6. Designed, approved-in-shape, NOT implemented — start here

Two features were designed this session and never written. The design below was
presented and is awaiting final approval; treat it as a strong proposal, not a
decision.

### 6.1 Clickable links in message bodies

Message bodies render as one plain `<Text>` (`MessageScreen.tsx:153`). No
`Linking` import exists anywhere in the app yet — React Native ships it, so no
new dependency.

**`app/src/lib/links.ts`** (new, pure, tested) — `linkify(text): Segment[]`
where a segment is `{ text, url? }`. Detect `http(s)://` **only**, and trim
trailing punctuation so `…see https://x.com/a.` doesn't swallow the full stop.
Nothing else becomes a link: no bare `www.`, no custom schemes. **That exclusion
is the security boundary** — `javascript:` and `file:` URLs must never become
tappable.

`MessageScreen` maps segments instead of printing one string; link segments in
brass, underlined. Decrypted bodies get it for free — same `<Text>`.

**A tap opens a confirm sheet, not the browser.** Host on its own line, then the
full URL, then Open / Copy / Cancel. Model it on the existing `AccountSheet`.
The user chose this over opening immediately: tapping a link in an email is the
classic phishing move, and one extra tap makes a spoofed destination visible
before it can do harm.

### 6.2 One-tap keyserver verification

**`app/src/keys/verifyLink.ts`** (new, pure, tested) —
`verifyLinkFrom({ from, body, fingerprint }): string | null`. Returns a URL only
if **all three** hold:

1. sender is exactly `keyserver@keys.openpgp.org`
2. the body contains **our own fingerprint**
3. the URL's host is exactly `keys.openpgp.org` **and** its path starts `/verify/`

Check 2 is what makes this safe — a forged confirmation can't name your
fingerprint before you've published. Check 3 matters because the same email also
contains `/about` and the bare domain; "first keys.openpgp.org URL" grabs the
wrong one.

The real email, captured from the live service:

```
From:    keyserver@keys.openpgp.org
Subject: Verify neotestmail9@gmail.com for your key on keys.openpgp.org

Hi,
This is an automated message from keys.openpgp.org. …
OpenPGP key: CA7C3C2CEA146FAEC4F71A15CCE350E7794E8111
To let others find this key from your email address "neotestmail9@gmail.com",
please follow the link below:
  https://keys.openpgp.org/verify/ZWoNyoqHMrK0hVJk0PT1hKz62tvob6yeWOF2gYV7Rjr
You can find more info at https://keys.openpgp.org/about
```

`plainBodyOf` already decodes quoted-printable and base64, so soft-wrapped long
URLs are handled — use it, don't re-parse MIME.

**Wiring:** inside the existing `refreshPublish`, which already runs each sync
and only works while status is `pending`. Scan the already-synced
`state.messages` for that sender, then spend one `getRaw` + `plainBodyOf`. **No
new `MailClient` method** — the seam is provider-agnostic and adding search to
it is not worth this feature.

**UI:** the pending banner gains a primary button, *"Open the confirmation
link"*, which opens **directly** — no sheet, because the three checks have
already established far more than a human squinting at a URL could. Afterwards
the existing `refreshPublish` flips the card to "Listed" on the next sync.

**Known limitation, to be stated rather than engineered around:** it scans the
last 20 synced inbox messages. If Gmail files the mail as spam or volume pushes
it out, the button won't appear and today's copy stands.

**Tests** (siblings, per repo convention): `lib/__tests__/links-test.ts`
(detection, punctuation, rejected schemes) and
`keys/__tests__/verifyLink-test.ts` (wrong sender, wrong fingerprint, wrong
host, the `/about` decoy, and the real email above as a fixture). Screens stay
untested.

`docs/key-management.md` §Publishing gets the in-app confirmation step and the
three checks.

### 6.3 Also designed earlier, also unimplemented: "Check for a key"

From the previous conversation, still outstanding: on a held (`awaiting-key`)
outbox message, relabel **Send now → Check for a key** and surface the outcome.
`sendScheduledNow` returns `Promise<void>` and swallows the `SendOutcome`; it
should return `SendOutcome | null` (`null` = no longer in the outbox).

New pure `app/src/outbox/checkResult.ts` — `describeCheck(pending,
undiscoverable)` splitting "nobody has published a key yet" from "couldn't reach
the directory", reusing the `undiscoverable` state added this session. **Don't
forget the third branch:** `deliver` *throws* on a changed fingerprint, so
without a catch, tapping on a message whose recipient substituted their key
looks like nothing happened.

---

## 7. Open items not addressed

1. **Physical phone.** Nothing has run on real hardware. StrongBox and
   `arm64-v8a` are untested. The release APK is ready to sideload.
2. **`sendPlain` carries no `Autocrypt` header** — unlike `deliver` and the
   invite, both of which pass `autocryptKey`. So an explicitly-plaintext email
   teaches the recipient nothing about how to reach you encrypted. Looks
   unintentional; the invite is plaintext and carries the header precisely
   because a plaintext message is what bootstraps. Adding it doesn't touch rule
   1 — a public key is not message content.
3. **Rotation signature verification** — unchanged from
   `CryptMailhandoffkeydiscovery.md` §4.3. Still half-built.
4. **The stale README banner** (`app/modules/cryptmail-core/README.md` opens
   "⛔ This has never been compiled") — still wrong, still unfixed.
5. **The PR template still contradicts merged behaviour**
   (`CryptMailhandoffkeydiscovery.md` §4.5) — still unfixed.
6. **Two throwaway probe keys are public on `keys.openpgp.org`**, retrievable by
   fingerprint only: `153F2686C5634F5F7BF2C502C28A5EF59A4BCD5D` and
   `EEFFA5FCFD9942B821B2067A2A23BF586C61163D`. Both unverified, so no address is
   searchable; UID is `cryptmail-probe@example.com`, an IANA-reserved domain
   that cannot receive mail — which also means VKS's removal flow can never be
   completed. They persist as orphans. Harmless, but they exist.

---

## 8. Test account

`neotestmail9@gmail.com` — **throwaway**, signed in on the emulator, `app/.env`
holds a working `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, so that build runs in **live
mode** (real Gmail, real keyserver) rather than demo fixtures. Its v4 key is
**published and verified** on `keys.openpgp.org` — public and effectively
permanent.

`neo999in@gmail.com` appears as a *recipient* in test sends; it has no CryptMail
key, so messages to it exercise the awaiting-key queue. Two such messages are
sitting held in the emulator's outbox right now.

Live-mode actions from this emulator are **real and often irreversible** —
publishing, sending, inviting. Never point these flows at a personal address.
