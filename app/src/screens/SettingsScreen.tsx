/**
 * Settings.
 *
 * Two groups of rows, each a destination that exists. Copilot, Calendar and
 * Contacts are not built, so they are not drawn — a settings screen full of
 * rows that do nothing is how a product stops being trusted about the rows
 * that do.
 *
 * This is also where the old account sheet's scattered entries landed. Keys,
 * recovery, drafts, scheduled and sign-out are all reachable from one place now,
 * with the mailbox switcher living in the drawer rail where switching is fast.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cryptoMode } from '../config';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { color, space, type } from '../theme';
import { useAppearance } from '../ui/appearance';
import { Destination, useDestination } from '../ui/destination';
import { confirmDialog } from '../ui/dialog';
import { IconName } from '../ui/Icon';
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
  const { session, accounts, signOut } = useApp();
  const { auroraColors, density, theme } = useAppearance();
  const { setDestination } = useDestination();
  const insets = useSafeAreaInsets();

  /** Drafts and Scheduled are destinations on the home screen, not routes. */
  const go = (destination: Destination) => {
    setDestination(destination);
    navigation.navigate('Home');
  };

  const confirmSignOut = () =>
    confirmDialog('Sign out?', 'Your keys stay on this device. You can reconnect the same mailbox any time.', [
      { label: 'Cancel' },
      { label: 'Sign out', tone: 'destructive', onPress: () => void signOut() },
    ]);

  const groups: { heading: string; rows: Row[] }[] = useMemo(
    () => [
      {
        heading: 'Quick Settings',
        rows: [
          {
            icon: 'palette',
            label: 'Display & Appearance',
            // The reference's own idea, and a good one: the current state reads
            // without opening the screen.
            value: `${THEME_LABEL[theme]} / ${auroraColors.name} / ${CAPITALISED_DENSITY[density]}`,
            onPress: () => navigation.navigate('Appearance'),
          },
          // Destinations on the home screen, not screens — so these send you
          // back to it with that destination selected (`ui/destination.tsx`).
          { icon: 'edit', label: 'Drafts', onPress: () => go('drafts') },
          { icon: 'clock', label: 'Scheduled', onPress: () => go('scheduled') },
        ],
      },
      {
        heading: 'General',
        rows: [
          {
            icon: 'user',
            label: 'Accounts',
            value:
              accounts.length > 1
                ? `${accounts.length} mailboxes · ${session?.email ?? ''} in front`
                : (session?.email ?? ''),
            // Switching lives in the drawer rail, which is one gesture from the
            // inbox; this row is how someone who came looking here finds it.
            onPress: () => navigation.navigate('Home'),
          },
          {
            icon: 'key',
            label: 'Keys and fingerprints',
            value: cryptoMode === 'demo' ? 'Demo crypto — nothing is really encrypted' : undefined,
            onPress: () => navigation.navigate('Keys'),
          },
          { icon: 'shield', label: 'Key recovery', onPress: () => navigation.navigate('Recovery') },
          { icon: 'signout', label: 'Sign out', onPress: confirmSignOut, tint: color.coral },
        ],
      },
    ],
    // `confirmSignOut` closes over `signOut` only, which is stable for the life
    // of the app — see the note on the actions `useApp()` exposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts.length, auroraColors.name, density, navigation, session?.email, setDestination, theme],
  );

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
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
