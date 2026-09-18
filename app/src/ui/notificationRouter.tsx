/**
 * Opens what a tapped notification points at, and asks for permission to post.
 *
 * Mounted once, beside the navigator, and only once the user is past setup —
 * which is why the permission prompt lives here: a first launch should reach
 * its inbox before the OS asks about notifications, not be asked over the
 * key-setup screen.
 *
 * A tap — on the notification, or on its Reply button — arrives through
 * `useApp().notificationTap` (`state/notify.ts` puts it
 * there from `notifications/os.ts`). Opening it follows the rule every other
 * way into a message follows: the mailbox it belongs to is put in front first,
 * because reading and decrypting always use the active account.
 */
import { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { useEffect } from 'react';

import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';

export function NotificationRouter({
  navigation,
  ready,
}: {
  navigation: NavigationContainerRefWithCurrent<RootStackParamList>;
  /** The navigator has mounted and can take a `navigate`. */
  ready: boolean;
}) {
  const {
    accounts,
    activeAccount,
    consumeNotificationTap,
    notificationPermission,
    notificationPrefs,
    notificationTap,
    refreshInbox,
    requestNotificationPermission,
    switchAccount,
  } = useApp();

  // Asked once, in context: only while notifications are on, and only if the
  // OS has never been asked. A refusal is final here; Settings → Notifications
  // is where it can be revisited.
  const wantsPermission = notificationPrefs.preview !== 'off';
  useEffect(() => {
    if (!wantsPermission) return;
    void notificationPermission().then((status) => {
      if (status === 'undetermined') void requestNotificationPermission();
    });
  }, [notificationPermission, requestNotificationPermission, wantsPermission]);

  useEffect(() => {
    if (!notificationTap || !ready) return;
    const { account, messageId, action } = notificationTap;
    consumeNotificationTap();
    // A mailbox removed since the notification was posted has nothing to open.
    if (!accounts.some((ref) => ref.id === account)) return;

    void (async () => {
      if (account !== activeAccount) await switchAccount(account);
      // The message arrived after the list on screen was fetched, or the app
      // was launched by the tap and has only its cached list.
      await refreshInbox();
      if (!navigation.isReady()) return;
      navigation.navigate('Home');
      // Reply opens the message first: a reply is built from what this device
      // decrypted, and the message screen is the one place that does that.
      if (messageId) navigation.navigate('Message', { id: messageId, reply: action === 'reply' });
    })();
    // Only a new tap starts this; the rest are read as they are at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationTap, ready]);

  return null;
}
