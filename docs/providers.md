# Provider Integration

CryptMail is a client for accounts users already have. This describes how it
authenticates and moves mail for each provider class. All connectors implement
one internal interface so the rest of the app is provider-agnostic.

## Connector interface (internal)

```
interface MailConnector {
  connect(account): Session
  listMailboxes(): Mailbox[]
  listMessages(mailbox, sinceCursor): MessageHeader[]
  getMessage(id): RawMime           // full RFC 5322 message
  sendMessage(rawMime): void        // already-encrypted MIME
  watch(mailbox, onChange): Unsubscribe   // IDLE / push / polling
  updateFlags(id, flags): void      // read/unread, labels
}
```

The crypto layer sits *above* this: connectors move opaque bytes; they never see
plaintext because the message handed to `sendMessage` is already ciphertext, and
the message returned by `getMessage` is decrypted only afterward in the crypto
core.

## Gmail / Google Workspace

**Auth:** native Play-services sign-in on Android
(`@react-native-google-signin/google-signin`). Users never type their Google
password into CryptMail. A browser Authorization-Code + PKCE flow is *not* an
option here: Google refuses custom URI schemes from an Android OAuth client, so
there is no redirect URI to come back to. A hosted `https` redirect would work,
but needs a server.

- Scopes (principle of least privilege):
  - `https://www.googleapis.com/auth/gmail.modify` — read, send, modify labels
    (avoid the broad `mail.google.com` scope unless full IMAP is needed). **This
    is what CryptMail requests**, as of 2026-08-08.
  - `gmail.readonly` + `gmail.send` is narrower, but 403s on label writes — which
    is what star, archive and mark-read are.
- **Transport options:**
  - **Gmail API (recommended):** `users.messages.list/get/send`, `users.watch`
    for push via Google Cloud Pub/Sub → real-time, quota-friendly.
  - **IMAP/SMTP with XOAUTH2:** use the OAuth token as the IMAP/SMTP credential.
    Simpler to share code with the generic path; no Pub/Sub setup.
- **Sending:** `users.messages.send` with a base64url raw MIME (our ciphertext).
- **Which endpoints to adopt, and which to refuse:**
  [gmail-api-adoption.md](gmail-api-adoption.md) — batching, `history.list` and
  aliases are the ones worth building; the `CATEGORY_*` tabs, server drafts and
  server-side filters are refused there with reasons.
- **App verification:** Gmail scopes are "restricted"; Google requires OAuth app
  verification + an annual third-party security assessment (CASA) for production.
  Budget for this.

## Outlook.com / Microsoft 365

**Auth:** OAuth 2.0 authorization code + PKCE against the Microsoft identity
platform's `common` endpoint, in the system browser. There is no MSAL SDK:
a public client may redirect to `cryptmail://auth`, so `expo-web-browser` plus
`expo-crypto` is enough ([auth/microsoftAuth.ts](../app/src/auth/microsoftAuth.ts)).
Setup: [running-it.md](running-it.md) §1c.

- Scopes: `offline_access`, `openid`, `profile`, `User.Read` (for `/me` only, to
  learn the SMTP address), `Mail.ReadWrite`, `Mail.Send`.
- **Transport (built):** Microsoft Graph ([mail/graph.ts](../app/src/mail/graph.ts)).
  - List: `/me/mailFolders/{inbox|sentitems|archive|junkemail|deleteditems}/messages`,
    one request per page, cleartext headers via `internetMessageHeaders`.
  - Raw: `/me/messages/{id}/$value`. The crypto core never reads Graph's JSON body.
  - Send: `POST /me/sendMail` with base64 MIME as `text/plain`.
  - Flags: `PATCH` for read and flag. Archive and trash are **moves**, so every
    request sends `Prefer: IdType="ImmutableId"`, or the id would change on move.
  - Archive is the well-known `archive` folder, the same one Outlook's own
    Archive button uses. Gmail's archive is a query instead.
  - Push (change notifications) is not built. Graph mail is polled like Gmail.
- **Alternative, not used:** IMAP/SMTP with OAuth2 (XOAUTH2).
- Note: Microsoft has been deprecating **Basic auth** for IMAP/SMTP — OAuth is
  required for personal and work/school accounts. Plan for OAuth only.

## iCloud, Yahoo, Fastmail, generic IMAP/SMTP

**Auth:** a password — ideally an app-specific one — kept in the OS keystore.
OAuth (XOAUTH2) is not built for this path.

> **Status (2026-09-18): built, tested against in-memory servers, never run
> against a real server or on a device.** See "Unproven" below.

**Code:** [mail/imap.ts](../app/src/mail/imap.ts) (the `MailClient`),
[mail/imapConnection.ts](../app/src/mail/imapConnection.ts) and
[mail/imapWire.ts](../app/src/mail/imapWire.ts) (the protocol),
[mail/smtp.ts](../app/src/mail/smtp.ts), [mail/autoconfig.ts](../app/src/mail/autoconfig.ts),
[auth/imapAuth.ts](../app/src/auth/imapAuth.ts), and the one file that opens a
socket, [mail/tcpSocket.ts](../app/src/mail/tcpSocket.ts) (over
`react-native-tcp-socket`). The protocol code never sees that library; it is
written against the `MailSocket` interface in [mail/socket.ts](../app/src/mail/socket.ts),
which is what lets the tests drive it with scripted servers.

**Availability.** This path needs no client id. It needs a native socket module,
so it exists in a dev build and not on web or in Expo Go (`canConnectImap` in
[config.ts](../app/src/config.ts)). The connect screen says "Needs a dev build"
rather than hiding the row.

**Sign-in** is a sheet ([ui/imapSetupSheet.tsx](../app/src/ui/imapSetupSheet.tsx)):
the address and password, with the servers looked up and folded away.
- **Discovery** tries three sources in parallel and takes them in this order.
  First the domain's own autoconfig over HTTPS, which receives the full address.
  Then Mozilla's ISPDB, which receives **the domain only**. Last, a guess of
  `imap.<domain>:993` and `smtp.<domain>:465`. A plaintext entry is skipped, and
  so is a server that only takes OAuth.
- **Signing in is the test.** `imapAuth` logs in to the IMAP server and
  authenticates to the SMTP server before anything is saved. A refused password
  names app-specific passwords, since iCloud, Yahoo and others need one.

**TLS, always.** There is no plaintext setting to choose, even by accident.
- `tls` connects over TLS from the first byte.
- `starttls` refuses a server that does not offer STARTTLS. Nothing is sent
  before the upgrade except CAPABILITY and STARTTLS/EHLO.
- Any bytes that arrive between the server's OK and the end of the handshake
  drop the connection (the CVE-2011-0411 injection class).
- Capabilities seen before TLS are asked for again inside it.

**The certificate host check is ours.** `react-native-tcp-socket` 6.4.3 on
Android validates the certificate *chain*, but it does not check that the
certificate names the host, and it sends no SNI. `tcpSocket.ts` therefore
compares the peer certificate's subject CN against the host (wildcards cover one
label) before writing a byte. The library reports only the CN, not the
subjectAltNames. So a server whose CN is a *different* one of its names is
refused, and so is a shared host that serves its default certificate for lack of
SNI. Both refusals are the safe way to be wrong, and the message names the
certificate's CN.

**Mapping onto `MailClient`:**
- **Ids** are `<uidvalidity>:<uid>:<folder>`. That is stable for as long as the
  folder's UIDVALIDITY is, which is what the raw cache needs.
- **Folders** are found by SPECIAL-USE attribute (RFC 6154), then by the usual
  names (`Sent Items`, `Junk`, `Deleted Messages`, …), including under an
  `INBOX.` prefix. Archive, Trash and Junk are created on first use when missing,
  as Thunderbird does. Listing a folder the server lacks gives an empty page.
- **Paging** is a UID cursor over `UID SEARCH UNDELETED`. The sync window is
  `SINCE`.
- **Row headers** come from `BODY.PEEK[HEADER.FIELDS (…)]`, the same set Gmail's
  metadata request asks for. RFC 2047 words are decoded
  ([mail/headers.ts](../app/src/mail/headers.ts)).
- **Snippets** are empty. There is no preview short of fetching the body.
- **Threads** are the first id in `References`, else `In-Reply-To`, else the
  message's own `Message-ID`. IMAP has no thread id.
- **Reading a message** uses `BODY.PEEK[]`, so it does not mark it read.
- **Moves** (archive, trash, junk) change the UID. The client uses `UID MOVE`, or
  failing that `COPY`, `\Deleted` and `UID EXPUNGE` of that one UID. It never
  runs a bare EXPUNGE, which would erase other clients' pending deletions. It
  remembers the new UID from `COPYUID` (RFC 4315), so a swipe's undo still names
  the message. A STORE or MOVE on a UID that no longer exists is an OK that did
  nothing, so the client checks the untagged responses and fails loudly instead
  of reporting a success.
- **Sending** is SMTP submission: `Bcc` stripped from DATA, dot-stuffing, and an
  EHLO of `[127.0.0.1]` rather than the device name. Then the same bytes, already
  ciphertext for encrypted mail, are `APPEND`ed to Sent. That step is skipped for
  hosts known to file their own copy (Gmail, Office 365/Outlook), and it is a
  per-account setting. A failed APPEND does **not** fail the send: the message is
  already delivered, and a throw would make the outbox deliver it twice.
- **Sessions:** one connection per mailbox, whole operations serialised on it,
  logged out after two idle minutes, and reconnected once if the server dropped
  it. A refused password is `reauth-required`. A server that says it
  cannot check the password right now ([UNAVAILABLE] and friends, RFC 5530) is an
  ordinary error.

**Unproven:**
- Never run against a real IMAP or SMTP server.
- Never run on a device. That includes the library under React Native 0.86's
  new architecture (it is a legacy native module, reached through the interop
  layer) and its STARTTLS upgrade.
- No IDLE and no incremental sync (`CONDSTORE`). Mail is polled like Gmail's,
  and each list runs one `UID SEARCH` over the folder.

## Token & credential storage

- OAuth **refresh tokens** and any passwords are stored in the OS keychain, never
  in plaintext files, never on our backend.
- Access tokens kept in memory, refreshed as needed.
- Revocation: signing out deletes tokens locally and (for OAuth) revokes at the
  provider where possible.
- An IMAP password is stored once it has worked, in `expo-secure-store`, one entry
  per mailbox (`cryptmail.imap.v1.<hex address>`). It is never put on `Session`
  and never in the account registry. It is read at connect time and sent only
  inside TLS, only to the hosts saved beside it. There is nothing to revoke at
  the provider, so signing out deletes it, and the setup sheet recommends an
  app-specific password, which the user can revoke without changing their own.

## Sync strategy

- **Initial sync:** pull headers for recent mail; fetch bodies lazily on open.
- **Incremental:** Gmail `historyId` / Graph `deltaLink` / IMAP `UIDNEXT` +
  `CONDSTORE` for efficient deltas.
- **Push:** Gmail `users.watch` (Pub/Sub), Graph subscriptions, or IMAP IDLE.
  Mobile uses the backend push relay ([api.md](api.md)) to avoid holding
  long-lived connections in the background.
- **Local cache:** stored in the encrypted SQLite store ([data-model.md](data-model.md)).

## Sent-folder handling

When sending via API/SMTP, the provider files a copy in "Sent". Because we send
already-encrypted MIME, the Sent copy is ciphertext too. We always encrypt a copy
to the sender's own key so the user can read their own Sent items.

## Rate limits & quotas

- Gmail API: per-user/day quota units — batch and cache aggressively.
- Graph: throttling with `Retry-After` — honor it.
- IMAP: keep connection counts low; reuse IDLE connections.

## What the provider can and cannot see

- **Sees:** envelope (From/To/Cc/Date), message size, placeholder subject,
  Autocrypt header (public key), that the message is encrypted.
- **Cannot see:** real subject, body, attachment contents/filenames (inside the
  encrypted MIME tree).
