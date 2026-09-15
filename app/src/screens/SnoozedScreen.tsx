import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { messageMatchesQuery } from '../search/search';
import { returnsBucket, returnsLabel, SnoozedRow, snoozedRows } from '../snooze/snooze';
import { useApp } from '../state/AppState';
import { color, font, radius, space, type } from '../theme';
import { Icon } from '../ui/Icon';
import { useAppearance } from '../ui/appearance';
import { useChrome } from '../ui/chrome';
import { OriginRect } from '../ui/expand';
import { mailBandBelow, mailTopInset } from '../ui/mailBar';
import { AnimatedSectionList, MAIL_LIST_WINDOW, MailListRow, SectionHeading, useComposeScroll } from '../ui/mailList';
import { EmptyState, SecondaryButton } from '../ui/primitives';
import { useToast } from '../ui/ToastContext';
import { useLatest } from '../ui/useLatest';
import { BodyProps } from './HomeScreen';

/**
 * Snoozed — the mail that is away, and when each message comes back.
 *
 * A destination body under the home screen's bar, like Scheduled, and backed
 * by the same kind of thing: a local due-time queue (`snooze/snooze.ts`). It is
 * the active account's queue, since that is the store a snooze is written to.
 *
 * Nothing here is a provider operation. A snooze is a local fact about this
 * device's inbox, so the message stays in the provider's inbox the whole time
 * — archiving it there and restoring it on wake would put the message's
 * return at the mercy of this app being run again, and a phone left in a
 * drawer would lose mail. Returning one early is the same local write.
 *
 * Rows are grouped by when they return, soonest first, rather than by when
 * they arrived: that is the question a person opening this list is asking.
 */
export function SnoozedBody({
  navigation,
  query,
  clearSearch,
  headerHeight,
  barHeight,
  entry,
  composeFold,
}: BodyProps) {
  const composeScroll = useComposeScroll(composeFold);
  const { messages, snoozed, session, encryptionFor, searchIndex, snoozeMessage, unsnoozeMessage } = useApp();
  const { showToast } = useToast();
  const { rowPadding } = useAppearance();
  const { setOverlay } = useChrome();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();

  const sections = useMemo(() => {
    const now = new Date();
    const rows = snoozedRows(snoozed, messages, now.toISOString()).filter(({ summary }) =>
      // A row with no summary has nothing to match against, so a search hides it.
      summary
        ? messageMatchesQuery(summary, encryptionFor(summary).kind === 'encrypted', searchIndex, query)
        : query.trim().length === 0,
    );
    const buckets = new Map<string, SnoozedRow[]>();
    for (const row of rows) {
      const bucket = returnsBucket(row.entry.until, now);
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
    }
    return [...buckets].map(([title, data]) => ({ title, data }));
  }, [encryptionFor, messages, query, searchIndex, snoozed]);

  // See `InboxBody`: this bar is the front of the app again once focused.
  useEffect(() => {
    if (isFocused) setOverlay('none');
  }, [isFocused, setOverlay]);

  const openMail = useCallback(
    (id: string, origin?: OriginRect) => {
      setOverlay('open');
      const topInset = mailTopInset(insets.top, headerHeight);
      navigation.navigate('Message', { id, origin, topInset, bandInset: mailBandBelow(barHeight, topInset) });
    },
    [barHeight, headerHeight, insets.top, navigation, setOverlay],
  );

  /**
   * Bring one back now, and offer the way back to the snooze it had.
   *
   * Only a success is called one: a failed write says so and the row stays.
   */
  const snoozedNow = useLatest(snoozed);
  const returnNow = useCallback(
    (id: string) => {
      const until = snoozedNow.current[id]?.until;
      if (!until) return;
      unsnoozeMessage(id).then(
        () =>
          showToast({
            message: 'Back in your inbox',
            icon: 'inbox',
            durationMs: 5000,
            actionLabel: 'Undo',
            onAction: () => void snoozeMessage(id, until),
          }),
        () => showToast({ message: 'Couldn’t return that message', icon: 'alert', durationMs: 5000 }),
      );
    },
    [showToast, snoozeMessage, snoozedNow, unsnoozeMessage],
  );

  const renderItem = ({ item, index }: { item: SnoozedRow; index: number }) => (
    <View>
      {item.summary ? (
        <MailListRow
          id={item.entry.id}
          summary={item.summary}
          encryption={encryptionFor(item.summary)}
          index={index}
          entry={entry}
          padding={rowPadding}
          selfAddress={session?.email}
          onPress={openMail}
        />
      ) : (
        // Snoozed by a build that kept no snapshot, and not in the loaded inbox.
        // Said plainly rather than dropped: it is still hidden, and still returns.
        <View style={s.unknown}>
          <Text style={s.unknownText}>A message this device has not loaded</Text>
        </View>
      )}
      <View style={s.returns}>
        <Icon name="bell" size={13} color={color.inkFaint} />
        <Text style={s.returnsText}>Returns {returnsLabel(item.entry.until)}</Text>
        <SecondaryButton title="Return now" icon="inbox" onPress={() => returnNow(item.entry.id)} />
      </View>
    </View>
  );

  const total = Object.keys(snoozed).length;

  return (
    <View style={s.screen}>
      <AnimatedSectionList
        {...MAIL_LIST_WINDOW}
        {...composeScroll}
        sections={sections}
        keyExtractor={(item) => item.entry.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => <SectionHeading title={section.title} />}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        ListEmptyComponent={
          query.trim().length > 0 && total > 0 ? (
            <EmptyState
              icon="search"
              title="Nothing matched"
              hint="Encrypted mail is searched by its subject and body once you have opened it on this device."
              action={<SecondaryButton title="Clear search" icon="close" onPress={clearSearch} />}
            />
          ) : (
            <EmptyState
              icon="bell"
              title="Nothing snoozed"
              // Honest about the one limit: the tick that wakes mail runs inside
              // the app (features.md, "the scheduler only runs while the app runs").
              hint="Snooze a message from the inbox and it waits here until its time, then returns to the inbox the next time CryptMail is open."
            />
          )
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },
  returns: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.sm,
    paddingBottom: space.sm,
    paddingHorizontal: space.lg,
  },
  returnsText: { ...type.small, color: color.inkDim, flex: 1 },
  unknown: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    marginHorizontal: space.lg,
    marginVertical: space.xs,
    padding: space.md,
  },
  unknownText: { color: color.inkDim, fontFamily: font.sans, fontSize: 14 },
});
