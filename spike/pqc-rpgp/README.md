# PQ.1 — RFC 9980 library spike

Answers the gating question in [../../docs/post-quantum.md](../../docs/post-quantum.md):
**does any OpenPGP library actually implement post-quantum encryption today?**

```bash
cargo run
```

## Result

```
          primary                     cert bytes   msg bytes
Stage 1   Ed25519                           2432        2125
Stage 2   MlDsa65Ed25519                   18523        6606
```

Both stages generate a V6 keypair with an **ML-KEM-768+X25519** encryption
subkey, sign, encrypt, decrypt, and re-parse the serialised key. Both pass.

## Why this exists

Three libraries were checked. Only one works:

| Library | Version | RFC 9980 |
|---|---|---|
| OpenPGP.js | 6.3.1 | **no** — `enums.publicKey` ends at `ed448` |
| Bouncy Castle `bcpg` | 1.85 | **no** — `PublicKeyAlgorithmTags` stops at `Ed448 = 28` |
| rPGP (`pgp`) | 0.20 | **yes** — IDs 35/36, ML-DSA, SLH-DSA |

So the Rust core is required for post-quantum CryptMail, and an Android-only
target does not open a Kotlin/Bouncy Castle shortcut.

The 7.6× size gap between the stages is the whole argument for shipping
post-quantum *confidentiality* before post-quantum *signatures*: an 18.5 KB
`Autocrypt:` header on every outgoing message is not deliverable, and Autocrypt
is what makes the product work without manual key exchange.

## Caveats

- rPGP gates this behind a feature named **`draft-pqc`** — implemented against
  the pre-RFC draft. The algorithm IDs match the published RFC, but the naming
  is a warning worth heeding.
- The round-trip is rPGP-to-itself. **Interop is unverified** and is now the
  largest open risk. The old "cross-check against GnuPG" step from M1 cannot
  cover PQC until GnuPG ships it.
- This is a spike, not a component. It does not build any part of the app.
