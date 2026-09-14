/**
 * The navigation drawer: an account rail beside a list of destinations.
 *
 * The rail on the left is the mailbox switcher — one avatar per connected
 * account, the active one ringed in the accent, and a `+` to add another. It is
 * a faster way to exercise the rule that already holds everywhere else:
 * **exactly one account is active at a time**, and tapping a rail avatar simply
 * calls the same `switchAccount` action the account sheet used to. Merging is
 * still only a reading convenience, and its one control is the Home circle at
 * the top of this rail — the panel's toggle was removed, because two controls
 * for one setting is the mistake the accent swatches already taught us.
 *
 * Switching is all this rail does. Managing a mailbox — its name, its avatar,
 * what it may fetch, how far back it syncs, and removing it — is
 * `screens/AccountScreen.tsx`, which a long press here opens.
 *
 * The panel on the right lists destinations that exist, and **every row is the
 * same kind of thing**: it sets the home screen's `Destination`
 * (`ui/destination.tsx`) and closes the drawer. Sent and Archive come from the
 * provider and Drafts and Scheduled from local stores, but none of them pushes a
 * screen, so none of them arrives with a back arrow. Settings is the one push
 * here, because it genuinely is a different screen. The reference also shows
 * Snoozed, and CryptMail has no backing for that, so it is not drawn as a row
 * that does nothing — see docs/design/ui-rework.md.
 *
 * Counts come from `unreadCountsByCategory`, which honours the encryption
 * boundary: unopened encrypted mail is never classified from its ciphertext, so
 * it counts under Primary until the user opens it. The Spam count is the spam
 * engine's verdict, plus whatever the provider filed as junk, plus any message the
 * user marked themselves — which is why the personal model and the marks are
 * passed through.
 */
import { DrawerContentComponentProps, DrawerContentScrollView } from '@react-navigation/drawer';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useMemo } from 'react';
import { InteractionManager, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATEGORIES, CATEGORY_LABELS, unreadCountsByCategory } from '../categorizer/categorizer';
import { signInProviders } from '../config';
import { initials } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { AccountRef, accountLabel, settingsOf } from '../store/accountScope';
import { color, font, radius, space, tint, type } from '../theme';
import { useAccent } from '../ui/appearance';
import { Icon, IconName } from '../ui/Icon';
import { AllAccountsAvatar, Avatar, PressableRow } from '../ui/primitives';
import { Destination, useDestination } from '../ui/destination';

const CATEGORY_ICON: Record<string, IconName> = {
  primary: 'inbox',
  purchases: 'archive',
  bills: 'file',
  promotions: 'star',
  spam: 'junk',
};

/** The mailboxes and queues that are not a filter over the inbox's own rows. */
const BOXES: { key: Destination; icon: IconName; label: string }[] = [
  { key: 'sent', icon: 'send', label: 'Sent' },
  { key: 'archive', icon: 'archive', label: 'Archive' },
  { key: 'trash', icon: 'trash', label: 'Trash' },
  { key: 'drafts', icon: 'edit', label: 'Drafts' },
  { key: 'scheduled', icon: 'clock', label: 'Scheduled' },
  { key: 'snoozed', icon: 'bell', label: 'Snoozed' },
];

export function CategoryDrawer({ navigation }: DrawerContentComponentProps) {
  const {
    messages,
    searchIndex,
    encryptionFor,
    spam,
    session,
    accounts,
    activeAccount,
    needsReauth,
    unified,
    switchAccount,
    addAccount,
    setUnified,
  } = useApp();
  const { destination, setDestination } = useDestination();
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

  // Everything except Spam, which is the Inbox destination's own contents:
  // `messages` carries the provider's junk folder as well as the inbox
  // (state/types.ts), and those rows are not in the list this badge belongs to.
  const total = CATEGORIES.reduce((sum, cat) => (cat === 'spam' ? sum : sum + counts[cat]), 0);

  /** The mailbox in front, for the panel's title — the user's name for it wins. */
  const activeRef = accounts.find((a) => a.id === activeAccount);

  /**
   * Close first, swap the body after.
   *
   * Both used to happen in one commit, and the body swap is a whole screen's
   * render — measured on a device at about 430 ms for a list of twenty, which is
   * JS-thread time the drawer's closing animation cannot have. The result was
   * the drawer sitting open and frozen with the tapped row already lit, which is
   * exactly what it looked like: a tap that did nothing for a second.
   *
   * `runAfterInteractions` gives the close its frames and then does the work, so
   * the drawer leaves immediately and the list arrives behind it. The row does
   * not light up on the way out, and that is the honest reading: the destination
   * has not changed yet.
   *
   * It is the animation this waits on, not a timer — a device that closes the
   * drawer faster gets the list sooner. Reanimated's own animations (the aurora
   * band, the row entry) run on the UI thread and register no interaction
   * handles, so nothing here can be held open by a loop that never ends.
   */
  const choose = (next: Destination) => {
    navigation.closeDrawer();
    InteractionManager.runAfterInteractions(() => setDestination(next));
  };

  /**
   * Settings is a real screen, so it is the one row here that pushes. Contacts
   * is not: it is a list this drawer reaches, and it now shares the home
   * screen's bar like every other row — the bar drops the mail lens and offers
   * its All/Verified/Unverified control instead (`screens/ContactsScreen.tsx`).
   */
  const openSettings = () => {
    navigation.closeDrawer();
    stack.navigate('Settings');
  };

  /**
   * A long press on a rail avatar opens that mailbox's own screen.
   *
   * It used to confirm *removal* — a destructive action on an unlabelled
   * gesture, with nothing on screen to say the gesture existed. Removal now
   * lives on the screen this opens, under a heading that says what it deletes,
   * and the gesture became a shortcut to it rather than a trapdoor.
   */
  const manage = (account: AccountRef) => {
    navigation.closeDrawer();
    stack.navigate('Account', { id: account.id });
  };

  return (
    <View style={[s.drawer, { paddingTop: insets.top }]}>
      {/* ------------------------------------------------------------ rail -- */}
      <View style={s.rail}>
        {/* Merged reading is the top of the rail rather than a toggle buried in
            the panel, because it is the same *kind* of choice as picking a
            mailbox: it answers "whose mail am I looking at". It only exists
            with something to merge — one account is already all of them.

            It does not change which account is *active*: composing, sending and
            decrypting still use one identity. The rail does not mark it while
            merged — compose shows the account it sends from, which is where
            that question is actually asked. */}
        {accounts.length > 1 ? (
          <>
            <Pressable
              accessibilityLabel="Show every account in one inbox"
              accessibilityRole="button"
              accessibilityState={{ selected: unified }}
              onPress={() => {
                if (!unified) void setUnified(true);
                navigation.closeDrawer();
              }}
              // No tinted slot behind it: the filled circle already carries the
              // selection, and stacking a wash under it only muddies the one
              // mark on the rail that is not a photograph.
              style={({ pressed }) => [s.railItem, pressed && { opacity: 0.7 }]}
            >
              <AllAccountsAvatar active={unified} size={40} tone={unified ? accent : color.inkFaint} />
            </Pressable>
            <View style={s.railDivider} />
          </>
        ) : null}

        {accounts.map((account) => {
          const active = account.id === activeAccount;
          // A mailbox whose grant died is still listed — it keeps its keyring
          // and its mail — but tapping it can only mean "sign in again", and
          // the rail has to say that before the tap rather than after. The
          // label carries it too: a dimmed avatar with a dot on it is not
          // something a screen reader can convey, and this is the one control
          // that explains why an account stopped syncing.
          const stale = needsReauth.includes(account.id);
          // Paused mailboxes are dimmed the same way and for the same reason —
          // they are not fetching — but the tap means something different, and
          // both the label and `switchAccount` say so: choosing a paused
          // mailbox resumes it (`state/accounts.ts`), because every way of
          // picking an account means "show me this mail".
          const paused = settingsOf(account).paused;
          return (
            <Pressable
              accessibilityLabel={
                stale
                  ? `Sign in again to ${account.email}`
                  : paused
                    ? `Resume syncing ${accountLabel(account)}`
                    : `Switch to ${accountLabel(account)}`
              }
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              key={account.id}
              onLongPress={() => manage(account)}
              onPress={() => {
                // A mailbox whose grant died can only be reached by signing in
                // again, and that is the provider's picker — so it happens here,
                // on a deliberate tap, and never as a side effect of a switch.
                if (stale) void addAccount(account.provider);
                // "This mailbox, on its own" — leaving the merged view is part
                // of picking one, and both land in a single sync.
                else if (!active || unified) void switchAccount(account.id, { unified: false });
                navigation.closeDrawer();
              }}
              // A tinted squircle behind the active avatar, not a ring around
              // it — the same soft-selection language as a chosen drawer row.
              style={({ pressed }) => [
                s.railItem,
                { backgroundColor: active && !unified ? tint(accent, 0.18) : 'transparent' },
                pressed && { opacity: 0.7 },
              ]}
            >
              <View
                style={[
                  (stale || paused) && s.railStale,
                ]}
              >
                <Avatar
                  label={initials(accountLabel(account))}
                  mode={settingsOf(account).avatar}
                  photo={account.photo}
                  provider={account.provider}
                  seed={account.email}
                  size={40}
                />
              </View>
              {stale ? (
                // Not `color.coral`: coral is trust vocabulary — a blocked
                // recipient, a changed fingerprint — and a mailbox that needs a
                // new token is not a trust failure. Borrowing the colour here
                // would make the one that matters mean less.
                <View style={s.railFlag}>
                  <Icon name="lock" size={11} color={color.ink} />
                </View>
              ) : null}
            </Pressable>
          );
        })}
        <Pressable
          accessibilityLabel="Add another account"
          accessibilityRole="button"
          onPress={() => {
            navigation.closeDrawer();
            // With two providers the rail cannot know which one is meant, and a
            // guessed picker is worse than one extra tap: the Accounts screen
            // offers a row per provider.
            if (signInProviders.length > 1) stack.navigate('Accounts');
            else void addAccount();
          }}
          style={({ pressed }) => [s.railAdd, pressed && { backgroundColor: color.segmentActive }]}
        >
          <Icon name="plus" size={22} color={color.inkDim} />
        </Pressable>
      </View>

      {/* ----------------------------------------------------------- panel -- */}
      <View style={s.panel}>
        <DrawerContentScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
          {/* A label, not a control. Merging moved to the rail, where it reads
              as one of the mailboxes to choose between; leaving a second switch
              here would be two controls for one setting, and the accent
              swatches already taught this codebase what that costs.

              Merging is still a reading convenience only — composing, sending
              and decrypting stay bound to the active account — but this is not
              where that is said. Compose shows the account it sends from: an
              address spelled out under this title, and again under the mail
              bar's, was a fact that changes about once a session taking a
              permanent line on two screens. */}
          <View style={s.panelHead}>
            <Text numberOfLines={1} style={s.panelTitle}>
              {unified ? 'All Accounts' : (activeRef ? accountLabel(activeRef) : (session?.email ?? 'Mailbox'))}
            </Text>
          </View>

          <View style={s.list}>
            <DrawerItem
              icon="inbox"
              label="Inbox"
              count={total}
              active={destination === 'inbox'}
              onPress={() => choose('inbox')}
            />
            {BOXES.map((d) => (
              <DrawerItem
                key={d.key}
                icon={d.icon}
                label={d.label}
                count={0}
                active={destination === d.key}
                onPress={() => choose(d.key)}
              />
            ))}
            {CATEGORIES.filter((cat) => cat !== 'spam').map((cat) => (
              <DrawerItem
                key={cat}
                icon={CATEGORY_ICON[cat]}
                label={CATEGORY_LABELS[cat]}
                count={counts[cat]}
                active={destination === cat}
                onPress={() => choose(cat)}
              />
            ))}
            <DrawerItem
              icon="junk"
              label="Spam"
              count={counts.spam}
              active={destination === 'spam'}
              onPress={() => choose('spam')}
            />
          </View>
        </DrawerContentScrollView>

        <View style={[s.footer, { paddingBottom: insets.bottom + space.sm }]}>
          <PressableRow
            accessibilityRole="button"
            accessibilityState={{ selected: destination === 'contacts' }}
            onPress={() => choose('contacts')}
            style={s.footerRow}
          >
            <Icon name="users" size={21} color={destination === 'contacts' ? accent : color.inkDim} />
            <Text
              style={[
                s.footerLabel,
                destination === 'contacts' && { color: accent, fontFamily: font.sansSemibold },
              ]}
            >
              Contacts
            </Text>
          </PressableRow>
          <PressableRow accessibilityRole="button" onPress={openSettings} style={s.footerRow}>
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
  const tone = active ? accent : color.inkDim;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count > 0 ? `${label}, ${count} unread` : label}
      onPress={onPress}
      style={({ pressed }) => [s.item, pressed && { opacity: 0.6 }]}
    >
      <Icon name={icon} size={22} color={tone} />
      <Text
        numberOfLines={1}
        style={[s.itemLabel, { color: active ? accent : color.ink }, active && { fontFamily: font.sansSemibold }]}
      >
        {label}
      </Text>
      {count > 0 ? <Text style={[s.count, { color: tone }]}>{count}</Text> : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  drawer: { backgroundColor: '#141414', flexDirection: 'row', flex: 1 },

  rail: { alignItems: 'center', gap: space.md, paddingTop: space.lg, width: 72 },
  railDivider: {
    backgroundColor: color.border,
    borderRadius: 1,
    height: 1,
    marginVertical: space.xs,
    width: 28,
  },
  railItem: { borderRadius: radius.pill, padding: 5 },
  railFlag: {
    alignItems: 'center',
    backgroundColor: color.inkFaint,
    borderColor: color.surface,
    borderRadius: radius.pill,
    borderWidth: 2,
    bottom: 2,
    height: 18,
    justifyContent: 'center',
    position: 'absolute',
    right: 2,
    width: 18,
  },
  railStale: { opacity: 0.45 },
  railAdd: {
    alignItems: 'center',
    borderColor: color.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 50,
    justifyContent: 'center',
    width: 50,
  },

  panel: { borderLeftColor: color.line, borderLeftWidth: 1, flex: 1 },
  content: { gap: space.lg, paddingBottom: space.lg, paddingHorizontal: space.lg, paddingTop: space.sm },
  // A stacked label since the toggle left: the mailbox being read, and — only
  // while merged, when it is genuinely ambiguous — the one being sent as.
  panelHead: {
    borderBottomColor: color.line,
    borderBottomWidth: 1,
    gap: 2,
    marginHorizontal: -space.lg,
    marginTop: -space.sm,
    paddingBottom: space.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  panelTitle: { ...type.heading, color: color.ink },

  list: { gap: space.xs },
  item: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.lg,
    paddingHorizontal: space.sm,
    paddingVertical: 14,
  },
  itemLabel: { ...type.settingsRow, flex: 1 },
  count: { ...type.settingsValue, fontFamily: font.sansSemibold },

  footer: { borderTopColor: color.line, borderTopWidth: 1, paddingTop: space.sm },
  footerRow: { alignItems: 'center', flexDirection: 'row', gap: space.lg, paddingHorizontal: space.lg, paddingVertical: 12 },
  footerLabel: { ...type.settingsRow, color: color.ink },
});
