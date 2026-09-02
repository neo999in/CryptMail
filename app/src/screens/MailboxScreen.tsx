/**
 * Sent and Archive — the two mailboxes that are not the inbox.
 *
 * One screen, parameterised, because they differ in three details and nothing
 * else: the title, the empty state, and which address a row leads with (Sent
 * shows who it went *to*; there is no point telling you that you sent it — and
 * that rule lives in `ui/mailRow.tsx`, keyed on the active account, so the
 * closing transition's ghost reaches the same answer).
 *
 * They are their own lists, fetched from the provider, not a filter over the
 * inbox — filtering `messages` would show only the sent mail that happened to be
 * in the inbox, which is none of it. Each paginates on its own cursor, so
 * reaching the bottom of Sent does not disturb where the inbox was paged to.
 *
 * That difference is invisible from the outside, and deliberately so. This is a
 * **destination body, not a route and not a screen**: picking Sent swaps what
 * `screens/HomeScreen.tsx` renders under its bar, exactly as picking Bills does.
 * The bar itself never moves — same aurora, same account avatar, same search box
 * with the same text in it — because it is mounted above this and only the list
 * below it changes. The rows are the inbox's rows under the same day headings
 * (`ui/mailList.tsx`), the search text and the Primary/Encrypted lens arrive as
 * props, and a mail grows out of the row it was tapped from.
 *
 * The active account only, even while the inbox is merged: merging is a reading
 * convenience for incoming mail, and quietly mixing two accounts' sent mail
 * would misrepresent which mailbox a message left from.
 */
import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { messageMatchesQuery } from '../search/search';
import { EncryptionState, useApp } from '../state/AppState';
import { InboxItem, SecondaryBox } from '../state/types';
import { color, space, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { useAccent, useAppearance } from '../ui/appearance';
import { useChrome } from '../ui/chrome';
import { OriginRect } from '../ui/expand';
import { mailTopInset } from '../ui/mailBar';
import { needsAttention } from '../ui/mailFilter';
import { groupByDay, MailListRow, MailSkeletonList, SectionHeading } from '../ui/mailList';
import { EmptyState, SecondaryButton } from '../ui/primitives';
import { BodyProps } from './HomeScreen';

const COPY: Record<SecondaryBox, { title: string; empty: string; hint: string; icon: IconName }> = {
  sent: {
    title: 'Sent',
    empty: 'Nothing sent yet',
    hint: 'Messages you send from this account appear here. Encrypted ones stay encrypted — the provider holds the ciphertext, and this device decrypts them to show you.',
    icon: 'send',
  },
  archive: {
    title: 'Archive',
    empty: 'Nothing archived',
    hint: 'Mail you archive leaves the inbox but stays in the account. Nothing is deleted.',
    icon: 'archive',
  },
};

export function MailboxBody({
  navigation,
  box,
  query,
  tab,
  filter,
  headerHeight,
  clearFilters,
}: BodyProps & { box: SecondaryBox }) {
  const { boxes, loadBox, loadMoreBox, encryptionFor, searchIndex, session } = useApp();
  const { items, loading, loadingMore, canLoadMore, error } = boxes[box];
  const { rowPadding } = useAppearance();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { setOverlay } = useChrome();
  const isFocused = useIsFocused();
  const copy = COPY[box];

  useEffect(() => {
    void loadBox(box);
  }, [box, loadBox]);

  /**
   * One pass: decorate with encryption state, filter, then group by day.
   *
   * The categorizer is deliberately absent. Bills and Promotions are a reading
   * of *incoming* mail; filing your own sent mail into them would be a guess
   * about a message you wrote. The Encrypted lens still applies, because that is
   * a property of the message rather than a category assigned to it.
   */
  const sections = useMemo(() => {
    const rows = items
      .map((item) => ({ item, encryption: encryptionFor(item) }))
      .filter(({ item, encryption }) => {
        const encrypted = encryption.kind === 'encrypted';
        if (tab === 'encrypted' && !encrypted) return false;
        // The same "needs attention" filter the inbox applies, from the same
        // control: a key that changed is no less a decision because the message
        // is one you sent.
        if (filter === 'attention' && !needsAttention(encryption)) return false;
        // Encrypted mail is matched on its decrypted content once opened.
        return messageMatchesQuery(item, encrypted, searchIndex, query);
      });
    return groupByDay(rows, (row) => row.item.date);
  }, [encryptionFor, filter, items, query, searchIndex, tab]);

  const filtering = query.trim().length > 0 || tab !== 'primary' || filter !== 'all';

  /**
   * Open one mail — the same expansion the inbox uses.
   *
   * The message grows into the list area and leaves this bar drawing above it,
   * so it is handed both the row's rectangle and how far down to start. The
   * `setOverlay` keeps the band running across the navigation and has to happen
   * here rather than on the far side — see `ui/chrome.tsx`.
   */
  const openMail = useCallback(
    (id: string, origin?: OriginRect) => {
      setOverlay('open');
      navigation.navigate('Message', { id, origin, topInset: mailTopInset(insets.top, headerHeight) });
    },
    [headerHeight, insets.top, navigation, setOverlay],
  );

  // Whatever happened to the mail that was open, this bar is the front of the
  // app again — a navigation that never arrived cannot leave the flag on.
  useEffect(() => {
    if (isFocused) setOverlay('none');
  }, [isFocused, setOverlay]);

  const renderItem = useCallback(
    ({ item, index }: { item: { item: InboxItem; encryption: EncryptionState }; index: number }) => (
      <MailListRow
        summary={item.item}
        encryption={item.encryption}
        index={index}
        padding={rowPadding}
        selfAddress={session?.email}
        onPress={(origin) => openMail(item.item.id, origin)}
      />
    ),
    [openMail, rowPadding, session?.email],
  );

  return (
    <View style={s.screen}>
      {error ? (
        <View style={s.errorRow}>
          <Icon name="alert" size={14} color={color.coral} />
          <Text style={s.error}>{error}</Text>
        </View>
      ) : null}

      {loading && items.length === 0 ? (
        <MailSkeletonList />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(row) => row.item.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => <SectionHeading title={section.title} />}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadBox(box)} tintColor={accent} />}
          // Search and the tab run over rows already on the device, so paging
          // while one is up would fetch mail the list is about to hide. The
          // footer button stays, which is how older mail is reached from there.
          onEndReached={filtering ? undefined : () => void loadMoreBox(box)}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={s.footer}>
                <ActivityIndicator color={accent} />
              </View>
            ) : canLoadMore && items.length > 0 ? (
              <View style={s.footer}>
                <SecondaryButton title="Load older mail" icon="refresh" onPress={() => void loadMoreBox(box)} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            loading ? null : filtering ? (
              <EmptyState
                icon="search"
                title="Nothing matched"
                hint="Encrypted mail becomes searchable by its subject and body once you've opened it on this device."
                action={<SecondaryButton title="Clear filters" icon="close" onPress={clearFilters} />}
              />
            ) : (
              <EmptyState icon={copy.icon} title={copy.empty} hint={copy.hint} />
            )
          }
        />
      )}

    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  errorRow: {
    alignItems: 'center',
    backgroundColor: color.coralBg,
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  error: { ...type.small, color: color.coralInk, flex: 1 },

  footer: { alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.lg },
});
