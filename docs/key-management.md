# Key Management

Key management is where E2EE products live or die. This covers key generation,
storage at rest, discovery of others' keys, recovery, multi-device sync, and
rotation.

## The user's keypair

On first setup, CipherMail generates an OpenPGP keypair **on the device**:

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

Resolved in priority order at send time:

1. **Local keyring** — keys already cached from prior messages/verification.
2. **Autocrypt cache** — keys learned from `Autocrypt` headers on received mail
   (see [encryption.md](encryption.md)).
3. **CipherMail key directory** — backend service mapping `email → public key(s)`
   for registered users (see [api.md](api.md)).
4. **WKD (Web Key Directory)** — RFC-standard lookup at the recipient's domain
   (`https://openpgpkey.<domain>/.well-known/openpgpkey/...`). Enables interop
   with non-CipherMail PGP users.
5. **Manual import** — paste/scan a key or fingerprint.

If none resolve, the recipient is treated as "no key" and fallbacks apply.

### Trust levels

- **Seen (TOFU):** learned via Autocrypt/directory, trust-on-first-use. Fine for
  the default, opportunistic experience.
- **Verified:** the user compared the key **fingerprint** out-of-band (QR scan in
  person, phone call, safety-number comparison). Upgrades UI to "verified".
- **Changed:** a previously-seen address presents a new key → warn loudly; could
  be a new device (benign) or an attacker (not). Require re-verification.

The key directory being honest is a trust assumption; verification defeats a
malicious directory. See [security.md](security.md) for key-substitution risk and
mitigations (key transparency log, self-signed key changes).

## Recovery

Losing the private key means losing access to all past encrypted mail. Two
supported paths, user chooses at onboarding (can enable both):

### A. Recovery code (recommended, zero-knowledge)
- At setup, generate a high-entropy **recovery code** (e.g. a BIP39-style
  mnemonic or a base32 code).
- Use it (via Argon2id) as an alternate wrapping key for the private key.
- Store the resulting encrypted blob in the **encrypted key backup** on the
  backend. The server cannot read it.
- To recover on a new device: sign in, download the blob, enter the recovery
  code, unwrap the private key.
- If the user loses the recovery code **and** all devices → mail is
  unrecoverable. This is stated plainly during onboarding.

### B. Passphrase backup
- Same as above but wrapped with the user's chosen passphrase instead of a
  generated code. More memorable, weaker if the passphrase is weak.

### Non-goal: server-side recovery of readable keys
The backend never holds anything it can decrypt. We do not offer "we'll reset it
for you" recovery, because that would mean the server could read mail.

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
- On rotation, the new public key is republished (directory + Autocrypt) and the
  old private key is retained locally (marked non-preferred) so historical mail
  stays readable.
- Compromise → revoke: publish a revocation certificate and a fresh key; warn
  contacts on next contact.

## Summary of what is stored where

| Item | Device (encrypted store / keychain) | Backend | Mail provider |
|------|-------------------------------------|---------|---------------|
| Private key (usable) | ✅ (wrapped, RAM when unlocked) | ❌ | ❌ |
| Private key (passphrase-wrapped backup) | optional | ✅ (opaque blob) | ❌ |
| Own public key | ✅ | ✅ (directory) | ✅ (Autocrypt headers) |
| Contacts' public keys | ✅ (keyring) | ✅ (directory) | ✅ (headers on their mail) |
| Passphrase / recovery code | ❌ (memorized / keychain) | ❌ | ❌ |
| Message ciphertext | cached | secure-link only | ✅ |
| Message plaintext | RAM / optional cache | ❌ | ❌ |
