import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Draft, listDrafts } from '../drafts/drafts';
import { relativeTime } from '../lib/format';
import { textMatchesQuery } from '../search/search';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
import { Icon } from '../ui/Icon';
import { EmptyState, SecondaryButton } from '../ui/primitives';
import { BodyProps } from './HomeScreen';

/**
 * Unsent messages, most-recently-edited first. Tap to resume, ✕ to discard.
 *
 * A destination body under the home screen's own bar (`screens/HomeScreen.tsx`),
 * so reaching Drafts from the drawer changes nothing above the list — the bar
 * simply drops the tabs and the search it has no rows to search. The rows are
 * their own thing: a draft is not a received message, and drawing it as one
 * would invite tapping it to read rather than to resume.
 */
export function DraftsBody({ navigation, query, clearSearch }: BodyProps) {
  const { drafts, deleteDraft } = useApp();
  const insets = useSafeAreaInsets();
  const all = listDrafts(drafts);
  // A draft is text this device wrote, so the bar's search box reads it
  // directly — there is no index to consult and no ciphertext to avoid.
  const items = all.filter((d) => textMatchesQuery([d.subject, d.body, ...d.to], query));
  const searching = query.trim().length > 0;

  return (
    <View style={s.screen}>
      {items.length === 0 ? (
        searching ? (
          <EmptyState
            icon="search"
            title="Nothing matched"
            hint="Drafts are searched by their subject, their recipients and what you have written so far."
            action={<SecondaryButton title="Clear search" icon="close" onPress={clearSearch} />}
          />
        ) : (
          <EmptyState
            icon="edit"
            title="No drafts"
            hint="Messages you start but don't send are saved here automatically."
            action={
              <SecondaryButton title="New message" icon="plus" onPress={() => navigation.navigate('Compose', {})} />
            }
          />
        )
      ) : (
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 10 }}
        showsVerticalScrollIndicator={false}
      >
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
              {d.attachments?.length ? (
                <View style={s.attached}>
                  <Icon name="paperclip" size={12} color={color.inkFaint} />
                  <Text style={s.attachedText}>
                    {d.attachments.length === 1 ? d.attachments[0].name : `${d.attachments.length} files`}
                  </Text>
                </View>
              ) : null}
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
      )}
    </View>
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
    backgroundColor: color.card,
    borderColor: color.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  main: { flex: 1, gap: 3, minWidth: 0, paddingHorizontal: 13, paddingVertical: 13 },
  mainPressed: { backgroundColor: color.cardPress },
  top: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { ...type.strong, color: color.ink, flex: 1 },
  time: { ...type.meta, color: color.inkFaint, fontSize: 11 },
  recipients: { color: color.inkDim, fontFamily: font.mono, fontSize: 11.5 },
  preview: { ...type.small, color: color.inkFaint, marginTop: 2 },
  attached: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 6 },
  attachedText: { color: color.inkFaint, fontFamily: font.mono, fontSize: 11 },

  discard: {
    alignItems: 'center',
    borderLeftColor: color.border,
    borderLeftWidth: 1,
    justifyContent: 'center',
    width: 46,
  },
});
