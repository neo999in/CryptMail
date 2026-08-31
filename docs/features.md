# Feature Register

Every feature CryptMail could plausibly build next, written against **what the
code actually does today**.

This is the implementation-oriented companion to [roadmap.md](roadmap.md).
The roadmap answers *"what are we committed to, and in what phase?"*; this file
answers *"what exactly would we build, which files would it touch, what's
blocking it, and how would we know it works?"*

Last updated: 2026-08-31.

---

## How to read this

Every entry carries a **readiness** tag — the single most useful axis in this
repo, because the app currently runs against a non-cryptographic demo core with
no backend:

| Tag | Meaning |
|---|---|
| 🟢 **Ready** | Buildable today, in TypeScript, against the existing demo core. No new native code, no server. |
| 🟡 **Needs core** | Blocked on the real Rust `cryptmail-core` (M1/M2 of [prototype-plan.md](prototype-plan.md)). |
| ⚫ **Debt** | Not a feature — something already wrong that gates shipping to real users. |

**Impact** and **effort** are S/M/L, from the perspective of a small team. They
are prioritisation aids, not estimates.

---

## Baseline — what exists today

Twelve features have been built one-by-one on top of the encryption prototype,
each test-driven and verified in the running app. Knowing this is what makes
"upcoming" well-defined.

| Shipped | Core module | Screens | Tests |
|---|---|---|---|
| Search over decrypted mail | [`search/search.ts`](../app/src/search/search.ts) | Inbox search field | 9 |
| Threading / conversation view | [`threads/threads.ts`](../app/src/threads/threads.ts) | `ConversationScreen` | 7 |
| Drafts + autosave | [`drafts/drafts.ts`](../app/src/drafts/drafts.ts) | `DraftsScreen`, Compose | 9 |
| Message actions (star / archive / read) | [`mail/flags.ts`](../app/src/mail/flags.ts) | Inbox rows, `MessageScreen` | 8 |
| Scheduled send + outbox | [`outbox/outbox.ts`](../app/src/outbox/outbox.ts) | `ScheduledScreen`, Compose | 8 |
| Import real OpenPGP public keys | [`pgp/parseArmoredKey.ts`](../app/src/pgp/parseArmoredKey.ts) | `KeysScreen` | 11 |
| Autocrypt harvest during sync | [`keys/autocrypt.ts`](../app/src/keys/autocrypt.ts) | — (inbox sync) | 10 |
| Key discovery + publish (VKS, WKD) | [`keys/discovery.ts`](../app/src/keys/discovery.ts) | `KeysScreen`, `SetupScreen` | 23 |
| Invite + `awaiting-key` queue | [`outbox/outbox.ts`](../app/src/outbox/outbox.ts), [`store/inviteStore.ts`](../app/src/store/inviteStore.ts) | Compose, `ScheduledScreen` | 15 |
| Reply / reply-all / forward (0.7) | [`mail/reply.ts`](../app/src/mail/reply.ts) | `MessageScreen` → Compose | 32 |
| Category drawer (Primary/Bills/…) | [`categorizer/categorizer.ts`](../app/src/categorizer/categorizer.ts) | `CategoryDrawer`, Inbox | 16 |
| Attachments (0.18) | [`mail/attachment.ts`](../app/src/mail/attachment.ts), [`core/mime.ts`](../app/src/core/mime.ts) | Compose, `MessageScreen` | 33 |

416 tests in all. Run with `npm test` (jest-expo). Convention: pure logic lives
in a framework-free module with a `__tests__/*-test.ts` sibling; persistence
lives in `store/*`; `state/*` orchestrates (a React end in `AppState.tsx`, the
work in plain service modules).

**What is deliberately still fake:**

- `core/demoCore.ts` **base64-encodes; it does not encrypt.** Every send path
  gates on `core.kind`, so the app can never present encoded bytes as encrypted.
- No backend at all, and none planned — no CryptMail key directory, no push, no
  secure links. Key discovery goes to `keys.openpgp.org` and WKD from the client
  ([key-management.md](key-management.md) §Discovery).
- Local storage is no longer plaintext — every store is sealed with
  XChaCha20-Poly1305 under a device key (⚫ Debt 1) — but **web has no keychain**,
  which `storageReason()` reports rather than hides.
- One real provider connector (Gmail REST) plus a demo fixture client, behind
  the `MailClient` interface: `listInbox` / `getRaw` / `send` / `updateFlags`.

---

## Tier 0 — 🟢 Buildable today

No native code, no server. These are the features that can be picked up in the
current session and finished end-to-end.

### 0.1 Client-side filters & rules · Impact M · Effort M

**What.** User-defined rules — *if sender is X / subject contains Y → star,
archive, label, mute, mark read* — evaluated locally.

**Why.** The provider cannot read encrypted mail, so server-side filtering is
structurally impossible for exactly the messages that matter most. Rules have to
run on-device after decrypt or they don't exist. This is one of the clearest
"encryption forces us to rebuild it client-side" features, and it composes with
the search index that already stores decrypted content.

**Build sketch.** A pure `rules/rules.ts` (`type Rule`, `matchRule`,
`applyRules(messages, index, rules): FlagPatch[]`) reusing the same
summary+index shape `messageMatchesQuery` already takes. Persist in
`store/rulesStore.ts`. Run from `AppState` on inbox refresh and after
`openMessage` indexes new content. New `RulesScreen` + entry in the account
sheet; "create rule from this message" from `MessageScreen`.

**Done when.** A rule created from a message auto-applies to a matching message
on the next refresh, survives restart, and never fires on content that hasn't
been decrypted on this device.

### 0.2 Labels / folders + bulk selection · Impact M · Effort M

**What.** Local labels, multi-select in the inbox, bulk archive/star/mark-read,
swipe actions on mobile.

**Why.** `updateFlags` already exists in the connector and Gmail maps labels
natively; the inbox is currently a flat single-action list. This is table stakes
that also gives filters (0.1) something to act on.

**Build sketch.** Extend `FlagPatch` with `labels?: { add?: string[]; remove?:
string[] }`; implement in `demoMail.ts` and via `messages/{id}/modify` in
`gmail.ts`. Selection state in `InboxScreen`; a bulk action bar. Keep the
sibling-`Pressable` row pattern — a nested pressable inside the row breaks on
RN-web.

**Done when.** Selecting three messages and archiving them updates the list
optimistically and survives a refresh.

### 0.3 Undo send · Impact S · Effort S

**What.** A 5–30 s window after Send during which the message can be pulled back.

**Why.** Nearly free given the outbox: it is `scheduleSend` with a very short
`sendAt` plus a toast. It also makes the scheduler's catch-up-on-launch path
exercised on every send rather than only on scheduled ones.

**Build sketch.** Compose calls `scheduleSend({ sendAt: now + delay })`; show a
persistent toast wired to `cancelScheduled` → restore draft. The 15 s scheduler
tick is coarser than a 5 s window, so either tighten the interval or schedule a
one-shot timer for the exact due time.

**Done when.** "Undo" within the window leaves the message in Drafts and nothing
in the mailbox; ignoring the toast delivers exactly once.

### 0.4 Snooze · Impact S · Effort S

**What.** Hide a message until a chosen time, then return it to the top of the
inbox.

**Why.** Same shape as the outbox (a due-time queue), and again something the
provider cannot do on the user's behalf for encrypted mail.

**Build sketch.** `snooze/snooze.ts` mirroring `outbox.ts` (`dueSnoozed`), a
`store/snoozeStore.ts`, filtered out of `InboxScreen` while pending, re-surfaced
by the same interval tick that drives the scheduler. Worth extracting one shared
`dueQueue` helper rather than a third near-copy.

**Done when.** A snoozed message disappears from the inbox, reappears at its due
time, and survives a restart.

### 0.5 Contacts & per-contact trust dashboard · Impact M · Effort M

**What.** An address book built from the keyring plus seen senders: one screen
showing every contact, their trust state, when the key was first seen, and
whether it ever changed.

**Why.** `contact_keys.trust` (seen / verified / changed) is already tracked and
already drives the compose fail-safe, but it's only visible on the Keys screen.
Trust is the product's actual security claim; it deserves a first-class surface.

**Build sketch.** `contacts/contacts.ts` merging `Keyring` with addresses
observed in `messages`. New `ContactsScreen`; recipient autocomplete in Compose
sourced from it, with the trust badge shown inline as you type.

**Done when.** Every address the app has seen appears with the right trust badge,
and picking one in Compose shows its state before you type a body.

### 0.6 Email signature + canned replies · Impact S · Effort S

**What.** A stored signature appended on compose; a small set of reusable
snippets.

**Build sketch.** Settings values in a new `store/settingsStore.ts`; Compose
seeds the body with the signature for new messages (never on a resumed draft, or
autosave will duplicate it).

**Done when.** A new message opens with the signature; editing and sending
behaves; drafts don't accumulate copies.

### 0.7 Reply / reply-all / forward · Impact L · Effort S — ✅ **Built**

**What.** Reply, reply-all and forward from an open message.

**Built.** [`mail/reply.ts`](../app/src/mail/reply.ts) is the pure derivation:
`buildReplyDraft` reshapes the decrypted subject/body and the summary's headers
into prefilled Compose params, with `replyRecipients` / `replyAllRecipients`
excluding the user's own address. `MessageScreen` calls it and navigates to
Compose; nothing is re-fetched, and the body quoted is the one already decrypted
in memory. `In-Reply-To`/`References` ride in the clear as provider metadata
([message-format.md](message-format.md)) and are emitted on a reply but not on a
forward, which starts a new conversation the way Gmail does. Reply-all goes
through the same `resolveRecipients` fail-safe as any send, so a recipient
without a key holds the message rather than downgrading it. 32 tests.

**Still open.** Nothing blocking. The quoted body is plain text, so rich quoting
arrives with 0.9.

### 0.8 Remote-content / tracking-pixel blocking · Impact M · Effort M

**What.** Don't load remote images by default; a per-message "load images" and a
per-sender allowlist.

**Why.** A privacy client that silently phones home on open undercuts its own
promise. Currently moot (bodies render as plain text) but becomes urgent the
moment HTML rendering lands — build the policy first, and it's cheap.

**Build sketch.** A `privacy/remoteContent.ts` that rewrites/strips remote `img`
and `link` URLs from decrypted HTML before render, plus the allowlist store.
Pairs with 0.9.

**Done when.** A message with a tracking pixel issues zero network requests on
open, and "load images" is an explicit, per-message action.

### 0.9 HTML reader + rich-text compose · Impact M · Effort M–L

**What.** Render inbound HTML mail; optionally compose it.

**Why.** Most real mail is HTML; plain-text-only is a hard ceiling on
usefulness. But this is the app's largest new attack surface — decrypted HTML is
attacker-controlled and can exfiltrate plaintext via remote loads.

**Build sketch.** Sanitise in one auditable module (`html/sanitize.ts`) with an
allowlist of tags/attributes, no scripts, no remote loads without 0.8's consent.
Extend `parseProtectedInner` to walk `multipart/alternative` and prefer
`text/plain` when present.

**Done when.** A hostile fixture (script tags, `onerror`, remote CSS, data-URI
payloads) renders inert, verified by tests over the sanitizer.

### 0.10 Privacy-preserving notification policy · Impact M · Effort S

**What.** The rule that a notification never carries subject or sender to the OS
lock screen; fetch and decrypt first, then reveal only if the device is unlocked
and the user opted in.

**Why.** The push relay is Phase 2 and needs a backend, but the *policy* and its
UI can be settled now so the relay can't be built the wrong way.

**Build sketch.** A `notifications/policy.ts` deciding what text a payload may
contain per setting; document the contract so [api.md](api.md)'s relay never
sees content.

**Done when.** Policy tests cover every setting, and the payload contract is
written down before the relay exists.

### 0.11 Multiple accounts + unified inbox · Impact M · Effort M–L — **built**

**What.** More than one mailbox, switchable, optionally merged.

**Why.** The data model already keys on `account_id` ([data-model.md](data-model.md));
the app hard-coded a single session. Retrofitting this later touches every
store, so doing it earlier is cheaper.

**How it works.** Every per-account store is keyed
`cryptmail.<store>.v1@<provider>:<address>`
([`app/src/store/accountScope.ts`](../app/src/store/accountScope.ts)). The id
pairs the provider with the address because the same mailbox read through
fixtures and through Gmail is two different sets of local data. The registry of
connected mailboxes is the one store that stays global
([`accountsStore.ts`](../app/src/store/accountsStore.ts)); it is sealed like the
rest, since a list of a person's mailboxes is exactly the metadata this product
keeps off a server.

`state/accounts.ts` owns which mailbox is in front, and
[`AppState`](../app/src/state/AppState.tsx) exposes `accounts`,
`activeAccount`, `unified`, and the four actions that change them. Each account
gets its own `MailClient`, cached in `mail.clients`.

**The rule that keeps them apart: exactly one account is active at a time**,
including while the inbox is merged. Merging is a *reading* convenience — rows
are tagged with the mailbox they came from, flag changes go to that mailbox's
provider, and opening a row from another account **switches to it first**.
Composing, sending and decrypting always use the active account, because each
needs one identity and one keyring; choosing those per message is precisely how
state leaks between mailboxes.

Removing an account deletes every scoped store belonging to it. Leaving its
search index — a plaintext copy of that mailbox's mail — on disk would make the
button a lie, and re-adding the address would silently adopt it.

An install that predates this keeps its data: `loadScopedJson` reads the old
global key once, **moves** it under the first account signed in, and deletes it,
so the second account starts empty rather than inheriting the first one's mail.

Gmail is still one account at a time —
[`googleAuth.restoreAll`](../app/src/auth/googleAuth.ts) can only return one
session because Play services holds a single signed-in user. Everything above
that line is multi-account, and demo mode connects two mailboxes
(`DEMO_ADDRESSES`) to exercise it.

**Done when.** Two demo accounts coexist, each with its own keyring and drafts,
and switching never leaks state between them. Covered end to end, against the
real stores, by
[`state/__tests__/accounts-test.ts`](../app/src/state/__tests__/accounts-test.ts).

### 0.12 Storage management & cache eviction · Impact S · Effort S

**What.** Show what's cached; bound it; "clear decrypted content" as a visible,
honest control.

**Why.** The search index is a growing plaintext store of decrypted mail. Users
who care enough to run this app deserve a switch for that — and it's the honest
counterpart to the known debt.

**Done when.** A settings row shows index size and clearing it empties the store
without breaking search over freshly-opened mail.

### 0.13 Mailbox export / backup · Impact M · Effort M

**What.** Export decrypted mail as `.mbox` or `.eml` files.

**Why.** The product's honest answer to "no server-side archival": your data is
yours and you can take it out. Also a de-risking story for account loss.

**Done when.** An export opens cleanly in Thunderbird.

### 0.14 Sign-only / verify-only mode · Impact S · Effort S — ◐ partly built

**What.** Send signed-but-unencrypted mail to recipients with no key.

**Why.** The current fail-safe correctly refuses to send. A signed plaintext
option is a middle path that never *pretends* to be private — but it must be an
explicit, clearly-labelled choice, never a fallback the app takes on its own.

**Built:** the *unsigned* half. Compose has an encrypted / not-encrypted mode
chosen up front, and it is the only route to `sendPlain`
([encryption.md](encryption.md), invite-and-queue). It is not a fallback: it
never appears after a send is refused, and it consults no recipient key state.

**Still open:** the signature. `CryptCore` ([app/src/core/types.ts](../app/src/core/types.ts))
exposes `buildEncrypted` and nothing that signs without encrypting, so
"signed only" is a third mode that cannot be built until the core grows one.

**Done when.** The UI distinguishes "encrypted", "signed only", and "refused"
without ambiguity, and signing never happens implicitly.

### 0.15 Onboarding: recovery-code drill · Impact M · Effort S — ◐ partly built

**What.** Make the user actually perform an unlock-with-recovery-code once,
during setup.

**Why.** [security.md](security.md) names permanent data loss as the top *user*
risk. A code you've never used is a code you don't have.

**Built.** Backup and restore themselves, which turned out **not** to need a
backend after all — the server in [key-management.md](key-management.md) is
zero-knowledge, so it only ever bought convenience. The user exports the blob
instead. There is a Recovery screen, and an unprompted warning on Keys for a key
that has never been backed up, which is the part that reaches users who don't
already know they need it.

The Argon2id wrapping in Rust is now written: `core/src/recovery.rs` re-locks the
secret key under an OpenPGP Argon2id S2K, and a test proves a message encrypted
to the original key still decrypts after restoring on a fresh device.

**Not built.** The drill itself: setup still completes without a code entry, and
recovery is reachable only after onboarding has already generated a key.

**Done when.** Setup can't complete without a successful code entry, and the
copy states plainly what is lost if it's lost.

### 0.16 Accessibility, i18n & theming pass · Impact M · Effort M

**What.** Screen-reader labels (trust badges must be conveyed non-visually),
dynamic type, high contrast, RTL, localisation, formal design tokens.

**Why.** Security state communicated only by colour is security state that some
users never receive. Also the hardest copy to translate well — start early.

**Done when.** The inbox and message screens are fully navigable by screen
reader, and every trust state has a text equivalent.

### 0.17 Client-side key sharing · Impact M · Effort M — ✎ designed

**What.** Two more ways a public key can reach a CryptMail user without a
server, a keyserver, a file or a camera: reading an armored public-key block a
human pasted into an email body, and a one-action "send my key over any channel
you already have" on the sending side with a matching one-action import.

**Why.** Discovery's automatic sources are all either a network service (VKS,
WKD) or a header CryptMail itself wrote (Autocrypt). A correspondent who does
the oldest thing in PGP — pastes their key into the message — is still reported
as having no key, and invite-and-queue then emails them an invitation to install
the app so they can send the key they just sent.

**Build sketch.** Design is written up in
[superpowers/specs/2026-08-14-client-side-key-sharing-design.md](superpowers/specs/2026-08-14-client-side-key-sharing-design.md),
including the size floor a post-quantum certificate imposes (~2,400 base64
characters, incompressible), which rules out anything read aloud or typed by
hand. Reuses [`pgp/parseArmoredKey.ts`](../app/src/pgp/parseArmoredKey.ts);
imported keys land as `trust: 'seen'` like any directory key.

**Done when.** A key pasted into a message body is offered for import on open,
and a key handed over an outside channel imports in one action on the far end —
neither ever landing as `verified`.

### 0.18 Attachments · Impact L · Effort M–L — ✅ **Built**

**What.** Attach files to a message, receive them, and get them back out —
sealed inside the encrypted tree along with their names.

**Built.** [`mail/attachment.ts`](../app/src/mail/attachment.ts) is the model:
base64 content, a decoded size, and the two caps (1 MB per file, 4 MB per
message) with `attachmentRefusal` as the single place that says why a file
cannot be attached. [`core/mime.ts`](../app/src/core/mime.ts) builds the parts:
`buildProtectedInner` emits the `text/plain` body followed by one base64 part
per file inside the existing `multipart/mixed`, so filename and type sit *inside*
the ciphertext exactly as [message-format.md](message-format.md) specifies —
`encrypted.asc` stays the only name a provider sees. `parseProtectedInner` reads
them back; [`mail/plainBody.ts`](../app/src/mail/plainBody.ts)'s `attachmentsOf`
does the same for ordinary inbound mail, so the reader renders both the same way.

Both cores carry them, unchanged in shape: the demo core round-trips them
through its encoded payload and the native path hands the same inner tree to
Rust, so nothing new crosses the bridge but the strings that already did.

The send path treats a file as part of the message and nothing else: a held
message keeps its attachments and delivers them when the key arrives, a
scheduled one carries them through the outbox, a rescued one becomes a draft
with them still on it, and a forward takes them along (a reply does not). The
composer's unencrypted mode says plainly that a file sent that way travels in
the clear, filenames included.

Reading: images render at size, everything else is a named row, and each row
says whether it was decrypted on this device. Saving is a per-file tap —
nothing is written to disk by opening a message —
via [`lib/files.ts`](../app/src/lib/files.ts), the one module that talks to the
platform (`expo-document-picker`, `expo-file-system`, the share sheet on
Android, an anchor download on web). 33 tests across the model, the MIME
round-trip, the inbound reader and the send path.

**Still open.** The 1 MB cap. Everything is held in memory as base64 and copied
across the bridge as a string, so a large file is refused up front rather than
taken and dropped later; the fix is file paths and a streaming read in Rust
(Phase 1, [prototype-plan.md](prototype-plan.md)). Inline `cid:` images are
carried and rendered as attachments, but the body is plain text, so a true
inline placement waits on the HTML reader (0.9).

---

## Tier 1 — 🟡 Needs the real crypto core

These are gated on `cryptmail-core` (M1/M2). Several have their *UI* buildable
now against the demo core, with the crypto swapped in later.

| Feature | Impact | Effort | Notes |
|---|---|---|---|
| ~~**Attachments** — send, receive, inline images, preview~~ | — | — | ✅ **Built** (0.18 below), against the demo core and the real one alike. What is still open is only the >1 MB case: streaming over the bridge as file paths rather than base64 strings. |
| **Encrypted local store (SQLCipher)** | L | S–M | Superseded for now: stores are sealed individually (⚫ Debt 1). SQLCipher remains the [data-model.md](data-model.md) target for query performance, not for the encryption property. |
| **Encrypted search index** | M | M | Today's index is plaintext decrypted content on disk, which fights any no-plaintext-cache mode. Encrypting it lets search and that mode coexist. |
| **Key rotation, expiry, revocation** | M | M | Keyring already records `firstSeen`/`lastSeen`/`changed`; needs real key material to act on. |
| **Fingerprint / QR safety-number verification** | L | M | The durable defence against key substitution. Fingerprints render today; the *comparison ceremony* is the feature. QR "add me" cards are a cheaper sibling. |
| **Multiple identities / send-as aliases** | S–M | M | Data model already allows N identity keys per account. |
| ~~**Publish own key via WKD / keyserver**~~ | — | — | ✅ **Built** ([`keys/discovery.ts`](../app/src/keys/discovery.ts)). Upload to `keys.openpgp.org` behind an explicit consent step, with the confirmation state tracked. Needs no core: it is public key material. |
| **Sign / verify / encrypt arbitrary files** | S | S | Pure reuse of the core; a cheap power-user surface. |
| **Message size padding** | S | S | Pad ciphertext to buckets to blunt size fingerprinting — [security.md](security.md) admits size leaks. |
| **Header minimisation on send** | S | S | Strip `User-Agent`/`X-Mailer` and other client fingerprints. |
| **Expiring / self-destruct messages** | M | M | Client-enforced only; the copy must be honest that a recipient can always keep a copy. |
| **S/MIME support** | M | L | Enterprise interop; a large second format surface. |
| **Client-side spam / malware scanning** | M | L | E2EE kills server-side scanning — a real, acknowledged gap. Must run after local decrypt. |

---

## ⚫ Debt that gates shipping

Not features — things already wrong. Any of these reaching a real user is worse
than shipping without any Tier 0 item.

1. ~~**Plaintext local storage.**~~ **Fixed.** Every local store is sealed with
   XChaCha20-Poly1305 under a device key in `expo-secure-store`. Not SQLCipher —
   see [data-model.md](data-model.md) for the divergence. Web still has no
   keychain, which `storageReason()` reports.
2. ~~**Trust on first use with no verification ceremony.**~~ **Fixed.** Safety
   numbers derived from both fingerprints, and `markVerified` refuses if the key
   changed since the number was shown. QR scanning is still to come.
3. **The scheduler only runs while the app runs.** Scheduled sends and snoozes
   fire from a 15 s in-app interval. Honest UI copy today; real background
   execution needs `expo-background-task` and a device to verify on.
   **Still open** — the only one of these five that is.
4. ~~**No token-revocation handling.**~~ **Fixed.** A revoked grant returns the
   app to signed-out with a reason; transient failures deliberately do not.
5. ~~**The README says "design documentation only. No code yet."**~~ **Fixed.**
   It now describes the client that exists.

---

## Suggested order

If the goal is *a client someone would actually use*, without pretending the
crypto is finished:

1. **0.1 Filters & rules** — the flagship "we had to build this client-side
   because encryption" feature, and the category drawer is already the shipped
   proof that classification has to run after local decrypt.
2. **0.2 Labels + bulk actions** — table stakes, and what rules act on.
3. **0.5 Contacts + trust dashboard** — makes the security model visible where
   recipients are chosen.
4. **0.17 Client-side key sharing** — designed and unblocked; closes the last
   discovery gap that needs no network.

If the goal is *shippable to a real user*: encryption at rest, the verification
ceremony, and now key recovery end to end are done, so the order is
**the onboarding drill → background scheduler → conformance tests**.

The wrapping is the sharp one and it needs a machine with cargo. Until it exists,
a real key still has no backup path — the screen is built, but in a native build
it reports `unavailable` rather than producing a blob. Nothing is shippable to a
user with mail worth losing until that is closed.

---

## Adding to this file

One entry per feature, in the tier that matches its true blocker:

```markdown
### N.M Name · Impact ? · Effort ?

**What.** One sentence.
**Why.** The argument — ideally one this product can make and others can't.
**Build sketch.** Concrete modules/files in this repo.
**Done when.** An observable check, not "it works."
```

Keep the pure-logic-module + `__tests__/*-test.ts` convention: it is why every
feature so far shipped with tests and no framework mocking.

> These are candidates, not commitments. When one is picked up, run it through
> brainstorm → spec → plan like anything else, and fold what's accepted back
> into the phases in [roadmap.md](roadmap.md).
