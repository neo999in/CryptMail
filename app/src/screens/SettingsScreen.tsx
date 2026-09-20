/**
 * Settings.
 *
 * One group of rows, each a destination that exists. Copilot and Calendar are
 * not built, so they are not drawn — a settings screen full of rows that do
 * nothing is how a product stops being trusted about the rows that do.
 *
 * This is also where the old account sheet's scattered entries landed. Keys,
 * recovery and sign-out are all reachable from one place now, with the mailbox
 * switcher living in the drawer rail where switching is fast. Drafts, Scheduled
 * and Contacts are not repeated here: they are home-screen destinations, and
 * the drawer has them.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LOCK_TIMEOUT_LABEL } from '../applock/appLock';
import { cryptoMode } from '../config';
import { BIOMETRIC_NAME } from '../lib/biometrics';
import { back, RootStackParamList } from '../navigation';
import { NOTIFICATION_PREVIEW_LABEL } from '../notifications/policy';
import { useApp } from '../state/AppState';
import { accountLabel } from '../store/accountScope';
import { SWIPE_ACTION_LABEL } from '../swipe/swipe';
import { color, space, type } from '../theme';
import { useAppearance } from '../ui/appearance';
import { useAppLock } from '../ui/appLock';
import { confirmDialog } from '../ui/dialog';
import { IconName } from '../ui/Icon';
import { useMailPrefs } from '../ui/mailPrefs';
import { Group, GroupHeading, IconButton, SettingsRow } from '../ui/primitives';
import { CAPITALISED_DENSITY, THEME_LABEL } from './AppearanceScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

type Row = {
  icon: IconName;
  label: string;
  value?: string;
  onPress: () => void;
  tint?: string;
};

export function SettingsScreen({ navigation }: Props) {
  const { session, accounts, activeAccount, unified, signOut, notificationPrefs } = useApp();
  const { auroraColors, density, theme } = useAppearance();
  const { swipeLeft, swipeRight } = useMailPrefs();
  const appLock = useAppLock();
  const insets = useSafeAreaInsets();

  /** What to call the mailbox in front on the Accounts row. */
  const active = accounts.find((a) => a.id === activeAccount);
  const inFront = active ? accountLabel(active) : (session?.email ?? '');

  const confirmSignOut = () =>
    confirmDialog('Sign out?', 'Your keys stay on this device. You can reconnect the same mailbox any time.', [
      { label: 'Cancel' },
      { label: 'Sign out', tone: 'destructive', onPress: () => void signOut() },
    ]);

  const groups: { heading: string; rows: Row[] }[] = useMemo(
    () => [
      {
        heading: 'General',
        rows: [
          {
            icon: 'user',
            label: 'Accounts',
            // The user's own name for the mailbox, like everywhere else that
            // names one. Falls back to the address, which is what
            // `accountLabel` does when nothing has been chosen.
            // While merged no mailbox is in front, so only the count is said.
            value:
              accounts.length > 1
                ? unified
                  ? `${accounts.length} mailboxes`
                  : `${accounts.length} mailboxes · ${inFront} active`
                : inFront,
            // Switching still lives in the drawer rail, which is one gesture
            // from the inbox. This is the other half: naming a mailbox, what it
            // may fetch, how far back it syncs, and what it has left here.
            onPress: () => navigation.navigate('Accounts'),
          },
          {
            icon: 'mail',
            label: 'Mail',
            // Behaviour, not looks — Display & Appearance keeps the latter.
            // Today that is the swipe gestures, said here so the current setup
            // reads without opening either screen.
            value: `Swipe: ${SWIPE_ACTION_LABEL[swipeLeft]} left · ${SWIPE_ACTION_LABEL[swipeRight]} right`,
            onPress: () => navigation.navigate('Mail'),
          },
          {
            icon: 'bell',
            label: 'Notifications',
            // The level's own title — "Private", "Sender and subject", "Off".
            value: NOTIFICATION_PREVIEW_LABEL[notificationPrefs.preview].title,
            onPress: () => navigation.navigate('Notifications'),
          },
          {
            icon: 'lock',
            label: 'App lock',
            // "Off" is said, not left blank: an unlocked mail app is a choice
            // worth seeing on the way past.
            value: appLock.enabled
              ? [
                  'PIN',
                  appLock.biometrics ? BIOMETRIC_NAME[appLock.biometricKind] : null,
                  LOCK_TIMEOUT_LABEL[appLock.timeout].toLowerCase(),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Off',
            onPress: () => navigation.navigate('AppLock'),
          },
          {
            icon: 'palette',
            label: 'Display & Appearance',
            // The reference's own idea, and a good one: the current state reads
            // without opening the screen.
            value: `${THEME_LABEL[theme]} / ${auroraColors.name} / ${CAPITALISED_DENSITY[density]}`,
            onPress: () => navigation.navigate('Appearance'),
          },
          {
            icon: 'key',
            label: 'Keys and fingerprints',
            value: cryptoMode === 'demo' ? 'Demo crypto — nothing is really encrypted' : undefined,
            onPress: () => navigation.navigate('Keys'),
          },
          { icon: 'shield', label: 'Key recovery', onPress: () => navigation.navigate('Recovery') },
          { icon: 'forward', label: 'Move to a new phone', onPress: () => navigation.navigate('Transfer') },
          { icon: 'shield', label: 'Quantum Key Manager', onPress: () => navigation.navigate('KeyManager') },
          { icon: 'signout', label: 'Sign out', onPress: confirmSignOut, tint: color.coral },
        ],
      },
    ],
    // `confirmSignOut` closes over `signOut` only, which is stable for the life
    // of the app — see the note on the actions `useApp()` exposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      accounts.length,
      appLock.biometricKind,
      appLock.biometrics,
      appLock.enabled,
      appLock.timeout,
      auroraColors.name,
      density,
      inFront,
      navigation,
      notificationPrefs.preview,
      swipeLeft,
      swipeRight,
      theme,
      unified,
    ],
  );

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Settings</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        showsVerticalScrollIndicator={false}
      >
        {groups.map((group) => (
          <View key={group.heading}>
            <GroupHeading>{group.heading}</GroupHeading>
            <Group>
              {group.rows.map((row) => (
                <SettingsRow
                  key={row.label}
                  icon={row.icon}
                  label={row.label}
                  onPress={row.onPress}
                  tint={row.tint}
                  value={row.value}
                />
              ))}
            </Group>
          </View>
        ))}
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

});
