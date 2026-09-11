/**
 * Settings → Mail → Swipe options.
 *
 * One card per direction: what it does now, a Change control, and a preview.
 *
 * The preview is a **still frame of the real thing**, not a drawing of one. It
 * is the same `SwipeActionPane` the inbox reveals, fed the same resolved
 * `SwipeVisual` through the same `resolveSwipe`, and driven by a shared value
 * that simply never moves — held at the point where the action is about to run,
 * which is the frame worth showing. So the colour, the glyph and the words are
 * the ones the user's thumb will meet, and they cannot drift apart later.
 *
 * The two sides are independent all the way down — a change writes one field of
 * `MailPrefs` (`ui/mailPrefs.tsx`) and the other is untouched on screen and on
 * disk. The right side ships unconfigured and stays that way until someone
 * chooses otherwise; see `store/mailPrefsStore.ts` for why that is not a gap
 * waiting to be filled.
 *
 * The picker offers *No action* — a side deliberately turned off — but not the
 * unconfigured state it ships in: emptying a side again is an answer, not a
 * retraction of one, so it is `off` and the preview goes blank rather than
 * going back to offering to be set up. See `SwipeAction` in `swipe/swipe.ts`.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { back, RootStackParamList } from '../navigation';
import {
  resolveSwipe,
  SWIPE_ACTION_HINT,
  SWIPE_ACTION_LABEL,
  SWIPE_PICKER_ACTIONS,
  SWIPE_DIRECTION_LABEL,
  SWIPE_DIRECTIONS,
  SwipeAction,
  SwipeContext,
  SwipeDirection,
} from '../swipe/swipe';
import { color, font, radius, space, type } from '../theme';
import { Icon } from '../ui/Icon';
import { useAccent } from '../ui/appearance';
import { useMailPrefs } from '../ui/mailPrefs';
import { Group, GroupHeading, IconButton, PressableRow, Sheet } from '../ui/primitives';
import { SwipeActionPane } from '../ui/swipeRow';

type Props = NativeStackScreenProps<RootStackParamList, 'SwipeOptions'>;

/**
 * The list the preview stands in: the inbox, on an unread message that is not
 * junk, which is where every action resolves to something.
 *
 * A preview has to pick one, and this is the one the gesture is for. What the
 * card says underneath is where the picked action *stops* applying.
 */
const PREVIEW_CONTEXT: SwipeContext = {
  box: null,
  junk: false,
  unread: true,
  category: null,
  foreign: false,
};

export function SwipeOptionsScreen({ navigation }: Props) {
  const { swipeLeft, swipeRight, setSwipe } = useMailPrefs();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  /** Which side the picker is open for, if either. */
  const [picking, setPicking] = useState<SwipeDirection | null>(null);

  const actionFor = (direction: SwipeDirection) => (direction === 'left' ? swipeLeft : swipeRight);

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Swipe options</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.intro}>Customise swipe options to quickly take action on emails in your inbox.</Text>

        {/* Right first, as the reference screen has it: the side that ships
            empty is the one worth reading about. */}
        {[...SWIPE_DIRECTIONS].reverse().map((direction) => (
          <DirectionCard
            key={direction}
            action={actionFor(direction)}
            direction={direction}
            onChange={() => setPicking(direction)}
          />
        ))}

        {/* The glyph bench. Dev builds only — it is a test rig, not a setting,
            and the release build has no way to reach it. */}
        {__DEV__ ? (
          <Pressable
            accessibilityLabel="Open the swipe glyph bench"
            accessibilityRole="button"
            onPress={() => navigation.navigate('SwipeGlyphDemo')}
            style={({ pressed }) => [s.devRow, pressed && { backgroundColor: color.rowPress }]}
          >
            <Text style={[s.devLabel, { color: accent }]}>Glyph animation bench (dev)</Text>
          </Pressable>
        ) : null}

        <Text style={s.note}>
          Some actions only mean something in some lists. Archive is offered in the inbox, Delete becomes Restore in
          Trash, and Spam and Snooze apply to the mailbox you are reading. Where an action has nothing to do the row
          simply doesn’t move — your choice is never quietly swapped for another one.
        </Text>
      </ScrollView>

      <ActionPicker
        direction={picking}
        selected={picking ? actionFor(picking) : 'none'}
        onClose={() => setPicking(null)}
        onPick={(action) => {
          if (picking) setSwipe(picking, action);
          setPicking(null);
        }}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ card ---- */

function DirectionCard({
  action,
  direction,
  onChange,
}: {
  action: SwipeAction;
  direction: SwipeDirection;
  onChange: () => void;
}) {
  const accent = useAccent();

  return (
    <View>
      <GroupHeading>{SWIPE_DIRECTION_LABEL[direction]}</GroupHeading>
      <Group style={s.card}>
        <View style={s.cardHead}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardValue}>{SWIPE_ACTION_LABEL[action]}</Text>
            <Text style={s.cardHint}>{SWIPE_ACTION_HINT[action]}</Text>
          </View>
          <Pressable
            accessibilityLabel={`Change what ${SWIPE_DIRECTION_LABEL[direction].toLowerCase()} does`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onChange}
            style={({ pressed }) => [s.change, pressed && { backgroundColor: color.rowPress }]}
          >
            <Text style={[s.changeLabel, { color: accent }]}>Change</Text>
          </Pressable>
        </View>

        <SwipePreview direction={direction} action={action} />
      </Group>
    </View>
  );
}

/**
 * A row of grey bars with the action's block already revealed.
 *
 * Held at the moment the action is about to run — full colour, glyph in dark ink
 * — because that is the frame that says what the gesture does. The row is
 * offset by exactly the block's width, so the two meet the way they do under a
 * finger.
 *
 * The block is `SwipeActionPane`, the same component the inbox mounts; it reads
 * a shared value, and this one is created once and never written to.
 */
function SwipePreview({ action, direction }: { action: SwipeAction; direction: SwipeDirection }) {
  // `null` for *No action*, and the preview is then the row alone, unswiped —
  // which is exactly what that choice looks like under a finger.
  const visual = resolveSwipe(action, PREVIEW_CONTEXT);
  // Pulling left moves the row left and uncovers the right-hand edge.
  const dx = useSharedValue(direction === 'left' ? -PREVIEW_BLOCK : PREVIEW_BLOCK);

  // Held aside only when there is a block to hold it aside for: a side that
  // does nothing shows a row sitting where it always sits.
  const offset = !visual ? 0 : direction === 'left' ? -PREVIEW_BLOCK : PREVIEW_BLOCK;

  const row = (
    <View style={[s.previewRow, { transform: [{ translateX: offset }] }]}>
      <View style={s.previewAvatar} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={[s.previewLine, { width: '52%' }]} />
        <View style={[s.previewLine, { backgroundColor: color.inkFaint, width: '76%' }]} />
      </View>
    </View>
  );

  if (!visual)
    return (
      <View
        accessibilityLabel={`Preview: ${SWIPE_DIRECTION_LABEL[direction].toLowerCase()} does nothing`}
        style={s.preview}
      >
        {row}
      </View>
    );

  return (
    <View
      accessibilityLabel={`Preview: ${SWIPE_DIRECTION_LABEL[direction].toLowerCase()} to ${visual.label}`}
      style={s.preview}
    >
      {/* Threshold equal to the offset, so the still frame sits exactly at the
          point the action arms — the full-colour state, as it is on a row. */}
      <SwipeActionPane visual={visual} direction={direction} dx={dx} threshold={PREVIEW_BLOCK} />
      {row}
    </View>
  );
}

/* ---------------------------------------------------------------- picker ---- */

/**
 * The action list for one side.
 *
 * Every action CryptMail actually has plus *No action*, each with the one line
 * that says where it applies — the same `Sheet` the filter and snooze pickers use, so choosing an
 * action is the gesture choosing a filter already is.
 */
function ActionPicker({
  direction,
  selected,
  onClose,
  onPick,
}: {
  direction: SwipeDirection | null;
  selected: SwipeAction;
  onClose: () => void;
  onPick: (action: SwipeAction) => void;
}) {
  const accent = useAccent();
  const insets = useSafeAreaInsets();

  return (
    <Sheet
      bottomInset={insets.bottom}
      onClose={onClose}
      title={direction ? SWIPE_DIRECTION_LABEL[direction] : undefined}
      visible={direction !== null}
    >
      {SWIPE_PICKER_ACTIONS.map((action) => (
        <PressableRow
          accessibilityRole="button"
          accessibilityState={{ selected: action === selected }}
          key={action}
          onPress={() => onPick(action)}
          style={s.pickRow}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.pickLabel}>{SWIPE_ACTION_LABEL[action]}</Text>
            <Text style={s.pickHint}>{SWIPE_ACTION_HINT[action]}</Text>
          </View>
          {action === selected ? <Icon name="check" size={19} color={accent} strokeWidth={2.4} /> : null}
        </PressableRow>
      ))}
    </Sheet>
  );
}

/** How far the preview's row is pulled aside — the width of the block behind it. */
const PREVIEW_BLOCK = 132;

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  topbar: {
    alignItems: 'center',
    backgroundColor: color.surface,
    flexDirection: 'row',
    gap: space.sm,
    paddingBottom: space.md,
    paddingHorizontal: space.md,
  },
  title: { ...type.display, color: color.ink },

  intro: {
    color: color.inkDim,
    fontFamily: font.sans,
    fontSize: 14,
    lineHeight: 21,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  devRow: {
    borderRadius: radius.sm,
    marginHorizontal: space.lg,
    marginTop: space.lg,
    paddingVertical: space.sm,
  },
  devLabel: { fontFamily: font.sansSemibold, fontSize: 14 },

  note: {
    color: color.inkFaint,
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },

  card: { paddingVertical: space.md },
  cardHead: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.md,
  },
  cardValue: { ...type.settingsRow, color: color.ink },
  cardHint: { ...type.settingsValue, color: color.inkFaint, marginTop: 2 },
  change: { borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4 },
  changeLabel: { fontFamily: font.sansSemibold, fontSize: 15 },

  preview: {
    backgroundColor: color.ground,
    borderRadius: radius.lg,
    marginHorizontal: space.md,
    marginTop: space.md,
    overflow: 'hidden',
  },
  previewRow: {
    alignItems: 'center',
    backgroundColor: color.ground2,
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 16,
  },
  previewAvatar: { backgroundColor: color.surfaceRaised, borderRadius: 17, height: 34, width: 34 },
  previewLine: { backgroundColor: color.surfaceRaised, borderRadius: 3, height: 8 },

  pickRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  pickLabel: { ...type.settingsRow, color: color.ink },
  pickHint: { ...type.settingsValue, color: color.inkFaint, marginTop: 1 },
});
