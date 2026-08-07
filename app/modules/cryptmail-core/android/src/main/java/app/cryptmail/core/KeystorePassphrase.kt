package app.cryptmail.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64

/**
 * Supplies the passphrase that protects the OpenPGP secret key at rest.
 *
 * The passphrase is a random 32-byte value generated once per install. It is
 * never chosen by the user, never shown, and — the point of the whole native
 * core — never crosses into JavaScript: it is read here and handed straight to
 * `CryptMailCore::new` (see `app/src/core/nativeCore.ts`, where no method takes
 * a passphrase argument).
 *
 * ## Why wrap rather than store directly
 *
 * The Android Keystore holds *keys*, not arbitrary secrets. So the passphrase
 * is generated randomly, encrypted with an AES key that lives inside the
 * Keystore, and the ciphertext is kept in app-private `SharedPreferences`. The
 * wrapping key is `setUserAuthenticationRequired(false)` and non-exportable, so
 * the passphrase can be recovered by this app on this device and nowhere else —
 * an extracted `SharedPreferences` file on its own is useless.
 *
 * `StrongBox` is requested where the hardware provides it and silently skipped
 * where it does not, since a large share of devices have no StrongBox and
 * failing there would make the app unusable rather than more secure.
 */
internal object KeystorePassphrase {
  private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  private const val WRAPPING_KEY_ALIAS = "cryptmail.core.passphrase.wrapping.v1"
  private const val PREFS = "cryptmail.core"
  private const val PREF_WRAPPED = "wrapped_passphrase_v1"
  private const val PREF_IV = "wrapped_passphrase_iv_v1"

  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val GCM_TAG_BITS = 128
  private const val PASSPHRASE_BYTES = 32

  /** The stored passphrase, creating one on first run. */
  fun get(context: Context): String {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val wrapped = prefs.getString(PREF_WRAPPED, null)
    val iv = prefs.getString(PREF_IV, null)

    if (wrapped != null && iv != null) {
      return unwrap(decode(wrapped), decode(iv))
    }
    return create(prefs)
  }

  private fun create(prefs: android.content.SharedPreferences): String {
    val passphrase = ByteArray(PASSPHRASE_BYTES).also { java.security.SecureRandom().nextBytes(it) }
    // Base64 rather than raw bytes: the passphrase crosses into Rust as a
    // String, and arbitrary bytes are not valid UTF-8.
    val text = encode(passphrase)

    val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, wrappingKey()) }
    val sealed = cipher.doFinal(text.toByteArray(Charsets.UTF_8))

    prefs.edit()
      .putString(PREF_WRAPPED, encode(sealed))
      .putString(PREF_IV, encode(cipher.iv))
      .apply()

    return text
  }

  private fun unwrap(sealed: ByteArray, iv: ByteArray): String {
    val cipher = Cipher.getInstance(TRANSFORMATION).apply {
      init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
    }
    return String(cipher.doFinal(sealed), Charsets.UTF_8)
  }

  /**
   * The Keystore-resident AES key, created on first use.
   *
   * If this key is ever lost — a factory reset, or the user clearing app data —
   * the passphrase is unrecoverable and so is the OpenPGP secret key. That is
   * the correct behaviour for a device-bound key with no backup, and it is why
   * `key-management.md` calls for a separate recovery path rather than relying
   * on this.
   */
  private fun wrappingKey(): SecretKey {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    (keyStore.getEntry(WRAPPING_KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

    return generateWrappingKey(strongBox = true) ?: generateWrappingKey(strongBox = false)
      ?: throw IllegalStateException("Could not create a Keystore key for the core passphrase.")
  }

  private fun generateWrappingKey(strongBox: Boolean): SecretKey? = try {
    val spec = KeyGenParameterSpec.Builder(
      WRAPPING_KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      // No biometric gate: the scheduler and background refresh need the core
      // while the screen is locked. Auth-bound keys belong to the auto-lock
      // feature in security.md, which is a separate decision.
      .setUserAuthenticationRequired(false)
      .apply {
        if (strongBox && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
          setIsStrongBoxBacked(true)
        }
      }
      .build()

    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
      .apply { init(spec) }
      .generateKey()
  } catch (e: Exception) {
    // Most devices have no StrongBox; that attempt failing is expected and the
    // caller retries without it. A failure without StrongBox is real, and the
    // null propagates to the throw above.
    if (strongBox) null else throw e
  }

  private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun decode(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)
}
