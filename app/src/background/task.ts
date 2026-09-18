/**
 * The OS side of background scheduling — the only file that touches
 * `expo-task-manager` or `expo-background-task`.
 *
 * Android runs the task through WorkManager no more often than every 15
 * minutes, and at the system's discretion rather than on the minute: a
 * scheduled send made for 9:00 goes out in the first window after 9:00 in
 * which the OS wakes us, or the moment the app is opened, whichever is first.
 * That is the promise, and the UI must not make a sharper one.
 *
 * The task is registered only while there is work: the outbox holds
 * something, or new-mail notifications are on for a mailbox. A pass is not free
 * — it unseals storage and asks the provider for a token — so an empty outbox
 * with notifications off costs no wake-ups at all.
 *
 * The same 15-minute floor is the promise for notifications: new mail is
 * noticed in the first window the OS gives us, not the moment it arrives.
 * Instant delivery needs a push relay (api.md), which does not exist.
 *
 * Both libraries are required lazily, behind the platform check: the web build
 * has no background execution, and jest has no native binary.
 */
import { Platform } from 'react-native';

import { registerNotificationActionTask, tapFromResponse } from '../notifications/os';
import { runBackgroundPass, runNotificationAction } from './pass';

export const SCHEDULER_TASK = 'cryptmail.scheduler';
/** Run by `expo-notifications` for a notification button pressed with the app closed (Android). */
export const NOTIFICATION_ACTION_TASK = 'cryptmail.notification-action';

/** Minutes. WorkManager's floor; asking for less is silently rounded up. */
const INTERVAL_MINUTES = 15;

const supported = Platform.OS !== 'web';

type BackgroundTaskLib = typeof import('expo-background-task');
type TaskManagerLib = typeof import('expo-task-manager');

function libs(): { bg: BackgroundTaskLib; tm: TaskManagerLib } | null {
  if (!supported) return null;
  return {
    bg: require('expo-background-task') as BackgroundTaskLib,
    tm: require('expo-task-manager') as TaskManagerLib,
  };
}

/**
 * Define what the task does. Must run at module scope of the entry file, before
 * the root component registers: a headless launch loads the bundle but mounts
 * nothing, and looks the task up by name.
 */
export function defineSchedulerTask() {
  const l = libs();
  if (!l || l.tm.isTaskDefined(SCHEDULER_TASK)) return;
  l.tm.defineTask(SCHEDULER_TASK, async () => {
    try {
      const result = await runBackgroundPass();
      // Emptied from the background, with no app open to notice: stop waking.
      // The app re-registers it the next time something is scheduled. Only
      // after a pass that actually *ran* — a boot that failed on a flaky
      // network also comes back without a session, with the outbox untouched.
      if (result.status === 'ran' && result.waiting === 0 && !result.watching) await setBackgroundSchedule(false);
      return l.bg.BackgroundTaskResult.Success;
    } catch (e) {
      // A failed pass loses nothing: a send that threw was rescued to drafts
      // by `run()`, and anything not attempted is still in the outbox for the
      // next pass or the next launch.
      console.warn('Background scheduler pass failed', e);
      return l.bg.BackgroundTaskResult.Failed;
    }
  });
}

/**
 * Register the task while there is something to deliver, and drop it when
 * there is not.
 *
 * Failure to register is not an error the user can act on: delivery falls back
 * to what it always was, the in-app interval while CryptMail is open.
 */
export async function setBackgroundSchedule(wanted: boolean): Promise<void> {
  const l = libs();
  if (!l) return;
  try {
    const registered = await l.tm.isTaskRegisteredAsync(SCHEDULER_TASK);
    if (wanted && !registered) {
      if ((await l.bg.getStatusAsync()) !== l.bg.BackgroundTaskStatus.Available) return;
      await l.bg.registerTaskAsync(SCHEDULER_TASK, { minimumInterval: INTERVAL_MINUTES });
    } else if (!wanted && registered) {
      await l.bg.unregisterTaskAsync(SCHEDULER_TASK);
    }
  } catch (e) {
    console.warn('Could not update the background scheduler', e);
  }
}

/**
 * Define and register the task a notification button runs when CryptMail is
 * in the background or not running — Mark read, which never opens the app.
 * Like the scheduler task, it must be defined at module scope of the entry
 * file; registering it again on every launch is harmless.
 *
 * `expo-notifications` also runs this task for *received* notifications; the
 * app only ever posts local ones, and anything that is not one of our button
 * presses is ignored.
 */
export function defineNotificationActionTask() {
  const l = libs();
  if (!l) return;
  if (!l.tm.isTaskDefined(NOTIFICATION_ACTION_TASK)) {
    l.tm.defineTask(NOTIFICATION_ACTION_TASK, async ({ data }) => {
      const tap = tapFromResponse(data);
      if (!tap || tap.action !== 'mark-read') return;
      try {
        await runNotificationAction(tap);
      } catch (e) {
        // The messages stay unread and the notification stays up, so the
        // button can be pressed again.
        console.warn('Notification action failed', e);
      }
    });
  }
  void registerNotificationActionTask(NOTIFICATION_ACTION_TASK);
}
