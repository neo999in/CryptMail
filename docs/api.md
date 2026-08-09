# Backend API — **not planned**

> **Status: this backend is not being built.** It is kept as a record of a design
> that was considered and rejected, not as a roadmap item. Nothing in the app
> calls any of it, and nothing is expected to.
>
> Each service below has an entry saying what replaced it. The short version:
>
> | Service | Instead |
> |---|---|
> | Key directory | `keys.openpgp.org` + WKD, client-side ([key-management.md](key-management.md) §Discovery) |
> | Encrypted key backup | The user exports the blob; it is opaque, so the server only ever bought convenience |
> | Push relay | Still open — a real gap on mobile, and the only entry here worth reconsidering |
> | Secure links | Rejected outright: it would make CryptMail a service, and the invite-and-queue flow covers the case ([encryption.md](encryption.md)) |
>
> The overriding reason is the project's first architectural commitment:
> CryptMail is a client, never a mail provider. A directory in particular would
> also give us a live log of who is about to email whom — the social graph, which
> is the thing the product exists to protect.

The design as it stood, for reference:

The backend was to be deliberately minimal and **zero-knowledge**: public key
discovery, encrypted key backup, and push. It would never see plaintext, private
keys, passphrases, or OAuth tokens.

Base URL: `https://api.cryptmail.app/v1`
Auth: bearer token from account sign-in (proves control of the email address).

## Address ownership verification

Before an address is listed in the directory, the user must prove they control it.
Options:
- **OAuth proof:** the same OAuth session used for Gmail/Graph proves ownership.
- **Challenge email:** send a code to the address; user confirms in-app.

## Key directory — **not built**

> Replaced by client-side discovery against `keys.openpgp.org` and WKD. The
> verifying keyserver already provides address-verified lookup, and `upsertKey`
> marking a changed fingerprint `changed` is the client-side check that keeps a
> lying keyserver from silently swapping a key you already hold.
>
> `prev_key_signature` below is the one idea worth keeping: it is the
> self-authenticated rotation described in
> [key-management.md](key-management.md), and the trust transition for it exists
> in the keyring today. It does not need a server — the signature can travel
> with the key material.

### `PUT /directory/{email}`
Publish or update the caller's **public** key. Requires ownership proof.

```json
{
  "fingerprint": "AABB...",
  "public_key": "-----BEGIN PGP PUBLIC KEY BLOCK----- ...",
  "prev_key_signature": "<optional: new key signed by old key>"
}
```
`prev_key_signature` links rotations so clients can verify a key change is
self-authenticated rather than a substitution.

### `GET /directory/{email}`
Look up a recipient's public key(s). Public / rate-limited.

```json
{
  "email": "bob@outlook.com",
  "keys": [
    { "fingerprint": "CCDD...", "public_key": "...", "revoked": false,
      "verified_at": "2026-07-01T00:00:00Z" }
  ]
}
```
Returns `404` if no key is published → client falls back to Autocrypt/WKD or
treats the recipient as key-less.

### `POST /directory/{email}/revoke`
Publish a revocation (requires ownership proof + a valid revocation certificate).

### `GET /directory/{email}/proof` (key transparency, roadmap)
Return an inclusion proof that the served key is the one committed to the public
append-only transparency log, so the directory can't equivocate.

## Encrypted key backup — **not built**

> The blob is opaque to the server by construction, so the server only ever
> bought convenience, never security. The app exports it and the user keeps it.
> The intended next increment is storing it as a self-addressed message in the
> user's own mailbox — durable, opaque to the provider, no new infrastructure.

### `PUT /backup`
Store the caller's **passphrase/recovery-code-wrapped** private key. The server
stores an opaque blob it cannot decrypt.

```json
{
  "blob": "<base64 AES-256-GCM ciphertext>",
  "kdf": { "alg": "argon2id", "salt": "...", "m": 65536, "t": 3, "p": 1 }
}
```

### `GET /backup`
Return the stored blob + KDF params for a new-device restore. May require device
approval (below).

## Multi-device

### `POST /devices`
Register a new device (push token, public device info). Returns `pending` if
device approval is enabled.

### `POST /devices/{id}/approve`
Called by an already-trusted device to approve a new one, releasing the key backup.

## Push relay — **not built, and the one still worth arguing about**

> Nothing client-side replaces this: a phone that is not running the app cannot
> notice new mail, and — since the outbox is client-side — cannot deliver a held
> message either. It is a real limitation rather than a decision. Any revival of
> this document starts here.

### `POST /devices/{id}/push-token`
Register an APNs/FCM token so the relay can notify the device of new mail without
it holding a live IMAP/IDLE connection. The push payload contains **no** message
content — only "you have new mail", triggering a fetch.

## Secure-link fallback — **rejected, not merely unbuilt**

> Hosting ciphertext and a web reader would make CryptMail a service. The
> case it addressed — a recipient with no key — is covered by invite-and-queue
> ([encryption.md](encryption.md)), which needs no infrastructure and does not
> teach anyone to type a passphrase into a page that arrived by email.

### `POST /links`
Upload ciphertext for a key-less recipient; returns a short URL. The decryption
passphrase is **never** sent here — it's shared out-of-band by the sender.

```json
{ "ciphertext": "<base64>", "expires_in": 604800, "max_reads": 3 }
```

### `GET /links/{id}`
Served to the web reader; returns ciphertext only. Decryption happens in the
recipient's browser with the out-of-band passphrase.

## What the backend would have stored (recap)

| Stored | Not stored |
|--------|-----------|
| Public keys, fingerprints, revocations | Private keys (usable) |
| Opaque passphrase-wrapped key backups | Passphrases / recovery codes |
| Push tokens, device records | OAuth tokens, mail credentials |
| Secure-link ciphertext (TTL'd) | Message plaintext |

Since none of it is being built, the backend trust boundary in
[security.md](security.md) is empty: there is no CryptMail server to breach. What
takes its place is a public keyserver that holds public keys, has no account for
the user, and is treated as untrusted — see
[key-management.md](key-management.md) §Trust levels.
