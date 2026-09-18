/**
 * The OS side of new-mail notifications — the only file that touches
 * `expo-notifications` or the `CryptMailDevice` lock check.
 *
 * Everything that decides *what* to post lives elsewhere and is pure
 * (`policy.ts`, `newMail.ts`); this file only carries a decided plan to the
 * shade. It is an interface so the service that uses it (`state/notify.ts`)
 * can be tested against a fake.
 *
 * ## Two channels, so the lock screen never gets more than the policy allows
 *
 * `expo-notifications` cannot set Android's `publicVersion`, the redacted copy
 * a lock screen would show in place of a detailed notification. So the split is
 * made with channels instead:
 *
 * - `mail` carries **generic** notifications ("CryptMail · 2 new messages")
 *   and is `PUBLIC` — there is nothing in one to hide.
 * - `mail-detail` carries notifications that **name a sender or subject**, and
 *   is `SECRET`: a secure lock screen does not show them at all. A detailed
 *   notification is only ever built while the device is unlocked (policy rule
 *   4), and this is what keeps it off the lock screen once the phone locks
 *   again — whatever the user's system-wide "sensitive content" setting says.
 *
 * Library and native module are required lazily and behind the platform check:
 * the web build has no notifications here, and jest has no native binary.
 */
import { AppState, Linking, Platform } from 'react-native';

import { NotificationText } from './policy';

/**
 * What a tap on a notification — or on one of its buttons — asks for.
 *
 * `messageIds` is every message the notification counted, which is what its
 * Mark read button marks; `messageId` is set only when that is exactly one,
 * the only case that opens a message or offers Reply.
 */
export type NotificationTap = {
  account: string;
  messageId?: string;
  messageIds?: string[];
  action?: NotificationAction;
};

/** `open` is the body of the notification; the others are its buttons. */
export type NotificationAction = 'open' | 'reply' | 'mark-read';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export type OsNotifier = {
  /** Whether this platform can post at all. */
  readonly supported: boolean;
  /**
   * Post, or replace, the one notification `key` names.
   *
   * `detailed` routes it to the channel the lock screen never shows.
   */
  post(key: string, text: NotificationText, detailed: boolean, tap: NotificationTap): Promise<void>;
  dismiss(key: string): Promise<void>;
  /** True unless the device is known to be unlocked right now. */
  deviceLocked(): boolean;
  /** True while CryptMail is on screen. */
  foreground(): boolean;
};

const supported = Platform.OS === 'android' || Platform.OS === 'ios';

type NotificationsLib = typeof import('expo-notifications');
type DeviceModule = { isDeviceLocked(): boolean };

function lib(): NotificationsLib | null {
  if (!supported) return null;
  try {
    return require('expo-notifications') as NotificationsLib;
  } catch {
    return null;
  }
}

function deviceModule(): DeviceModule | null {
  if (Platform.OS !== 'android') return null;
  try {
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    return requireOptionalNativeModule<DeviceModule>('CryptMailDevice');
  } catch {
    return null;
  }
}

const GENERIC_CHANNEL = 'mail';
const DETAIL_CHANNEL = 'mail-detail';

/**
 * The buttons. One message gets Mark read and Reply, as in Gmail; several get
 * Mark all read — a reply to "3 new messages" has no one to go to.
 *
 * Mark read runs **without opening the app** (`opensAppToForeground: false`),
 * so it can be pressed from the lock screen, like Gmail's. It marks mail read
 * and nothing else: it reveals nothing, and nothing it does is irreversible.
 * Reply opens the app, so the OS asks for the unlock first.
 */
const ONE_CATEGORY = 'cryptmail.mail.one';
const MANY_CATEGORY = 'cryptmail.mail.many';
const MARK_READ = 'mark-read';
const REPLY = 'reply';

let channels: Promise<void> | null = null;

/** Create the channels and button sets once per process. The OS keeps them; re-creating is harmless. */
function ensureChannels(n: NotificationsLib): Promise<void> {
  channels ??= (async () => {
    await n.setNotificationCategoryAsync(ONE_CATEGORY, [
      { identifier: MARK_READ, buttonTitle: 'Mark read', options: { opensAppToForeground: false } },
      { identifier: REPLY, buttonTitle: 'Reply', options: { opensAppToForeground: true } },
    ]);
    await n.setNotificationCategoryAsync(MANY_CATEGORY, [
      { identifier: MARK_READ, buttonTitle: 'Mark all read', options: { opensAppToForeground: false } },
    ]);
    if (Platform.OS !== 'android') return;
    await n.setNotificationChannelAsync(GENERIC_CHANNEL, {
      name: 'New mail',
      description: 'That new mail arrived, with no sender or subject.',
      importance: n.AndroidImportance.HIGH,
      lockscreenVisibility: n.AndroidNotificationVisibility.PUBLIC,
      showBadge: true,
    });
    await n.setNotificationChannelAsync(DETAIL_CHANNEL, {
      name: 'New mail (with sender)',
      description: 'Who new mail is from. Never shown on the lock screen.',
      importance: n.AndroidImportance.HIGH,
      lockscreenVisibility: n.AndroidNotificationVisibility.SECRET,
      showBadge: true,
    });
  })().catch((e) => {
    channels = null;
    throw e;
  });
  return channels;
}

/** Identifiers are per mailbox, so each mailbox has one notification that is replaced, not stacked. */
const identifierFor = (key: string) => `cryptmail.mail.${key}`;

export const osNotifier: OsNotifier = {
  supported,

  async post(key, text, detailed, tap) {
    const n = lib();
    if (!n) return;
    try {
      await ensureChannels(n);
      await n.scheduleNotificationAsync({
        identifier: identifierFor(key),
        content: {
          title: text.title,
          body: text.body,
          data: { account: tap.account, messageId: tap.messageId, messageIds: tap.messageIds ?? [] },
          sound: 'default',
          categoryIdentifier: tap.messageId ? ONE_CATEGORY : MANY_CATEGORY,
        },
        trigger: Platform.OS === 'android' ? { channelId: detailed ? DETAIL_CHANNEL : GENERIC_CHANNEL } : null,
      });
    } catch (e) {
      // Permission refused, or the OS said no: there is nothing the user can
      // act on in a background pass, and the mail itself is unaffected.
      console.warn('Could not post a notification', e);
    }
  },

  async dismiss(key) {
    const n = lib();
    if (!n) return;
    try {
      await n.dismissNotificationAsync(identifierFor(key));
    } catch {
      // Nothing on the shade to dismiss.
    }
  },

  deviceLocked() {
    const device = deviceModule();
    if (!device) return true;
    try {
      return device.isDeviceLocked();
    } catch {
      return true;
    }
  },

  foreground() {
    return AppState.currentState === 'active';
  },
};

/* ----------------------------------------------------------- permission ---- */

export async function notificationPermission(): Promise<PermissionStatus> {
  const n = lib();
  if (!n) return 'unsupported';
  try {
    const status = await n.getPermissionsAsync();
    if (status.granted) return 'granted';
    return status.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/** Ask the OS. Where it will no longer ask, send the user to the app's system settings. */
export async function requestNotificationPermission(): Promise<PermissionStatus> {
  const n = lib();
  if (!n) return 'unsupported';
  const current = await notificationPermission();
  if (current === 'granted') return current;
  if (current === 'denied') {
    await Linking.openSettings().catch(() => undefined);
    return current;
  }
  try {
    await ensureChannels(n).catch(() => undefined);
    const status = await n.requestPermissionsAsync();
    return status.granted ? 'granted' : status.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/* ------------------------------------------------------------------ taps ---- */

/**
 * Read a notification response back into a tap, or null if it is not ours.
 *
 * Everything in it came from `post` above, but it is read as untrusted
 * anyway: the OS hands back whatever the notification carried.
 */
export function tapFromResponse(response: unknown): NotificationTap | null {
  if (typeof response !== 'object' || response === null) return null;
  const r = response as { actionIdentifier?: unknown; notification?: { request?: { content?: { data?: unknown } } } };
  const data = r.notification?.request?.content?.data;
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.account !== 'string') return null;
  const messageIds = Array.isArray(record.messageIds)
    ? record.messageIds.filter((id): id is string => typeof id === 'string')
    : [];
  const messageId = typeof record.messageId === 'string' ? record.messageId : undefined;
  const action: NotificationAction =
    r.actionIdentifier === MARK_READ ? 'mark-read' : r.actionIdentifier === REPLY && messageId ? 'reply' : 'open';
  return { account: record.account, messageId, messageIds, action };
}

/**
 * Call `listener` for every tap on one of our notifications — including the
 * one that launched the app, if it was launched that way.
 */
export function onNotificationTap(listener: (tap: NotificationTap) => void): () => void {
  const n = lib();
  if (!n) return () => {};
  const handle = (response: unknown) => {
    const tap = tapFromResponse(response);
    if (tap) listener(tap);
  };
  let live = true;
  void n
    .getLastNotificationResponseAsync()
    .then((response) => {
      if (!live) return;
      handle(response);
      return n.clearLastNotificationResponseAsync();
    })
    .catch(() => undefined);
  const subscription = n.addNotificationResponseReceivedListener(handle);
  return () => {
    live = false;
    subscription.remove();
  };
}

/**
 * Have the OS run `taskName` for a button pressed while the app is in the
 * background or not running (Android). The task itself is defined by
 * `background/task.ts`; this only registers it with the notifications module.
 */
export async function registerNotificationActionTask(taskName: string): Promise<void> {
  const n = lib();
  if (!n || Platform.OS !== 'android') return;
  try {
    await n.registerTaskAsync(taskName);
  } catch (e) {
    console.warn('Could not register the notification action task', e);
  }
}
