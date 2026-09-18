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
 * The task is registered only while the outbox holds something. With nothing
 * waiting there is no work, and a pass is not free — it unseals storage and
 * asks the provider for a token — so an empty outbox costs no wake-ups at all.
 *
 * Both libraries are required lazily, behind the platform check: the web build
 * has no background execution, and jest has no native binary.
 */
import { Platform } from 'react-native';

import { runBackgroundPass } from './pass';

export const SCHEDULER_TASK = 'cryptmail.scheduler';

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
      if (result.status === 'ran' && result.waiting === 0) await setBackgroundSchedule(false);
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
