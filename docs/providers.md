# Provider Integration

CipherMail is a client for accounts users already have. This describes how it
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

**Auth:** OAuth 2.0 (Authorization Code + PKCE). Users never type their Google
password into CipherMail.

- Scopes (principle of least privilege):
  - `https://www.googleapis.com/auth/gmail.modify` — read, send, modify labels
    (avoid the broad `mail.google.com` scope unless full IMAP is needed).
  - Or `gmail.readonly` + `gmail.send` if you don't need label writes.
- **Transport options:**
  - **Gmail API (recommended):** `users.messages.list/get/send`, `users.watch`
    for push via Google Cloud Pub/Sub → real-time, quota-friendly.
  - **IMAP/SMTP with XOAUTH2:** use the OAuth token as the IMAP/SMTP credential.
    Simpler to share code with the generic path; no Pub/Sub setup.
- **Sending:** `users.messages.send` with a base64url raw MIME (our ciphertext).
- **App verification:** Gmail scopes are "restricted"; Google requires OAuth app
  verification + an annual third-party security assessment (CASA) for production.
  Budget for this.

## Outlook.com / Microsoft 365

**Auth:** OAuth 2.0 via Microsoft identity platform (MSAL).

- Scopes: `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `openid email`.
- **Transport options:**
  - **Microsoft Graph API (recommended):** `/me/messages`, `/me/sendMail`,
    change notifications (webhook subscriptions) for push.
  - **IMAP/SMTP with OAuth2:** Microsoft supports OAuth for IMAP/SMTP AUTH.
- Note: Microsoft has been deprecating **Basic auth** for IMAP/SMTP — OAuth is
  required for personal and work/school accounts. Plan for OAuth only.

## iCloud, Yahoo, Fastmail, generic IMAP/SMTP

**Auth:** app-specific passwords or, where supported, OAuth.

- **IMAP** for reading (`IMAP IDLE` for push-ish updates), **SMTP** for sending.
- iCloud/Yahoo require **app-specific passwords** (their 2FA blocks raw password
  login). Guide the user through generating one.
- Autodiscovery: try Mozilla ISPDB / Thunderbird autoconfig, then common
  host/port guesses, then manual entry.
- Always TLS: IMAPS (993), SMTPS (465) or STARTTLS (587). Reject plaintext ports.

## Token & credential storage

- OAuth **refresh tokens** and any passwords are stored in the OS keychain, never
  in plaintext files, never on our backend.
- Access tokens kept in memory, refreshed as needed.
- Revocation: signing out deletes tokens locally and (for OAuth) revokes at the
  provider where possible.

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
