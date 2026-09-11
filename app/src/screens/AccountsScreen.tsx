/**
 * The mailboxes connected on this device.
 *
 * The rail in the drawer is where you *switch*; this is where you manage. They
 * are different actions with different frequencies — switching happens dozens of
 * times a day and must stay one gesture from the inbox, while renaming a mailbox
 * or clearing its cache happens once. Until this screen existed the only way to
 * remove an account was a long-press on a rail avatar, which is a destructive
 * action behind an unlabelled gesture; that now lives on the detail screen under
 * a heading that says what it does.
 *
 * There is deliberately **no "All accounts" control here.** Merging has exactly
 * one, the rail's Home circle — two controls for one setting is the mistake the
 * accent swatches already taught this codebase.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { providerName } from '../auth';
import { signInProviders } from '../config';
import { initials } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { accountLabel, settingsOf } from '../store/accountScope';
import { color, space, type } from '../theme';
import { Avatar, Group, GroupHeading, IconButton, PressableRow, SettingsRow } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Accounts'>;

export function AccountsScreen({ navigation }: Props) {
  const { accounts, activeAccount, needsReauth, unified, addAccount } = useApp();
  const insets = useSafeAreaInsets();

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
        <Text style={s.title}>Accounts</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        showsVerticalScrollIndicator={false}
      >
        <GroupHeading>Mailboxes</GroupHeading>
        <Group>
          {accounts.map((account) => {
            // Three facts, and the row says whichever applies rather than
            // colouring the avatar: a mailbox that cannot sync is the one thing
            // someone comes to this screen to find out. While merged no mailbox
            // is "in front", and which one sends is the compose From picker's
            // to say, so every healthy row reads the same.
            const stale = needsReauth.includes(account.id);
            const active = account.id === activeAccount;
            const paused = settingsOf(account).paused;
            const state = stale
              ? 'Needs you to sign in again'
              : paused
                ? 'Not syncing'
                : active && !unified
                  ? 'In front'
                  : 'Connected';
            const label = accountLabel(account);
            return (
              <PressableRow
                accessibilityLabel={`${label}, ${account.email}. ${state}`}
                accessibilityRole="button"
                key={account.id}
                onPress={() => navigation.navigate('Account', { id: account.id })}
                style={s.row}
              >
                <Avatar
                  label={initials(label)}
                  mode={settingsOf(account).avatar}
                  photo={account.photo}
                  seed={account.email}
                  size={40}
                />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={s.name}>
                    {label}
                  </Text>
                  {/* The address, but only when it is not already the line
                      above it. A mailbox with no display name and no name from
                      the provider falls back to its address, and printing it
                      twice reads as a rendering fault rather than as detail. */}
                  {label !== account.email ? (
                    <Text numberOfLines={1} style={s.address}>
                      {account.email}
                    </Text>
                  ) : null}
                </View>
                <Text style={[s.state, (stale || paused) && { color: color.inkDim }]}>{state}</Text>
              </PressableRow>
            );
          })}
          {/* One row per provider this build can reach, named only when there
              is more than one — a lone "Add account" needs no qualifier. */}
          {signInProviders.map((provider) => (
            <SettingsRow
              icon="plus"
              key={provider}
              label={signInProviders.length > 1 ? `Add ${providerName(provider)} account` : 'Add account'}
              onPress={() => void addAccount(provider)}
            />
          ))}
        </Group>

        <Text style={s.footnote}>
          Every mailbox keeps its own keys, drafts and decrypted mail on this device. Switching between
          them is the rail in the drawer.
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

  row: { alignItems: 'center', flexDirection: 'row', gap: space.md, padding: space.md },
  name: { ...type.settingsRow, color: color.ink },
  address: { ...type.settingsValue, color: color.inkDim },
  state: { ...type.small, color: color.inkFaint },

  footnote: {
    ...type.small,
    color: color.inkFaint,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
});
