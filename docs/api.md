# Backend API (optional)

The backend is deliberately minimal and **zero-knowledge**: it handles public key
discovery, encrypted key backup, and push. It never sees plaintext, private keys,
passphrases, or OAuth tokens. A pure peer-to-peer variant is possible using only
Autocrypt + WKD, but the directory greatly improves the "just works" experience.

Base URL: `https://api.cryptmail.app/v1`
Auth: bearer token from account sign-in (proves control of the email address).

## Address ownership verification

Before an address is listed in the directory, the user must prove they control it.
Options:
- **OAuth proof:** the same OAuth session used for Gmail/Graph proves ownership.
- **Challenge email:** send a code to the address; user confirms in-app.

## Key directory

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

## Encrypted key backup

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

## Push relay

### `POST /devices/{id}/push-token`
Register an APNs/FCM token so the relay can notify the device of new mail without
it holding a live IMAP/IDLE connection. The push payload contains **no** message
content — only "you have new mail", triggering a fetch.

## Secure-link fallback

### `POST /links`
Upload ciphertext for a key-less recipient; returns a short URL. The decryption
passphrase is **never** sent here — it's shared out-of-band by the sender.

```json
{ "ciphertext": "<base64>", "expires_in": 604800, "max_reads": 3 }
```

### `GET /links/{id}`
Served to the web reader; returns ciphertext only. Decryption happens in the
recipient's browser with the out-of-band passphrase.

## What the backend stores (recap)

| Stored | Not stored |
|--------|-----------|
| Public keys, fingerprints, revocations | Private keys (usable) |
| Opaque passphrase-wrapped key backups | Passphrases / recovery codes |
| Push tokens, device records | OAuth tokens, mail credentials |
| Secure-link ciphertext (TTL'd) | Message plaintext |

See [security.md](security.md) for the backend trust boundary and why a breach
does not yield mass decryption.
