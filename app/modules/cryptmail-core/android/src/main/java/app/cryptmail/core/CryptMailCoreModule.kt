package app.cryptmail.core

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.cryptmail_core.CryptMailCore
import uniffi.cryptmail_core.FfiException

/**
 * The `CryptMailCore` native module: seven string-in/string-out crypto calls,
 * bridging JavaScript to the Rust crate through UniFFI.
 *
 * This is the module `app/src/core/nativeCore.ts` looks for by name. Its
 * presence is what flips `cryptoMode` to `real` (see `app/src/config.ts`) — so
 * registering it half-finished would make the app claim real encryption it
 * cannot deliver.
 *
 * ## What deliberately does not happen here
 *
 * **No MIME.** The envelope is assembled in TypeScript by `core/mime.ts`, which
 * already implements `docs/message-format.md` and is tested. This layer only
 * passes strings across.
 *
 * **No passphrase in any signature.** It is read from the Android Keystore by
 * `KeystorePassphrase` and handed to the Rust constructor once. Nothing that
 * JavaScript can call takes or returns it. That is the entire reason a native
 * core exists rather than an OpenPGP library in JS.
 *
 * **No private key crossing back.** Every return value is a `String`: armored
 * public material, ciphertext, or JSON describing the public half.
 */
class CryptMailCoreModule : Module() {
  /**
   * Built on first use rather than in a constructor: key generation and
   * Keystore access both need a `Context`, and the module is instantiated
   * before one is guaranteed to be available.
   */
  private val core: CryptMailCore by lazy {
    val context = appContext.reactContext
      ?: throw CodedException("unavailable", "No Android context is available.", null)

    val passphrase = KeystorePassphrase.get(context)

    // App-private storage. Not `getExternalFilesDir`: the secret key is
    // S2K-encrypted, but external storage is world-readable on older devices
    // and included in some backup paths.
    val storage = context.filesDir.resolve("cryptmail-core")

    // The passphrase that locked whatever is in here is gone, so the secret key
    // in it can never be opened again — see `KeystorePassphrase.get`. Leaving
    // the files would be worse than deleting them: `load_identity` reads only
    // the public half, so the app would show a healthy identity and then fail
    // every send and every decryption with no explanation. Clearing them puts
    // the user on the setup screen, where "restore from your recovery code" is
    // the offer that actually helps.
    if (passphrase.reset && storage.exists()) {
      Log.w("CryptMailCore", "Discarding key material sealed with a passphrase this device can no longer read.")
      storage.deleteRecursively()
    }

    CryptMailCore(
      storageDir = storage.apply { mkdirs() }.absolutePath,
      passphrase = passphrase.value,
    )
  }

  override fun definition() = ModuleDefinition {
    Name("CryptMailCore")

    // `Coroutine` moves every call off the main thread. Key generation takes a
    // noticeable moment — ML-KEM keygen plus an Ed25519 primary — and blocking
    // the UI thread would drop frames on the one screen where the user is
    // waiting anyway.
    AsyncFunction("generateIdentity") Coroutine { email: String ->
      mapErrors { core.generateIdentity(email) }
    }

    AsyncFunction("loadIdentity") Coroutine { email: String ->
      mapErrors { core.loadIdentity(email) }
    }

    AsyncFunction("importPublicKey") Coroutine { armored: String ->
      mapErrors { core.importPublicKey(armored) }
    }

    // Recovery is the slowest thing here by a wide margin — Argon2id at 64 MiB
    // is deliberately expensive — so `Coroutine` is load-bearing, not decoration:
    // running this inline would freeze the UI outright.
    AsyncFunction("exportRecoveryBackup") Coroutine { email: String, code: String ->
      mapErrors { core.exportRecoveryBackup(email, code) }
    }

    // Takes no address: the backup carries its own, in the restored key's User ID.
    AsyncFunction("importRecoveryBackup") Coroutine { blob: String, code: String ->
      mapErrors { core.importRecoveryBackup(blob, code) }
    }

    AsyncFunction("encryptSign") Coroutine { email: String, plaintext: String, recipientKeysJson: String ->
      mapErrors { core.encryptSign(email, plaintext, recipientKeysJson) }
    }

    // Takes no address on purpose: the envelope cannot say which identity to
    // decrypt with — our address may be in `Cc`, or `To` may list several
    // people — so the core uses the identity this device holds.
    AsyncFunction("decryptVerify") Coroutine { armored: String, senderKeysJson: String ->
      mapErrors { core.decryptVerify(armored, senderKeysJson) }
    }
  }

  /**
   * Translate `FfiException` into the four codes TypeScript already switches on
   * (`CoreError` in `app/src/core/types.ts`).
   *
   * The `when` is exhaustive over a sealed class, so adding a variant on the
   * Rust side becomes a compile error here rather than an unhandled code
   * reaching the UI at runtime — which is why `FfiError` is an enum rather than
   * a `{ code, message }` struct. See `core/src/ffi.rs`.
   */
  private suspend fun <T> mapErrors(block: suspend () -> T): T = withContext(Dispatchers.IO) {
    try {
      block()
    } catch (e: FfiException) {
      val code = when (e) {
        is FfiException.NoKey -> "no-key"
        is FfiException.Malformed -> "malformed"
        is FfiException.DecryptFailed -> "decrypt-failed"
        is FfiException.Unavailable -> "unavailable"
      }
      // `e.message` is the Rust `Display` string (`#[uniffi(flat_error)]`), so
      // it is safe to surface: it names what failed, never key material.
      throw CodedException(code, e.message, e)
    } catch (e: CodedException) {
      throw e
    } catch (e: Throwable) {
      // A panic crossing the FFI, a missing .so, a Keystore failure. Reported
      // as `unavailable` rather than allowed to surface as an opaque crash.
      Log.e("CryptMailCore", "Native crypto call failed", e)
      throw CodedException("unavailable", describe(e), e)
    }
  }

  /**
   * A human-readable one-liner for a throwable that may carry no message of its
   * own.
   *
   * `e.message ?: "…failed unexpectedly"` was worse than useless: the two
   * failures most likely to reach here — `ExceptionInInitializerError` from the
   * UniFFI/JNA library load, and a Keystore `ProviderException` — both have a
   * null message and carry everything you need in `cause`. Collapsing them to
   * one generic sentence made a load failure, a checksum mismatch and a
   * StrongBox fault indistinguishable on a release build, where `run-as` cannot
   * reach the logs either.
   *
   * So: name the class, walk the cause chain, and keep it short enough for a
   * toast.
   */
  private fun describe(e: Throwable): String {
    val chain = generateSequence(e) { if (it.cause === it) null else it.cause }.take(4)
    return chain.joinToString(" ← ") { link ->
      val name = link.javaClass.simpleName.ifEmpty { link.javaClass.name }
      link.message?.let { "$name: $it" } ?: name
    }
  }
}
