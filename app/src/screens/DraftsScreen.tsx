import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Draft, listDrafts } from '../drafts/drafts';
import { relativeTime } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
import { Icon } from '../ui/Icon';
import { EmptyState, SecondaryButton } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Drafts'>;

/** Unsent messages, most-recently-edited first. Tap to resume, ✕ to discard. */
export function DraftsScreen({ navigation }: Props) {
  const { drafts, deleteDraft } = useApp();
  const insets = useSafeAreaInsets();
  const items = listDrafts(drafts);

  if (items.length === 0) {
    return (
      <View style={s.screen}>
        <EmptyState
          icon="edit"
          title="No drafts"
          hint="Messages you start but don't send are saved here automatically."
          action={<SecondaryButton title="New message" icon="plus" onPress={() => navigation.navigate('Compose', {})} />}
        />
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 10 }}>
      {items.map((d) => (
        <View key={d.id} style={s.row}>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate('Compose', { draftId: d.id })}
            style={({ pressed }) => [s.main, pressed && s.mainPressed]}
          >
            <View style={s.top}>
              <Text numberOfLines={1} style={s.title}>
                {titleOf(d)}
              </Text>
              <Text style={s.time}>{relativeTime(d.updatedAt)}</Text>
            </View>
            <Text numberOfLines={1} style={s.recipients}>
              To: {d.to.length > 0 ? d.to.join(', ') : 'no recipients yet'}
            </Text>
            <Text numberOfLines={2} style={s.preview}>
              {previewOf(d)}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Discard draft"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => void deleteDraft(d.id)}
            style={({ pressed }) => [s.discard, pressed && { backgroundColor: color.line }]}
          >
            <Icon name="close" size={15} color={color.inkDim} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/* -------------------------------------------------------------- helpers ---- */

function titleOf(d: Draft): string {
  return d.subject.trim() || '(no subject)';
}

function previewOf(d: Draft): string {
  const line = d.body.split('\n').find((l) => l.trim().length > 0);
  return line ? line.slice(0, 140) : 'No message yet.';
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  row: {
    alignItems: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderColor: glass.hairline,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
  },
  main: { flex: 1, gap: 3, minWidth: 0, paddingHorizontal: 13, paddingVertical: 13 },
  mainPressed: { backgroundColor: color.press },
  top: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { ...type.strong, color: color.ink, flex: 1 },
  time: { ...type.meta, color: color.inkFaint, fontSize: 11 },
  recipients: { color: color.inkDim, fontFamily: font.mono, fontSize: 11.5 },
  preview: { ...type.small, color: color.inkFaint, marginTop: 2 },

  discard: {
    alignItems: 'center',
    borderLeftColor: glass.hairline,
    borderLeftWidth: 1,
    justifyContent: 'center',
    width: 46,
  },
});
