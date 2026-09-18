package app.cryptmail.device

import android.app.KeyguardManager
import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The `CryptMailDevice` native module: whether the device is locked right now.
 *
 * `app/src/notifications/os.ts` asks this before posting a notification that
 * names a sender or a subject (policy rule 4 in
 * `app/src/notifications/policy.ts`). JavaScript has no way to know, and the
 * answer when it cannot find out — this module missing, or no context — is
 * *locked*, so the failure mode is a generic notification, never a detailed
 * one on a lock screen.
 */
class CryptMailDeviceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CryptMailDevice")

    Function("isDeviceLocked") {
      val keyguard = appContext.reactContext?.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      keyguard?.isDeviceLocked ?: true
    }
  }
}
