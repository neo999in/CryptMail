# cryptmail-core

The crypto half of the `CryptCore` contract in
[`app/src/core/types.ts`](../app/src/core/types.ts). Post-quantum hybrid
encryption per RFC 9980, built on rPGP.

```bash
cargo test        # 20 tests, no Android toolchain required
```

## What it does, and what it deliberately does not

**Does:** hold the private key, generate identities, import contact keys,
encrypt-and-sign, decrypt-and-verify.

**Does not:** build or parse MIME. [`app/src/core/mime.ts`](../app/src/core/mime.ts)
already implements [`docs/message-format.md`](../docs/message-format.md) and is
covered by tests. Reimplementing it here would duplicate the fiddliest part of
the envelope and risk two divergent implementations of the same spec — the plan
even warns that rPGP does crypto, not MIME, so this would all be hand-written.

So the split is: **TypeScript composes the envelope, Rust does what must not
happen in JavaScript.** Plaintext crosses the boundary — it always did, since
`parseEncrypted` returns a decrypted body — but the private key never does.

## Algorithms

Stage 1 of [`docs/post-quantum.md`](../docs/post-quantum.md):

| | Algorithm | Why |
|---|---|---|
| Primary (sign, certify) | Ed25519 | Classical. PQ signatures inflate the cert to ~18 KB, which Autocrypt cannot carry on every message. |
| Encryption subkey | **ML-KEM-768 + X25519** (RFC 9980, id 35) | Post-quantum confidentiality. Composite: an attacker must break both. |
| Symmetric | AES-256 OCB, SEIPDv2 | |
| Key version | V6 | Required by RFC 9980. |

Certificates come out at ~2.4 KB. Stage 2 (ML-DSA-65 primary) is deferred; see
that document for why the two are staged apart, and [`spike/pqc-rpgp`](../spike/pqc-rpgp)
for the measurements.

## Invariants, each with a test

1. **A private key never appears in a return value.** Exit criterion 4 of
   [`docs/prototype-plan.md`](../docs/prototype-plan.md), and the whole reason a
   native core exists rather than OpenPGP.js.
2. **Secret keys are S2K-encrypted at rest** under a passphrase the caller
   supplies. On Android that comes from the Keystore.
3. **An unintended recipient cannot decrypt**, even holding a valid key of their
   own.
4. **`unknown` and `invalid` signatures stay distinct.** Collapsing them would
   let a forged message read as merely unverified.

## Building for Android (M2)

Not yet done, and not doable without an Android SDK/NDK. Outline:

> ### ⚠️ `src/ffi.rs` is not yet a UniFFI interface
>
> It is plain Rust *shaped* like the FFI surface: correct method set, correct
> error codes, passphrase taken at construction. But **`uniffi` is not a
> dependency and there are no UniFFI annotations**, so the compiled `.so`
> carries no UniFFI metadata and `uniffi-bindgen` has nothing to read.
>
> Before the binding step below will work, either:
>
> - add `uniffi` to `Cargo.toml`, annotate `CryptMailCore` with
>   `#[derive(uniffi::Object)]` / `#[uniffi::export]`, and call
>   `uniffi::setup_scaffolding!()`; **or**
> - drop UniFFI and hand-write JNI. For five string-in/string-out methods that
>   is a defensible choice, and it removes a build-time code generator.

```bash
rustup target add aarch64-linux-android
cargo install cargo-ndk

# Cross-compile
cargo ndk -t arm64-v8a -o ../app/android/app/src/main/jniLibs build --release

# Only after the UniFFI scaffolding above exists:
cargo install uniffi-bindgen
uniffi-bindgen generate --library target/aarch64-linux-android/release/libcryptmail_core.so \
  --language kotlin --out-dir ../app/android/app/src/main/java
```

Pin the NDK version. Cross-compilation is historically the biggest time sink in
this project, which is why `prototype-plan.md` puts it in M0 while the Rust
surface is trivial.

None of these commands has been run — there is no Android toolchain in the
environment this crate was developed in.

### The Kotlin module

Register an Expo module named `CryptMailCore` exposing the five methods in
[`app/src/core/nativeCore.ts`](../app/src/core/nativeCore.ts). It should:

- Derive or unwrap a passphrase from the **Android Keystore** and pass it to
  `CryptMailCore::new` once, at construction. The passphrase must never appear
  in a JavaScript-visible signature — that is the point of the native core.
- Use app-private storage for `storage_dir`.
- Map `FfiError.code` onto the `CoreError` codes TypeScript already switches on:
  `no-key`, `malformed`, `decrypt-failed`, `unavailable`.
- Run calls off the main thread; keygen takes a noticeable moment.

Note `decryptVerify` takes **no** email argument. The envelope cannot say which
identity to decrypt with — our address may be in `Cc`, or `To` may list several
people — so the core uses the identity it holds
(`Core::stored_identity_email`).

> The Kotlin side is unwritten and untested; there is no Android toolchain in
> the environment this crate was developed in. Treat the outline above as a
> specification, not as verified instructions.

## Open risk

**Interop is unverified.** Every test here is this crate talking to itself, and
rPGP gates RFC 9980 behind a feature named `draft-pqc` — implemented against the
pre-RFC draft. The algorithm IDs match the published RFC, but before this is
trusted with real mail it must round-trip against a second RFC 9980
implementation. The old "cross-check against GnuPG" step from M1 cannot cover
post-quantum until GnuPG ships it.
