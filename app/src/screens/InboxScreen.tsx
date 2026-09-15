import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, BackHandler, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { categorizeMessage, CATEGORY_LABELS } from '../categorizer/categorizer';
import { hasLabel, labelNamesFor } from '../labels/labels';
import { AccountId, AccountRef } from '../store/accountScope';
import { messageMatchesQuery } from '../search/search';
import { isSnoozed } from '../snooze/snooze';
import { SwipeVisual } from '../swipe/swipe';
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
import { mailBandBelow, mailTopInset } from '../ui/mailBar';
import { needsAttention } from '../ui/mailFilter';
import {
  groupByDay,
  MAIL_LIST_WINDOW,
  MailListRow,
  MailSkeletonList,
  SectionHeading,
  useComposeScroll,
} from '../ui/mailList';
import { EmptyState, SecondaryButton } from '../ui/primitives';
import { BulkBar } from '../ui/bulkBar';
import { LabelSheet } from '../ui/labelSheet';
import { MailOperation, useSwipeRunner } from '../ui/swipeRun';
import { useToast } from '../ui/ToastContext';
import { useLatest } from '../ui/useLatest';
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
export function InboxBody({
  navigation,
  query,
  tab,
  filter,
  headerHeight,
  barHeight,
  clearFilters,
  entry,
  labelFilter,
  onSelecting,
  onComposeCollapse,
}: BodyProps) {
  const composeScroll = useComposeScroll(onComposeCollapse);
  const {
    session,
    accounts,
    activeAccount,
    unified,
    switchingAccount,
    messages,
    snoozed,
    loadingInbox,
    refreshingInbox,
    loadingMore,
    canLoadMore,
    error,
    refreshInbox,
    loadMoreInbox,
    encryptionFor,
    searchIndex,
    spam,
    labels,
    toggleStar,
  } = useApp();
  const { showToast } = useToast();
  const { destination, setDestination } = useDestination();
  const category = categoryOf(destination);
  const { rowPadding } = useAppearance();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { setOverlay } = useChrome();
  // One runner, and one snooze sheet, for the whole list — see `ui/swipeRun.tsx`.
  // A side nobody has configured offers the setup screen rather than an action.
  const { runSwipe, runOperation, snoozePicker } = useSwipeRunner({
    onSetUp: () => navigation.navigate('SwipeOptions'),
  });

  // `ifStale` so returning to the inbox from Sent or Archive draws the mail
  // already in state instead of waiting on a sync that would hand back the same
  // rows. A pull, the Refresh action, a send and a boot all still fetch.
  useEffect(() => {
    void refreshInbox({ ifStale: true });
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
    const now = new Date().toISOString();
    const visible = messages
      .filter((summary) => !isSnoozed(snoozed, summary.id, now))
      .filter((summary) => !labelFilter || hasLabel(labels, [summary.id], labelFilter))
      .map((summary) => {
        const encryption = encryptionFor(summary);
        return {
          summary,
          encryption,
          // Kept rather than recomputed below: the swipe needs the same verdict
          // to know whether Spam means file or rescue, and categorizing the
          // whole list twice to answer that would be a second pass for nothing.
          category: categorizeMessage(summary, encryption.kind === 'encrypted', searchIndex, spamContext),
        };
      })
      .filter(({ summary, encryption, category: messageCategory }) => {
        const encrypted = encryption.kind === 'encrypted';
        if (filter === 'attention' && !needsAttention(encryption)) return false;
        // The drawer's category filter sorts plaintext mail only:
        // categorizeMessage leaves every encrypted message in 'primary', opened
        // or not, so encrypted mail is never filed away from the main list
        // (categorizer/categorizer.ts).
        //
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
      });

    const junkIds = new Set(visible.filter((r) => r.category === 'spam').map((r) => r.summary.id));

    // One row per conversation; the row stands for the thread's latest message.
    const rows = groupIntoThreads(visible.map((r) => r.summary)).map((thread) => ({
      thread,
      encryption: encryptionFor(thread.latest),
      junk: junkIds.has(thread.latest.id),
      labels: labelNamesFor(
        labels,
        thread.messages.map((m) => m.id),
      ),
    }));

    return groupByDay(rows, (row) => row.thread.latest.date);
  }, [category, encryptionFor, filter, labelFilter, labels, messages, query, searchIndex, snoozed, spamContext, tab]);

  const firstLoad = loadingInbox && messages.length === 0;
  const filtering = query.trim().length > 0 || filter !== 'all' || category !== null || !!labelFilter;

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
      const topInset = mailTopInset(insets.top, headerHeight);
      navigation.navigate('Message', {
        id,
        origin,
        topInset,
        // What is still bar below that line, so the message's own header can
        // stand on the band instead of on a black block.
        bandInset: mailBandBelow(barHeight, topInset),
      });
    },
    [barHeight, headerHeight, insets.top, navigation, setOverlay],
  );

  // Whatever happened to the mail that was open, this bar is the front of the
  // app again — a navigation that never arrived cannot leave the flag on.
  useEffect(() => {
    if (isFocused) setOverlay('none');
  }, [isFocused, setOverlay]);

  /**
   * The conversations on screen, by id — what a row's tap and swipe act on.
   *
   * Read through `useLatest` so the two handlers below are built once: a row
   * hands back its thread id and the handler finds the thread as it is *now*.
   * Closing over `sections` instead would rebuild both whenever the list's data
   * changed, and a new handler re-renders every memoised row (`ui/mailList.tsx`).
   */
  const threadsById = useMemo(
    () => new Map(sections.flatMap((section) => section.data.map((row) => [row.thread.id, row.thread] as const))),
    [sections],
  );
  const threads = useLatest(threadsById);

  /**
   * The selected conversations, by thread id.
   *
   * Held as the ids the user picked, and read back through what is on screen:
   * a row that a sync, a filter or another action has taken away is simply no
   * longer selected, so the bar can never act on mail the reader cannot see.
   */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(
    () => new Set([...picked].filter((id) => threadsById.has(id))),
    [picked, threadsById],
  );
  const selecting = selected.size > 0;
  const selectingNow = useLatest(selecting);
  const [labelling, setLabelling] = useState<string[] | null>(null);

  const clearSelection = useCallback(() => setPicked(new Set()), []);
  const toggleSelected = useCallback(
    (threadId: string) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(threadId)) next.delete(threadId);
        else next.add(threadId);
        return next;
      }),
    [],
  );

  useEffect(() => {
    onSelecting(selecting);
  }, [onSelecting, selecting]);

  // Back leaves the selection before it leaves anything else. Registered after
  // the home screen's own handler, so it is asked first.
  useEffect(() => {
    if (!selecting || !isFocused) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      clearSelection();
      return true;
    });
    return () => sub.remove();
  }, [clearSelection, isFocused, selecting]);

  const openRow = useCallback(
    (threadId: string, origin?: OriginRect) => {
      // Selecting, a tap adds or removes the row; it never opens mail.
      if (selectingNow.current) {
        toggleSelected(threadId);
        return;
      }
      const thread = threads.current.get(threadId);
      if (!thread) return;
      if (thread.count === 1) {
        openMail(thread.latest.id, origin);
        return;
      }
      // A conversation grows out of its row exactly as one message does — the
      // same rectangle, the same inset, the same bar held running above it.
      setOverlay('open');
      const topInset = mailTopInset(insets.top, headerHeight);
      navigation.navigate('Conversation', {
        threadId: thread.id,
        origin,
        topInset,
        bandInset: mailBandBelow(barHeight, topInset),
      });
    },
    [barHeight, headerHeight, insets.top, navigation, openMail, selectingNow, setOverlay, threads, toggleSelected],
  );

  /** Every message behind the selected rows — a conversation is all of them. */
  const targets = useMemo(
    () => [...selected].flatMap((id) => threadsById.get(id)?.messages ?? []),
    [selected, threadsById],
  );

  /** Run one of the swipe's own operations over the selection, then leave it. */
  const bulk = (operation: MailOperation) => {
    runOperation(operation, targets, null);
    clearSelection();
  };

  /**
   * Star or unstar the whole selection.
   *
   * Not a swipe operation, so it has its own toast — but the same shape: say
   * what happened, offer the way back, and never call a failure a success.
   * Only the messages whose star actually changes are touched, which is also
   * exactly the set the undo has to put back.
   */
  const bulkStar = () => {
    const starring = !targets.every((m) => m.starred);
    const ids = targets.filter((m) => m.starred !== starring).map((m) => m.id);
    clearSelection();
    if (ids.length === 0) return;
    Promise.all(ids.map(toggleStar)).then(
      () =>
        showToast({
          message: starring ? 'Starred' : 'Unstarred',
          icon: 'star',
          durationMs: 5000,
          actionLabel: 'Undo',
          onAction: () => void Promise.all(ids.map(toggleStar)),
        }),
      () => showToast({ message: 'Couldn’t change the star on those messages', icon: 'alert', durationMs: 5000 }),
    );
  };

  // The conversation, not just its newest message: a row that archived one of
  // three messages would spring straight back.
  const swipeRow = useCallback(
    (visual: SwipeVisual, threadId: string) => {
      const thread = threads.current.get(threadId);
      if (thread) runSwipe(visual, thread.messages, null);
    },
    [runSwipe, threads],
  );

  const renderItem = useCallback(
    ({
      item,
      index,
    }: {
      item: { thread: Thread<InboxItem>; encryption: EncryptionState; junk: boolean; labels: string[] };
      index: number;
    }) => (
      <MailListRow
        id={item.thread.id}
        summary={item.thread.latest}
        encryption={item.encryption}
        // Only while merged: in a single-account inbox every row is from the
        // same mailbox, and saying so on each one is noise.
        mailbox={unified ? mailboxName(accounts, item.thread.latest.account) : undefined}
        count={item.thread.count}
        index={index}
        entry={entry}
        padding={rowPadding}
        selfAddress={session?.email}
        onPress={openRow}
        // `box: null` is the inbox — including every category filter over it,
        // which is what `category` then tells the row apart for.
        swipe={{
          box: null,
          junk: item.junk,
          category,
          // Marking spam and snoozing are written against the mailbox in front.
          // A merged row from another one is left alone rather than appearing
          // to work — see `swipe/swipe.ts`.
          foreign: item.thread.latest.account !== activeAccount,
        }}
        onSwipe={swipeRow}
        labels={item.labels}
        selecting={selecting}
        selected={selected.has(item.thread.id)}
        // A long press starts a selection; while one is up it adds to it.
        onLongPress={toggleSelected}
      />
    ),
    // `accounts` and `unified` are read above, so they belong here: without
    // them the row renderer keeps the values it closed over on first render —
    // when nothing was merged — and the mailbox label never appears.
    [
      accounts,
      activeAccount,
      category,
      entry,
      openRow,
      rowPadding,
      selected,
      selecting,
      swipeRow,
      session?.email,
      toggleSelected,
      unified,
    ],
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
          {...MAIL_LIST_WINDOW}
          {...composeScroll}
          sections={sections}
          keyExtractor={(item) => item.thread.id}
          renderItem={renderItem}
          extraData={selected}
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
            // `refreshingInbox`, not `loadingInbox`: the spinner answers the
            // pull, and the syncs nobody asked for happen behind the list.
            <RefreshControl
              refreshing={refreshingInbox}
              onRefresh={() => void refreshInbox({ manual: true })}
              tintColor={accent}
            />
          }
          ListEmptyComponent={
            loadingInbox ? null : query.trim().length > 0 || filter !== 'all' || labelFilter ? (
              <EmptyState
                icon="search"
                title="Nothing matched"
                hint="Encrypted mail becomes searchable by its subject and body once you've opened it on this device."
                action={<SecondaryButton title="Clear filters" icon="close" onPress={clearFilters} />}
              />
            ) : category !== null ? (
              // A chosen category with nothing in it is not a failed search, and
              // the search copy above read as one — the reason this branch exists.
              <EmptyState
                icon={category === 'spam' ? 'junk' : 'inbox'}
                title={`Nothing in ${CATEGORY_LABELS[category]}`}
                hint={
                  category === 'spam'
                    ? 'Mail your provider filed as junk shows here, and so does mail this device flagged. Pull down to check for new mail.'
                    : 'Mail filed here appears as it arrives. Pull down to check for new mail.'
                }
                action={<SecondaryButton title="Show all mail" icon="close" onPress={() => setDestination('inbox')} />}
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

      {/* The Snooze swipe's picker. Mounted once, by the list, rather than once
          per row — a mail list holds hundreds of them. */}
      {snoozePicker}

      {selecting ? (
        <BulkBar
          count={selected.size}
          bottom={insets.bottom + 16}
          anyUnread={targets.some((m) => m.unread)}
          allStarred={targets.length > 0 && targets.every((m) => m.starred)}
          onCancel={clearSelection}
          onSelectAll={
            selected.size < threadsById.size ? () => setPicked(new Set(threadsById.keys())) : undefined
          }
          onArchive={() => bulk('archive')}
          onTrash={() => bulk('trash')}
          onToggleRead={() => bulk(targets.some((m) => m.unread) ? 'mark-read' : 'mark-unread')}
          onToggleStar={bulkStar}
          onLabel={() => setLabelling(targets.map((m) => m.id))}
        />
      ) : null}

      {/* Held on the ids it was opened with rather than the live selection:
          labelling can take a row out of a label-filtered list mid-sheet, and
          the rest of the selection must not change under the reader's thumb.
          The selection ends when the sheet closes. */}
      <LabelSheet
        visible={labelling !== null}
        messageIds={labelling ?? []}
        onClose={() => {
          setLabelling(null);
          clearSelection();
        }}
      />
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
