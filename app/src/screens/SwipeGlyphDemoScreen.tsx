/**
 * A bench for the animated swipe glyphs — **`__DEV__` only**, and reachable only
 * from a row that Swipe options hides in a release build.
 *
 * It exists because the thing it tests cannot honestly be tested any other way.
 * A glyph's motion lasts a few hundred milliseconds, only happens on the frame a
 * pull crosses its trigger, and lives on a block a finger is holding open over a
 * *real mailbox* — so the obvious way to look at it is to swipe live mail
 * repeatedly and hope to catch it, which risks archiving somebody's messages to
 * inspect an animation. That is the wrong trade, and this screen is what makes
 * it unnecessary: every glyph, side by side, driven by the same shared value the
 * pane drives, with no message anywhere near it.
 *
 * What it is for, in order of how much time it saves:
 *
 *  - **Slow it down.** The real spring settles in about a fifth of a second,
 *    which is right on a row and useless for judging. `Slow` scales it to a
 *    tenth of the speed so each part can be watched into place.
 *  - **Loop it.** Hands-free repetition, so a glyph can be stared at rather than
 *    re-triggered.
 *  - **Answer "is it even animating?"** The readout at the bottom is the honest
 *    answer to that, and it is there because of a specific afternoon: the parts
 *    were snapping rather than travelling, and the cause was neither the spring
 *    nor the props — the device had animations turned off, so `useReducedMotion`
 *    was true and the pane was correctly skipping the travel. Nothing on screen
 *    said so. Now something does.
 *
 * It draws `SwipeGlyph` itself rather than the whole pane, because the pane's
 * colours and the fill switch are not what is in question here.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RootStackParamList } from '../navigation';
import { SwipeOperation, swipeVisual } from '../swipe/swipe';
import { color, font, radius, space, swipeColor, type } from '../theme';
import { useAccent } from '../ui/appearance';
import { Group, GroupHeading, IconButton, PrimaryButton, Segmented } from '../ui/primitives';
import { GLYPH_SPRING, glyphDrive, hasGlyph, SwipeGlyph } from '../ui/swipeGlyph';

type Props = NativeStackScreenProps<RootStackParamList, 'SwipeGlyphDemo'>;

/** Every operation that draws something, in the order the pane would meet them. */
const OPERATIONS: SwipeOperation[] = (
  [
    'archive',
    'unarchive',
    'trash',
    'restore',
    'mark-spam',
    'mark-not-spam',
    'mark-read',
    'mark-unread',
    'snooze',
  ] satisfies SwipeOperation[]
).filter(hasGlyph);

/** How much longer the slow spring takes: soft enough to watch each part land. */
const SLOW_SPRING = { stiffness: GLYPH_SPRING.stiffness / 40, damping: GLYPH_SPRING.damping / 6, mass: 1.6 };

/** One full out-and-back, when looping. Long enough to see both directions. */
const LOOP_HOLD = 900;

type Speed = 'real' | 'slow';

export function SwipeGlyphDemoScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const reducedMotion = useReducedMotion();

  const [speed, setSpeed] = useState<Speed>('slow');
  const [looping, setLooping] = useState(false);
  /** Mirrors `armed` for the label; the value itself lives on the UI thread. */
  const [armedLabel, setArmedLabel] = useState(false);

  /**
   * The value every glyph on this screen follows — one for all of them, so they
   * are compared under identical conditions rather than each on its own timing.
   */
  const armed = useSharedValue(0);

  const spring = useCallback(
    (to: number) => {
      'worklet';
      return withSpring(to, speed === 'slow' ? SLOW_SPRING : GLYPH_SPRING);
    },
    [speed],
  );

  const toggle = useCallback(() => {
    setLooping(false);
    cancelAnimation(armed);
    const next = armed.value > 0.5 ? 0 : 1;
    setArmedLabel(next === 1);
    armed.value = spring(next);
  }, [armed, spring]);

  // Looping runs the same spring out and back, forever, until it is turned off.
  useEffect(() => {
    if (!looping) return;
    const hold = { duration: LOOP_HOLD };
    armed.value = withRepeat(
      withSequence(spring(1), withTiming(1, hold), spring(0), withTiming(0, hold)),
      -1,
      false,
    );
    return () => cancelAnimation(armed);
  }, [armed, looping, spring]);

  /** Rest → armed as a plain readout, so "is the value moving" is visible. */
  const readout = useAnimatedStyle(() => ({ width: `${Math.round(armed.value * 100)}%` }));

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
        <Text style={s.title}>Swipe glyphs</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }} showsVerticalScrollIndicator={false}>
        <Text style={s.intro}>
          Every animated swipe glyph, driven by one shared value — the same one a pull drives on a row. No message is
          involved and nothing here can touch mail.
        </Text>

        <GroupHeading>Drive</GroupHeading>
        <Group style={s.controls}>
          <Segmented<Speed>
            options={[
              { key: 'slow', label: 'Slow' },
              { key: 'real', label: 'Real speed' },
            ]}
            stretch
            value={speed}
            onChange={setSpeed}
          />
          {/* Each button takes half the row: `PrimaryButton` sizes to its own
              content, and two of them side by side otherwise collapse to the
              width of the word inside. */}
          <View style={s.buttons}>
            <View style={s.button}>
              <PrimaryButton title={armedLabel ? 'Back to rest' : 'Arm'} onPress={toggle} />
            </View>
            <View style={s.button}>
              <PrimaryButton
                title={looping ? 'Stop loop' : 'Loop'}
                onPress={() => {
                  setLooping((on) => !on);
                  setArmedLabel(false);
                }}
              />
            </View>
          </View>

          {/* The value itself, as a bar. If this slides, the spring is running;
              if it snaps between the two ends, nothing below it can be
              animating and the reason is underneath. */}
          <View style={s.trackWrap}>
            <Text style={s.trackLabel}>armed</Text>
            <View style={s.track}>
              <Animated.View style={[s.trackFill, { backgroundColor: accent }, readout]} />
            </View>
          </View>
        </Group>

        <GroupHeading>Glyphs</GroupHeading>
        <View style={s.grid}>
          {OPERATIONS.map((operation) => (
            <View key={operation} style={s.cell}>
              <View style={s.stage}>
                <SwipeGlyph armed={armed} color={color.ink} operation={operation} size={44} strokeWidth={1.7} />
              </View>
              <Text style={s.cellLabel}>{swipeVisual(operation).label}</Text>
              {/* Which way this one is driven, because the two read completely
                  differently under the same control: a `hold` glyph stops in its
                  armed pose, a `play` glyph runs a sequence and comes back. */}
              <Text style={s.cellOp}>{glyphDrive(operation).drive === 'play' ? 'play · once' : 'hold'}</Text>
            </View>
          ))}
        </View>

        <GroupHeading>Why it might not move</GroupHeading>
        <Group style={s.diag}>
          <Row
            label="Reduced motion"
            value={reducedMotion ? 'ON — the pane skips the travel by design' : 'off'}
            bad={reducedMotion}
          />
          <Row
            label="Animator duration scale"
            value={
              reducedMotion
                ? Platform.OS === 'android'
                  ? 'likely 0 — Developer options › Animator duration scale'
                  : 'Settings › Accessibility › Motion'
                : 'animations enabled'
            }
            bad={reducedMotion}
          />
          <Row label="Spring" value={`stiffness ${GLYPH_SPRING.stiffness} · damping ${GLYPH_SPRING.damping}`} />
          <Row label="Armed fill" value={swipeColor.positive} />
        </Group>

        <Text style={s.note}>
          A device with animations turned off is not a bug here — reduced motion is honoured on purpose, and the parts
          jump straight to their armed positions so the drawing still says what is about to happen. It is only worth
          knowing before spending an afternoon on the spring.
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, bad ? { color: color.coral } : null]}>{value}</Text>
    </View>
  );
}

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
  note: {
    color: color.inkFaint,
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },

  controls: { gap: space.md, padding: space.md },
  buttons: { flexDirection: 'row', gap: space.sm },
  button: { flex: 1 },

  trackWrap: { gap: 6 },
  trackLabel: { color: color.inkFaint, fontFamily: font.mono, fontSize: 11 },
  track: { backgroundColor: color.surfaceRaised, borderRadius: 3, height: 6, overflow: 'hidden' },
  trackFill: { borderRadius: 3, height: 6 },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  cell: {
    alignItems: 'center',
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    gap: 4,
    paddingVertical: space.md,
    width: '31%',
  },
  stage: { alignItems: 'center', height: 52, justifyContent: 'center' },
  cellLabel: { ...type.small, color: color.ink, fontFamily: font.sansSemibold },
  cellOp: { color: color.inkFaint, fontFamily: font.mono, fontSize: 9 },

  diag: { padding: space.md },
  row: { flexDirection: 'row', gap: space.md, justifyContent: 'space-between', paddingVertical: 5 },
  rowLabel: { ...type.settingsValue, color: color.inkDim },
  rowValue: { ...type.settingsValue, color: color.ink, flexShrink: 1, textAlign: 'right' },
});
