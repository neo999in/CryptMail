/**
 * The swipe gesture on a mail row, and the pane it reveals.
 *
 * Two exports, and the second one is the reason the first is shaped this way:
 *
 * - `SwipeActionPane` draws *only* the coloured area behind a row — fill, glyph,
 *   label — from a resolved `SwipeVisual` and the row's live offset. Nothing
 *   about mail reaches it.
 * - `SwipeableRow` is the gesture: it follows the finger, feeds that pane, and
 *   on release either runs the operation or springs back.
 *
 * The Swipe options screen draws its preview with the same two, so what the user
 * configures cannot drift away from what their thumb will do. That is the only
 * reason the pane is a separate component.
 *
 * **Nothing here re-renders while a finger is down.** Both panes are mounted
 * once and everything that moves — the fill deepening, the glyph flipping to
 * dark ink, the label appearing, the row itself — is an animated style driven
 * from one shared value on the UI thread. A version of this that pushed the
 * pull into React state re-rendered the row (and rebuilt the gesture under it)
 * on every frame of every swipe.
 *
 * Deliberately knows nothing about what an operation *does*: it is handed a
 * resolved visual and calls back with it. Running it is `ui/swipeRun.tsx`,
 * through `useApp()` like every other screen.
 *
 * On the animation gates the top bar's aurora answers to: those are about a band
 * that animates on an idle screen, and nothing here does. This moves while a
 * finger is down and for the fraction of a second a release takes to settle.
 * Reduced motion is still honoured for the one piece of motion the user did not
 * ask for by dragging — the exit fling.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityActionEvent,
  LayoutChangeEvent,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import {
  SWIPE_ENGAGE_PX,
  SWIPE_REST_ALPHA,
  SwipeDirection,
  SwipeOperation,
  SwipeTone,
  SwipeVisual,
  swipeArmed,
  swipeFillState,
  swipeProgress,
  swipeRelease,
  swipeThreshold,
  swipeTravel,
} from '../swipe/swipe';
import { color, font, readableOn, space, swipeColor, tint, type } from '../theme';
import { useAccent } from './appearance';
import { GLYPH_SPRING, glyphDrive, hasGlyph, SwipeGlyph } from './swipeGlyph';

/**
 * The width the block's contents are laid out in, whatever the block itself is
 * doing — wide enough for a glyph beside "Mark unread", and for "Swipe to set up
 * actions" over two lines.
 *
 * Fixed, because it is what stops the label re-wrapping as the block grows; the
 * block clips it while it is still the narrower of the two.
 */
const PANE_CONTENT = 116;

/**
 * The tone's colour.
 *
 * The action colours from the theme — a saturated green and a true red, their
 * own family rather than the `mint`/`coral` trust pair (see `swipeColor` for
 * why). Snooze is the one that follows the accent, because a time is not a
 * verdict about the message. Every value is a 6-digit hex, which is what
 * `tint()` needs to wash it down the pull.
 *
 * `neutral` is a *surface*, not a colour: an operation that files nothing and
 * moves nothing (a read flag, the set-up prompt) should read as a panel behind
 * the row rather than as a verdict about the message. It ramps from the ground
 * to `surfaceRaised`, which is the same grey the app's own controls sit on — a
 * light slab there would shout louder than Delete does.
 */
export function swipeTint(tone: SwipeTone, accent: string): string {
  switch (tone) {
    case 'positive':
      return swipeColor.positive;
    case 'destructive':
      return swipeColor.destructive;
    case 'accent':
      return accent;
    case 'neutral':
      return color.surfaceRaised;
  }
}

/**
 * The ink on that block, at rest and once it will fire.
 *
 * At rest the glyph is the block's own colour picked out of a dark shade of
 * itself — a green outline on near-black green — and the whole thing is dim.
 * Armed, the block is full colour and the ink is whatever actually reads on it,
 * which `readableOn` answers per colour rather than per tone: the action green
 * is light enough to need dark ink, the red is not, and the accents vary with
 * whichever palette the user picked.
 *
 * The flip is one of the three things that change on the single frame the block
 * arms — fill, ink, and the action's name appearing — so "this will happen" is
 * never carried by colour alone, and never by a shade the eye has nothing to
 * compare against.
 */
export function swipeInk(tone: SwipeTone, hue: string): { rest: string; armed: string } {
  // The neutral tone is a dark surface at both depths, so its ink stays light
  // and only brightens; there is no full colour for it to contrast against.
  if (tone === 'neutral') return { rest: color.inkDim, armed: color.ink };
  return { rest: hue, armed: readableOn(hue) };
}

/* ------------------------------------------------------------------ pane ---- */

/**
 * The block a swipe reveals.
 *
 * It is exactly the strip the row has uncovered — its width tracks the pull and
 * it is anchored to the edge the row came away from — so the colour arrives as a
 * solid block growing out of the side of the screen rather than as a tint lying
 * under the whole row. That is the difference between "an action is being
 * revealed" and "this row has changed colour".
 *
 * It has **two** looks and switches between them; it does not fade from one to
 * the other. Through the whole of the pull it is a dark shade of the action's
 * colour with the glyph picked out in that colour. On the single frame the pull
 * crosses the line, all three change at once: the fill becomes the full colour,
 * the glyph flips to the ink that reads on it, and the action's *name* appears
 * under it. So the armed state is said three ways and never by colour alone,
 * and — the reason for the step — a pull that will fire is a different picture
 * from one that will not, rather than a slightly deeper shade of it.
 *
 * A block whose whole content *is* a word (`set-up`, which has no glyph) shows
 * it from the start — there is nothing else in there to read.
 *
 * The dark glyph is a second copy of the light one, cross-faded: an SVG's stroke
 * is a prop rather than a style, so it cannot be animated, and re-rendering to
 * recolour it is exactly what this component exists not to do. The label's
 * colour *is* a style, so that one is interpolated in place.
 *
 * Mounted for both sides at once and shown by the sign of `dx`, so a gesture
 * never mounts anything. The settings preview drives the same component from a
 * shared value it simply never changes — a still frame of the real thing rather
 * than a drawing of it.
 */
export function SwipeActionPane({
  visual,
  direction,
  dx,
  threshold,
}: {
  visual: SwipeVisual;
  /** Which way the finger goes for this pane. It fills the edge the row uncovers. */
  direction: SwipeDirection;
  /** The row's live offset, in points. Negative is a leftward pull. */
  dx: SharedValue<number>;
  /** The distance at which this operation arms. */
  threshold: number;
}) {
  const accent = useAccent();
  const hue = swipeTint(visual.tone, accent);
  const wash = tint(hue, SWIPE_REST_ALPHA);
  // The armed fill is the colour itself, opaque: the true-black ground must not
  // show through the state that means "this is about to happen".
  const full = hue;
  const toRight = direction === 'right';
  const ink = swipeInk(visual.tone, hue);
  const glyph = hasGlyph(visual.operation);
  const reducedMotion = useReducedMotion();

  /**
   * How far through the pull this side is: 0 at rest, 1 at the trigger line, and
   * 0 whenever the pull is the other way — which is what keeps both panes
   * mounted with only one of them visible.
   *
   * Written out in each style rather than shared through one captured helper,
   * and with explicit dependencies. A helper closure is captured by the first
   * `useAnimatedStyle` that reads it, and the first render of a row happens
   * *before* it has been measured — so the threshold inside that closure was
   * zero, `progress` was pinned at zero for the life of the row, and the pane
   * sat at `opacity: 0` while the row itself slid perfectly well. It cost an
   * afternoon on a device; the duplication is the cheaper half of that trade.
   */
  const block = useAnimatedStyle(() => {
    const travel = toRight ? dx.value : -dx.value;
    const p = travel <= 0 ? 0 : swipeProgress(travel, threshold);
    return {
      // Two fills, switched — never faded between. The dark shade holds for the
      // whole of the pull and is replaced by the full colour on the frame the
      // action arms. See `SWIPE_REST_ALPHA` for why the step is the signal.
      backgroundColor: swipeFillState(p) === 'armed' ? full : wash,
      // Only ever seen through the strip the row has uncovered — see `s.pane`.
      opacity: p > 0 ? 1 : 0,
    };
  }, [dx, full, threshold, toRight, wash]);

  /**
   * Whether this side is armed right now: a plain 0 or 1, recomputed on every
   * frame of the pull along with everything else that reads `dx`.
   *
   * Deliberately carries **no animation**. See `armed` below for why that
   * separation is the whole thing.
   */
  const armedTarget = useDerivedValue<number>(() => {
    const travel = toRight ? dx.value : -dx.value;
    const p = travel <= 0 ? 0 : swipeProgress(travel, threshold);
    return swipeFillState(p) === 'armed' ? 1 : 0;
  }, [dx, threshold, toRight]);

  /**
   * The value the glyph's parts actually follow: 0 at rest, 1 once the pull
   * will fire, and *travelling* between the two.
   *
   * It is a shared value written by a reaction rather than a derived value that
   * returns a spring, and that is not a style choice. A `useDerivedValue` whose
   * worklet reads `dx` re-runs on every frame of the drag; if such a worklet
   * returns `withSpring(target)`, each of those runs **starts a new spring**
   * from the current value with zero velocity. Sixty restarts a second is a
   * spring that never gets to travel, so the parts snapped to their armed
   * positions and the animation was invisible — which is exactly how this was
   * first written, and exactly what it looked like on a device.
   *
   * A reaction fires only when its input actually changes, so the spring is
   * started once, on the frame the side arms or disarms, and is then left alone
   * to run. Everything else on the pane still switches instantly: this is the
   * only thing that eases.
   *
   * Under reduced motion the same transition is written without the spring — the
   * parts land in their armed positions without the travel, so the drawing still
   * says what is about to happen.
   */
  const armed = useSharedValue(0);

  /**
   * Which way this glyph wants driving — a pose to spring into and hold, or a
   * sequence to play through once (`ui/swipeGlyph.tsx`).
   */
  const { drive, durationMs } = glyphDrive(visual.operation);

  useAnimatedReaction(
    () => armedTarget.value,
    (next, previous) => {
      if (next === previous) return;
      if (reducedMotion) {
        // A `play` glyph ends where it started, so there is nothing to jump to:
        // it simply does not run. A `hold` glyph lands in its armed pose.
        armed.value = drive === 'play' ? 0 : next;
        return;
      }
      if (drive === 'play') {
        // Once through on arming, and straight back to the start on disarming —
        // the sequence has already returned the parts to their rest positions by
        // its last keyframe, so the reset is invisible and only matters for the
        // *next* arm.
        armed.value = next === 1 ? withTiming(1, { duration: durationMs, easing: Easing.linear }) : 0;
        return;
      }
      armed.value = withSpring(next, GLYPH_SPRING);
    },
    [drive, durationMs, reducedMotion],
  );

  const lightGlyph = useAnimatedStyle(() => {
    const travel = toRight ? dx.value : -dx.value;
    return { opacity: swipeArmed(swipeProgress(Math.max(travel, 0), threshold)) ? 0 : 1 };
  }, [dx, threshold, toRight]);

  const darkGlyph = useAnimatedStyle(() => {
    const travel = toRight ? dx.value : -dx.value;
    return { opacity: swipeArmed(swipeProgress(Math.max(travel, 0), threshold)) ? 1 : 0 };
  }, [dx, threshold, toRight]);

  /**
   * The word under the glyph: absent until the pull will actually run the
   * action, then there. A block that named its action from the first millimetre
   * would say "Delete" through a gesture that was going to be cancelled.
   *
   * A glyph-less block is the exception — its word is its whole content, so it
   * is there throughout and only its ink deepens.
   */
  const labelStyle = useAnimatedStyle(() => {
    const travel = toRight ? dx.value : -dx.value;
    const p = travel <= 0 ? 0 : swipeProgress(travel, threshold);
    const isArmed = swipeFillState(p) === 'armed';
    return {
      color: isArmed ? ink.armed : ink.rest,
      // Appears on the same frame the fill switches, rather than fading in
      // across the pull — one moment of change, said three ways.
      opacity: glyph ? (isArmed ? 1 : 0) : 1,
    };
  }, [dx, glyph, ink.armed, ink.rest, threshold, toRight]);

  return (
    <Animated.View
      // The row carries the same operations as accessibility actions, so this is
      // decoration — it must not become a second stop for a screen reader.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      // Pulling right uncovers the left edge, and the other way round.
      style={[s.pane, toRight ? s.paneStart : s.paneEnd, block]}
    >
      {/* Glyph over word, laid out at a fixed width and centred in the block, so
          a block still narrower than its contents clips them evenly instead of
          re-wrapping the word on every frame of the pull. */}
      <View style={s.paneInner}>
        {glyph ? (
          <View>
            <Animated.View style={lightGlyph}>
              <SwipeGlyph operation={visual.operation} armed={armed} color={ink.rest} strokeWidth={2} />
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, darkGlyph]}>
              <SwipeGlyph operation={visual.operation} armed={armed} color={ink.armed} strokeWidth={2.3} />
            </Animated.View>
          </View>
        ) : null}
        <Animated.Text numberOfLines={2} style={[s.paneLabel, labelStyle]}>
          {visual.label}
        </Animated.Text>
      </View>
    </Animated.View>
  );
}

/* --------------------------------------------------------------- gesture ---- */

const SETTLE = { damping: 20, stiffness: 220, mass: 0.6 } as const;

/** What the gesture needs to know about one side, as plain values a worklet can
 *  hold. Rebuilt on the JS thread when the row, its width or the prefs change. */
type Side = { threshold: number; removes: boolean };

export type SwipeableRowProps = {
  /** What a leftward pull does, or `null` for "this side does nothing". */
  left: SwipeVisual | null;
  /** What a rightward pull does, or `null`. */
  right: SwipeVisual | null;
  /**
   * Crossed the line and released. Called exactly once per gesture, as the row
   * starts to leave — the list is what actually drops the row.
   */
  onAction: (visual: SwipeVisual) => void;
  /**
   * Whether that operation takes the row out of this list, which is what decides
   * between flinging it away and springing it back. Defaults to yes.
   *
   * A message still in front of the reader must not slide away as though it
   * moved, and one that has genuinely gone must not spring back under a toast
   * saying it was archived.
   */
  removes?: (visual: SwipeVisual) => boolean;
  /**
   * Which message is under the finger.
   *
   * A list reuses this component for a different row as the data changes, and a
   * shared value does not reset when props do — so without this a row that had
   * been flung away could hand its offset to whatever message took its place,
   * which reads as a stray coloured block beside an untouched row.
   */
  resetKey?: string;
  /**
   * Styles for the clipping wrapper — which is where a list's *gap between
   * rows* belongs.
   *
   * The block is drawn to the wrapper's bounds, so a margin left on the row
   * inside it is a strip of wrapper the row does not cover, and the block shows
   * through it as a coloured hairline under every row it is behind. The gap has
   * to be outside the clip, not inside it.
   */
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

export function SwipeableRow({ left, right, onAction, removes, resetKey, style, children }: SwipeableRowProps) {
  const [width, setWidth] = useState(0);
  const dx = useSharedValue(0);
  /** Guards the callback: a gesture runs its operation once, or not at all. */
  const fired = useSharedValue(false);
  const reducedMotion = useReducedMotion();
  const recovery = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whatever this row was doing, it was doing it to a different message.
  useEffect(() => {
    dx.value = 0;
    fired.value = false;
  }, [dx, fired, resetKey]);

  /**
   * Put a row that flew away but is still here back where it belongs.
   *
   * A row is flung off only when its operation takes it out of the list, and
   * the list normally drops it within a frame or two. If it is still mounted
   * after that, the operation did not do what the fling promised — it failed,
   * or the provider put the row back — and a message that is still in the
   * mailbox must not sit parked off-screen behind a block of colour. So the row
   * comes back, and the toast is left to say what actually happened.
   */
  const recoverIfStillHere = useCallback(() => {
    if (recovery.current) clearTimeout(recovery.current);
    recovery.current = setTimeout(() => {
      fired.value = false;
      dx.value = withSpring(0, SETTLE);
    }, 700);
  }, [dx, fired]);

  useEffect(
    () => () => {
      if (recovery.current) clearTimeout(recovery.current);
    },
    [],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width;
    setWidth((current) => (current === next ? current : next));
  }, []);

  /**
   * Everything the worklets read, as plain data.
   *
   * Gesture callbacks run on the UI thread, so they may not call back into a
   * function defined here — `removes` and the visuals are resolved into numbers
   * and booleans up front, and only the two run callbacks cross back via
   * `runOnJS`.
   */
  const sides = useMemo(() => {
    const side = (visual: SwipeVisual | null): Side | null =>
      visual ? { threshold: swipeThreshold(width, visual.destructive), removes: removes ? removes(visual) : true } : null;
    return { width, left: side(left), right: side(right) };
  }, [left, removes, right, width]);

  const runLeft = useCallback(() => {
    if (left) onAction(left);
  }, [left, onAction]);

  const runRight = useCallback(() => {
    if (right) onAction(right);
  }, [onAction, right]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Sideways only, and only once the intent is unmistakable: the list
        // under this scrolls, and every row is a tap target.
        .activeOffsetX([-SWIPE_ENGAGE_PX, SWIPE_ENGAGE_PX])
        .failOffsetY([-10, 10])
        .onBegin(() => {
          fired.value = false;
        })
        .onUpdate((e) => {
          const side = e.translationX > 0 ? sides.right : sides.left;
          // A side with nothing configured — or nothing that means anything in
          // this list — does not move at all. That is the whole of "the first
          // right swipe does nothing".
          if (!side || side.threshold <= 0) {
            dx.value = 0;
            return;
          }
          // One-to-one up to the trigger line, damped past it (`swipeTravel`).
          dx.value = swipeTravel(e.translationX, side.threshold);
        })
        .onEnd((e) => {
          const toRight = e.translationX > 0;
          const side = toRight ? sides.right : sides.left;
          if (!side || side.threshold <= 0 || fired.value) {
            dx.value = 0;
            return;
          }

          if (swipeRelease(e.translationX, side.threshold) === 'cancel') {
            // Below the line: nothing ran, nothing changed, and the row goes back.
            dx.value = withSpring(0, SETTLE);
            return;
          }

          fired.value = true;
          if (side.removes && !reducedMotion) {
            // Off the edge it was pulled towards; the list then drops the row.
            // If it doesn't, `recoverIfStillHere` brings it back.
            dx.value = withTiming(toRight ? sides.width : -sides.width, { duration: 160 }, (done) => {
              if (done) runOnJS(recoverIfStillHere)();
            });
          } else {
            dx.value = withSpring(0, SETTLE);
          }
          runOnJS(toRight ? runRight : runLeft)();
        })
        .onFinalize(() => {
          // A gesture the system cancelled mid-pull leaves nothing half-open.
          if (!fired.value) dx.value = withSpring(0, SETTLE);
        }),
    [dx, fired, recoverIfStillHere, reducedMotion, runLeft, runRight, sides],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value }],
    // The row fades only as it leaves, which is the frame where it is over the
    // pane's full colour rather than beside it.
    opacity:
      sides.width === 0
        ? 1
        : interpolate(Math.abs(dx.value), [0, sides.width * 0.75, sides.width], [1, 1, 0.2], 'clamp'),
  }));

  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      if (left && e.nativeEvent.actionName === left.operation) onAction(left);
      else if (right && e.nativeEvent.actionName === right.operation) onAction(right);
    },
    [left, onAction, right],
  );

  const actions = useMemo(
    () =>
      [left, right]
        .filter((v): v is SwipeVisual => v !== null)
        // Both sides can resolve to the same operation; a duplicate action name
        // is not something to hand a screen reader.
        .filter((v, i, all) => all.findIndex((o) => o.operation === v.operation) === i)
        .map((v) => ({ name: v.operation, label: v.label })),
    [left, right],
  );

  // Nothing configured on either side: no detector, no pane, no layout listener
  // — the row is exactly what it was before this component existed.
  if (!left && !right) return <>{children}</>;

  return (
    <View
      // A pull is not available to someone driving the screen with a reader, so
      // whatever the two sides resolve to is offered as an action on the row
      // instead. Same operations, same words.
      accessibilityActions={actions}
      onAccessibilityAction={onAccessibilityAction}
      onLayout={onLayout}
      style={[s.wrap, style]}
    >
      {left && sides.left ? (
        <SwipeActionPane visual={left} direction="left" dx={dx} threshold={sides.left.threshold} />
      ) : null}
      {right && sides.right ? (
        <SwipeActionPane visual={right} direction="right" dx={dx} threshold={sides.right.threshold} />
      ) : null}
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: color.ground, overflow: 'hidden' },

  /**
   * The block, and why it is drawn full-bleed rather than sized to the pull.
   *
   * What the reader sees is the strip the row has uncovered — because the row
   * is opaque and lies on top of this. So the block *appears* to grow out of the
   * edge while nothing about it is actually animating its width, and that is
   * deliberate: an animated `width` moves the view's frame on the UI thread
   * without re-running layout, so its glyph and label keep the position Yoga
   * gave them at the width the pane was first laid out at — which is zero. They
   * end up parked off the visible strip, and the block reads as an empty slab.
   * Verified on a device before this comment existed.
   */
  pane: {
    alignItems: 'center',
    bottom: 0,
    flexDirection: 'row',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  // The contents sit against the edge the row comes away from, so they are the
  // first thing the strip reveals rather than something that arrives late.
  paneStart: { justifyContent: 'flex-start' },
  paneEnd: { justifyContent: 'flex-end' },
  paneInner: {
    alignItems: 'center',
    flexShrink: 0,
    gap: 6,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    // Fixed, so the label wraps once at layout time rather than on every frame
    // of the pull.
    width: PANE_CONTENT,
  },
  // Centred in the block, and allowed two lines: "Swipe to set up actions" is a
  // sentence, and a narrow block should wrap it rather than clip it.
  paneLabel: { ...type.small, fontFamily: font.sansSemibold, textAlign: 'center' },
});
