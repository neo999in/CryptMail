/**
 * Simple UI — inbox.
 *
 * Twenty messages, a lock badge, and a way to open one. Everything the full
 * InboxScreen does beyond that (search, threads, star, archive, swipe actions)
 * is deliberately absent; see docs/simple-ui-plan.md.
 */
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { appMode, demoReason } from '../../config';
import { displayName, relativeTime } from '../../lib/format';
import { MailSummary } from '../../mail/types';
import { RootStackParamList } from '../../navigation';
import { useApp } from '../../state/AppState';
import { color, radius, space, type } from '../../theme';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  IconButton,
  PressableRow,
  PrimaryButton,
  Skeleton,
} from '../../ui/primitives';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function SimpleInboxScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { messages, loadingInbox, refreshInbox, encryptionFor, signOut, session, error } = useApp();

  useEffect(() => {
    void refreshInbox();
    // Once on mount: refreshInbox is stable per session and re-running on every
    // identity change would refetch the list mid-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const banner = demoReason();

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.md }]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Inbox</Text>
          <Text style={styles.account}>{session?.email ?? ''}</Text>
        </View>
        <IconButton icon="key" label="Keys" onPress={() => nav.navigate('SimpleKeys')} />
        <IconButton icon="refresh" label="Refresh" onPress={() => void refreshInbox()} />
        <IconButton icon="signout" label="Sign out" onPress={() => void signOut()} />
      </View>

      {banner ? (
        <View style={styles.pad}>
          <Callout>{banner}</Callout>
        </View>
      ) : null}
      {error ? (
        <View style={styles.pad}>
          <Callout>{error}</Callout>
        </View>
      ) : null}

      {loadingInbox && messages.length === 0 ? (
        <View style={styles.pad}>
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} style={{ marginBottom: space.sm }}>
              <Skeleton width="52%" height={14} />
              <View style={{ height: space.sm }} />
              <Skeleton width="82%" height={12} />
            </Card>
          ))}
        </View>
      ) : (
        <FlatList
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 96 }]}
          data={messages}
          keyExtractor={(m) => m.id}
          refreshControl={
            <RefreshControl
              refreshing={loadingInbox}
              onRefresh={() => void refreshInbox()}
              tintColor={color.brass}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="inbox"
              title="Nothing here yet"
              hint={appMode === 'demo' ? 'Demo fixtures load on refresh.' : 'Pull down to refresh.'}
            />
          }
          renderItem={({ item }) => (
            <Row summary={item} encrypted={encryptionFor(item).kind === 'encrypted'} onPress={() => nav.navigate('SimpleMessage', { id: item.id })} />
          )}
        />
      )}

      <View style={[styles.fab, { bottom: insets.bottom + space.lg }]}>
        <PrimaryButton title="New message" icon="edit" onPress={() => nav.navigate('SimpleCompose', {})} />
      </View>
    </View>
  );
}

function Row({
  summary,
  encrypted,
  onPress,
}: {
  summary: MailSummary;
  encrypted: boolean;
  onPress: () => void;
}) {
  return (
    <PressableRow onPress={onPress} style={styles.row}>
      <Card style={{ marginBottom: space.sm }}>
        <View style={styles.rowTop}>
          <Text numberOfLines={1} style={[styles.from, summary.unread && styles.unread]}>
            {displayName(summary.from.address, summary.from.name)}
          </Text>
          <Text style={styles.time}>{relativeTime(summary.date)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.subject}>
          {summary.subject}
        </Text>
        <View style={styles.rowBottom}>
          {encrypted ? (
            <Badge tone="enc" icon="lock">
              Encrypted
            </Badge>
          ) : (
            <Badge tone="plain" icon="mail">
              Plaintext
            </Badge>
          )}
        </View>
      </Card>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  account: { ...type.meta, color: color.inkFaint, marginTop: 2 },
  fab: { position: 'absolute', right: space.lg },
  from: { ...type.strong, color: color.inkDim, flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.sm,
    paddingBottom: space.md,
    paddingHorizontal: space.lg,
  },
  list: { paddingHorizontal: space.lg },
  pad: { paddingHorizontal: space.lg },
  row: { borderRadius: radius.lg },
  rowBottom: { flexDirection: 'row', marginTop: space.sm },
  rowTop: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  screen: { flex: 1 },
  subject: { ...type.small, color: color.body, marginTop: 2 },
  time: { ...type.meta, color: color.inkFaint },
  title: { ...type.display, color: color.ink },
  unread: { color: color.ink },
});
