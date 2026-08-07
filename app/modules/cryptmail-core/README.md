# cryptmail-core (Expo local module)

The Android half of the native crypto core: JavaScript → Kotlin → UniFFI →
[`core/`](../../../core).

> ⛔ **This has never been compiled.** There is no Android SDK or NDK in the
> environment it was written in, and `app/android/` (an `expo prebuild`
> artifact) does not exist. It is written against the real Expo SDK 57 module
> API and the UniFFI bindings that
> [`core/`](../../../core) is verified to generate, but treat it as a starting
> point that needs a first build, not as working code.

## What it is

Five string-in/string-out crypto calls — exactly the surface
[`app/src/core/nativeCore.ts`](../../src/core/nativeCore.ts) expects. Registering
this module under the name `CryptMailCore` is what makes `getNativeCore()`
return non-null, which flips `cryptoMode` to `real`.

Nothing else in the app changes when it lands.

| File | Role |
|---|---|
| `CryptMailCoreModule.kt` | The Expo module. Calls off the main thread, maps `FfiException` onto the four `CoreError` codes. |
| `KeystorePassphrase.kt` | Generates a random passphrase once, wraps it with an Android Keystore AES key, keeps the ciphertext in app-private prefs. |

## Two invariants it exists to hold

1. **The passphrase never reaches JavaScript.** No method here takes or returns
   one; it goes from the Keystore straight into the Rust constructor. If a
   passphrase ever appears in a signature in `nativeCore.ts`, the native core has
   stopped being worth having.
2. **MIME stays in TypeScript.** `core/mime.ts` implements
   [`docs/message-format.md`](../../../docs/message-format.md) and is tested;
   this layer only passes strings.

## Bringing it up

```bash
# 1. Generate the Android project (this directory is picked up automatically).
cd app && npx expo prebuild -p android

# 2. Cross-compile the Rust core and drop the .so where build.gradle looks.
cd ../core
rustup target add aarch64-linux-android
cargo install cargo-ndk
cargo ndk -t arm64-v8a -o ../app/android/app/src/main/jniLibs build --release

# 3. Generate the Kotlin bindings from that same .so — version-locked bindgen.
cargo run --bin uniffi-bindgen -- generate \
  --library ../app/android/app/src/main/jniLibs/arm64-v8a/libcryptmail_core.so \
  --language kotlin --out-dir ../app/android/app/src/main/java

# 4. Build and run.
cd ../app && npx expo run:android
```

Step 3 emits `uniffi/cryptmail_core/cryptmail_core.kt`, which is what the
`import uniffi.cryptmail_core.*` lines here resolve to. Steps 2 and 3 must use
the *same* `.so`; bindings generated from a host build will link but misread the
FFI at runtime.

## Expected first-build friction

None of this has been exercised, and these are the parts most likely to need
adjustment:

- **JNA.** UniFFI's Kotlin needs `net.java.dev.jna:jna:…@aar` (the `@aar`
  matters — the plain jar has no Android natives). The version pinned in
  `build.gradle` is a guess at a compatible one.
- **`jniLibs.srcDirs`** points into `app/android/`, which only exists after
  prebuild. If the relative path is wrong the build succeeds and fails at the
  first call with `UnsatisfiedLinkError`.
- **NDK version** must be pinned in `android/build.gradle` after prebuild;
  cross-compilation is historically the biggest time sink in this project.
- **`abiFilters`** is arm64-only, matching the `cargo ndk -t arm64-v8a` above.
  An emulator on an x86_64 host needs both sides changed.

## Verifying it actually works

The first thing to run after it builds — and the check M2 is defined by — is a
round-trip on a device: generate an identity, send to yourself, read it back.
[`spike/interop-rpgp-sequoia`](../../../spike/interop-rpgp-sequoia) already
proves the *crypto* interoperates; what is unproven here is the bridge.
