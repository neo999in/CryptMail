import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { categorizeMessage } from '../categorizer/categorizer';
import { AccountId, AccountRef } from '../store/accountScope';
import { messageMatchesQuery } from '../search/search';
import { groupIntoThreads, Thread } from '../threads/threads';
import { EncryptionState, useApp } from '../state/AppState';
import { InboxItem } from '../state/types';
import { color, space, type } from '../theme';
import { Icon } from '../ui/Icon';
import { useAccent, useAppearance } from '../ui/appearance';
import { showsUnderTab } from '../ui/inboxTabs';
import { useChrome } from '../ui/chrome';
import { categoryOf, useDestination } from '../ui/destination';
import { OriginRect } from '../ui/expand';
import { mailTopInset } from '../ui/mailBar';
import { needsAttention } from '../ui/mailFilter';
import { groupByDay, MailListRow, MailSkeletonList, SectionHeading } from '../ui/mailList';
import { EmptyState, SecondaryButton } from '../ui/primitives';
import { BodyProps } from './HomeScreen';

/**
 * The inbox, and every category filter over it — encryption state on every row.
 *
 * A destination body, not a route, and **not the bar either**: the bar belongs
 * to `screens/HomeScreen.tsx` and stays mounted while this is swapped for the
 * Sent, Archive, Drafts or Scheduled body, so a destination change never
 * remounts the aurora. What the bar holds — the search text, the lens, the
 * filter — arrives here as props.
 */
export function InboxBody({ navigation, query, tab, filter, headerHeight, clearFilters }: BodyProps) {
  const {
    session,
    accounts,
    unified,
    switchingAccount,
    messages,
    loadingInbox,
    loadingMore,
    canLoadMore,
    error,
    refreshInbox,
    loadMoreInbox,
    encryptionFor,
    searchIndex,
    spam,
  } = useApp();
  const { destination } = useDestination();
  const category = categoryOf(destination);
  const { rowPadding } = useAppearance();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { setOverlay } = useChrome();

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);

  /**
   * What the categorizer needs to reach the same spam verdict the message view
   * shows: the personal model, the user's own marks, and this account's address.
   * Memoised because it goes into the filter pass below.
   */
  const spamContext = useMemo(
    () => ({ model: spam.model, marks: spam.marks, selfAddress: session?.email }),
    [spam, session?.email],
  );

  /** One pass: decorate with encryption state, then filter, then group by day. */
  const sections = useMemo(() => {
    const visible = messages
      .map((summary) => ({ summary, encryption: encryptionFor(summary) }))
      .filter(({ summary, encryption }) => {
        const encrypted = encryption.kind === 'encrypted';
        if (filter === 'attention' && !needsAttention(encryption)) return false;
        // The drawer's category filter sorts plaintext mail only:
        // categorizeMessage leaves every encrypted message in 'primary', opened
        // or not, so encrypted mail is never filed away from the main list
        // (categorizer/categorizer.ts).
        const messageCategory = categorizeMessage(summary, encrypted, searchIndex, spamContext);
        // A chosen category is the more specific request, so it wins over the
        // tab — otherwise picking Promotions from the drawer while Primary is
        // selected would show an empty list and look broken. The Encrypted tab
        // still applies on top of it, since it narrows rather than re-files.
        if (category !== null) {
          if (messageCategory !== category) return false;
          if (tab === 'encrypted' && !encrypted) return false;
        } else if (!showsUnderTab(messageCategory, encrypted, tab)) {
          return false;
        }
        // Encrypted mail is matched on its decrypted content once opened (search/search.ts).
        return messageMatchesQuery(summary, encrypted, searchIndex, query);
      })
      .map((r) => r.summary);

    // One row per conversation; the row stands for the thread's latest message.
    const rows = groupIntoThreads(visible).map((thread) => ({
      thread,
      encryption: encryptionFor(thread.latest),
    }));

    return groupByDay(rows, (row) => row.thread.latest.date);
  }, [category, encryptionFor, filter, messages, query, searchIndex, spamContext, tab]);

  const firstLoad = loadingInbox && messages.length === 0;
  const filtering = query.trim().length > 0 || filter !== 'all' || category !== null;

  /**
   * Open one mail.
   *
   * The message expands into the list area and leaves this bar drawing above
   * it, so it is handed both the row's rectangle and how far down to start.
   *
   * Where that inset comes from — and why it is the title row rather than the
   * whole bar — is `mailTopInset` in `ui/mailBar.tsx`.
   *
   * The `setOverlay` is what keeps the band running across the navigation, and
   * it has to happen here rather than on the far side — see `ui/chrome.tsx`.
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
    ({ item, index }: { item: { thread: Thread<InboxItem>; encryption: EncryptionState }; index: number }) => (
      <MailListRow
        summary={item.thread.latest}
        encryption={item.encryption}
        // Only while merged: in a single-account inbox every row is from the
        // same mailbox, and saying so on each one is noise.
        mailbox={unified ? mailboxName(accounts, item.thread.latest.account) : undefined}
        count={item.thread.count}
        index={index}
        padding={rowPadding}
        selfAddress={session?.email}
        onPress={(origin) =>
          item.thread.count > 1
            ? navigation.navigate('Conversation', { threadId: item.thread.id })
            : openMail(item.thread.latest.id, origin)
        }
      />
    ),
    // `accounts` and `unified` are read above, so they belong here: without
    // them the row renderer keeps the values it closed over on first render —
    // when nothing was merged — and the mailbox label never appears.
    [accounts, openMail, navigation, rowPadding, session?.email, unified],
  );

  return (
    <View style={s.screen}>
      {error ? (
        <View style={s.errorRow}>
          <Icon name="alert" size={14} color={color.coral} />
          <Text style={s.error}>{error}</Text>
        </View>
      ) : null}

      {firstLoad ? (
        <MailSkeletonList />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.thread.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => <SectionHeading title={section.title} />}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          // Filters and search run over rows already on the device, so paging
          // while one is up would fetch mail the list is about to hide. The
          // footer button stays, which is how older mail is reached from there.
          onEndReached={filtering ? undefined : () => void loadMoreInbox()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={s.footer}>
                <ActivityIndicator color={accent} />
              </View>
            ) : canLoadMore && messages.length > 0 ? (
              <View style={s.footer}>
                <SecondaryButton title="Load older mail" icon="refresh" onPress={() => void loadMoreInbox()} />
              </View>
            ) : null
          }
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={loadingInbox} onRefresh={() => void refreshInbox()} tintColor={accent} />
          }
          ListEmptyComponent={
            loadingInbox ? null : filtering ? (
              <EmptyState
                icon="search"
                title="Nothing matched"
                hint="Encrypted mail becomes searchable by its subject and body once you've opened it on this device."
                action={<SecondaryButton title="Clear filters" icon="close" onPress={clearFilters} />}
              />
            ) : (
              <EmptyState
                icon={tab === 'encrypted' ? 'lock' : 'inbox'}
                title={tab === 'encrypted' ? 'No encrypted mail yet' : 'Nothing in Primary'}
                hint={
                  tab === 'encrypted'
                    ? 'Mail that arrives protected shows here. Invite someone to exchange keys and it will.'
                    : 'Pull down to check for new mail.'
                }
              />
            )
          }
        />
      )}
    </View>
  );
}

/* -------------------------------------------------------------- helpers ---- */

/** The address behind an account id — what a row shows, never the id itself. */
function mailboxName(accounts: AccountRef[], id: AccountId): string {
  return accounts.find((a) => a.id === id)?.email ?? id;
}


/** What is left after the bar (`ui/mailBar.tsx`) and the rows
 *  (`ui/mailList.tsx`) took their own styles with them. */
const s = StyleSheet.create({
  footer: { alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.lg },

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

});
