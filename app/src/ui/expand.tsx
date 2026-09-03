/**
 * Opening a mail: it grows out of its row, and it goes back to it.
 *
 * `Message` is presented as a `transparentModal` with `animation: 'none'` — the
 * list stays visible underneath — and what happens above it is a clipping
 * frame that starts and ends as the rectangle that was tapped:
 *
 *   - **Opening grows from the row.** The frame starts as the row's own
 *     rectangle, with `ghost` — a copy of that row — drawn in it, and opens out
 *     to the full display while the message cross-fades in behind it. The mail
 *     comes from the thing that was touched, so the list is never handed off to
 *     a card that arrived from somewhere else.
 *   - **Closing runs the same geometry backwards.** The frame shrinks to that
 *     rectangle and the ghost fades back in over the message. The mail becomes
 *     the row again, so the list handed back is visibly the one that was left.
 *
 * The two halves are the same move deliberately: a tapped row is a direct
 * manipulation, and a card that arrives from the bottom edge but leaves into a
 * row makes the reader learn two stories about one gesture. What kept them
 * apart before was the fear that a screen of text growing out of a row-high
 * band spends the transition unreadable — and it would, if it were scaled. It
 * is not: only the frame's box moves, the message inside is at fixed pixel size
 * throughout, and the frame *reveals* it rather than stretching it. Type is at
 * 100% on the first frame and every frame after.
 *
 * What keeps it honest:
 *
 *   - **The ghost is the row, not a likeness of it.** `ui/mailRow.tsx` is the
 *     single definition both the list and this draw, so the first and last
 *     frames of the transition are pixel-identical to what the list draws under
 *     them. A separate imitation drifts, and the drift reads as a cut.
 *   - **The message never reflows.** Only the frame's own box is animated; the
 *     screen inside it is absolutely positioned at fixed pixel dimensions and
 *     rides a `transform` that holds it still in window coordinates, so Yoga
 *     measures that subtree once instead of at every width between the row and
 *     the card.
 *   - **The list dims rather than being cut away.** The black under the frame
 *     comes up as the frame opens and clears early as it closes, so the list is
 *     lit either side of the mail and never disappears in one frame.
 *   - **The aurora bar is not part of this at all.** `topInset` holds the
 *     opening screen's own top bar clear: the inbox's bar keeps drawing above
 *     everything here. The band is never scaled, faded, clipped or re-mounted —
 *     it is the same bar, still running (`ui/chrome.tsx` is the one gate that
 *     had to widen to keep it running). Nothing here paints inside that inset.
 *   - **A spring out, a timing back.** `withSpring` decelerates the way the
 *     finger that started it did; a spring run backwards reads as hesitation,
 *     so the close is `motion.travel` on an ease that leaves quickly and lands
 *     softly — the row it is going to is already on screen, so the arrival is
 *     the part that has to be gentle.
 *
 * Without an origin — a deep link, any entry point that is not a tapped row —
 * the mail slides up from the bottom edge instead, and closing slides it back
 * down: there is no rectangle to morph out of, and inventing one would throw
 * the card at a row that is not there. Reduced motion draws the screen in
 * place. This is discrete motion, one run per open, so `useReducedMotion()` is
 * the only gate it answers to; it is not the aurora's continuous case.
 *
 * The pop is held by `beforeRemove` until the frame is home, then
 * re-dispatched — which is why the screen using this must not also keep a
 * native back gesture (see `App.tsx`).
 */
import type { NavigationAction } from '@react-navigation/native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { color, motion, radius } from '../theme';

/** Where the transition ends up: a row's rectangle, in window coordinates. */
export type OriginRect = { x: number; y: number; width: number; height: number };

/**
 * Soft and near-critical: enough give to read as physical, not enough to bounce
 * the subject line about. Overshoot on a full screen of text is what makes a
 * spring look cheap, so the damping carries this and the stiffness does not.
 */
const OPEN_SPRING = { damping: 22, stiffness: 120, mass: 0.9 } as const;

/** Closing is the travel token: the frame crosses the display, and `base` over
 *  that distance reads as a snap rather than a move. */
const CLOSE_MS = motion.travel;

/** Leaves quickly, lands softly — the row it is closing onto is already drawn,
 *  so the last few pixels are the ones worth spending the time on. */
const CLOSE_EASING = Easing.bezier(0.4, 0, 0.2, 1);

/** How long the open will wait on a layout before running without one. */
const OPEN_BAIL_MS = 100;

/** Which half is running. Read inside worklets, so a number, not a union. */
const OPENING = 0;
const CLOSING = 1;

/**
 * A ref for the view a screen should collapse back onto, and a way to measure
 * it.
 *
 * Measured at press time rather than on layout: a row in a scrolling list is at
 * a different place every frame, and the only rectangle that matters is the one
 * under the finger. `undefined` — the view is gone, or has no size — is a normal
 * answer, and means the mail slides back down rather than closing onto a stale
 * rectangle.
 */
export function useOriginRef() {
  const ref = useRef<View | null>(null);

  const measureOrigin = useCallback(
    () =>
      new Promise<OriginRect | undefined>((resolve) => {
        const node = ref.current;
        if (!node?.measureInWindow) {
          resolve(undefined);
          return;
        }
        let settled = false;
        const done = (rect?: OriginRect) => {
          if (settled) return;
          settled = true;
          resolve(rect);
        };
        // `measureInWindow` simply never calls back for a view that has gone
        // away, and a tap that opens nothing is worse than one that opens with
        // nowhere to close back to.
        const bail = setTimeout(() => done(undefined), 120);
        node.measureInWindow((x, y, width, height) => {
          clearTimeout(bail);
          done(width > 0 && height > 0 ? { x, y, width, height } : undefined);
        });
      }),
    [],
  );

  return [ref, measureOrigin] as const;
}

/** The part of a screen's navigation object this needs — nothing stack-specific. */
type ExitNavigation = {
  addListener: (
    type: 'beforeRemove',
    listener: (e: { preventDefault: () => void; data: { action: NavigationAction } }) => void,
  ) => () => void;
  dispatch: (action: NavigationAction) => void;
};

export function ExpandingScreen({
  origin,
  navigation,
  topInset = 0,
  revealTop = 0,
  ghost,
  onClosing,
  children,
}: {
  /** The rectangle to collapse back onto. Absent — another entry point, a deep
   *  link — closes by sliding back down. */
  origin?: OriginRect;
  navigation: ExitNavigation;
  /**
   * How much of the top of the display belongs to the screen underneath — its
   * top bar, which stays on show. Nothing here paints inside it: not the
   * ground, not the body, at no point in the transition. The inbox passes its
   * measured aurora bar; a screen with no bar worth keeping passes nothing, and
   * the mail fills the display.
   */
  topInset?: number;
  /**
   * How far below `topInset` the bar underneath is *still the bar* — the strip
   * of aurora the controls sat on, which they leave lit while they fade.
   * Nothing here paints inside it either, so a screen that keeps its own top
   * chrome transparent stands on the band rather than on a black block; past
   * this line the list is what is underneath, and the ground has to cover it.
   * Zero — the default — paints from `topInset` down, as before.
   */
  revealTop?: number;
  /**
   * The row this screen was opened from, drawn again — the thing the frame ends
   * as. Rendered at the row's own size in the frame's top-left corner and faded
   * in as the message leaves; without it the close is a shrink to an empty
   * card, not a morph back into the list.
   */
  ghost?: React.ReactNode;
  /**
   * Fired once, when the close starts — not when it finishes.
   *
   * The collapse reveals the screen underneath from its first frame, so
   * anything that screen hid on the way in has to come back now rather than at
   * the unmount at the end. The inbox's bar contents are exactly that.
   */
  onClosing?: () => void;
  children: React.ReactNode;
}) {
  const window = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const animated = !reducedMotion;

  const bodyRef = useRef<View | null>(null);
  /** The body's own rectangle, so the origin — in window coordinates — can be
   *  expressed as a point inside it. */
  const [frame, setFrame] = useState({ x: 0, y: 0, width: window.width, height: window.height });

  const progress = useSharedValue(animated ? 0 : 1);
  /** Which half `progress` is driving, so one value can run two transitions
   *  that are not each other's reverse. */
  const phase = useSharedValue<number>(OPENING);
  /** The pop this screen is holding back until the body is home again. */
  const exit = useRef<NavigationAction | null>(null);

  /**
   * Whether the body has been measured, so the frame's own box is known.
   *
   * The open is gated on it. Mounting a mail screen is real work — the row
   * summary, the trust chip, the scroll view — and a spring started at mount
   * runs on the UI thread by wall clock while the JS thread is still doing
   * that, so the first frame that actually paints is already a third of the way
   * through and the row it was supposed to grow out of has never been drawn.
   * Waiting for layout costs a frame and buys the whole first half of the move.
   */
  const [measured, setMeasured] = useState(false);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const node = bodyRef.current;
    const apply = (x: number, y: number) =>
      setFrame((was) =>
        was.x === x && was.y === y && was.width === width && was.height === height
          ? was
          : { x, y, width, height },
      );
    if (node?.measureInWindow) node.measureInWindow((x, y) => apply(x, y));
    else apply(0, 0);
    // Synchronously, on the layout itself — never inside the `measureInWindow`
    // callback. That callback simply never fires for some views, and a gate
    // that waits on it leaves the screen parked at `progress === 0`, which is
    // an invisible mail rather than a slow one.
    setMeasured(true);
  }, []);

  useEffect(() => {
    if (!animated) {
      progress.value = 1;
      return undefined;
    }
    if (!measured) {
      // Layout should land on the next commit; if something has swallowed it,
      // open anyway. A mail that opens from the wrong rectangle is a bad
      // transition — one that never opens is a broken screen.
      const bail = setTimeout(() => setMeasured(true), OPEN_BAIL_MS);
      return () => clearTimeout(bail);
    }
    // One more frame after the measurement commit, so the ghost is painted on
    // the row at rest before anything moves. Without it the first painted frame
    // is already the second frame of the spring.
    const frameId = requestAnimationFrame(() => {
      progress.value = withSpring(1, OPEN_SPRING);
    });
    return () => cancelAnimationFrame(frameId);
  }, [animated, measured, progress]);

  const leave = useCallback(() => {
    const action = exit.current;
    if (action) navigation.dispatch(action);
  }, [navigation]);

  useEffect(() => {
    if (!animated) return undefined;
    return navigation.addListener('beforeRemove', (e) => {
      // The second pass — our own re-dispatch — has to go through.
      if (exit.current) return;
      e.preventDefault();
      exit.current = e.data.action;
      onClosing?.();
      // Flipped before the run, never during it: every style below branches on
      // it, and at `progress === 1` both halves describe the same resting
      // frame, so the switch itself paints nothing.
      phase.value = CLOSING;
      progress.value = withTiming(0, { duration: CLOSE_MS, easing: CLOSE_EASING }, () => {
        runOnJS(leave)();
      });
    });
  }, [animated, leave, navigation, onClosing, phase, progress]);

  // The row, expressed inside the body's own box. The collapse lands here, on
  // the pixel, so its last painted frame and the list row it is handing back to
  // are the same picture.
  const from = origin
    ? { x: origin.x - frame.x, y: origin.y - frame.y, width: origin.width, height: origin.height }
    : null;

  // The clipping frame — the only box that moves. With a row to work from it
  // is that rectangle at `progress === 0` and the whole display at 1, and
  // `overflow: hidden` does the work: the message stays full size inside it,
  // revealed rather than stretched. With no row it is full size the whole way
  // and rides up on a transform from the bottom edge.
  const frameStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!from) {
      return {
        left: 0,
        top: 0,
        width: frame.width,
        height: frame.height,
        borderRadius: 0,
        // The fill is a layer of its own whenever a strip is being revealed —
        // see `fillStyle`. On the frame itself it could only be all or nothing.
        backgroundColor: revealTop > 0 ? 'transparent' : color.ground,
        // Off the bottom edge of the body — which is already clipped to below
        // the bar, so the card is never over the inset on its way up.
        transform: [{ translateY: interpolate(p, [0, 1], [frame.height, 0]) }],
      };
    }
    return {
      left: interpolate(p, [0, 1], [from.x, 0]),
      top: interpolate(p, [0, 1], [from.y, 0]),
      width: interpolate(p, [0, 1], [from.width, frame.width]),
      height: interpolate(p, [0, 1], [from.height, frame.height]),
      // The row is a flat band and the card is full bleed, so the rounding is
      // borrowed for the flight only — square at both ends.
      borderRadius: interpolate(p, [0, 0.5, 1], [0, radius.lg, 0], 'clamp'),
      // Card while the frame is small enough to read as an object, ground once
      // it is the screen; the message fades in over the top of that either way.
      backgroundColor: revealTop > 0 ? 'transparent' : interpolateColor(p, [0, 0.5], [color.card, color.ground]),
      transform: [{ translateY: 0 }],
    };
  });

  /**
   * The frame's fill, when a strip of bar is being kept lit.
   *
   * It cannot live on the frame: the frame is the box that moves, and its
   * background is either all of it or none. `revealTop` is a line in window
   * space, so the inset is measured from wherever the frame's top has got to —
   * while the card is still down on its row it is wholly below that line and
   * the fill is whole, and it opens up only as the frame arrives at the top.
   * Nothing pops at the end: the strip is clear from the first frame that
   * reaches it.
   */
  const fillStyle = useAnimatedStyle(() => {
    const p = progress.value;
    const offset = from
      ? interpolate(p, [0, 1], [from.y, 0])
      : interpolate(p, [0, 1], [frame.height, 0]);
    return {
      top: Math.max(0, revealTop - offset),
      backgroundColor: from ? interpolateColor(p, [0, 0.5], [color.card, color.ground]) : color.ground,
    };
  });

  // Sliding, the message is simply carried by the frame. Morphing out of a row
  // it rides a transform of its own that cancels the frame's offset, so it is
  // pinned in window coordinates while the frame opens over it: no reflow, and
  // no drift to correct at either end.
  //
  // It cross-fades against the ghost, and the two crossings are not the same
  // length. Opening, the message is what the reader asked for, so it is up
  // early and the row is gone by a third of the way. Closing, the row is the
  // destination and takes over sooner still — before that the frame is much
  // bigger than the row was, and a row-sized card in the corner of it does not
  // read as the same object.
  const contentStyle = useAnimatedStyle(() => {
    if (!from) return { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }] };
    const p = progress.value;
    const opening = phase.value === OPENING;
    return {
      opacity: opening
        ? interpolate(p, [0.2, 0.55], [0, 1], 'clamp')
        : interpolate(p, [0.25, 0.75], [0, 1], 'clamp'),
      transform: [
        { translateX: interpolate(p, [0, 1], [-from.x, 0]) },
        { translateY: interpolate(p, [0, 1], [-from.y, 0]) },
      ],
    };
  });

  const ghostStyle = useAnimatedStyle(() => {
    if (!from) return { opacity: 0 };
    const p = progress.value;
    return {
      opacity:
        phase.value === OPENING
          ? interpolate(p, [0.05, 0.4], [1, 0], 'clamp')
          : interpolate(p, [0, 0.3], [1, 0], 'clamp'),
    };
  });

  // Black under the frame, between it and the list. Sliding, it stays out of
  // the way until the end: the list is meant to show in the gap the card has
  // not covered yet. Morphing, it is the other half of the cross-fade — it
  // comes up behind the opening frame so the list dims out around it, and
  // clears early on the way back so the list is lit again before the frame
  // reaches the row. It starts at `topInset`: everything above that line
  // belongs to the bar, which stays lit.
  const groundStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!from) return { opacity: interpolate(p, [0.85, 1], [0, 1], 'clamp') };
    return {
      opacity:
        phase.value === OPENING
          ? interpolate(p, [0.2, 0.85], [0, 1], 'clamp')
          : interpolate(p, [0, 0.35], [0, 1], 'clamp'),
    };
  });

  return (
    // Touches are swallowed across the whole screen, the inset included: the
    // bar above is on show, but it belongs to a screen that is not in front,
    // and tapping through to the drawer from inside a message would be a bug.
    <View style={[styles.root, { paddingTop: topInset }]}>
      <Animated.View
        pointerEvents="none"
        style={[styles.ground, { top: topInset + revealTop }, groundStyle]}
      />
      <View collapsable={false} onLayout={onLayout} ref={bodyRef} style={styles.body}>
        <Animated.View style={[styles.frame, frameStyle]}>
          {revealTop > 0 ? (
            <Animated.View pointerEvents="none" style={[styles.fill, fillStyle]} />
          ) : null}
          <Animated.View
            style={[styles.content, { width: frame.width, height: frame.height }, contentStyle]}
          >
            {children}
          </Animated.View>
          {from && ghost ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.ghost, { width: from.width, height: from.height }, ghostStyle]}
            >
              {ghost}
            </Animated.View>
          ) : null}
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  ground: { backgroundColor: color.ground, bottom: 0, left: 0, position: 'absolute', right: 0 },
  // Clipped: the card comes up from below this box, and a row tapped while it
  // was half under the bar puts the frame above it on the way back — nothing
  // may paint into the inset the bar owns.
  body: { flex: 1, overflow: 'hidden' },
  frame: { overflow: 'hidden', position: 'absolute' },
  fill: { bottom: 0, left: 0, position: 'absolute', right: 0 },
  content: { left: 0, position: 'absolute', top: 0 },
  // Pinned to the frame's leading corner, at the row's own size: as the frame
  // closes upward the row stays where the row is.
  ghost: { left: 0, position: 'absolute', top: 0 },
});
