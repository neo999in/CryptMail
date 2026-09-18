# Feature Register

Every feature CryptMail could plausibly build next, written against **what the
code actually does today**.

This is the implementation-oriented companion to [roadmap.md](roadmap.md).
The roadmap answers *"what are we committed to, and in what phase?"*; this file
answers *"what exactly would we build, which files would it touch, what's
blocking it, and how would we know it works?"*

Last updated: 2026-09-17.

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

The features below have been built one-by-one on top of the encryption prototype,
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
| Sent + Archive + Trash destinations | [`screens/MailboxScreen.tsx`](../app/src/screens/MailboxScreen.tsx), [`state/mailbox.ts`](../app/src/state/mailbox.ts) | Drawer → Sent, Archive, Trash | 16 |
| Reply / reply-all / forward (0.7) | [`mail/reply.ts`](../app/src/mail/reply.ts) | `MessageScreen` → Compose | 32 |
| Category drawer (Primary/Bills/…) — **plaintext mail only**, Promotions and Spam from Gmail's own labels | [`categorizer/categorizer.ts`](../app/src/categorizer/categorizer.ts) | `CategoryDrawer`, Inbox | 30 |
| Attachments (0.18) | [`mail/attachment.ts`](../app/src/mail/attachment.ts), [`core/mime.ts`](../app/src/core/mime.ts) | Compose, `MessageScreen` | 33 |
| Contacts + per-contact trust dashboard (0.5) | [`contacts/contacts.ts`](../app/src/contacts/contacts.ts), [`contacts/useContacts.ts`](../app/src/contacts/useContacts.ts) | `ContactsScreen`, Compose autocomplete | 26 |
| Spam & phishing detection — **plaintext mail only** | [`spam/`](../app/src/spam/) (`spam.ts`, `headers.ts`, `content.ts`, `urls.ts`, `bayes.ts`, `tokenize.ts`, `unicode.ts`), [`store/spamModelStore.ts`](../app/src/store/spamModelStore.ts) | Inbox Spam category, `MessageScreen` notice + mark actions | 330 |
| The provider's junk folder, fetched and filed under Spam ([SPAM_PHISHING_DETECTION.md §14.4](SPAM_PHISHING_DETECTION.md)) | [`mail/gmail.ts`](../app/src/mail/gmail.ts), [`state/mailbox.ts`](../app/src/state/mailbox.ts) | Drawer → Spam | 20 |
| Configurable swipe actions ([swipe-actions.md](swipe-actions.md)) | [`swipe/swipe.ts`](../app/src/swipe/swipe.ts), [`store/mailPrefsStore.ts`](../app/src/store/mailPrefsStore.ts) | Mail rows, `Settings → Mail → Swipe options` | 56 |

1571 tests across 89 suites (2026-09-17). Run with `npm test` (jest-expo). Convention: pure logic lives
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
- Three provider connectors, Gmail REST, Microsoft Graph (Outlook.com /
  Microsoft 365) and generic IMAP/SMTP, behind the `MailClient` interface: `list` /
  `getRaw` / `send` / `updateFlags`. Each account carries its provider, and
  sign-in, restore, token refresh and the client all dispatch on it. Outlook has
  been run against a real mailbox, but encrypted mail over Graph is still unproven
  ([running-it.md](running-it.md) §1c). IMAP has only been run against in-memory
  servers ([running-it.md](running-it.md) §1d).

---

## Tier 0 — 🟢 Buildable today

No native code, no server. These are the features that can be picked up in the
current session and finished end-to-end.

### 0.1 Client-side filters & rules · Impact M · Effort M — ✅ **Built**

**What.** User-defined rules — *if sender is X / subject contains Y → star,
archive, label, mark read* — evaluated locally. (*Mute* from the original
sketch is not built: it is a thread-level "skip the inbox for future replies",
which is a different mechanism from a once-per-message rule.)

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

**What was built.** [`rules/rules.ts`](../app/src/rules/rules.ts) is pure:
`Rule` (all-of conditions on *Sender*, *Subject* or *Subject or body*, plus
star / mark read / archive / label actions), `matchRule`, and
`applyRules(inputs, index, state, options)`. Persisted per account in
[`store/rulesStore.ts`](../app/src/store/rulesStore.ts);
[`state/rules.ts`](../app/src/state/rules.ts) runs them after every inbox sync
and page of older mail, and again the moment `openMessage` decrypts and indexes
a message. `RulesScreen` and `RuleEditScreen` hang off Settings → Mail; the
reader's More menu has *Create rule from this message*.

The properties that make it trustworthy:

- **The decrypt boundary is a `null`, not a guess.** `readableField` returns the
  sender for any message, but an encrypted message's subject and body only from
  the local search index. An unopened encrypted message has no subject as far as
  a rule is concerned — its placeholder subject and ciphertext snippet are never
  offered as stand-ins — so a content condition cannot match until this device
  has read the content. This is the same line `search/search.ts` draws.
- **Once per message.** `fired` records which rules acted on which message, so a
  user who un-stars something a rule starred is not overruled on the next sync.
  It is persisted with the rules and bounded (`FIRED_CAP`).
- **One path for every change.** Flags go through `mailbox.setFlags` — the tap's
  path — so a rule's archive is optimistic, reaches the provider the row came
  from, and re-fetches if refused.
- **The inbox of the active account.** A merged row from another mailbox is
  left to that mailbox's rules, which run when it is active. Junk rows are
  never archived by a rule (they are not in the provider's inbox to begin with).
- **No rule can match everything.** `ruleProblem` refuses an empty condition or
  a rule with no action, in the service as well as the editor.

### 0.2 Labels / folders + bulk selection · Impact M · Effort M — ✅ **Built**

**What.** Local labels, multi-select in the inbox, bulk archive/star/mark-read.
Swipe actions are **built** — see [swipe-actions.md](swipe-actions.md).

**Why.** The inbox was a flat single-action list. This is table stakes that also
gives filters (0.1) something to act on.

**Done when.** Selecting three messages and archiving them updates the list
optimistically and survives a refresh.

**What was built — and one deliberate change from the sketch.** The sketch said
to push labels to Gmail through `messages.modify`. Labels are instead **local
only**: [`labels/labels.ts`](../app/src/labels/labels.ts) (pure) and
[`store/labelsStore.ts`](../app/src/store/labelsStore.ts), sealed per account.
A label is a statement about content — "Lawyer", "Diagnosis" — and writing it
onto a message the provider holds as ciphertext would hand the provider, in the
clear, exactly the summary the encryption withholds. It would also need
`labels.create`, which [gmail-api-adoption.md](gmail-api-adoption.md) §3 already
rules out for that reason. The cost is stated in the UI: labels do not appear in
other mail apps on the account.

- Labels show as chips on the row (`ui/mailRow.tsx`, so the closing transition's
  ghost carries them too), are narrowed to from the bar's Filter sheet over the
  inbox and Sent/Archive/Trash alike, and are managed in Settings → Mail →
  Labels. The reader and the conversation view label from their More menu; a
  conversation is labelled across all its messages.
- **Multi-select** is a long press on an inbox row; taps then toggle. The compose
  button steps aside for `ui/bulkBar.tsx` — Archive, Star, Mark read/unread,
  Label, Move to Trash — and Android back leaves the selection. Swiping is off
  while selecting. Archive, Trash and read/unread run through
  `useSwipeRunner().runOperation`, the swipe's own implementation, toast and
  undo; there is no second archive. The selection is read back through the rows
  on screen, so it can never act on mail a sync has taken away.
- The row stays one `Pressable` (tap + long press), per the RN-web note.
- Entering selection must stay cheap. The swipe wrapper stays mounted with its
  gesture disabled rather than being swapped out (a swap remounted every row),
  swipe panes mount only once a pull activates and stay until the row settles,
  `MailRowCard` is memoised so only the picked row redraws, and the home
  screen's selecting flag lives outside React state so only the compose button
  re-renders.

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

### 0.5 Contacts & per-contact trust dashboard · Impact M · Effort M — ✅ **Built**

**What.** An address book built from the keyring plus seen senders: one screen
showing every contact, their trust state, when the key was first seen, and
whether it ever changed.

**Why.** `contact_keys.trust` (seen / verified / changed) is already tracked and
already drives the compose fail-safe, but it's only visible on the Keys screen.
Trust is the product's actual security claim; it deserves a first-class surface.

**What was built.** [`contacts/contacts.ts`](../app/src/contacts/contacts.ts) —
pure, 26 tests — merges the keyring with every address seen in the mail, in
either direction, and yields a `Contact` per address carrying its trust state,
when the key was first seen, how it arrived, when it was compared out of band,
when it last changed, and how much correspondence there has been.
[`contacts/useContacts.ts`](../app/src/contacts/useContacts.ts) is the one place
that wiring lives, so the screen and Compose cannot disagree about who exists.
[`ContactsScreen`](../app/src/screens/ContactsScreen.tsx) is a stack push from
the drawer footer and from Settings — not a home-screen destination, since it is
not a list of mail — with a search field, an All / Verified / Unverified / No key
filter, and a headline that counts each state in words. Compose's To field gained
autocomplete from the same source, each suggestion carrying its trust badge.

Four things are worth knowing about the shape it took:

- **A contact with no key is a first-class row**, not an omission. That state is
  exactly the one that holds a message in the outbox behind an invite, and the
  autocomplete deliberately does not rank it below the contacts that have keys —
  burying them would hide the people the invite path exists for.
- **"Ever changed" needed a new fact.** `trust` is the *current* state and moves
  back off `changed` as soon as the new key is compared, so `upsertKey` now
  records `changedAt` and `previousFingerprint` and keeps them
  ([data-model.md](data-model.md), [key-management.md](key-management.md)). They
  are written going forward only; nothing infers a change from their absence.
- **No decryption, ever.** Every field comes from a cleartext envelope header or
  the keyring, so an unopened encrypted mailbox produces the same book as a
  fully-read one.
- **Junk follows the categoriser's rule**, not the provider's: a user's own spam
  mark files a message, and a provider junk label counts only for plaintext mail,
  because a junk verdict on ciphertext is a verdict about structure the filter
  could not read. A junk sender that has a key is still listed — a key the user
  imported does not vanish because mail landed in the wrong folder.

The verification ceremony stays on Keys: comparing a safety number is a
deliberate, one-contact-at-a-time act, and a list is the wrong place for it. The
dashboard says who needs it and sends you there.

**Done when.** Every address the app has seen appears with the right trust badge,
and picking one in Compose shows its state before you type a body. ✅ — with the
caveat the module documents: the keyring half is complete the moment an account
loads, while the observed half grows as mail is fetched, so a mailbox whose Sent
has never been opened has genuinely not been seen.

### 0.6 Email signature + canned replies · Impact S · Effort S — ✅ **Built**

**What.** A stored signature appended on compose; a small set of reusable
snippets.

**Build sketch.** Settings values in a new `store/settingsStore.ts`; Compose
seeds the body with the signature for new messages (never on a resumed draft, or
autosave will duplicate it).

**Done when.** A new message opens with the signature; editing and sending
behaves; drafts don't accumulate copies.

**Built.** [`signature/signature.ts`](../app/src/signature/signature.ts) is the
pure half: the RFC 3676 `-- ` block, seeding, swapping and snippet insertion.
It diverges from the sketch in two places:

- **The signature is per mailbox**, and lives on the account ref's settings
  (`AccountSettings.signature`) rather than a new store. A work address and a
  personal one sign differently, and Compose can switch From mid-message, so
  it needs the other mailbox's signature synchronously. It is edited on the
  account screen; Settings → Mail links there. Removing the account removes it.
- **Canned replies are global**, in
  [`store/cannedRepliesStore.ts`](../app/src/store/cannedRepliesStore.ts)
  (sealed, not per account, up to 50), served by `ui/cannedReplies.tsx` the way
  swipe prefs are, and managed at Settings → Mail → Canned replies.

Compose seeds a *started* message only, never a resumed draft (anything opened
with a `draftId`), and puts the signature above quoted text. A body that is
only the seeded signature counts as empty, so opening Compose and backing out
leaves no draft. Switching From swaps an intact block for the new mailbox's
and leaves a block the user edited alone. A canned reply goes in at the caret,
or above the signature and quote if the body was never touched. All of it is
body text, so it is encrypted with the message. Signature text is plain, even in
a message written with formatting (0.9) — a rich signature is still open.

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

**Still open.** Nothing blocking. The quoted body is plain text; with formatting
on (0.9) it becomes a blockquote of that text, not the original HTML.

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

**Status: ◐ per-account, opt-in.** Blocking is now a setting on each mailbox —
*Block external images* on
[`screens/AccountScreen.tsx`](../app/src/screens/AccountScreen.tsx), stored on
the account's registry ref and read at the `HtmlReader` call site in
`screens/MessageScreen.tsx`. It is **off by default**, so the standing decision
below is unchanged for anyone who does not go looking: what changed is that the
choice now exists and belongs to the reader, per mailbox.

Both halves of this entry were once built and then removed on the maintainer's
call: blocking by *default*, and a per-message strip saying what had been
withheld and offering to load it. Neither has come back.

What that costs is worth stating plainly rather than leaving for someone to
rediscover. A remote image URL is routinely unique per recipient, so opening a
message now tells its sender that it was opened, when, how often, and from what
IP — for a client whose premise is that not even the provider can read the mail,
that is the one disclosure that happens with no action by the reader and no
indication to them. It is also the only outbound request this app makes on
another party's say-so.

Turning blocking on for a mailbox removes that disclosure for its mail:
`HtmlReader` renders a non-fetching placeholder for every blocked image, and a
strip above the body says how many were withheld and offers to load them
([`html/remoteImages.ts`](../app/src/html/remoteImages.ts) counts them —
distinct http(s) sources, so one spacer repeated down a newsletter counts once,
and a `data:` or `cid:` image counts not at all). That consent is **per message
and per opening**: it is never remembered, because a "just this once" that
quietly became permanent is a privacy control that decays.

What is still missing is the per-sender allowlist, which was never built.

### 0.9 HTML reader + rich-text compose · Impact M · Effort M–L

**What.** Render inbound HTML mail; optionally compose it.

**Why.** Most real mail is HTML; plain-text-only is a hard ceiling on
usefulness. But this is the app's largest new attack surface — decrypted HTML is
attacker-controlled and can exfiltrate plaintext via remote loads.

**Build sketch.** Sanitise in one auditable module (`html/sanitize.ts`) with an
allowlist of tags/attributes, no scripts, no remote loads without 0.8's consent.
Extend `parseProtectedInner` to walk `multipart/alternative`, and **prefer
`text/html` when the sender wrote one**, falling back to `text/plain`.

That preference is the reverse of what this entry said until the reader was
built, and the reversal is deliberate. A sender's plain-text alternative is not
the same message in a simpler form — it is a lossy rendering of the HTML one,
and the loss falls on exactly what mail is for: an anchor becomes a bare URL
next to its own label, a table becomes a column of fragments, a list loses its
structure. Preferring it made the app harder to read than the webmail it
replaces, for no security gain the sanitizer does not already provide. Both
bodies are parsed either way — the flattened text is still what the search
index stores, since indexing markup would put tag names in it.

**Done when.** A hostile fixture (script tags, `onerror`, remote CSS, data-URI
payloads) renders inert, verified by tests over the sanitizer.

**Status.** Reader built: `html/sanitize.ts` + `ui/HtmlReader.tsx`, wired into
the message screen for plaintext *and* decrypted mail. `parseProtectedInner`
walks nested multiparts and transfer-decodes them, so a tree sealed by another
PGP client (Thunderbird, ProtonMail) reads as HTML rather than as nothing.
Remote images load unless the mailbox blocks them (0.8); there is no
per-message consent step.

Rich-text compose is built. The format button (an A with a pencil) in Compose's top bar turns formatting on,
and the message is then written in `ui/RichTextComposer.tsx`: a borderless
editor where the plain body was, and a formatting bar pinned to the bottom of
the screen, on top of the keyboard — ✕ (hide the bar, keep the formatting),
text size (title, heading, normal), bold, italic, underline, text colour,
strikethrough, lists, quote and link. Removing formatting is in the overflow.
Text colours are a fixed set of mid-tones (`messageTextColors` in `theme.ts`)
that read on other clients' white pages, and none of them is a trust colour. The HTML is the message and the
text is derived from it on every edit by
[`compose/richText.ts`](../app/src/compose/richText.ts) — lists keep their
markers, quotes their `>`, links their address — and both leave as a
`multipart/alternative` sealed in the inner tree
([message-format.md](message-format.md)). Turning formatting on is free and a
quote becomes a blockquote; turning it off asks only when formatting would be
lost. The HTML rides with the draft, the outbox, a held message and an undone
send, so none of those drops it; signature swaps and canned replies work in
both modes. A message written without formatting is byte-for-byte what it was.
Not offered on web, where the editor's webview does not exist.

**Still open.** Rich signatures (the signature is still text, placed as
paragraphs) and rich quoting on reply (quoted text arrives as a blockquote of
the plain body, not the original HTML).

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

**Status: ✅ policy and contract built; nothing posts notifications yet.**
[`notifications/policy.ts`](../app/src/notifications/policy.ts) is pure.
`planFor(mail, preview, device)` decides a batch's notification under four
settings — `off`, `private` (the default: "New message", nothing else, ever),
`sender`, and `full` (sender and subject). At every setting the lock-screen
version is generic and the notification is `private` visibility; detail is
built only when the device is unlocked at posting time, and only from a message
this device could read — an encrypted one that was not decrypted here shows
nothing, not even its envelope `From`, which is unauthenticated. A batch names
senders but never subjects. `parseRelayPayload` enforces the push contract now
written in [api.md](api.md): `{ v, t: "sync", a: <random account token> }` and
not one field more. Covered by `notifications/__tests__/policy-test.ts`.

The settings UI is deliberately not built: a preference for notifications the
app cannot post would be a control that does nothing. The labels it will use
are in the module (`NOTIFICATION_PREVIEW_LABEL`) so they are settled with the
rules.

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

`state/accounts.ts` owns which mailbox is active, and
[`AppState`](../app/src/state/AppState.tsx) exposes `accounts`,
`activeAccount`, `unified`, and the four actions that change them. Each account
gets its own `MailClient`, cached in `mail.clients`.

**The switcher.** The drawer's left rail is the account list: a Home circle on
top for the merged inbox, then one avatar per mailbox, then `+`. Tapping Home
merges; tapping a mailbox means "this one, on its own", which changes the active
account and the merged lens together — `switchAccount(id, { unified: false })`
does both in one write and one sync, because doing them as two calls fetched a
full merged page and then a full unmerged one for a single tap.

Merging deliberately has **one** control. It used to also be a toggle on the
drawer panel header; that header is now a label, because two controls for one
setting is the mistake the accent swatches already taught this codebase.

Each avatar is the account's own Google profile picture, with initials as the
fallback. An account can instead show its initials, or the provider's own mark
(the Google "G", the Microsoft squares), which tells a Gmail and an Outlook
mailbox apart on the rail; a provider with no mark falls back to initials.
`Session` carries `name` and `photo` because the sign-in response
already contains them, so it costs no extra call and no extra scope. Message
senders keep initials: loading a remote image because mail arrived is a tracking
pixel with extra steps.

**The rule that keeps them apart: exactly one account is active at a time**,
including while the inbox is merged. While merged, Home carries the accent fill
on the rail and no mailbox is marked there: "who am I sending as" is answered by
the compose screen's account selection, where it is asked. Merging is a
*reading* convenience — rows
are tagged with the mailbox they came from, flag changes go to that mailbox's
provider, and opening a row from another account **switches to it first**.
Composing, sending and decrypting always use the active account, because each
needs one identity and one keyring; choosing those per message is precisely how
state leaks between mailboxes.

**Managing one, as opposed to switching.** Switching is the rail, which is one
gesture from the inbox and happens dozens of times a day. Everything else is
Settings → Accounts
([`screens/AccountsScreen.tsx`](../app/src/screens/AccountsScreen.tsx)) and the
per-mailbox screen behind it
([`screens/AccountScreen.tsx`](../app/src/screens/AccountScreen.tsx)): a display
name, whether the avatar shows the provider's photo, initials or the provider's
logo, whether that
mailbox's mail may fetch remote images (0.8), how far back it syncs, what it has
cached here, and removal. Those four settings live on the registry ref rather
than in a per-account store, because every consumer needs all of them at once
and synchronously — N rows, N rail avatars, and a merged sync that asks each
mailbox for *its own* window. Every default reproduces the behaviour of an
install that never opens the screen.

That screen also carries the two things a per-account app owed the user and had
nowhere to put. **Which key this mailbox sends with**, and whether it is listed
in the directory — the keyring, the publication record and the recovery mark are
all per-account stores, but Keys and Recovery are reached from Settings and
silently describe whichever mailbox is active. And **"stop syncing"**, the
rung between a dead grant and removal: a paused mailbox keeps its place, its
keys, its drafts and its indexed mail, and simply loses its `MailClient`, so a
merged sync steps over it and boot does not even ask the provider for a token
for it. Resuming restores the session and makes it active — every way of
choosing a mailbox means "show me this mail", so `switchAccount` on a paused one
resumes it rather than refusing. Pausing the last mailbox still syncing is
refused, and the screen says why before the tap: an app with nothing to read is
the connect screen, and that is what signing out is for.

Removal used to be a long-press on a rail avatar: a destructive action on an
unlabelled gesture. The long press now opens that mailbox's screen, where
removal sits under a heading that says what it deletes.

Removing an account deletes every scoped store belonging to it. Leaving its
search index — a plaintext copy of that mailbox's mail — on disk would make the
button a lie, and re-adding the address would silently adopt it.

An install that predates this keeps its data: `loadScopedJson` reads the old
global key once, **moves** it under the first account signed in, and deletes it,
so the second account starts empty rather than inheriting the first one's mail.

**Two Gmail accounts, through a one-user API.** Play services holds a single
*signed-in user*, which is why this said for a while that the limit lived in the
provider. But the **grant** is per Google account and survives `signOut()`, so
[`googleAuth`](../app/src/auth/googleAuth.ts) serves N mailboxes by re-pointing
Play services with `accountName` and silently signing in again between them: one
user in front at any instant, several reachable. Every call runs on one FIFO
queue, and the address that comes back is checked against the one asked for
before any token is handed out — a mismatch fails rather than returning another
mailbox's token. See
[the design](superpowers/specs/2026-09-05-multi-gmail-design.md), which also
records what is still unverified on a device.

Boot restores the mailbox that was active, paints it, and brings the rest back
behind it — a second account costs no launch time on the screen the user is
actually looking at.

A revoked grant is now **one account's problem**. It is flagged
(`State.needsReauth`), stepped off if it was active, and shown in the drawer's
account rail as "sign in again"; its keyring, drafts and decrypted mail are kept,
because a dead token says nothing about whether the data on this device is still
the user's. Clearing every account was correct only while there could be one.

Everything above the provider handles N and always did, so a second provider
(Outlook, IMAP) needs no change here. The two-account path is exercised by fakes
in the test rather than by a mode of the app — `demoAuth` used to connect two
fixture mailboxes and was removed with demo mail on 2026-08-31.

**Done when.** Two accounts coexist, each with its own keyring and drafts, and
switching never leaks state between them. Covered end to end against the real
service graph and the real stores — with only the auth provider and the Gmail
client faked — by
[`state/__tests__/accounts-test.ts`](../app/src/state/__tests__/accounts-test.ts).

### 0.12 Storage management & cache eviction · Impact S · Effort S — ✓ built

**What.** Show what's cached; bound it; "clear decrypted content" as a visible,
honest control.

**Why.** The search index is a growing plaintext store of decrypted mail. Users
who care enough to run this app deserve a switch for that — and it's the honest
counterpart to the known debt.

**Done when.** A settings row shows index size and clearing it empties the store
without breaking search over freshly-opened mail.

**Status: ✓ built, per account.** The Storage group on
[`screens/AccountScreen.tsx`](../app/src/screens/AccountScreen.tsx) shows what a
mailbox takes on this device in bytes, and the search index's share of it, and
offers two controls. *Clear decrypted content* empties the search index, the
cached mail list and the cache of fetched encrypted messages. *Reset account*
also drops the learned spam model and any snoozes, then syncs again. The
fetched-message cache ([`store/rawCache.ts`](../app/src/store/rawCache.ts))
holds only the provider's ciphertext, so it goes in both scopes because it is
this device's copy of the mailbox, not because it is readable. Its bytes count
toward the total shown ([data-model.md](data-model.md)). Neither touches the keyring, the recovery blob,
drafts or the outbox: those are the private key and the user's unsent work, and
a control called "reset" must not silently destroy either.

Bytes are measured by
[`store/storageUsage.ts`](../app/src/store/storageUsage.ts) from the **sealed**
values, without unsealing them — so they are shown for a mailbox that is not in
front too, without its index being decrypted behind the user's back. Row counts
(messages indexed, drafts, queued) still need the plaintext and are shown only
for the active mailbox; the row says so for the others.

The index bounds itself. `indexContent` in
[`search/search.ts`](../app/src/search/search.ts) keeps it under
`SEARCH_INDEX_MAX_BYTES` (1 MB of JSON) by evicting the entries indexed longest
ago, and indexes at most the first 16,000 characters of a body so one long
message cannot evict hundreds. The number is set by storage, not taste: the
index is one sealed AsyncStorage value, and on Android a value much past 2 MB
fails to read back. An evicted message is not lost — it is searchable again once
opened.

### 0.13 Mailbox export / backup · Impact M · Effort M — ✓ built

**What.** Export mail as `.mbox` or `.eml` files.

**Why.** The product's honest answer to "no server-side archival": your data is
yours and you can take it out. Also a de-risking story for account loss.

**Done when.** An export opens cleanly in Thunderbird.

**Status: ✓ built, per account and per message.** *Export as .mbox* on
[`screens/AccountScreen.tsx`](../app/src/screens/AccountScreen.tsx) writes the
mailbox out through [`mail/mbox.ts`](../app/src/mail/mbox.ts) — mboxrd, so a
`From ` line inside a body round-trips instead of splitting one message into
two, and asctime in UTC rather than the device's locale. *Save as .eml* in a
message's overflow menu writes that one message.

It exports **the bytes the provider stores**, not a re-rendering of what the app
shows: a faithful copy is the only kind worth calling a backup, which means an
encrypted message exports *sealed*. That is the right outcome — the ciphertext
is the mail, and any PGP-capable client with the same key reads it — and writing
the decrypted tree instead would make the export a button that strips encryption
off everything the user chose to encrypt. An `.eml` is named by the **header**
subject, so an encrypted message's file is called `…-encrypted-message-….eml`
and no decrypted text reaches a filename.

The mbox is **the whole mailbox**: `exportMailbox` in
[`state/accounts.ts`](../app/src/state/accounts.ts) pages Inbox, Sent and Archive
from the provider to the end, ignoring the sync window (a filter on listing, and
a backup that silently kept 30 days would be a trap). Spam and Trash are left
out, and the row says so. Because it pages the provider rather than reading
`State`, any syncing mailbox can be exported, active or not. Messages are
appended to the file as they arrive (`openTextFileWriter` in
[`lib/files.ts`](../app/src/lib/files.ts)), so the mailbox is never one string in
memory; the row shows progress. A listing failure ends the export; a single
message the provider refuses is skipped and counted in the result.

Rate limits are waited out, not counted as failures
([`mail/rateLimit.ts`](../app/src/mail/rateLimit.ts)). Found on a device: a
387-message Gmail export first skipped 226 messages, every one refused with
`403 Quota exceeded … Units per minute per user`. A 429, or a 403 naming a quota
or rate limit, is now retried with a backoff that reaches a full minute; after
that fix the same mailbox exported all 387 in about four minutes.

Known cost: Gmail's list spends a metadata request per row, so a whole-mailbox
export is roughly two requests a message, and that quota is what sets its
speed. An ids-only listing on `MailClient` would halve it.

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

### 0.15 Onboarding: recovery-code drill · Impact M · Effort S — ✓ built

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

**The drill.** Creating a new key on
[`screens/SetupScreen.tsx`](../app/src/screens/SetupScreen.tsx) now goes
*backup → drill → publish*. The backup step shows the code once, with the
backup text to save or copy, and says what is lost if both are lost. The code
is shown numbered 1–8, since unnumbered two rows of four were copied down the
columns, and it can be copied too — which does mean a clipboard round trip
passes the drill without the code ever leaving the phone; the drill then proves
the code and backup match, not that the code was written down. Code fields
group what is typed or pasted as it arrives, so a multi-line paste lands as one
line. The drill step asks for the code back
and `completeRecoveryDrill` in
[`state/identity.ts`](../app/src/state/identity.ts) runs a **real unlock**
through the core, against the blob this run produced (never a pasted one), and
checks the fingerprint matches. Restoring from a backup skips the drill: a
restore *is* a successful code entry.

The gate is persisted, not screen state: `createIdentity` records
`drillPending` (the key's fingerprint) in the recovery store before it returns,
and `App.tsx` keeps setup open while `drillOutstanding` holds. So quitting
between the key and the code reopens setup at the backup step with a fresh code.
A key whose stored state predates the field owes nothing, so existing users are
not pulled back into setup.

One escape, decided by the service rather than the screen:
`waiveRecoveryDrill` releases the gate only when the core itself reports
`unavailable` for backups (an older native core). Holding setup open for a
drill that can never run would lock the user out of their mail. The waiver
records no backup, so Keys keeps warning.

**Done when.** Setup can't complete without a successful code entry, and the
copy states plainly what is lost if it's lost.

### 0.16 Accessibility, i18n & theming pass · Impact M · Effort M — ◐ partly built

**What.** Screen-reader labels (trust badges must be conveyed non-visually),
dynamic type, high contrast, RTL, localisation, formal design tokens.

**Why.** Security state communicated only by colour is security state that some
users never receive. Also the hardest copy to translate well — start early.

**Built.** Theming, as of the UI rework: a Settings screen and a Display &
Appearance screen, with the aurora colour palettes (one choice that sets both
the top bar's band and the accent) and three densities persisted in
`store/prefsStore.ts`. The accent deliberately does not reach trust colour —
mint and coral are fixed at every accent — and every row's encryption state
carries an `accessibilityLabel`, so it is never colour-only.

**Not built.** A **light palette**: `theme` stores `light` and `system` as
preferences, but both resolve to dark (`resolveTheme`, guarded by
`LIGHT_THEME_AVAILABLE`) because every screen is drawn for a dark ground. The
Light radio is shown disabled and says so rather than lying. Also outstanding:
dynamic type, RTL and localisation.

**Done when.** The inbox and message screens are fully navigable by screen
reader, every trust state has a text equivalent, and a light palette exists.

### 0.19 Snooze folder · Impact M · Effort M

**What.** A Snoozed destination, backed by local scheduling and Gmail label
operations, listed in the navigation drawer.

**Why.** The drawer's shape is Outlook's, and that is an entry a person reaches
for out of habit. A row that does nothing costs more trust than a missing row, so
the drawer lists only what exists.

**Status.** **Sent, Archive and Trash are done** —
[`screens/MailboxScreen.tsx`](../app/src/screens/MailboxScreen.tsx), one body
parameterised by box, each list fetched from the provider and paged on its own
cursor. They are destinations on the home screen rather than pushed screens
([`ui/destination.tsx`](../app/src/ui/destination.tsx)), so they wear the
inbox's bar and rows exactly as a category filter does. Archive is a query rather than a label (Gmail has no archived label:
archiving removes `INBOX`), which is why the connector translates it; Trash is a
label, but one `messages.list` excludes unless asked twice, exactly like the junk
folder. Deleting and restoring go through `messages.trash` / `messages.untrash`
rather than a label edit, and both are **moves** — CryptMail has no permanent
delete, and emptying the trash stays the provider's own action. What is left here
is snooze, which needs local scheduling like the outbox.

**Done when.** Snoozing returns a thread at the chosen time, listed in the
drawer. ✅

**Snoozed — built, locally.** A `snoozed` destination
([`screens/SnoozedScreen.tsx`](../app/src/screens/SnoozedScreen.tsx)) lists the
active mailbox's pending snoozes, grouped by when they return, with *Return
now* (and an undo) on each. A snooze now records a snapshot of the row's
cleartext summary, so a long snooze that has scrolled out of the loaded inbox
still draws, and still opens. **There are no Gmail label operations**, which
the sketch called for. Archiving on snooze and restoring on wake would make the
message's return depend on this app running again. With the in-app scheduler
(limit 3 below), a phone left in a drawer would lose mail from the provider's
inbox. The cost of staying local is that another client still shows a snoozed
message in the inbox.

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
base64 content, a decoded size, and a **5 MB** cap with `attachmentRefusal` as
the single place that says why a file cannot be attached. That number is
measured, not chosen: see "still open" below. [`core/mime.ts`](../app/src/core/mime.ts) builds the parts:
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

**Still open — the size ceiling.** Two limits bind. *Arithmetic:* base64 (+33%)
then armor (+33%) roughly doubles a file, and a provider's 25 MB applies to the
encoded message, so ~14 MB of raw file is the most that can ever arrive; no
optimisation moves it. *Cost:* everything is held in memory as base64 and
crosses the bridge as one string, on the JS thread. Measured through the demo
core on desktop V8 — 1 MB: 0.3 s send / 1.0 s open · 5 MB: 3.6 s / 4.1 s ·
10 MB: 3.5 s / 7.6 s · 25 MB: 21 s / 45 s with peak memory in gigabytes. Hermes
on a mid-range phone is 2–5× slower with a heap in the low hundreds of MB, so
the last row is a process kill rather than a slow send. Hence 5 MB, which covers
photos, decks and PDFs. Raising it needs chunked base64 helpers
([`lib/base64.ts`](../app/src/lib/base64.ts) builds a multi-million-element
`number[]`), Gmail's resumable upload endpoint, and then the streaming path
(file paths, chunked read in Rust — Phase 1,
[prototype-plan.md](prototype-plan.md)); after that ~10 MB is honest. A second, separate limit stays until then: an autosaved draft is sealed
JSON in AsyncStorage and cannot hold tens of megabytes, so files past
`MAX_STORED_ATTACHMENT_BYTES` live only in the compose session and the screen
names them rather than losing them quietly (`splitForStorage`). Inline `cid:` images are
carried and rendered as attachments, but the body is plain text, so a true
inline placement waits on the HTML reader (0.9).

---

## Tier 1 — 🟡 Needs the real crypto core

These are gated on `cryptmail-core` (M1/M2). Several have their *UI* buildable
now against the demo core, with the crypto swapped in later.

| Feature | Impact | Effort | Notes |
|---|---|---|---|
| ~~**Attachments** — send, receive, inline images, preview~~ | — | — | ✅ **Built** (0.18 below), against the demo core and the real one alike. Files up to 5 MB — a measured limit, not an arbitrary one. What is still open is the chunked-base64 and streaming work that would raise it, and holding a large file in a saved draft. |
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
| ~~**Client-side spam / phishing scanning**~~ | — | — | ✅ **Built, and needed no core.** [`spam/`](../app/src/spam/) — weighted symbol scoring over headers, content, links and attachment metadata, plus a personal Naive Bayes model trained by "Mark as spam"/"Mark as not spam" and persisted sealed in [`store/spamModelStore.ts`](../app/src/store/spamModelStore.ts). Runs on plaintext mail only: encrypted mail is not scored at all, opened or not, and a provider junk verdict on it is ignored rather than obeyed. The provider's junk folder *is* fetched and filed under Spam for plaintext mail ([SPAM_PHISHING_DETECTION.md](SPAM_PHISHING_DETECTION.md) §14.4). Entirely local — no URL is ever fetched to classify a message. **Malware scanning is still open**: it needs attachment bodies (Tier 1 *Attachments*) and a scanning engine, and only filename/type metadata is inspected today. |

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

1. ~~**0.1 Filters & rules**~~ — ✅ **built**. Categorisation and scoring still
   never read encrypted mail (SPAM_PHISHING_DETECTION.md §13.4); a *user's own*
   rule is different in kind — the user stated it — and reads an encrypted
   message's content only once this device has decrypted it (0.1 above).
2. ~~**0.2 Labels + bulk actions**~~ — ✅ **built**, with labels kept local.
3. ~~**0.5 Contacts + trust dashboard**~~ — ✅ **built**. The security model is
   now visible where recipients are chosen.
4. **0.17 Client-side key sharing** — designed and unblocked; closes the last
   discovery gap that needs no network.

If the goal is *shippable to a real user*: encryption at rest, the verification
ceremony, key recovery end to end and the onboarding drill are done, so the
order is **background scheduler → conformance tests**.

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
