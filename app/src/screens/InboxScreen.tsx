import { DrawerScreenProps } from '@react-navigation/drawer';
import { CompositeScreenProps } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BlurView } from 'expo-blur';
import { MotiView } from 'moti';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { appMode, cryptoMode, mailMode } from '../config';
import { categorizeMessage, CATEGORY_LABELS } from '../categorizer/categorizer';
import { displayName, initials, relativeTime } from '../lib/format';
import { MailSummary } from '../mail/types';
import { messageMatchesQuery } from '../search/search';
import { groupIntoThreads, Thread } from '../threads/threads';
import { EncryptionState, useApp } from '../state/AppState';
import { color, font, glass, radius, shadow, space, type } from '../theme';
import { InboxDrawerParamList, RootStackParamList } from '../navigation';
import { Icon, IconName } from '../ui/Icon';
import { useCategoryFilter } from '../ui/inboxFilter';
import {
  Avatar,
  Badge,
  BadgeTone,
  EmptyState,
  Field,
  Glass,
  frost,
  IconButton,
  Input,
  SectionLabel,
  SecondaryButton,
  Skeleton,
  useFocus,
} from '../ui/primitives';

type Props = CompositeScreenProps<
  DrawerScreenProps<InboxDrawerParamList, 'Inbox'>,
  NativeStackScreenProps<RootStackParamList>
>;

/** Filters that matter for this product: everything, protected, or needs a decision. */
type Filter = 'all' | 'encrypted' | 'attention';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'encrypted', label: 'Encrypted' },
  { key: 'attention', label: 'Attention' },
];

/** Inbox — encryption state on every row, at a glance. */
export function InboxScreen({ navigation }: Props) {
  const { session, messages, loadingInbox, error, refreshInbox, encryptionFor, signOut, searchIndex, toggleStar } =
    useApp();
  const { category, setCategory } = useCategoryFilter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [menuOpen, setMenuOpen] = useState(false);
  const [fabPressed, setFabPressed] = useState(false);
  const search = useFocus();

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);

  /** One pass: decorate with encryption state, then filter, then group by day. */
  const sections = useMemo(() => {
    const visible = messages
      .map((summary) => ({ summary, encryption: encryptionFor(summary) }))
      .filter(({ summary, encryption }) => {
        const encrypted = encryption.kind === 'encrypted';
        if (filter === 'encrypted' && !encrypted) return false;
        if (filter === 'attention' && !needsAttention(encryption)) return false;
        // The drawer's category filter reads only on-device content, exactly like
        // search: categorizeMessage classifies unopened encrypted mail as 'primary'
        // rather than reading its ciphertext (categorizer/categorizer.ts).
        if (category !== null && categorizeMessage(summary, encrypted, searchIndex) !== category) return false;
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
  }, [category, encryptionFor, filter, messages, query, searchIndex]);

  const unread = messages.filter((m) => m.unread).length;
  const attention = useMemo(
    () => messages.filter((m) => needsAttention(encryptionFor(m))).length,
    [encryptionFor, messages],
  );
  const firstLoad = loadingInbox && messages.length === 0;
  const filtering = query.trim().length > 0 || filter !== 'all' || category !== null;

  const renderItem = useCallback(
    ({ item, index }: { item: { thread: Thread; encryption: EncryptionState }; index: number }) => (
      <MailRow
        summary={item.thread.latest}
        encryption={item.encryption}
        count={item.thread.count}
        index={index}
        onToggleStar={() => void toggleStar(item.thread.latest.id)}
        onPress={() =>
          item.thread.count > 1
            ? navigation.navigate('Conversation', { threadId: item.thread.id })
            : navigation.navigate('Message', { id: item.thread.latest.id })
        }
      />
    ),
    [navigation, toggleStar],
  );

  const confirmSignOut = () => {
    setMenuOpen(false);
    Alert.alert('Sign out?', 'Your keys stay on this device. You can reconnect the same mailbox any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  return (
    <View style={s.screen}>
      <Glass
        radius={0}
        border="transparent"
        fill={glass.fillStrong}
        intensity={glass.blur.strong}
        contentStyle={{ paddingTop: insets.top + 6 }}
        style={s.topbar}
      >
        <View style={s.header}>
          <IconButton icon="menu" label="Categories" onPress={() => navigation.openDrawer()} />
          <Pressable
            accessibilityLabel="Account"
            accessibilityRole="button"
            onPress={() => setMenuOpen(true)}
            style={({ pressed }) => [s.identity, pressed && { opacity: 0.7 }]}
          >
            <View style={s.titleRow}>
              <Text numberOfLines={1} style={s.headerTitle}>
                {category ? CATEGORY_LABELS[category] : 'Inbox'}
              </Text>
              {/* The count is the mailbox's total unread; beside a category label it
                  would read as that category's count, so it only shows unfiltered. */}
              {category === null && unread > 0 ? (
                <View style={s.count}>
                  <Text style={s.countText}>{unread}</Text>
                </View>
              ) : null}
            </View>
            <View style={s.subRow}>
              <Text numberOfLines={1} style={s.headerSub}>
                {session?.email ?? ''}
              </Text>
              <Icon name="chevron" size={11} color={color.inkFaint} />
            </View>
          </Pressable>
          {/* A sibling of the identity button, never nested — clears the drawer's
              category filter back to All mail. */}
          {category !== null ? (
            <IconButton icon="close" label="Show all mail" onPress={() => setCategory(null)} />
          ) : null}
          <IconButton icon="edit" label="Drafts" onPress={() => navigation.navigate('Drafts')} />
          <IconButton icon="key" label="Keys" onPress={() => navigation.navigate('Keys')} />
          <IconButton icon="refresh" label="Refresh" onPress={() => void refreshInbox()} />
        </View>

        {appMode === 'demo' ? (
          <View style={s.demoStrip}>
            <Icon name="alert" size={13} color={color.brass} />
            {/* Name the half that is fake — "real Gmail, demo crypto" and its
                inverse mean very different things for the user's safety. */}
            <Text style={s.demoText}>
              {cryptoMode === 'demo' && mailMode === 'demo'
                ? 'DEMO MODE · fixtures, no real encryption'
                : cryptoMode === 'demo'
                  ? 'DEMO CRYPTO · real mailbox, nothing is really encrypted'
                  : 'DEMO MAILBOX · real encryption, fixture mail'}
            </Text>
          </View>
        ) : null}

        <View style={s.controls}>
          <Field focused={search.focused} style={s.searchField}>
            <View style={s.searchRow}>
              <Icon name="search" size={15} color={search.focused ? color.brass : color.inkFaint} />
              <Input
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setQuery}
                placeholder="Search sender or subject"
                returnKeyType="search"
                style={s.searchInput}
                value={query}
                {...search.bind}
              />
              {query.length > 0 ? (
                <Pressable accessibilityLabel="Clear search" hitSlop={10} onPress={() => setQuery('')}>
                  <Icon name="close" size={15} color={color.inkDim} />
                </Pressable>
              ) : null}
            </View>
          </Field>

          <View style={s.filters}>
            {FILTERS.map((f) => (
              <FilterPill
                key={f.key}
                active={filter === f.key}
                label={f.label}
                count={f.key === 'attention' ? attention : undefined}
                onPress={() => setFilter(f.key)}
              />
            ))}
          </View>
        </View>
      </Glass>

      {error ? (
        <View style={s.errorRow}>
          <Icon name="alert" size={14} color={color.coral} />
          <Text style={s.error}>{error}</Text>
        </View>
      ) : null}

      {firstLoad ? (
        <View style={{ paddingHorizontal: 16 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <SkeletonRow key={i} />
          ))}
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.thread.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => <SectionLabel style={s.sectionHead}>{section.title}</SectionLabel>}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 96, paddingHorizontal: 16 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={loadingInbox} onRefresh={() => void refreshInbox()} tintColor={color.brass} />
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
              <EmptyState icon="inbox" title="Inbox is empty" hint="Pull down to check for new mail." />
            )
          }
        />
      )}

      <MotiView
        from={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: fabPressed ? 0.92 : 1 }}
        transition={{ type: 'spring', damping: 15, stiffness: 220, mass: 0.7 }}
        style={[s.fab, { bottom: insets.bottom + 22 }]}
      >
        <Pressable
          accessibilityLabel="Compose"
          accessibilityRole="button"
          onPress={() => navigation.navigate('Compose', {})}
          onPressIn={() => setFabPressed(true)}
          onPressOut={() => setFabPressed(false)}
          style={s.fabPress}
        >
          <Icon name="plus" size={24} color={color.brassInk} strokeWidth={2.6} />
        </Pressable>
      </MotiView>

      <AccountSheet
        email={session?.email ?? ''}
        onClose={() => setMenuOpen(false)}
        onDrafts={() => {
          setMenuOpen(false);
          navigation.navigate('Drafts');
        }}
        onScheduled={() => {
          setMenuOpen(false);
          navigation.navigate('Scheduled');
        }}
        onKeys={() => {
          setMenuOpen(false);
          navigation.navigate('Keys');
        }}
        onSignOut={confirmSignOut}
        visible={menuOpen}
      />
    </View>
  );
}

/* ----------------------------------------------------------------- rows ---- */

function MailRow({
  summary,
  encryption,
  count = 1,
  index,
  onPress,
  onToggleStar,
}: {
  summary: MailSummary;
  encryption: EncryptionState;
  /** Number of messages in this conversation; > 1 shows a thread-count chip. */
  count?: number;
  index: number;
  onPress: () => void;
  onToggleStar: () => void;
}) {
  const name = displayName(summary.from.address, summary.from.name);
  const badge = badgeFor(encryption);
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
        style={({ pressed }) => [s.rowTap, pressed && s.rowPressed]}
      >
        <View style={s.rail}>
          <Avatar seed={summary.from.address} label={initials(name)} />
          {summary.unread ? <View style={s.unreadDot} /> : null}
        </View>
        <View style={s.rowMain}>
          <View style={s.rowTop}>
            <Text numberOfLines={1} style={[s.from, summary.unread && s.unread]}>
              {name}
            </Text>
            {count > 1 ? (
              <View style={s.threadChip} accessibilityLabel={`${count} messages in this conversation`}>
                <Icon name="mail" size={9} color={color.inkDim} />
                <Text style={s.threadChipText}>{count}</Text>
              </View>
            ) : null}
            <Text style={s.time}>{relativeTime(summary.date)}</Text>
          </View>
          <Text numberOfLines={1} style={[s.subject, summary.unread && s.subjectUnread]}>
            {encrypted ? 'Encrypted message' : summary.subject}
          </Text>
          {/* The stored snippet of an encrypted mail is ciphertext — showing it
              would be noise. Say what the row actually means instead. */}
          <Text numberOfLines={encrypted ? 1 : 2} style={[s.snippet, encrypted && s.snippetLocked]}>
            {encrypted ? 'Contents decrypt on this device when you open it.' : summary.snippet}
          </Text>
          <View style={s.badgeRow}>
            <Badge tone={badge.tone} icon={badge.icon}>
              {badge.label}
            </Badge>
          </View>
        </View>
      </Pressable>
      {/* Sibling of the row's Pressable, not nested — nested <button>s are
          invalid on web and would let a star tap bubble into opening the row. */}
      <Pressable
        accessibilityLabel={summary.starred ? 'Unstar' : 'Star'}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onToggleStar}
        style={({ pressed }) => [s.star, pressed && s.starPressed]}
      >
        <Icon
          name="star"
          size={17}
          color={summary.starred ? color.brass : color.inkFaint}
          fill={summary.starred ? color.brass : 'none'}
        />
      </Pressable>
    </View>
    </MotiView>
  );
}

function SkeletonRow() {
  return (
    <View style={s.skelRow}>
      <Skeleton width={34} height={34} radius={9} />
      <View style={{ flex: 1, gap: 7 }}>
        <Skeleton width="55%" height={11} />
        <Skeleton width="80%" height={10} />
        <Skeleton width="40%" height={10} />
        <Skeleton width={104} height={16} radius={radius.pill} />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------- controls ---- */

function FilterPill({
  active,
  label,
  count,
  onPress,
}: {
  active: boolean;
  label: string;
  count?: number;
  onPress: () => void;
}) {
  const warn = !!count && count > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [s.pill, active && s.pillActive, pressed && !active && { borderColor: color.inkFaint }]}
    >
      <Text style={[s.pillText, active && s.pillTextActive]}>{label}</Text>
      {warn ? (
        <View style={[s.pillCount, active && { backgroundColor: color.brassInk }]}>
          <Text style={[s.pillCountText, active && { color: color.brass }]}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Bottom sheet for the account — the only place sign-out lives. */
function AccountSheet({
  visible,
  email,
  onDrafts,
  onScheduled,
  onKeys,
  onSignOut,
  onClose,
}: {
  visible: boolean;
  email: string;
  onDrafts: () => void;
  onScheduled: () => void;
  onKeys: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={[s.scrim, frost(glass.blur.medium)]}>
        {Platform.OS !== 'web' ? <BlurView intensity={glass.blur.medium} tint="dark" style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim }]} />
      </Pressable>
      <Glass
        border="transparent"
        fill={glass.fillStrong}
        intensity={glass.blur.strong}
        radius={0}
        style={s.sheet}
        contentStyle={[s.sheetInner, { paddingBottom: insets.bottom + space.lg }]}
      >
        <View style={s.grabber} />
        <View style={s.sheetHead}>
          <Avatar seed={email} label={initials(email)} size={38} />
          <View style={{ flex: 1 }}>
            <Text style={s.sheetName}>{displayName(email)}</Text>
            <Text style={s.sheetEmail}>{email}</Text>
          </View>
        </View>
        <SheetItem icon="edit" label="Drafts" onPress={onDrafts} />
        <SheetItem icon="clock" label="Scheduled" onPress={onScheduled} />
        <SheetItem icon="key" label="Keys and fingerprints" onPress={onKeys} />
        <SheetItem icon="signout" label="Sign out" onPress={onSignOut} tint={color.coral} />
      </Glass>
    </Modal>
  );
}

function SheetItem({
  icon,
  label,
  onPress,
  tint = color.ink,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.sheetItem, pressed && { backgroundColor: color.press }]}
    >
      <Icon name={icon} size={17} color={tint} />
      <Text style={[s.sheetItemText, { color: tint }]}>{label}</Text>
      <Icon name="chevron" size={14} color={color.inkFaint} />
    </Pressable>
  );
}

/* -------------------------------------------------------------- helpers ---- */

function needsAttention(encryption: EncryptionState): boolean {
  return encryption.kind === 'encrypted' && (encryption.trust === 'changed' || encryption.trust === 'unknown');
}

function dayBucket(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  return 'Earlier';
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

function badgeFor(encryption: EncryptionState): { tone: BadgeTone; icon?: 'lock' | 'alert'; label: string } {
  if (encryption.kind === 'plain') return { tone: 'plain', label: 'Not encrypted' };
  if (encryption.own) return { tone: 'enc', icon: 'lock', label: 'Encrypted · from you' };
  switch (encryption.trust) {
    case 'verified':
      return { tone: 'enc', icon: 'lock', label: 'Encrypted · verified' };
    case 'seen':
      return { tone: 'enc', icon: 'lock', label: 'Encrypted · key unverified' };
    case 'changed':
      return { tone: 'warn', icon: 'alert', label: 'Encrypted · key changed' };
    default:
      return { tone: 'warn', icon: 'alert', label: 'Encrypted · no key' };
  }
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  topbar: {
    borderBottomColor: glass.hairline,
    borderBottomWidth: 1,
    ...shadow.raised,
  },

  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  identity: { flex: 1, minWidth: 0 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  headerTitle: { ...type.display, color: color.ink },
  count: {
    backgroundColor: color.brassBg,
    borderColor: 'rgba(235,184,99,0.35)',
    borderRadius: radius.pill,
    borderWidth: 1,
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  countText: { color: color.brass, fontFamily: font.mono, fontSize: 11, textAlign: 'center' },
  subRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 2 },
  headerSub: { ...type.meta, color: color.inkFaint, flexShrink: 1 },

  demoStrip: {
    alignItems: 'center',
    backgroundColor: color.brassBg,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingVertical: 7,
  },
  demoText: { color: color.brass, fontFamily: font.mono, fontSize: 10.5, letterSpacing: 0.6 },

  // Symmetrical: without the bottom padding the filter pills sat flush against
  // the frosted bar's own edge, so the glass read as clipping them.
  controls: { paddingBottom: 12, paddingHorizontal: 16, paddingTop: 12 },
  searchField: { marginBottom: 10, paddingVertical: 9 },
  searchRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  searchInput: { flex: 1, fontSize: 14 },

  filters: { flexDirection: 'row', gap: 7 },
  pill: {
    alignItems: 'center',
    backgroundColor: color.panel,
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  pillActive: { backgroundColor: color.brass, borderColor: color.brass },
  pillText: { color: color.inkDim, fontFamily: font.sansSemibold, fontSize: 12.5 },
  pillTextActive: { color: color.brassInk, fontFamily: font.sansBold },
  pillCount: {
    backgroundColor: color.coralBg,
    borderRadius: radius.pill,
    minWidth: 17,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  pillCountText: { color: color.coral, fontFamily: font.mono, fontSize: 10, textAlign: 'center' },

  errorRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  error: { color: color.coral, flex: 1, fontFamily: font.sans, fontSize: 13 },

  sectionHead: { marginBottom: 4, marginTop: 18 },

  row: {
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderColor: glass.hairline,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 10,
    overflow: 'hidden',
  },
  rowTap: {
    flex: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  rowPressed: { backgroundColor: color.press },
  rail: { width: 34 },
  unreadDot: {
    backgroundColor: color.brass,
    borderColor: color.ground,
    borderRadius: 5,
    borderWidth: 2,
    height: 10,
    position: 'absolute',
    right: -3,
    top: -3,
    width: 10,
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowTop: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  from: { ...type.strong, color: color.ink, flex: 1 },
  unread: { fontFamily: font.sansExtrabold },
  time: { ...type.meta, color: color.inkFaint, fontSize: 11 },
  threadChip: {
    alignItems: 'center',
    backgroundColor: color.panel,
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  threadChipText: { color: color.inkDim, fontFamily: font.mono, fontSize: 10.5 },
  star: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  starPressed: { backgroundColor: color.press },
  subject: { color: color.inkDim, fontFamily: font.sans, fontSize: 13.5, marginTop: 2 },
  subjectUnread: { color: color.ink, fontFamily: font.sansSemibold },
  snippet: { ...type.small, color: color.inkFaint, marginTop: 2 },
  snippetLocked: { color: color.inkFaint, fontFamily: font.mono, fontSize: 11 },
  badgeRow: { alignSelf: 'flex-start', flexDirection: 'row', marginTop: 8 },

  skelRow: { flexDirection: 'row', gap: 12, paddingVertical: 15 },

  // The one solid-brass control: the primary action, and the only saturated
  // fill in the composition. Everything else is glass; this is the focal point.
  fab: {
    backgroundColor: color.brass,
    borderRadius: 28,
    height: 56,
    position: 'absolute',
    right: 20,
    width: 56,
    ...shadow.floating,
  },
  fabPress: { alignItems: 'center', height: '100%', justifyContent: 'center', width: '100%' },

  scrim: { flex: 1 },
  sheet: {
    borderTopColor: glass.hairline,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    ...shadow.sheet,
  },
  sheetInner: { paddingHorizontal: 16, paddingTop: 10 },
  grabber: {
    alignSelf: 'center',
    backgroundColor: color.line,
    borderRadius: radius.pill,
    height: 4,
    marginBottom: 16,
    width: 38,
  },
  sheetHead: {
    alignItems: 'center',
    borderBottomColor: color.lineSoft,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 14,
  },
  sheetName: { ...type.strong, color: color.ink },
  sheetEmail: { ...type.meta, color: color.inkFaint, marginTop: 2 },
  sheetItem: {
    alignItems: 'center',
    borderRadius: radius.sm,
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: -8,
    paddingHorizontal: 8,
    paddingVertical: 15,
  },
  sheetItemText: { ...type.strong, flex: 1 },
});
