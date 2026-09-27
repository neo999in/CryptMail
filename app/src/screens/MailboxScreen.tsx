/**
 * Sent, Archive and Trash — the mailboxes that are not the inbox.
 *
 * One screen, parameterised, because they differ in three details and nothing
 * else: the title, the empty state, and which address a row leads with (Sent
 * shows who it went *to*; there is no point telling you that you sent it — and
 * that rule lives in `ui/mailRow.tsx`, keyed on the active account, so the
 * closing transition's ghost reaches the same answer).
 *
 * Trash is one of them rather than a category because deleted mail is a *place*
 * the provider moved the message to, not a verdict this app formed about it —
 * which is also why nothing here empties it. Deleting is reversible from the
 * message itself (`screens/MessageScreen.tsx`), and permanent erasure stays the
 * provider's own action.
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hasLabel, labelNamesFor } from '../labels/labels';
import { messageMatchesQuery } from '../search/search';
import { EncryptionState, useApp } from '../state/AppState';
import { InboxItem, SecondaryBox } from '../state/types';
import { SwipeVisual } from '../swipe/swipe';
import { color, space, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { useAccent, useAppearance } from '../ui/appearance';
import { BulkBar } from '../ui/bulkBar';
import { useChrome } from '../ui/chrome';
import { OriginRect } from '../ui/expand';
import { mailBandBelow, mailTopInset } from '../ui/mailBar';
import { needsAttention } from '../ui/mailFilter';
import {
  groupByDay,
  MAIL_LIST_WINDOW,
  MailListRow,
  MailSkeletonList,
  SectionHeading,
  AnimatedSectionList,
  useComposeScroll,
} from '../ui/mailList';
import { EmptyState, SecondaryButton } from '../ui/primitives';
import { LabelSheet } from '../ui/labelSheet';
import { MailOperation, useSwipeRunner } from '../ui/swipeRun';
import { useToast } from '../ui/ToastContext';
import { useLatest } from '../ui/useLatest';
import { BodyProps } from './HomeScreen';

/** One row of this list: the message, and the trust state drawn on it. */
type BoxRow = { item: InboxItem; encryption: EncryptionState; labels: string[] };

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
  trash: {
    title: 'Trash',
    empty: 'Trash is empty',
    hint: 'Deleted mail waits here, and opening it offers Restore. CryptMail never erases mail from the server — your provider empties the trash on its own schedule.',
    icon: 'trash',
  },
};

export function MailboxBody({
  navigation,
  box,
  query,
  tab,
  filter,
  headerHeight,
  barHeight,
  clearFilters,
  entry,
  labelFilter,
  onSelecting,
  composeFold,
}: BodyProps & { box: SecondaryBox }) {
  const composeScroll = useComposeScroll(composeFold);
  const { boxes, loadBox, loadMoreBox, encryptionFor, searchIndex, session, labels, toggleStar } = useApp();
  const { showToast } = useToast();
  const { items, loading, refreshing, loadingMore, canLoadMore, error } = boxes[box];
  const { rowPadding } = useAppearance();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { setOverlay } = useChrome();
  const isFocused = useIsFocused();
  // One runner, and one snooze sheet, for the whole list — see `ui/swipeRun.tsx`.
  // A side nobody has configured offers the setup screen rather than an action.
  const { runSwipe, runOperation, snoozePicker } = useSwipeRunner({
    onSetUp: () => navigation.navigate('SwipeOptions'),
  });
  const copy = COPY[box];

  /**
   * Make sure this box is loaded — without re-fetching one that already is.
   *
   * `ifStale` is what makes leaving Archive and coming back free. Before it,
   * every arrival here was a provider round trip for a list that was already in
   * state and already on screen, which is most of what "switching is slow" was.
   * A deliberate Refresh, and every other caller, still fetches unconditionally.
   */
  useEffect(() => {
    void loadBox(box, { ifStale: true });
  }, [box, loadBox]);

  /**
   * Back to the top when the box changes.
   *
   * This is what the removed `key={box}` was for. Doing it here keeps the body
   * mounted, so the arriving list is drawn from state on the same frame instead
   * of being rebuilt — see the note at the call site in `HomeScreen`.
   *
   * `scrollTo` on the underlying scroll view rather than `scrollToLocation`,
   * which throws on an empty section list — a box with nothing in it yet is
   * exactly the case this runs in.
   */
  const listRef = useRef<SectionList<BoxRow, { title: string; data: BoxRow[] }>>(null);
  useEffect(() => {
    listRef.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false });
  }, [box]);

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
        // Labels outlive the inbox: an archived message keeps what it was filed under.
        if (labelFilter && !hasLabel(labels, [item.id], labelFilter)) return false;
        // Encrypted mail is matched on its decrypted content once opened.
        return messageMatchesQuery(item, encrypted, searchIndex, query);
      })
      .map((row) => ({ ...row, labels: labelNamesFor(labels, [row.item.id]) }));
    const out = groupByDay(rows, (row) => row.item.date);
    return out;
  }, [encryptionFor, filter, items, labelFilter, labels, query, searchIndex, tab]);

  const filtering = query.trim().length > 0 || tab !== 'primary' || filter !== 'all' || !!labelFilter;

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
   * The messages in this box, by id, read through `useLatest` so the swipe
   * handler is built once — the same arrangement as the inbox, and for the same
   * reason: a handler that changed with the data would re-render every
   * memoised row (`ui/mailList.tsx`).
   */
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item] as const)), [items]);
  const latestItems = useLatest(itemsById);

  /**
   * The selected messages, by id — the inbox's arrangement (`InboxBody`), one
   * message per row. Read back through what is on screen, so a row a sync or a
   * filter took away is no longer selected and the bar never acts on it.
   */
  const visibleIds = useMemo(
    () => new Set(sections.flatMap((section) => section.data.map((row) => row.item.id))),
    [sections],
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(() => new Set([...picked].filter((id) => visibleIds.has(id))), [picked, visibleIds]);
  const selecting = selected.size > 0;
  const selectingNow = useLatest(selecting);
  const [labelling, setLabelling] = useState<string[] | null>(null);

  const clearSelection = useCallback(() => setPicked(new Set()), []);
  const toggleSelected = useCallback(
    (id: string) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  // Another box is another list: a selection made in Sent does not follow the
  // reader into Archive.
  useEffect(() => clearSelection(), [box, clearSelection]);

  useEffect(() => {
    onSelecting(selecting);
  }, [onSelecting, selecting]);

  // Back leaves the selection before it leaves anything else.
  useEffect(() => {
    if (!selecting || !isFocused) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      clearSelection();
      return true;
    });
    return () => sub.remove();
  }, [clearSelection, isFocused, selecting]);

  const openRow = useCallback(
    (id: string, origin?: OriginRect) => {
      // Selecting, a tap adds or removes the row; it never opens mail.
      if (selectingNow.current) toggleSelected(id);
      else openMail(id, origin);
    },
    [openMail, selectingNow, toggleSelected],
  );

  const targets = useMemo(
    () => [...selected].flatMap((id) => itemsById.get(id) ?? []),
    [itemsById, selected],
  );

  /** Run one of the swipe's own operations over the selection, then leave it. */
  const bulk = (operation: MailOperation) => {
    runOperation(operation, targets, box);
    clearSelection();
  };

  /** Star or unstar the whole selection — the inbox's `bulkStar`, over this box. */
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

  // One message, not a conversation: these lists are not threaded.
  const swipeRow = useCallback(
    (visual: SwipeVisual, id: string) => {
      const item = latestItems.current.get(id);
      if (item) runSwipe(visual, [item], box);
    },
    [box, latestItems, runSwipe],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: BoxRow; index: number }) => (
      <MailListRow
        id={item.item.id}
        summary={item.item}
        encryption={item.encryption}
        index={index}
        entry={entry}
        padding={rowPadding}
        selfAddress={session?.email}
        onPress={openRow}
        // The list itself is the context. Sent swipes to Delete alone and
        // Archive to Delete and Move to inbox, whatever the preference says;
        // Trash follows the preference, with Delete becoming Restore
        // (`swipe/swipe.ts`). These lists are the active account's alone, so no
        // row here is ever another mailbox's.
        swipe={{ box, junk: false, category: null, foreign: false }}
        onSwipe={swipeRow}
        labels={item.labels}
        selecting={selecting}
        selected={selected.has(item.item.id)}
        // A long press starts a selection; while one is up it adds to it.
        onLongPress={toggleSelected}
      />
    ),
    [box, entry, openRow, rowPadding, selected, selecting, swipeRow, session?.email, toggleSelected],
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
        <AnimatedSectionList
          ref={listRef}
          {...MAIL_LIST_WINDOW}
          {...composeScroll}
          sections={sections}
          keyExtractor={(row) => row.item.id}
          renderItem={renderItem}
          extraData={selected}
          renderSectionHeader={({ section }) => <SectionHeading title={section.title} />}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            // `refreshing`, not `loading` — see the inbox: only a pull puts a
            // spinner up, and the load this screen runs on mount is silent.
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void loadBox(box, { manual: true })}
              tintColor={accent}
            />
          }
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

      {/* Mounted once by the list rather than once per row. Nothing in these
          three lists resolves to Snooze today; it is here so that stays a fact
          about the resolver rather than about which screen wired what. */}
      {snoozePicker}

      {selecting ? (
        <BulkBar
          count={selected.size}
          bottom={insets.bottom + 16}
          anyUnread={targets.some((m) => m.unread)}
          allStarred={targets.length > 0 && targets.every((m) => m.starred)}
          onCancel={clearSelection}
          onSelectAll={selected.size < visibleIds.size ? () => setPicked(new Set(visibleIds)) : undefined}
          box={box}
          onMove={bulk}
          onToggleRead={() => bulk(targets.some((m) => m.unread) ? 'mark-read' : 'mark-unread')}
          onToggleStar={bulkStar}
          onLabel={() => setLabelling(targets.map((m) => m.id))}
        />
      ) : null}

      {/* Held on the ids it was opened with — see the same sheet in the inbox. */}
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
