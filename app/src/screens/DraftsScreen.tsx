import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Draft, listDrafts } from '../drafts/drafts';
import { relativeTime } from '../lib/format';
import { textMatchesQuery } from '../search/search';
import { useApp } from '../state/AppState';
import { fixedSwipes } from '../swipe/swipe';
import { color, font, radius, type } from '../theme';
import { Icon } from '../ui/Icon';
import { useComposeScroll } from '../ui/mailList';
import { useMailPrefs } from '../ui/mailPrefs';
import { EmptyState, SecondaryButton } from '../ui/primitives';
import { SwipeableRow } from '../ui/swipeRow';
import { useToast } from '../ui/ToastContext';
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
export function DraftsBody({ navigation, query, clearSearch, composeFold }: BodyProps) {
  const composeScroll = useComposeScroll(composeFold);
  const { drafts, deleteDraft, saveDraft } = useApp();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { swipeLeft, swipeRight } = useMailPrefs();
  // Delete alone, on the side Delete is configured on — else the left
  // (`swipe/swipe.ts`, `fixedSwipes`).
  const { left, right } = React.useMemo(() => fixedSwipes('drafts', swipeLeft, swipeRight), [swipeLeft, swipeRight]);

  /** Discard by swipe, with the draft itself kept for five seconds as the way back. */
  const discard = (d: Draft) => {
    deleteDraft(d.id).then(
      () =>
        showToast({
          message: 'Draft discarded',
          icon: 'trash',
          durationMs: 5000,
          actionLabel: 'Undo',
          onAction: () => void saveDraft(d),
        }),
      () => showToast({ message: 'Couldn’t discard that draft', icon: 'alert', durationMs: 5000 }),
    );
  };
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
      <Animated.ScrollView
        {...composeScroll}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 10 }}
        showsVerticalScrollIndicator={false}
      >
        {items.map((d) => (
          <SwipeableRow
            key={d.id}
            left={left}
            right={right}
            onAction={() => discard(d)}
            resetKey={d.id}
            style={s.swipe}
          >
          <View style={s.row}>
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
          </SwipeableRow>
        ))}
      </Animated.ScrollView>
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

  /** The swipe wrapper clips to the card's corners, so the pane does too. */
  swipe: { borderRadius: radius.xl },

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
