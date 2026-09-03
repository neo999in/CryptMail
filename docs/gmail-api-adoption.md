# Gmail API — what to implement, and what to leave alone

Which parts of Gmail REST v1 CryptMail should use, in the order worth building
them. Scope note first, because it decides several rows below: **encrypted mail
is never categorised or scored** (SPAM_PHISHING_DETECTION.md §13.4), so anything
Google infers *from content* is a signal about other people's plaintext mail and
nothing more.

What is implemented today lives in
[`app/src/mail/gmail.ts`](../app/src/mail/gmail.ts): `messages.list` (paged),
`messages.get` (`metadata` and `raw`), `messages.send`, `messages.modify`.
Scopes are `openid`, `email`, `gmail.modify` ([`config.ts`](../app/src/config.ts)).

## 1. Build these

| # | API | Why | Cost |
|---|---|---|---|
| 1 | **`batch` endpoint** (`POST /batch/gmail/v1`) | A page of 20 rows is currently 21 round trips — one `messages.list` plus a `messages.get` per id, fired in parallel. Batched it is 2. A sync is now that plus an 11-request junk page (§1.6), which is why that page is ten rows rather than twenty. This is also what stops bursty parallel `get`s tripping 429s, which is the most likely cause of a failed sync on a slow connection. | Multipart request/response encoding in `gmail.ts`. No interface change: `list` keeps its shape. |
| 2 | **`users.getProfile`** | Returns `emailAddress`, `messagesTotal`, `threadsTotal`, `historyId`. One cheap call. `messagesTotal` lets "Load older mail" say how much is actually behind it; `historyId` is the seed for #3. | Two lines. Do it with #3. |
| 3 | **`history.list`** | The correct sync primitive: given a `historyId`, it returns only what changed — added, deleted, labels changed. Replaces re-listing the newest page on every refresh, and fixes a real defect — `refreshInbox` rebuilds `messages` from the newest page down, so **it discards rows the user paged in**. Needs the full-list path kept as a fallback: history is retained for a limited window (roughly a week, and Google may expire it sooner), and an expired `historyId` returns 404. | Moderate. A new `MailClient` method and a cursor in the store beside the paging cursors. |
| 4 | **`settings.sendAs.list`** | The account's aliases and their `signature` / `replyToAddress` / default flag. An identity and its key are bound to an address: if a user sends as an alias, the `From` we sign and the key we encrypt under must agree, and today we assume the single Play-services address. This is a correctness gap in the send path, not a feature. | Small call; the design work is in `identity`/`send`, not the connector. Needs `gmail.settings.basic` — a **new scope**, so it forces re-consent. |

### 1.5 `CATEGORY_*` labels — done

Adopted for **plaintext mail only**, in
[`categorizer/categorizer.ts`](../app/src/categorizer/categorizer.ts). They ride
along free on the `format=metadata` response, so there is no extra call.

`CATEGORY_PROMOTIONS` decides the Promotions bucket in both directions: a
labelled message is a promo even with no keyword in it, and a message Google
tabbed Personal or Updates is not re-filed by our keywords because it says
"deal". The provider sees sending-domain reputation and bulk-send patterns that
no client can, and being wrong costs a misfiled newsletter.

Bills and Purchases stay on local keywords — Gmail has no tab for either, so
there is no provider opinion to defer to. No labels at all (another connector,
older mail) falls through to keywords; absence is not a verdict.

The labels are never consulted for encrypted mail. They exist because the
provider could read the message, and it could not read that one.

### 1.6 The junk folder (`labelIds=SPAM`) — done

Adopted, and it was a **defect**, not a feature. Gmail moves a message it files
as spam *out* of the inbox, and `messages.list` hides SPAM from every result
unless `includeSpamTrash` is set — so a client that lists `labelIds=INBOX` never
receives junk at all. The app's Junk destination filters the list the inbox
loaded, which meant it could only ever show mail Gmail had **delivered** and this
device then flagged: an empty folder on any account whose provider filter works.
Reported from a real mailbox with two messages in Gmail's Spam and none in ours.

What ships now:

- [`gmail.ts`](../app/src/mail/gmail.ts) adds a `spam` mailbox, asked for with
  **both** `labelIds=SPAM` and `includeSpamTrash=true` — the flag lifts the
  blanket exclusion, the label narrows the result to the folder. No other list
  carries either, so junk never leaks into the inbox, Sent or Archive.
- [`state/mailbox.ts`](../app/src/state/mailbox.ts) fetches it on every sync
  beside the inbox (`collectInbox`), ten rows to the inbox's twenty, with its own
  paging cursor. A junk folder that cannot be listed is not a failed sync.
- [`categorizer.ts`](../app/src/categorizer/categorizer.ts) reads the `SPAM`
  label for **plaintext mail** and files it under Junk — above the Bills and
  Purchases keywords, because Gmail's junk folder is full of mail written to read
  like an order update. The user's own *Not spam* still outranks it.
- **Encrypted mail is un-filed instead.** A junk verdict on `multipart/encrypted`
  is a verdict about ciphertext — unusual structure, a placeholder subject, no
  readable text — so such a row stays visible in Primary and the reader is told
  the provider disagreed. That is the sweep this row used to propose, and it is
  something this client can do that Gmail's own app cannot.
- No key is harvested from plaintext junk, or the junk folder would be a way to
  seed the keyring.

## 2. Probe before deciding

| API | Question it answers |
|---|---|
| `messages.modify` add/remove `SPAM` | Whether "not spam" can be pushed back to the provider at all. Today a mark is local: it moves the row in CryptMail and leaves Gmail's own filing alone, so a rescued message still ages out of Gmail's Spam after 30 days. `TRASH` cannot be set this way — hence the dedicated `messages.trash`/`untrash` — and `SPAM` may be restricted the same way. Verify against the live account rather than assuming. |
| `messages.insert` | Whether an encrypted copy of a sent message can be written into the mailbox without a send round trip. Would also make seeding a test mailbox cheap. |

## 3. Deliberately not

| API | Why not |
|---|---|
| `threads.list` / `threads.get` | We group in [`threads/threads.ts`](../app/src/threads/threads.ts). Server-side threading cannot see locally-decrypted content, so it would disagree with our own rows. |
| `drafts.create` / `update` | A server draft is plaintext on Google's infrastructure. Drafts stay local unless we encrypt them first, which is a design decision, not a connector one. |
| `settings.filters.*` | Server-side rules act on content Google can read. Silent on encrypted mail by construction. |
| `settings.sendAs.smimeInfo.*` | The other end-to-end story, run through the provider's key handling — the trust model this product exists to avoid. Useful as a contrast point in the docs, not as a feature. |
| `settings.delegates.*` | Grants another account read access to the mailbox. Hostile to the threat model. |
| `users.watch` (Pub/Sub push) | Correct answer to polling, but it needs a GCP project and a server endpoint we control. Real infrastructure, and a server in a path that currently has none. Revisit when there is a backend. |
| `messages.delete` | Needs the full `https://mail.google.com/` scope, which materially raises the bar on Google's OAuth verification review. `messages.trash` covers the user-visible need. |
| `labels.create` / `patch` | Only wanted if CryptMail organised mail server-side, which conflicts with "the provider sees ciphertext". |

## Scopes

Everything in §1 except #4 fits inside the `gmail.modify` we already hold.
`settings.sendAs.list` needs `gmail.settings.basic`; raising a scope forces every
existing user to re-consent, so if aliases are wanted it is worth adding at the
same time as any other scope change rather than on its own.

## Quota

Unit-based per user, not request-based: `messages.list` ≈ 5 units, `messages.get`
≈ 5, `messages.send` ≈ 100, against 250 units/user/second. Nothing here is near
the ceiling; the failure mode is burstiness, which #1 fixes.
