/**
 * Sent and Archive — the two mailboxes that are not the inbox.
 *
 * One screen, parameterised, because they differ in three details and nothing
 * else: the title, the empty state, and which address a row leads with (Sent
 * shows who it went *to*; there is no point telling you that you sent it).
 *
 * They are their own lists, fetched from the provider, not a filter over the
 * inbox — filtering `messages` would show only the sent mail that happened to be
 * in the inbox, which is none of it. Each paginates on its own cursor, so
 * reaching the bottom of Sent does not disturb where the inbox was paged to.
 *
 * The active account only, even while the inbox is merged: merging is a reading
 * convenience for incoming mail, and quietly mixing two accounts' sent mail
 * would misrepresent which mailbox a message left from.
 */
import { useIsFocused } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { displayName, initials, relativeTime } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { EncryptionState, useApp } from '../state/AppState';
import { InboxItem, SecondaryBox } from '../state/types';
import { color, font, space, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { AuroraHeaderBackground } from '../ui/aurora';
import { useAccent, useAppearance } from '../ui/appearance';
import { lockFor } from '../ui/lock';
import { Avatar, EmptyState, SecondaryButton, Skeleton } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Sent' | 'Archive'>;

const COPY: Record<SecondaryBox, { empty: string; hint: string; icon: IconName }> = {
  sent: {
    empty: 'Nothing sent yet',
    hint: 'Messages you send from this account appear here. Encrypted ones stay encrypted — the provider holds the ciphertext, and this device decrypts them to show you.',
    icon: 'send',
  },
  archive: {
    empty: 'Nothing archived',
    hint: 'Mail you archive leaves the inbox but stays in the account. Nothing is deleted.',
    icon: 'archive',
  },
};

export function SentScreen(props: Props) {
  return <MailboxScreen {...props} box="sent" />;
}

export function ArchiveScreen(props: Props) {
  return <MailboxScreen {...props} box="archive" />;
}

function MailboxScreen({ navigation, box }: Props & { box: SecondaryBox }) {
  const { boxes, loadBox, loadMoreBox, encryptionFor } = useApp();
  const { items, loading, loadingMore, canLoadMore, error } = boxes[box];
  const { rowPadding, auroraColors } = useAppearance();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const copy = COPY[box];

  useEffect(() => {
    void loadBox(box);
  }, [box, loadBox]);

  // The same aurora band the inbox top bar uses — only the list underneath
  // changes screen to screen, not the chrome around it.
  useEffect(() => {
    navigation.setOptions({
      headerBackground: () => <AuroraHeaderBackground active={isFocused} palette={auroraColors} />,
    });
  }, [auroraColors, isFocused, navigation]);

  const renderItem = useCallback(
    ({ item }: { item: InboxItem }) => (
      <Row
        item={item}
        box={box}
        encryption={encryptionFor(item)}
        padding={rowPadding}
        onPress={() => navigation.navigate('Message', { id: item.id })}
      />
    ),
    [box, encryptionFor, navigation, rowPadding],
  );

  // A first load has nothing to show under a spinner, so it shows the shape of
  // what is coming instead — the same skeleton the inbox uses.
  if (loading && items.length === 0) {
    return (
      <View style={s.screen}>
        {[0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={s.skelRow}>
            <Skeleton width={44} height={44} radius={22} />
            <View style={{ flex: 1, gap: 8 }}>
              <Skeleton width="55%" height={12} />
              <Skeleton width="80%" height={12} />
            </View>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={s.screen}>
      {error ? (
        <View style={s.errorRow}>
          <Icon name="alert" size={14} color={color.coral} />
          <Text style={s.error}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadBox(box)} tintColor={accent} />}
        onEndReached={() => void loadMoreBox(box)}
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
        ListEmptyComponent={loading ? null : <EmptyState icon={copy.icon} title={copy.empty} hint={copy.hint} />}
      />
    </View>
  );
}

function Row({
  item,
  box,
  encryption,
  padding,
  onPress,
}: {
  item: InboxItem;
  box: SecondaryBox;
  encryption: EncryptionState;
  padding: number;
  onPress: () => void;
}) {
  const accent = useAccent();
  const lock = lockFor(encryption);
  const encrypted = encryption.kind === 'encrypted';
  // Sent mail leads with the recipient: who it went to is the identifying fact,
  // and the sender is always you. With several recipients the rest are counted
  // rather than listed, so the row does not wrap.
  const [first, ...rest] = item.to;
  const who =
    box === 'sent'
      ? first
        ? rest.length > 0
          ? `${displayName(first)} +${rest.length}`
          : displayName(first)
        : 'No recipient'
      : displayName(item.from.address, item.from.name);
  const seed = box === 'sent' ? (first ?? item.from.address) : item.from.address;

  return (
    <View style={s.row}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [s.rowTap, { paddingVertical: padding }, pressed && s.rowPressed]}
      >
        <Avatar seed={seed} label={initials(who)} size={44} />
        <View style={s.rowMain}>
          <View style={s.rowTop}>
            <Text numberOfLines={1} style={s.who}>
              {box === 'sent' ? `To ${who}` : who}
            </Text>
            <Icon name={lock.icon} size={13} color={lock.tint} {...(lock.icon === 'lock' ? { fill: lock.tint } : {})} />
            <Text style={[s.time, { color: accent }]} accessibilityLabel={lock.label}>
              {relativeTime(item.date)}
            </Text>
          </View>
          <Text numberOfLines={1} style={s.subject}>
            {encrypted ? 'Encrypted message' : item.subject}
          </Text>
          {/* An encrypted message's stored snippet is ciphertext, so it is never
              shown — the same rule the inbox row follows. */}
          <Text numberOfLines={1} style={[s.snippet, encrypted && s.snippetLocked]}>
            {encrypted ? 'Contents decrypt on this device when you open it.' : item.snippet}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  errorRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  error: { ...type.small, color: color.coral, flex: 1 },

  row: { borderBottomColor: color.line, borderBottomWidth: 1 },
  rowTap: { alignItems: 'flex-start', flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  rowPressed: { backgroundColor: color.surface },
  rowMain: { flex: 1, gap: 3 },
  rowTop: { alignItems: 'center', flexDirection: 'row', gap: space.xs },

  who: { ...type.body, color: color.ink, flex: 1, fontFamily: font.sansSemibold },
  time: { ...type.small },
  subject: { ...type.body, color: color.ink },
  snippet: { ...type.small, color: color.inkDim },
  snippetLocked: { color: color.inkFaint, fontStyle: 'italic' },

  skelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },

  footer: { alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.lg },
});
