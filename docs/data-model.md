# Data Model

Two stores: the **local encrypted store** on each device (the source of truth for
the user's view) and the **backend directory/backup store** (minimal, opaque).

## Local encrypted store (SQLite / SQLCipher)

The DB file is encrypted at rest with a key held in the OS keychain.

> **Prototype status.** SQLite/SQLCipher is not what the prototype uses. It
> stores these records as JSON in AsyncStorage, each value sealed with
> XChaCha20-Poly1305 under a 32-byte device key held in `expo-secure-store`
> (Keystore on Android, Keychain on iOS) — see
> [`app/src/store/localCrypto.ts`](../app/src/store/localCrypto.ts). The
> encryption-at-rest property above therefore holds; the storage engine and the
> per-table structure below do not yet.
>
> Web has no keychain, so the key is stored beside the data there and
> `storageReason()` says so in the UI.

### `accounts`
| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| email | text | the provider address |
| provider | text | `gmail` / `outlook` / `imap` |
| auth_kind | text | `oauth` / `password` |
| token_ref | text | keychain reference, **not** the token itself |
| created_at | ts | |

### `identity_keys` (this user's keypairs)
| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| account_id | uuid | FK |
| fingerprint | text | OpenPGP fingerprint |
| public_key | blob | armored public key |
| private_key_wrapped | blob | Argon2id+AES-GCM wrapped; only unwrapped in RAM |
| is_primary | bool | current preferred key |
| created_at / expires_at | ts | rotation/expiry |

### `contacts` and `contact_keys` (the keyring)
| column | type | notes |
|--------|------|-------|
| contact_id | uuid | PK |
| email | text | |
| display_name | text | |

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| contact_id | uuid | FK |
| fingerprint | text | |
| public_key | blob | armored |
| source | text | `autocrypt` / `directory` / `manual`. A key fetched from `keys.openpgp.org` or from WKD is `directory` either way — the trust it earns is identical, so splitting the two would only invite treating one as better than the other. |
| trust | text | `seen` / `verified` / `changed` |
| first_seen / last_seen | ts | |

### `messages`
| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| account_id | uuid | FK |
| provider_uid | text | Gmail id / IMAP UID / Graph id |
| mailbox | text | INBOX/Sent/… |
| from_addr / to_addrs / cc_addrs | text | envelope (clear) |
| date | ts | |
| encrypted | bool | was PGP/MIME? |
| sig_status | text | `valid` / `invalid` / `none` |
| subject_cached | text | decrypted real subject (optional cache) |
| body_cached | blob | decrypted body cache (optional; can be disabled) |
| flags | text | read/unread/labels |

> **Caching plaintext is optional.** A "high security" mode stores only
> ciphertext locally and decrypts on demand, so a stolen unlocked DB reveals less.

### `pending_outbox`
Queued sends, with the reason each one is held: `time` (scheduled for later) or
`awaiting-key` (a recipient has no published key yet), plus which addresses are
still pending. There is no per-message "mode" column — a queued message is
always encrypted-or-nothing. See [`outbox/outbox.ts`](../app/src/outbox/outbox.ts).

## Backend directory / backup store (Postgres)

The backend holds only opaque or public data. See [api.md](api.md).

### `directory`
| column | type | notes |
|--------|------|-------|
| email | text | PK (verified owner) |
| fingerprint | text | |
| public_key | blob | armored **public** key only |
| verified_at | ts | proof-of-control of the address |
| updated_at | ts | |
| revoked | bool | |

### `key_backups`
| column | type | notes |
|--------|------|-------|
| account_id | uuid | PK |
| blob | bytea | **passphrase/recovery-code-wrapped** private key — server can't read |
| kdf_params | jsonb | Argon2id salt/params (needed to unwrap client-side) |
| created_at | ts | |

### `devices` (for multi-device approval / push)
| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| account_id | uuid | FK |
| push_token | text | for push relay |
| approved | bool | approved by an existing device |
| created_at | ts | |

## Invariants

- The backend **never** stores: private keys in usable form, passphrases, message
  plaintext, or OAuth tokens.
- `contact_keys.trust = changed` must surface a warning before the app encrypts to
  or trusts a signature from that key.
- Every stored `identity_keys.private_key_wrapped` must be unwrappable by at least
  one recovery path, or the user is warned they have no recovery.
