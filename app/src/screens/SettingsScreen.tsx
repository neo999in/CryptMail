/**
 * Settings.
 *
 * A search field over two groups, matching the reference's shape. What it does
 * *not* match is its contents: every row here is a destination that exists.
 * Copilot, Calendar and Contacts are not built, so they are not drawn — a
 * settings screen full of rows that do nothing is how a product stops being
 * trusted about the rows that do.
 *
 * This is also where the old account sheet's scattered entries landed. Keys,
 * recovery, drafts, scheduled and sign-out are all reachable from one place now,
 * with the mailbox switcher living in the drawer rail where switching is fast.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cryptoMode } from '../config';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { color, font, space, type } from '../theme';
import { useAppearance } from '../ui/appearance';
import { Icon, IconName } from '../ui/Icon';
import {
  Field,
  GroupHeading,
  IconButton,
  Input,
  SettingsRow,
  useFocus,
} from '../ui/primitives';
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
  const { accent, density, theme } = useAppearance();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const search = useFocus();

  const confirmSignOut = () =>
    Alert.alert('Sign out?', 'Your keys stay on this device. You can reconnect the same mailbox any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
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
            value: `${THEME_LABEL[theme]} / ${capitalise(accent)} / ${CAPITALISED_DENSITY[density]}`,
            onPress: () => navigation.navigate('Appearance'),
          },
          { icon: 'edit', label: 'Drafts', onPress: () => navigation.navigate('Drafts') },
          { icon: 'clock', label: 'Scheduled', onPress: () => navigation.navigate('Scheduled') },
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
    [accent, accounts.length, density, navigation, session?.email, theme],
  );

  /**
   * Filtering matches the label and the value line, so typing "dark" or an
   * address finds the row that mentions it, not just the one titled it.
   */
  const term = query.trim().toLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter(
        (row) =>
          term.length === 0 ||
          row.label.toLowerCase().includes(term) ||
          (row.value ?? '').toLowerCase().includes(term),
      ),
    }))
    .filter((group) => group.rows.length > 0);

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
        <Text style={s.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }} keyboardShouldPersistTaps="handled">
        <Field focused={search.focused} style={s.searchField}>
          <View style={s.searchRow}>
            <Icon name="search" size={18} color={color.inkFaint} />
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setQuery}
              placeholder="Search"
              style={s.searchInput}
              value={query}
              {...search.bind}
            />
          </View>
        </Field>

        {shown.map((group) => (
          <View key={group.heading}>
            <GroupHeading>{group.heading}</GroupHeading>
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
          </View>
        ))}

        {shown.length === 0 ? <Text style={s.noMatch}>Nothing in settings matches “{query.trim()}”.</Text> : null}
      </ScrollView>
    </View>
  );
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
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

  searchField: { marginHorizontal: space.md, marginTop: space.md, paddingVertical: 13 },
  searchRow: { alignItems: 'center', flexDirection: 'row', gap: space.md },
  searchInput: { flex: 1, fontSize: 16 },

  noMatch: {
    ...type.body,
    color: color.inkFaint,
    fontFamily: font.sans,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    textAlign: 'center',
  },
});
