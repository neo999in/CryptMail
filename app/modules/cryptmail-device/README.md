# cryptmail-device

One synchronous call, `isDeviceLocked()`, backed by Android's
`KeyguardManager.isDeviceLocked`. The notification code
([`app/src/notifications/os.ts`](../../src/notifications/os.ts)) uses it to
decide whether a notification may name a sender or subject: the privacy policy
only allows that while the device is unlocked.

Autolinked from `app/modules/` like `cryptmail-core`; a dev build picks it up
after `npx expo prebuild` / `npm run android`. Without it (web, Expo Go, an old
build) the app treats the device as locked and every notification is generic.
