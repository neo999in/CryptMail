/**
 * Persistence for new-mail notifications: one ledger per mailbox, and the
 * device's notification preferences.
 *
 * The **ledger** (`notifications/newMail.ts`) is ids and one timestamp — which
 * messages this device has already looked at, and which are counted by the
 * notification on the shade. Keyed by account like every mailbox store, since
 * an id only means anything inside its own mailbox, and listed in
 * `PER_ACCOUNT_STORE_KEYS` so removing the account removes it.
 *
 * It is written for whichever mailbox a sync listed, not only the one in front:
 * a merged inbox and the background check both observe several at once, and
 * each row already names its account. That is the one way this store differs
 * from the others, and it is why the account is always passed explicitly.
 *
 * The **preferences** are global, like appearance: what a lock screen may show
 * is a property of the device in the user's hand, not of a mailbox. Whether a
 * given mailbox notifies at all is on its registry ref (`AccountSettings.notify`).
 */
import { EMPTY_LEDGER, NOTIFY_SCOPES, NotifyLedger, NotifyScope } from '../notifications/newMail';
import { DEFAULT_NOTIFICATION_PREVIEW, NOTIFICATION_PREVIEWS, NotificationPreview } from '../notifications/policy';
import { AccountId } from './accountScope';
import { loadJson, loadScopedJson, saveJson, saveScopedJson } from './secureJson';

export const NOTIFY_STORE_KEY = 'cryptmail.notify.v1';
export const NOTIFY_PREFS_STORE_KEY = 'cryptmail.notifyprefs.v1';

export type NotificationPrefs = {
  /** What a notification may reveal (`policy.ts`). `off` posts nothing. */
  preview: NotificationPreview;
  /** Which inbox mail is announced. */
  scope: NotifyScope;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  preview: DEFAULT_NOTIFICATION_PREVIEW,
  scope: 'primary',
};

/** Anything off disk, made valid field by field. */
export function normaliseNotificationPrefs(value: Partial<NotificationPrefs> | null | undefined): NotificationPrefs {
  return {
    preview:
      value?.preview && NOTIFICATION_PREVIEWS.includes(value.preview)
        ? value.preview
        : DEFAULT_NOTIFICATION_PREFS.preview,
    scope: value?.scope && NOTIFY_SCOPES.includes(value.scope) ? value.scope : DEFAULT_NOTIFICATION_PREFS.scope,
  };
}

export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  return normaliseNotificationPrefs(
    await loadJson<Partial<NotificationPrefs>>(NOTIFY_PREFS_STORE_KEY, DEFAULT_NOTIFICATION_PREFS),
  );
}

export async function saveNotificationPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs> {
  const next = normaliseNotificationPrefs(prefs);
  await saveJson(NOTIFY_PREFS_STORE_KEY, next);
  return next;
}

export async function loadLedger(account: AccountId): Promise<NotifyLedger> {
  const stored = await loadScopedJson<Partial<NotifyLedger>>(NOTIFY_STORE_KEY, account, EMPTY_LEDGER);
  return {
    since: typeof stored?.since === 'string' ? stored.since : null,
    seen: Array.isArray(stored?.seen) ? stored.seen.filter((id) => typeof id === 'string') : [],
    pending: Array.isArray(stored?.pending) ? stored.pending.filter((id) => typeof id === 'string') : [],
  };
}

export async function saveLedger(account: AccountId, ledger: NotifyLedger): Promise<void> {
  await saveScopedJson(NOTIFY_STORE_KEY, account, ledger);
}
