import { DrawerScreenProps } from '@react-navigation/drawer';
import { CompositeScreenProps } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { MotiView } from 'moti';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cryptoMode } from '../config';
import { categorizeMessage, CATEGORY_LABELS } from '../categorizer/categorizer';
import { displayName, initials, relativeTime } from '../lib/format';
import { MailSummary } from '../mail/types';
import { AccountId, AccountRef } from '../store/accountScope';
import { messageMatchesQuery } from '../search/search';
import { groupIntoThreads, Thread } from '../threads/threads';
import { EncryptionState, useApp } from '../state/AppState';
import { InboxItem } from '../state/types';
import { color, font, radius, shadow, space, type } from '../theme';
import { InboxDrawerParamList, RootStackParamList } from '../navigation';
import { Icon } from '../ui/Icon';
import { useAccent, useAppearance } from '../ui/appearance';
import { INBOX_TABS, InboxTab, showsUnderTab } from '../ui/focusedSplit';
import { useCategoryFilter } from '../ui/inboxFilter';
import {
  Avatar,
  EmptyState,
  Field,
  IconButton,
  Input,
  PressableRow,
  SecondaryButton,
  Segmented,
  Sheet,
  Skeleton,
  useFocus,
} from '../ui/primitives';

type Props = CompositeScreenProps<
  DrawerScreenProps<InboxDrawerParamList, 'Inbox'>,
  NativeStackScreenProps<RootStackParamList>
>;

/**
 * Filters that matter for this product: everything, protected, or needs a
 * decision.
 *
 * These used to be pills across the top bar. They now live behind the Filter
 * control, which is where the reference puts a filter and where they stop
 * competing with the Focused/Other tabs for the same strip of screen.
 */
type Filter = 'all' | 'encrypted' | 'attention';

const FILTERS: { key: Filter; label: string; hint: string }[] = [
  { key: 'all', label: 'All mail', hint: 'Everything in this mailbox' },
  { key: 'encrypted', label: 'Encrypted', hint: 'Only mail that arrived protected' },
  { key: 'attention', label: 'Needs attention', hint: 'A key changed, or a sender has no key on file' },
];

/** Inbox — encryption state on every row, at a glance. */
export function InboxScreen({ navigation }: Props) {
  const {
    session,
    accounts,
    unified,
    switchingAccount,
    messages,
    loadingInbox,
    error,
    refreshInbox,
    encryptionFor,
    searchIndex,
    toggleStar,
    spam,
  } = useApp();
  const { category, setCategory } = useCategoryFilter();
  const { rowPadding } = useAppearance();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [tab, setTab] = useState<InboxTab>('focused');
  const [filter, setFilter] = useState<Filter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [fabPressed, setFabPressed] = useState(false);
  const search = useFocus();

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
        if (filter === 'encrypted' && !encrypted) return false;
        if (filter === 'attention' && !needsAttention(encryption)) return false;
        // The drawer's category filter and the tabs both read only on-device
        // content, exactly like search: categorizeMessage classifies unopened
        // encrypted mail as 'primary' rather than reading its ciphertext
        // (categorizer/categorizer.ts).
        const messageCategory = categorizeMessage(summary, encrypted, searchIndex, spamContext);
        // A chosen category is the more specific request, so it wins over the
        // tab — otherwise picking Promotions from the drawer while Focused is
        // selected would show an empty list and look broken.
        if (category !== null) {
          if (messageCategory !== category) return false;
        } else if (!showsUnderTab(messageCategory, tab)) {
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

    const buckets = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = dayBucket(row.thread.latest.date);
      const list = buckets.get(bucket);
      if (list) list.push(row);
      else buckets.set(bucket, [row]);
    }
    return [...buckets].map(([title, data]) => ({ title, data }));
  }, [category, encryptionFor, filter, messages, query, searchIndex, spamContext, tab]);

  const attention = useMemo(
    () => messages.filter((m) => needsAttention(encryptionFor(m))).length,
    [encryptionFor, messages],
  );
  const firstLoad = loadingInbox && messages.length === 0;
  const filtering = query.trim().length > 0 || filter !== 'all' || category !== null;

  const renderItem = useCallback(
    ({ item, index }: { item: { thread: Thread<InboxItem>; encryption: EncryptionState }; index: number }) => (
      <MailRow
        summary={item.thread.latest}
        encryption={item.encryption}
        // Only while merged: in a single-account inbox every row is from the
        // same mailbox, and saying so on each one is noise.
        mailbox={unified ? mailboxName(accounts, item.thread.latest.account) : undefined}
        count={item.thread.count}
        index={index}
        padding={rowPadding}
        onToggleStar={() => void toggleStar(item.thread.latest.id)}
        onPress={() =>
          item.thread.count > 1
            ? navigation.navigate('Conversation', { threadId: item.thread.id })
            : navigation.navigate('Message', { id: item.thread.latest.id })
        }
      />
    ),
    // `accounts` and `unified` are read above, so they belong here: without
    // them the row renderer keeps the values it closed over on first render —
    // when nothing was merged — and the mailbox label never appears.
    [accounts, navigation, rowPadding, toggleStar, unified],
  );

  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        {searching ? (
          <View style={s.header}>
            <IconButton icon="back" label="Close search" onPress={closeSearch} />
            <Field focused={search.focused} style={s.searchField}>
              <View style={s.searchRow}>
                <Icon name="search" size={16} color={search.focused ? accent : color.inkFaint} />
                <Input
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  onChangeText={setQuery}
                  placeholder="Search sender or subject"
                  returnKeyType="search"
                  style={s.searchInput}
                  value={query}
                  {...search.bind}
                />
                {query.length > 0 ? (
                  <Pressable accessibilityLabel="Clear search" hitSlop={10} onPress={() => setQuery('')}>
                    <Icon name="close" size={16} color={color.inkDim} />
                  </Pressable>
                ) : null}
              </View>
            </Field>
          </View>
        ) : (
          <View style={s.header}>
            {/* The account avatar is the drawer handle, as in the reference —
                the rail behind it is where mailboxes are switched. */}
            <Pressable
              accessibilityLabel="Accounts and folders"
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => navigation.openDrawer()}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <Avatar seed={session?.email ?? ''} label={initials(session?.email ?? '')} size={36} />
            </Pressable>
            <View style={s.titleWrap}>
              <Text numberOfLines={1} style={s.headerTitle}>
                {category ? CATEGORY_LABELS[category] : 'Inbox'}
              </Text>
              {/* Which mailbox is in front, and only when that is ambiguous — a
                  merged inbox still composes, sends and decrypts as exactly one
                  account, so the reader must be able to see which. */}
              {switchingAccount || unified ? (
                <Text numberOfLines={1} style={s.headerSub}>
                  {switchingAccount ? 'Switching…' : `${session?.email ?? ''} · all accounts`}
                </Text>
              ) : null}
            </View>
            {category !== null ? (
              <IconButton icon="close" label="Show all mail" onPress={() => setCategory(null)} />
            ) : null}
            <IconButton icon="refresh" label="Refresh" onPress={() => void refreshInbox()} size={40} />
            <IconButton icon="search" label="Search" onPress={() => setSearching(true)} size={40} />
          </View>
        )}

        {/* Rule 2: the demo core must never be presented as secure. The mail
            half can no longer be fake, so this strip is now only ever about
            the crypto — and that is the half that matters, because a real
            mailbox makes everything on screen look like the product. */}
        {cryptoMode === 'demo' ? (
          <View style={s.demoStrip}>
            <Icon name="alert" size={13} color={color.coral} />
            <Text style={s.demoText}>DEMO CRYPTO · nothing here is really encrypted</Text>
          </View>
        ) : null}

        <View style={s.controls}>
          <Segmented options={INBOX_TABS} value={tab} onChange={setTab} />
          <Pressable
            accessibilityLabel="Filter"
            accessibilityRole="button"
            onPress={() => setFilterOpen(true)}
            style={({ pressed }) => [s.filterPill, pressed && { backgroundColor: color.segmentActive }]}
          >
            <Text style={s.filterText}>Filter</Text>
            {filter !== 'all' ? <View style={[s.filterDot, { backgroundColor: accent }]} /> : null}
          </Pressable>
        </View>
      </View>

      {error ? (
        <View style={s.errorRow}>
          <Icon name="alert" size={14} color={color.coral} />
          <Text style={s.error}>{error}</Text>
        </View>
      ) : null}

      {firstLoad ? (
        <View>
          {[0, 1, 2, 3, 4].map((i) => (
            <SkeletonRow key={i} />
          ))}
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.thread.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => <Text style={s.sectionHead}>{section.title}</Text>}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
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
                action={
                  <SecondaryButton
                    title="Clear filters"
                    icon="close"
                    onPress={() => {
                      setQuery('');
                      setFilter('all');
                      setCategory(null);
                    }}
                  />
                }
              />
            ) : (
              <EmptyState
                icon="inbox"
                title={tab === 'focused' ? 'Nothing in Focused' : 'Nothing in Other'}
                hint="Pull down to check for new mail."
              />
            )
          }
        />
      )}

      <MotiView
        from={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: fabPressed ? 0.92 : 1 }}
        transition={{ type: 'spring', damping: 15, stiffness: 220, mass: 0.7 }}
        style={[s.fab, shadow.floating, { backgroundColor: accent, bottom: insets.bottom + 22 }]}
      >
        <Pressable
          accessibilityLabel="Compose"
          accessibilityRole="button"
          onPress={() => navigation.navigate('Compose', {})}
          onPressIn={() => setFabPressed(true)}
          onPressOut={() => setFabPressed(false)}
          style={s.fabPress}
        >
          <Icon name="edit" size={23} color={color.ground} strokeWidth={2} />
        </Pressable>
      </MotiView>

      <Sheet
        bottomInset={insets.bottom}
        onClose={() => setFilterOpen(false)}
        title="Filter"
        visible={filterOpen}
      >
        {FILTERS.map((f) => (
          <PressableRow
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f.key }}
            key={f.key}
            onPress={() => {
              setFilter(f.key);
              setFilterOpen(false);
            }}
            style={s.filterRow}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.filterRowLabel}>{f.label}</Text>
              <Text style={s.filterRowHint}>{f.hint}</Text>
            </View>
            {f.key === 'attention' && attention > 0 ? (
              <View style={s.attentionCount}>
                <Text style={s.attentionCountText}>{attention}</Text>
              </View>
            ) : null}
            {filter === f.key ? <Icon name="check" size={19} color={accent} strokeWidth={2.4} /> : null}
          </PressableRow>
        ))}
      </Sheet>
    </View>
  );
}

/* ----------------------------------------------------------------- rows ---- */

function MailRow({
  summary,
  encryption,
  mailbox,
  count = 1,
  index,
  padding,
  onPress,
  onToggleStar,
}: {
  summary: MailSummary;
  encryption: EncryptionState;
  /**
   * Which mailbox this row came from, shown only while the inbox is merged.
   *
   * A merged list without it is unreadable in the way that matters: the reply
   * it prompts goes out from whichever account is in front, and the reader has
   * no way to tell that is not the one the message arrived in.
   */
  mailbox?: string;
  /** Number of messages in this conversation; > 1 shows a thread-count chip. */
  count?: number;
  index: number;
  /** Vertical padding for the current density. */
  padding: number;
  onPress: () => void;
  onToggleStar: () => void;
}) {
  const accent = useAccent();
  const name = displayName(summary.from.address, summary.from.name);
  const lock = lockFor(encryption);
  const encrypted = encryption.kind === 'encrypted';

  return (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      // Capped so a long inbox settles quickly instead of dribbling in.
      transition={{ type: 'timing', duration: 300, delay: Math.min(index, 8) * 45 }}
    >
      <View style={s.row}>
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          style={({ pressed }) => [s.rowTap, { paddingVertical: padding }, pressed && s.rowPressed]}
        >
          <Avatar seed={summary.from.address} label={initials(name)} size={44} />
          <View style={s.rowMain}>
            <View style={s.rowTop}>
              <Text numberOfLines={1} style={[s.from, summary.unread && s.fromUnread]}>
                {name}
              </Text>
              {/* The lock is furniture: it must be findable on every row without
                  out-shouting the subject, so it sits beside the date at the
                  size of the date, not as a captioned badge. */}
              <Icon
                name={lock.icon}
                size={13}
                color={lock.tint}
                {...(lock.icon === 'lock' ? { fill: lock.tint } : {})}
              />
              <Text style={[s.time, { color: accent }]} accessibilityLabel={lock.label}>
                {relativeTime(summary.date)}
              </Text>
            </View>
            <View style={s.rowTop}>
              <Text numberOfLines={1} style={[s.subject, summary.unread && s.subjectUnread]}>
                {encrypted ? 'Encrypted message' : summary.subject}
              </Text>
              {count > 1 ? (
                <View style={s.threadChip} accessibilityLabel={`${count} messages in this conversation`}>
                  <Text style={s.threadChipText}>{count}</Text>
                </View>
              ) : null}
            </View>
            {/* The stored snippet of an encrypted mail is ciphertext — showing it
                would be noise. Say what the row actually means instead. */}
            <Text numberOfLines={1} style={[s.snippet, encrypted && s.snippetLocked]}>
              {encrypted ? 'Contents decrypt on this device when you open it.' : summary.snippet}
            </Text>
            {mailbox ? (
              <Text numberOfLines={1} style={s.mailbox} accessibilityLabel={`In ${mailbox}`}>
                {mailbox}
              </Text>
            ) : null}
          </View>
        </Pressable>
        {/* Sibling of the row's Pressable, not nested — nested <button>s are
            invalid on web and would let a star tap bubble into opening the row. */}
        <Pressable
          accessibilityLabel={summary.starred ? 'Unstar' : 'Star'}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onToggleStar}
          style={({ pressed }) => [s.star, pressed && { opacity: 0.6 }]}
        >
          <Icon
            name="star"
            size={18}
            color={summary.starred ? accent : color.inkFaint}
            fill={summary.starred ? accent : 'none'}
          />
        </Pressable>
        {summary.unread ? <View style={[s.unreadDot, { backgroundColor: accent }]} /> : null}
      </View>
    </MotiView>
  );
}

function SkeletonRow() {
  return (
    <View style={s.skelRow}>
      <Skeleton width={44} height={44} radius={22} />
      <View style={{ flex: 1, gap: 8 }}>
        <Skeleton width="55%" height={12} />
        <Skeleton width="80%" height={12} />
        <Skeleton width="40%" height={11} />
      </View>
    </View>
  );
}

/* -------------------------------------------------------------- helpers ---- */

/** The address behind an account id — what a row shows, never the id itself. */
function mailboxName(accounts: AccountRef[], id: AccountId): string {
  return accounts.find((a) => a.id === id)?.email ?? id;
}

function needsAttention(encryption: EncryptionState): boolean {
  return encryption.kind === 'encrypted' && (encryption.trust === 'changed' || encryption.trust === 'unknown');
}

/**
 * Date buckets, matching the reference's headings.
 *
 * "This month" and "Last week" only ever appear below Today/Yesterday, so the
 * list reads as a single descending timeline rather than a set of overlapping
 * ranges.
 */
function dayBucket(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 14) return 'Last week';
  if (days < 31) return 'This month';
  return 'Earlier';
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * The row's encryption glyph.
 *
 * Trust colour is fixed at every accent — mint for protected, coral for a
 * decision the user has to make. `label` is what a screen reader announces on
 * the row, so the state is never colour-only.
 */
function lockFor(encryption: EncryptionState): { icon: 'lock' | 'alert' | 'mail'; tint: string; label: string } {
  if (encryption.kind === 'plain') return { icon: 'mail', tint: color.inkFaint, label: 'Not encrypted' };
  if (encryption.own) return { icon: 'lock', tint: color.mint, label: 'Encrypted, from you' };
  switch (encryption.trust) {
    case 'verified':
      return { icon: 'lock', tint: color.mint, label: 'Encrypted, verified key' };
    case 'seen':
      return { icon: 'lock', tint: color.mint, label: 'Encrypted, key not verified' };
    case 'changed':
      return { icon: 'alert', tint: color.coral, label: 'Encrypted, key changed' };
    default:
      return { icon: 'alert', tint: color.coral, label: 'Encrypted, no key on file' };
  }
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  topbar: { backgroundColor: color.surface },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  titleWrap: { flex: 1 },
  headerTitle: { ...type.display, color: color.ink },
  headerSub: { ...type.small, color: color.inkDim, marginTop: 1 },

  searchField: { flex: 1, marginBottom: 0, paddingVertical: 9 },
  searchRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  searchInput: { flex: 1, fontSize: 15 },

  demoStrip: {
    alignItems: 'center',
    backgroundColor: color.coralBg,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
  },
  demoText: { color: color.coralInk, fontFamily: font.mono, fontSize: 10.5, letterSpacing: 0.6 },

  controls: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  filterPill: {
    alignItems: 'center',
    backgroundColor: color.segment,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  filterText: { color: color.ink, fontFamily: font.sansMedium, fontSize: 15 },
  filterDot: { borderRadius: 3, height: 6, width: 6 },

  filterRow: { alignItems: 'center', flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 13 },
  filterRowLabel: { ...type.settingsRow, color: color.ink },
  filterRowHint: { ...type.settingsValue, color: color.inkFaint, marginTop: 1 },
  attentionCount: {
    backgroundColor: color.coralBg,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 2,
  },
  attentionCountText: { color: color.coralInk, fontFamily: font.sansSemibold, fontSize: 12 },

  errorRow: {
    alignItems: 'center',
    backgroundColor: color.coralBg,
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  error: { ...type.small, color: color.coralInk, flex: 1 },

  sectionHead: {
    ...type.settingsValue,
    color: color.inkDim,
    paddingBottom: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },

  row: { borderBottomColor: color.line, borderBottomWidth: 1 },
  rowTap: { alignItems: 'flex-start', flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  rowPressed: { backgroundColor: color.rowPress },
  rowMain: { flex: 1, gap: 2, paddingRight: 22 },
  rowTop: { alignItems: 'center', flexDirection: 'row', gap: space.sm },

  from: { ...type.row, color: color.inkDim, flex: 1 },
  fromUnread: { color: color.ink, fontFamily: font.sansBold },
  time: { ...type.date },
  subject: { ...type.rowSubject, color: color.inkDim, flex: 1 },
  subjectUnread: { color: color.ink, fontFamily: font.sansBold },
  snippet: { ...type.rowSub, color: color.inkFaint },
  snippetLocked: { fontFamily: font.sans, fontStyle: 'italic' },
  mailbox: { ...type.meta, color: color.inkFaint, marginTop: 3 },

  threadChip: { backgroundColor: color.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  threadChipText: { color: color.inkDim, fontFamily: font.sansSemibold, fontSize: 11 },

  star: { padding: 6, position: 'absolute', right: space.sm, top: 10 },
  unreadDot: { borderRadius: 4, height: 8, left: 5, position: 'absolute', top: 26, width: 8 },

  skelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },

  fab: {
    alignItems: 'center',
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    position: 'absolute',
    right: 20,
    width: 56,
  },
  fabPress: { alignItems: 'center', height: '100%', justifyContent: 'center', width: '100%' },
});
