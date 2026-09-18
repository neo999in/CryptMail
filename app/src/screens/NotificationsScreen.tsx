/**
 * Settings → Notifications.
 *
 * What a new-mail notification may say, which mail it is for, and which
 * mailboxes post one. The words for each level come from
 * `notifications/policy.ts`, where the rules they describe are enforced, so the
 * screen cannot promise something the policy does not do.
 *
 * The promise about *when* is stated plainly at the bottom: with no push relay,
 * a closed app hears about new mail when the OS next wakes it, which is every
 * fifteen minutes at best.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { AppState as OsAppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { back, RootStackParamList } from '../navigation';
import { NOTIFY_SCOPE_LABEL, NOTIFY_SCOPES, NotifyScope } from '../notifications/newMail';
import type { PermissionStatus } from '../notifications/os';
import { NOTIFICATION_PREVIEW_LABEL, NOTIFICATION_PREVIEWS } from '../notifications/policy';
import { useApp } from '../state/AppState';
import { accountLabel, settingsOf } from '../store/accountScope';
import { color, space, type } from '../theme';
import { useAccent } from '../ui/appearance';
import { Icon } from '../ui/Icon';
import { Group, GroupHeading, IconButton, PressableRow, Segmented, SettingsRow, Toggle } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Notifications'>;

const PERMISSION_TEXT: Record<PermissionStatus, string> = {
  granted: 'Allowed',
  undetermined: 'Not allowed yet — tap to allow',
  denied: 'Blocked in system settings — tap to open them',
  unsupported: 'Not available on this platform',
};

export function NotificationsScreen({ navigation }: Props) {
  const {
    accounts,
    notificationPermission,
    notificationPrefs,
    requestNotificationPermission,
    setNotificationPrefs,
    updateAccount,
  } = useApp();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const [permission, setPermission] = useState<PermissionStatus | null>(null);

  const readPermission = useCallback(() => {
    void notificationPermission().then(setPermission);
  }, [notificationPermission]);

  // Read on open, and again on coming back from the system settings screen
  // the Blocked row sends the user to.
  useEffect(() => {
    readPermission();
    const subscription = OsAppState.addEventListener('change', (next) => {
      if (next === 'active') readPermission();
    });
    return () => subscription.remove();
  }, [readPermission]);

  const unsupported = permission === 'unsupported';
  const off = notificationPrefs.preview === 'off';

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Notifications</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        showsVerticalScrollIndicator={false}
      >
        <GroupHeading>This device</GroupHeading>
        <Group>
          <SettingsRow
            icon="bell"
            label="System permission"
            onPress={() => {
              if (permission === 'granted' || unsupported) return;
              void requestNotificationPermission().then(setPermission);
            }}
            tint={permission === 'denied' ? color.coral : undefined}
            value={permission ? PERMISSION_TEXT[permission] : ' '}
          />
        </Group>

        <GroupHeading>What notifications show</GroupHeading>
        <Group>
          {NOTIFICATION_PREVIEWS.map((preview) => {
            const selected = notificationPrefs.preview === preview;
            const { title, detail } = NOTIFICATION_PREVIEW_LABEL[preview];
            return (
              <PressableRow
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                key={preview}
                onPress={() => void setNotificationPrefs({ preview })}
                style={s.choice}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.choiceLabel}>{title}</Text>
                  <Text style={s.choiceDetail}>{detail}</Text>
                </View>
                {selected ? <Icon color={accent} name="check" size={20} /> : <View style={s.checkSpace} />}
              </PressableRow>
            );
          })}
        </Group>
        <Text style={s.note}>
          The lock screen only ever says that mail arrived. Encrypted mail names its sender only after it has been
          opened on this device.
        </Text>

        <GroupHeading>Notify me about</GroupHeading>
        <Group>
          <View style={s.pad}>
            <Segmented<NotifyScope>
              onChange={(scope) => void setNotificationPrefs({ scope })}
              options={NOTIFY_SCOPES.map((key) => ({ key, label: NOTIFY_SCOPE_LABEL[key] }))}
              stretch
              value={notificationPrefs.scope}
            />
            <Text style={s.hint}>
              Primary leaves out Gmail&apos;s Promotions, Social, Updates and Forums tabs. Encrypted mail is always
              Primary, since the provider cannot read it to sort it.
            </Text>
          </View>
        </Group>

        <GroupHeading>Mailboxes</GroupHeading>
        <Group>
          {accounts.map((ref) => {
            const settings = settingsOf(ref);
            const label = accountLabel(ref);
            return (
              <SettingsRow
                icon="mail"
                key={ref.id}
                label={label}
                onPress={() => void updateAccount(ref.id, { notify: !settings.notify })}
                trailing={
                  <Toggle
                    disabled={off}
                    label={`Notifications for ${label}`}
                    on={settings.notify && !off}
                    onChange={(next) => void updateAccount(ref.id, { notify: next })}
                  />
                }
                value={settings.paused ? 'Paused — nothing is synced, so nothing is announced' : ref.email}
              />
            );
          })}
        </Group>

        <Text style={s.note}>
          While CryptMail is closed, Android wakes it to check for new mail about every 15 minutes, when it chooses
          to — not the moment mail arrives. Opening the app checks at once. Nothing is announced for mail you are
          already looking at.
        </Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  topbar: {
    alignItems: 'center',
    backgroundColor: color.surface,
    flexDirection: 'row',
    gap: space.sm,
    paddingBottom: space.md,
    paddingHorizontal: space.md,
  },
  title: { ...type.display, color: color.ink },

  // The measure of `SettingsRow`, so a choice sits in a group like a row does.
  choice: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  choiceLabel: { ...type.settingsRow, color: color.ink },
  choiceDetail: { ...type.settingsValue, color: color.inkDim, marginTop: 2 },
  checkSpace: { width: 20 },

  pad: { gap: space.sm, padding: space.md },
  hint: { ...type.small, color: color.inkFaint },
  note: { ...type.small, color: color.inkFaint, paddingHorizontal: space.lg + 2, paddingTop: space.sm },
});
