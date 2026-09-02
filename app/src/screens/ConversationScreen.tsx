import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { displayName, initials, relativeTime } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { EncryptionState, useApp } from '../state/AppState';
import { InboxItem } from '../state/types';
import { groupIntoThreads } from '../threads/threads';
import { color, font, glass, radius, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { OriginRect, useOriginRef } from '../ui/expand';
import { Avatar, EmptyState, SecondaryButton } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

/** A single conversation: every message in the thread, oldest first. */
export function ConversationScreen({ route, navigation }: Props) {
  const { messages, encryptionFor, searchIndex } = useApp();
  const insets = useSafeAreaInsets();

  const thread = useMemo(
    () => groupIntoThreads(messages).find((t) => t.id === route.params.threadId),
    [messages, route.params.threadId],
  );

  const title = thread ? subjectOf(thread.latest.id, thread.latest.subject, encryptionFor(thread.latest), searchIndex) : '';

  useEffect(() => {
    navigation.setOptions({ title: title || 'Conversation' });
  }, [navigation, title]);

  if (!thread) {
    return (
      <View style={s.screen}>
        <EmptyState
          icon="mail"
          title="Conversation not available"
          hint="It is no longer in the list on this device."
          action={<SecondaryButton title="Back to inbox" icon="back" onPress={() => navigation.goBack()} />}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={s.subject}>{title}</Text>
      <Text style={s.meta}>{thread.count} messages</Text>

      <View style={s.list}>
        {thread.messages.map((m) => (
          <ConversationRow
            key={m.id}
            message={m}
            encryption={encryptionFor(m)}
            searchIndex={searchIndex}
            onPress={(origin) => navigation.navigate('Message', { id: m.id, origin })}
          />
        ))}
      </View>
    </ScrollView>
  );
}

/* -------------------------------------------------------------- helpers ---- */

/** The conversation title: the decrypted subject if we have it, else honest fallbacks. */
/**
 * One message in the thread. A component rather than an inline map so it can
 * hold the ref the expansion measures — opening from here grows the card the
 * same way an inbox row does.
 */
function ConversationRow({
  message,
  encryption,
  searchIndex,
  onPress,
}: {
  message: InboxItem;
  encryption: EncryptionState;
  searchIndex: Record<string, { subject: string; body: string }>;
  onPress: (origin?: OriginRect) => void;
}) {
  const [rowRef, measureOrigin] = useOriginRef();
  const name = displayName(message.from.address, message.from.name);
  const trust = trustBits(encryption);
  const preview = previewOf(message.id, message.snippet, encryption, searchIndex);

  return (
    <Pressable
      accessibilityRole="button"
      collapsable={false}
      onPress={() => void measureOrigin().then(onPress)}
      ref={rowRef}
      style={({ pressed }) => [s.card, pressed && s.cardPressed]}
    >
      <Avatar seed={message.from.address} label={initials(name)} />
      <View style={s.cardMain}>
        <View style={s.cardTop}>
          <Text numberOfLines={1} style={[s.name, message.unread && s.unread]}>
            {name}
          </Text>
          <Text style={s.time}>{relativeTime(message.date)}</Text>
        </View>
        <Text numberOfLines={2} style={s.preview}>
          {preview}
        </Text>
        <View style={s.trustRow}>
          <Icon name={trust.icon} size={11} color={trust.color} />
          <Text style={[s.trust, { color: trust.color }]}>{trust.label}</Text>
        </View>
      </View>
      <Icon name="chevron" size={14} color={color.inkFaint} />
    </Pressable>
  );
}

function subjectOf(id: string, headerSubject: string, encryption: EncryptionState, searchIndex: Record<string, { subject: string }>): string {
  const indexed = searchIndex[id];
  if (indexed?.subject) return indexed.subject;
  if (encryption.kind === 'plain') return headerSubject;
  return 'Encrypted conversation';
}

/** A one-line preview: decrypted body first, then plaintext snippet, else a locked hint. */
function previewOf(
  id: string,
  snippet: string,
  encryption: EncryptionState,
  searchIndex: Record<string, { subject: string; body: string }>,
): string {
  const indexed = searchIndex[id];
  if (indexed) return firstLine(indexed.body) || indexed.subject || snippet;
  if (encryption.kind === 'plain') return snippet;
  return 'Encrypted — open to read on this device.';
}

function trustBits(encryption: EncryptionState): { icon: IconName; color: string; label: string } {
  if (encryption.kind === 'plain') return { icon: 'mail', color: color.inkFaint, label: 'Not encrypted' };
  if (encryption.own) return { icon: 'lock', color: color.mint, label: 'From you' };
  switch (encryption.trust) {
    case 'verified':
      return { icon: 'lock', color: color.mint, label: 'Verified' };
    case 'seen':
      return { icon: 'lock', color: color.mint, label: 'Encrypted' };
    case 'changed':
      return { icon: 'alert', color: color.coral, label: 'Key changed' };
    default:
      return { icon: 'alert', color: color.coral, label: 'No key' };
  }
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.slice(0, 140) ?? '';
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  subject: { ...type.display, color: color.ink, lineHeight: 28 },
  meta: { ...type.meta, color: color.inkFaint, marginTop: 6, marginBottom: 18 },

  list: { gap: 10 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderColor: glass.hairline,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  cardPressed: { backgroundColor: color.rowPress },
  cardMain: { flex: 1, minWidth: 0 },
  cardTop: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  name: { ...type.strong, color: color.ink, flex: 1 },
  unread: { fontFamily: font.sansExtrabold },
  time: { ...type.meta, color: color.inkFaint, fontSize: 11 },
  preview: { ...type.small, color: color.inkDim, marginTop: 3 },
  trustRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 8 },
  trust: { fontFamily: font.mono, fontSize: 10.5 },
});
