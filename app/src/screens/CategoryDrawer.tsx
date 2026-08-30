/**
 * The navigation drawer: an account rail beside a list of destinations.
 *
 * The rail on the left is the mailbox switcher — one avatar per connected
 * account, the active one ringed in the accent, and a `+` to add another. It is
 * a faster way to exercise the rule that already holds everywhere else:
 * **exactly one account is active at a time**, and tapping a rail avatar simply
 * calls the same `switchAccount` action the account sheet used to. Merging is
 * still only a reading convenience, and it is the "All accounts" toggle at the
 * top of the panel.
 *
 * The panel on the right lists destinations that exist. The reference also shows
 * Archive, Snoozed and Deleted; CryptMail has no backing for those, so they are
 * not drawn as rows that do nothing — see docs/design/ui-rework.md.
 *
 * Counts come from `unreadCountsByCategory`, which honours the encryption
 * boundary: unopened encrypted mail is never classified from its ciphertext, so
 * it counts under Primary until the user opens it. The Junk count is the spam
 * engine's verdict plus any message the user marked themselves, which is why the
 * personal model and the marks are passed through.
 */
import { DrawerContentComponentProps, DrawerContentScrollView } from '@react-navigation/drawer';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useMemo } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Category, CATEGORIES, CATEGORY_LABELS, unreadCountsByCategory } from '../categorizer/categorizer';
import { initials } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { AccountRef } from '../store/accountScope';
import { color, font, radius, space, type } from '../theme';
import { useAccent } from '../ui/appearance';
import { Icon, IconName } from '../ui/Icon';
import { Avatar, PressableRow } from '../ui/primitives';
import { useCategoryFilter } from '../ui/inboxFilter';

const CATEGORY_ICON: Record<Category, IconName> = {
  primary: 'inbox',
  purchases: 'archive',
  bills: 'file',
  promotions: 'star',
  spam: 'junk',
};

/** Destinations that are their own screen rather than a filter on this list. */
type Destination = { icon: IconName; label: string; go: () => void };

export function CategoryDrawer({ navigation }: DrawerContentComponentProps) {
  const {
    messages,
    searchIndex,
    encryptionFor,
    spam,
    session,
    accounts,
    activeAccount,
    unified,
    switchAccount,
    addAccount,
    removeAccount,
    setUnified,
  } = useApp();
  const { category, setCategory } = useCategoryFilter();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const stack = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const counts = useMemo(() => {
    const items = messages.map((summary) => ({
      summary,
      encrypted: encryptionFor(summary).kind === 'encrypted',
    }));
    return unreadCountsByCategory(items, searchIndex, {
      model: spam.model,
      marks: spam.marks,
      selfAddress: session?.email,
    });
  }, [messages, searchIndex, encryptionFor, spam, session?.email]);

  const total = messages.filter((m) => m.unread).length;

  const choose = (next: Category | null) => {
    setCategory(next);
    navigation.closeDrawer();
  };

  const push = (screen: 'Drafts' | 'Scheduled' | 'Settings') => {
    navigation.closeDrawer();
    stack.navigate(screen);
  };

  /**
   * Removing an account erases its keyring, drafts and search index, so it asks
   * — and says so. It is a long press rather than a visible button because the
   * tap on a rail avatar means "switch to this mailbox", which is the thing
   * people do constantly and must never do this by accident.
   */
  const confirmRemove = (account: AccountRef) => {
    Alert.alert(
      `Remove ${account.email}?`,
      'This deletes its keyring, drafts and locally decrypted mail from this device. Nothing on the server is touched.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void removeAccount(account.id) },
      ],
    );
  };

  const destinations: Destination[] = [
    { icon: 'edit', label: 'Drafts', go: () => push('Drafts') },
    { icon: 'clock', label: 'Scheduled', go: () => push('Scheduled') },
  ];

  return (
    <View style={[s.drawer, { paddingTop: insets.top }]}>
      {/* ------------------------------------------------------------ rail -- */}
      <View style={s.rail}>
        {accounts.map((account) => {
          const active = account.id === activeAccount;
          return (
            <Pressable
              accessibilityLabel={`Switch to ${account.email}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              key={account.id}
              onLongPress={() => confirmRemove(account)}
              onPress={() => {
                if (!active) void switchAccount(account.id);
                navigation.closeDrawer();
              }}
              style={({ pressed }) => [
                s.railItem,
                { borderColor: active ? accent : 'transparent' },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Avatar seed={account.email} label={initials(account.email)} size={44} />
            </Pressable>
          );
        })}
        <Pressable
          accessibilityLabel="Add another account"
          accessibilityRole="button"
          onPress={() => {
            navigation.closeDrawer();
            void addAccount();
          }}
          style={({ pressed }) => [s.railAdd, pressed && { backgroundColor: color.segmentActive }]}
        >
          <Icon name="plus" size={22} color={color.inkDim} />
        </Pressable>
      </View>

      {/* ----------------------------------------------------------- panel -- */}
      <View style={s.panel}>
        <DrawerContentScrollView contentContainerStyle={s.content}>
          {/* Merging is a reading convenience only — composing, sending and
              decrypting stay bound to whichever account the rail has in front. */}
          <Pressable
            accessibilityLabel={unified ? 'Show only the account in front' : 'Show all accounts in one inbox'}
            accessibilityRole="switch"
            accessibilityState={{ checked: unified }}
            disabled={accounts.length < 2}
            onPress={() => void setUnified(!unified)}
            style={({ pressed }) => [s.panelHead, pressed && { backgroundColor: color.rowPress }]}
          >
            <Text numberOfLines={1} style={s.panelTitle}>
              {unified ? 'All Accounts' : (session?.email ?? 'Mailbox')}
            </Text>
            {accounts.length > 1 ? (
              <Icon name={unified ? 'check' : 'inbox'} size={17} color={unified ? accent : color.inkFaint} />
            ) : null}
          </Pressable>

          <DrawerItem
            icon="inbox"
            label="Inbox"
            count={total}
            active={category === null}
            onPress={() => choose(null)}
          />
          {destinations.map((d) => (
            <DrawerItem key={d.label} icon={d.icon} label={d.label} count={0} active={false} onPress={d.go} />
          ))}
          <DrawerItem
            icon="junk"
            label="Junk"
            count={counts.spam}
            active={category === 'spam'}
            onPress={() => choose('spam')}
          />

          <Text style={s.section}>Categories</Text>
          {CATEGORIES.filter((cat) => cat !== 'spam').map((cat) => (
            <DrawerItem
              key={cat}
              icon={CATEGORY_ICON[cat]}
              label={CATEGORY_LABELS[cat]}
              count={counts[cat]}
              active={category === cat}
              onPress={() => choose(cat)}
            />
          ))}
        </DrawerContentScrollView>

        <View style={[s.footer, { paddingBottom: insets.bottom + space.sm }]}>
          <PressableRow accessibilityRole="button" onPress={() => push('Settings')} style={s.footerRow}>
            <Icon name="settings" size={21} color={color.inkDim} />
            <Text style={s.footerLabel}>Settings</Text>
          </PressableRow>
        </View>
      </View>
    </View>
  );
}

function DrawerItem({
  icon,
  label,
  count,
  active,
  onPress,
}: {
  icon: IconName;
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  const accent = useAccent();
  const tint = active ? accent : color.inkDim;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count > 0 ? `${label}, ${count} unread` : label}
      onPress={onPress}
      style={({ pressed }) => [s.item, pressed && { backgroundColor: color.rowPress }]}
    >
      <Icon name={icon} size={21} color={tint} />
      <Text numberOfLines={1} style={[s.itemLabel, active && { color: accent }]}>
        {label}
      </Text>
      {count > 0 ? (
        <View style={[s.count, { backgroundColor: accent }]}>
          <Text style={s.countText}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  drawer: { backgroundColor: color.surface, flexDirection: 'row', flex: 1 },

  rail: { alignItems: 'center', gap: space.lg, paddingTop: space.lg, width: 72 },
  railItem: { borderRadius: 26, borderWidth: 2, padding: 2 },
  railAdd: {
    alignItems: 'center',
    borderColor: color.line,
    borderRadius: 24,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },

  panel: { borderLeftColor: color.line, borderLeftWidth: 1, flex: 1 },
  content: { paddingBottom: space.lg },
  panelHead: {
    alignItems: 'center',
    borderBottomColor: color.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: space.sm,
    paddingBottom: space.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  panelTitle: { ...type.heading, color: color.ink, flex: 1 },

  section: { ...type.settingsValue, color: color.inkFaint, paddingHorizontal: space.lg, paddingTop: space.lg },

  item: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  itemLabel: { ...type.settingsRow, color: color.ink, flex: 1 },

  count: { borderRadius: radius.xs, minWidth: 26, paddingHorizontal: 6, paddingVertical: 2 },
  countText: { color: color.ground, fontFamily: font.sansSemibold, fontSize: 13, textAlign: 'center' },

  footer: { borderTopColor: color.line, borderTopWidth: 1, paddingTop: space.sm },
  footerRow: { alignItems: 'center', flexDirection: 'row', gap: space.lg, paddingHorizontal: space.lg, paddingVertical: 12 },
  footerLabel: { ...type.settingsRow, color: color.ink },
});
