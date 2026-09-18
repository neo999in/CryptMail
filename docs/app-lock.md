# App lock

A PIN in front of the app, an optional fingerprint (or face) in front of the
PIN, and a timeout for how soon it asks again. Settings → App lock.

## What it is, and what it is not

The lock hides CryptMail from someone holding the phone while it is unlocked.
It is a **gate in front of the UI**, not a layer of encryption:

- Local data is sealed under the keystore's device key
  ([security.md](security.md), `store/localCrypto.ts`) whether the lock is on
  or not. The PIN does not wrap that key, so while CryptMail is running the key
  is in memory behind the lock screen, as it is without one.
- It does not stop someone who can read or write the app's storage — the same
  line `localCrypto.ts` already draws. Deleting the lock's store turns the lock
  off; that needs filesystem access the lock never claimed to resist.
- Notifications are governed by their own setting
  ([features.md](features.md) 0.10). The App lock screen says so and points at
  *Private*.
- Recent-apps thumbnails are not hidden (that needs `FLAG_SECURE`, which also
  blocks screenshots — a separate choice not made here).

Tying the PIN to the key — so a locked app genuinely cannot decrypt its stores —
is possible later, and belongs with the Rust core's own passphrase handling
rather than here.

## The rules

All in [`applock/appLock.ts`](../app/src/applock/appLock.ts), pure and tested.

| Rule | Value |
|---|---|
| PIN | 4 to 8 ASCII digits |
| Stored as | PBKDF2-SHA256, random 16-byte salt, 1 000 rounds, in the sealed store `cryptmail.applock.v1`. Few on purpose: 30 000 held every unlock for 1–2 s in Hermes, and a 4-digit PIN is ten thousand guesses either way once the device key is had — the cooldown is the defence. The count is stored per verifier; one made with another count is re-made on its next successful unlock |
| PIN length | stored, so the unlock pad checks as soon as that many digits are in |
| Wrong PINs | five free, then a 30 s wait, doubling per further miss, capped at an hour. The count and the wait are stored, so killing the app does not reset them |
| Fingerprint | Android Class 3 (**strong**) biometrics only; the device's own PIN/pattern is not offered as a fallback — CryptMail's PIN is. Turning it on needs a successful scan. A successful scan clears the PIN cooldown |
| Locks | on launch; on returning after at least the timeout in the background (Immediately, 1, 5, 15 or 60 min); on *Lock now* |
| Does not lock | returning from something CryptMail opened itself — file picker, share sheet, Google/Microsoft sign-in, the biometric prompt — if the trip took under 5 minutes ([`lib/lockExemption.ts`](../app/src/lib/lockExemption.ts)) |
| Clock went backwards | locks |
| Turning off / changing the PIN | asks for the current PIN first, and counts misses towards the same cooldown |

The store is global, not per-account — the lock is in front of every mailbox —
so it is in `SEALED_STORE_KEYS` and deliberately **not** in
`PER_ACCOUNT_STORE_KEYS`.

## Forgotten PIN

There is no reset from the lock screen: one would let anyone holding the phone
past the lock. Clearing CryptMail's storage in the system app settings removes
the lock along with every mailbox, key and draft on the device; the key comes
back from its recovery code. The lock screen and the settings screen both say
so.

## Where the code is

| | |
|---|---|
| [`applock/appLock.ts`](../app/src/applock/appLock.ts) | the rules: verifier, cooldown, timeout decision, normalising what is read back |
| [`store/appLockStore.ts`](../app/src/store/appLockStore.ts) | sealed persistence |
| [`lib/biometrics.ts`](../app/src/lib/biometrics.ts) | the only module that touches `expo-local-authentication` |
| [`lib/lockExemption.ts`](../app/src/lib/lockExemption.ts) | `whileAway()` around the calls that leave the app on purpose |
| [`ui/appLock.tsx`](../app/src/ui/appLock.tsx) | `AppLockProvider` / `useAppLock()` — live state and actions, a sibling of `AppState`'s provider like `mailPrefs` |
| [`ui/appLockGate.tsx`](../app/src/ui/appLockGate.tsx) | the lock screen: a `Modal`, so it also covers an open sheet or dialog. The app underneath stays mounted, so a half-written reply survives |
| [`ui/pinPad.tsx`](../app/src/ui/pinPad.tsx) | the pad, shared by the lock screen and settings |
| [`screens/AppLockScreen.tsx`](../app/src/screens/AppLockScreen.tsx) | Settings → App lock |

A new call that hands the screen to another app on the user's behalf should go
through `whileAway()`, or it will bring the lock down on return with the
timeout at *Immediately*.

## Not yet verified on a device

Written against the SDK 57 docs and typechecked; the unit tests cover the rules.
On a device, still to check: which of the pickers and the biometric prompt
actually report `background` on Android 14+, and that the lock `Modal` lands
above a `Sheet` that was open when the app left.
