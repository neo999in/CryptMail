/**
 * The glyph on a swipe pane, and the motion it makes when the action arms.
 *
 * A swipe icon here is not one drawing: it is the parts the drawing is already
 * made of — a lid and a box, a bin and its bars, a face and its hands — each in
 * its own group, each moving on its own. What they do is the operation acting on
 * the object: the archive lid lifts and the message drops through the slot, the
 * bin's lid swings open and its contents fall out, the envelope's flap folds
 * down, the clock's hands sweep.
 *
 * The technique is `heroicons-animated`'s, which the user pointed at. Its code
 * is not, and cannot be: that library is React DOM + `motion/react`, and there
 * is no DOM here for it to animate. What transfers is the decomposition, the
 * keyframes and the timings — and those transfer exactly.
 *
 * ## Two kinds of motion
 *
 * `motion/react` variants come in two shapes and both are needed, so both are
 * here. A glyph declares which one it is:
 *
 *  - **`hold`** — a rest pose and an armed pose, sprung between them. The glyph
 *    stays armed for as long as the pull is past the line, and springs back when
 *    it is not. Most operations are this.
 *  - **`play`** — a keyframed sequence that runs once and *ends where it
 *    started*, like a bin whose lid opens, empties and closes. Holding past the
 *    line does not hold it open, because the thing it depicts is over.
 *
 * Both are driven by the same 0→1 value, which is why the difference costs
 * nothing at the call site: a `hold` glyph is simply a sequence with two stops.
 * Only who *drives* that value differs (`ui/swipeRow.tsx`) — a spring that
 * settles at 1, or a timing that sweeps to 1 once.
 *
 * Segments between keyframes are linear, where `motion/react` eases each one.
 * Over a sequence this short the keyframe positions carry the shape and the
 * difference is not visible; if it ever is, the fix is more stops, not an easing
 * on the driver — that would distort the `times` the sequence is built on.
 *
 * ## Why it is built this way
 *
 * Nothing here re-renders while a finger is down — the whole of `swipeRow.tsx`
 * exists to hold that line — so every part follows one shared value on the UI
 * thread.
 *
 * **Each part is its own `<Svg>`, stacked, and moved by a `View` transform.**
 * The obvious build is one `<Svg>` with a `G` per part and `useAnimatedProps`
 * driving the group's `x`/`y`/`rotation`, and that build does not work: under
 * Fabric those props are not applied per frame, so the parts lag the value badly
 * and settle only when something else re-renders. It was measured rather than
 * guessed — the driving value swept smoothly (99% → 55% → 5% on a readout) while
 * the glyph sat on one of two poses throughout. A `View`'s `transform` is
 * animated on the UI thread and always has been, so the parts are `View`s and
 * the SVG under each one never changes.
 *
 * The cost is one `<Svg>` per part instead of per glyph. They share a viewBox
 * and are absolutely positioned in the same box, so they overlay exactly, and
 * the count is bounded by the parts of one icon.
 *
 * ## Geometry
 *
 * The app's own (`ui/Icon.tsx`) except where an icon was handed over
 * specifically — `archive` and `trash` are the reference library's, path for
 * path. The cost is real and worth stating: those two now differ slightly from
 * the same-named glyphs the message screen's toolbar and the drawer draw. A
 * third exception should mean moving the whole set over rather than keeping two
 * of everything.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Extrapolation, interpolate, SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { SwipeOperation } from '../swipe/swipe';

/**
 * The spring a `hold` glyph settles on, from the reference library.
 *
 * One spring for every part: they move by different amounts and in different
 * directions, but they are one object doing one thing, and a lid that settled on
 * a different curve from its own box would read as two icons.
 */
export const GLYPH_SPRING = { stiffness: 200, damping: 25, mass: 0.5 } as const;

/**
 * How one part moves, as keyframes over the 0→1 drive.
 *
 * `times` are the stops, and every channel present must have one value per stop
 * — the same contract `motion/react` keyframes use, so a variant can be copied
 * across without rethinking it. Distances are in the glyph's own 24×24 units,
 * rotations in degrees.
 */
type Track = {
  /** Defaults to `[0, 1]`: a plain rest → armed pair. */
  times?: number[];
  x?: number[];
  y?: number[];
  rotate?: number[];
  scale?: number[];
  scaleY?: number[];
  opacity?: number[];
  /** What a rotation or scale turns about. Defaults to the glyph's centre. */
  origin?: [number, number];
};

const CENTRE: [number, number] = [12, 12];
const PAIR = [0, 1];

/**
 * One part of a glyph: what it draws, and how it moves.
 *
 * `draw` takes the stroke props so a part is styled by the caller — the pane
 * renders the same glyph twice in two inks and cross-fades them, since an SVG's
 * `stroke` is a prop rather than a style and recolouring it would mean a render.
 */
type Part = { track: Track; draw: (p: object) => React.ReactNode };

type Glyph = {
  /** See the header: hold an armed pose, or play a sequence through once. */
  drive: 'hold' | 'play';
  /** `play` only — how long the sequence takes. */
  durationMs?: number;
  parts: Part[];
};

/**
 * Every animated swipe glyph, by the operation it stands for.
 *
 * The motion *is* the operation, which is the whole reason it is worth
 * animating: a reader who has pulled far enough to fire sees the thing that is
 * about to happen acted out, rather than an icon that wobbled.
 *
 * `set-up` is absent and keeps having no glyph — it is a sentence, and a moving
 * picture beside a side that has not been given a meaning yet would be the app
 * animating its own settings prompt.
 */
const GLYPHS: Partial<Record<SwipeOperation, Glyph>> = {
  /**
   * The lid lifts off a box that settles under it — the message going in.
   *
   * The reference library's `ArchiveBoxIcon`: paths and both variants exactly
   * (lid −1.5, every other stroke +1). The lid is drawn last so it sits over the
   * box it lifts away from.
   */
  archive: {
    drive: 'hold',
    parts: [
      {
        track: { y: [0, 1] },
        draw: (p) => (
          <Path
            d="M19.6246 18.1321C19.5546 19.3214 18.5698 20.25 17.3785 20.25H6.62154C5.43022 20.25 4.44538 19.3214 4.37542 18.1321"
            {...p}
          />
        ),
      },
      { track: { y: [0, 1] }, draw: (p) => <Path d="M20.25 7.5L19.6246 18.1321" {...p} /> },
      { track: { y: [0, 1] }, draw: (p) => <Path d="M3.75 7.5L4.37542 18.1321" {...p} /> },
      { track: { y: [0, 1] }, draw: (p) => <Path d="M9.99976 11.25H13.9998" {...p} /> },
      {
        track: { y: [0, -1.5] },
        draw: (p) => (
          <Path
            d="M3.375 7.5H20.625C21.2463 7.5 21.75 6.99632 21.75 6.375V4.875C21.75 4.25368 21.2463 3.75 20.625 3.75H3.375C2.75368 3.75 2.25 4.25368 2.25 4.875V6.375C2.25 6.99632 2.75368 7.5 3.375 7.5Z"
            {...p}
          />
        ),
      },
    ],
  },

  /**
   * The bin being emptied — the one glyph that is a **sequence** rather than a
   * pose. The lid swings open on its left hinge, the two bars drop out and fade
   * as they go, the bin takes the weight with a short squash, and everything
   * comes back.
   *
   * The reference library's `Trash2Icon`, keyframes and `times` transferred
   * exactly. It ends where it began on purpose: holding a pull past the line
   * does not hold the lid open, because the thing being depicted has finished
   * happening. That is what `drive: 'play'` means, and this is the glyph it
   * exists for.
   *
   * Bars first, then the bin, then the lid group on top — the reference's order,
   * and the one that lets the bars fall *into* the bin rather than over it.
   */
  trash: {
    drive: 'play',
    durationMs: 900,
    parts: [
      {
        track: { times: [0, 0.35, 0.6, 1], y: [0, 5, 5, 0], opacity: [1, 0, 0, 1] },
        draw: (p) => <Path d="M10 11v6" {...p} />,
      },
      {
        track: { times: [0, 0.35, 0.6, 1], y: [0, 5, 5, 0], opacity: [1, 0, 0, 1] },
        draw: (p) => <Path d="M14 11v6" {...p} />,
      },
      {
        track: { times: [0, 0.55, 0.75, 1], y: [0, 0, 1, 0], scaleY: [1, 1, 0.94, 1], origin: [12, 22] },
        draw: (p) => <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" {...p} />,
      },
      {
        track: { times: [0, 0.2, 0.55, 1], rotate: [0, -24, -24, 0], origin: [3, 6] },
        draw: (p) => <Path d="M3 6h18" {...p} />,
      },
      {
        track: { times: [0, 0.2, 0.55, 1], rotate: [0, -24, -24, 0], origin: [3, 6] },
        draw: (p) => <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" {...p} />,
      },
    ],
  },

  // The same move as archive, the other way: the tray lifts out of the box.
  unarchive: {
    drive: 'hold',
    parts: [
      { track: { y: [0, 1] }, draw: (p) => <Rect x={3} y={4} width={18} height={16} rx={2} {...p} /> },
      { track: { y: [0, -2] }, draw: (p) => <Path d="M3 13h4l2 3h6l2-3h4" {...p} /> },
    ],
  },
  restore: {
    drive: 'hold',
    parts: [
      { track: { y: [0, 1] }, draw: (p) => <Rect x={3} y={4} width={18} height={16} rx={2} {...p} /> },
      { track: { y: [0, -2] }, draw: (p) => <Path d="M3 13h4l2 3h6l2-3h4" {...p} /> },
    ],
  },

  // The badge presses into the folder: the mark being applied to it.
  'mark-spam': {
    drive: 'hold',
    parts: [
      { track: { x: [0, -1], y: [0, -0.5] }, draw: (p) => <Path d="M3 7V6a2 2 0 0 1 2-2h3.5l2 2H15" {...p} /> },
      { track: { x: [0, -1], y: [0, -0.5] }, draw: (p) => <Path d="M3 9h9" {...p} /> },
      { track: { x: [0, -1], y: [0, -0.5] }, draw: (p) => <Path d="M3 9v9a2 2 0 0 0 2 2h8" {...p} /> },
      {
        track: { scale: [1, 1.14], origin: [17.5, 15.5] },
        draw: (p) => <Circle cx={17.5} cy={15.5} r={4.5} {...p} />,
      },
      {
        track: { scale: [1, 1.14], origin: [17.5, 15.5] },
        draw: (p) => <Path d="m14.3 18.7 6.4-6.4" {...p} />,
      },
    ],
  },

  // A single stroke, so the motion is the whole of it: the tick lands.
  'mark-not-spam': {
    drive: 'hold',
    parts: [{ track: { scale: [1, 1.16], y: [0, 0.5] }, draw: (p) => <Path d="M20 6 9 17l-5-5" {...p} /> }],
  },

  // The flap folds down onto a closed envelope, and lifts off an opened one —
  // the two states this action flips between, drawn.
  'mark-read': {
    drive: 'hold',
    parts: [
      { track: {}, draw: (p) => <Rect x={3} y={5} width={18} height={14} rx={2} {...p} /> },
      { track: { y: [0, 1.5] }, draw: (p) => <Path d="m3 7 9 6 9-6" {...p} /> },
    ],
  },
  'mark-unread': {
    drive: 'hold',
    parts: [
      { track: {}, draw: (p) => <Rect x={3} y={5} width={18} height={14} rx={2} {...p} /> },
      { track: { y: [0, -1.5] }, draw: (p) => <Path d="m3 7 9 6 9-6" {...p} /> },
    ],
  },

  // The face holds still and the hands move on, which is the only part of a
  // clock that ever does.
  snooze: {
    drive: 'hold',
    parts: [
      { track: {}, draw: (p) => <Circle cx={12} cy={12} r={9} {...p} /> },
      { track: { rotate: [0, 40] }, draw: (p) => <Path d="M12 7.5V12l3 2" {...p} /> },
    ],
  },
};

/** Whether this operation draws anything at all — `set-up` is the one that does not. */
export function hasGlyph(operation: SwipeOperation): boolean {
  return GLYPHS[operation] !== undefined;
}

/**
 * How this operation's glyph wants its 0→1 value driven.
 *
 * Read by `ui/swipeRow.tsx`, which owns the driving: a `hold` glyph is sprung to
 * 1 and left there while the pull is past the line; a `play` glyph is swept to 1
 * once over `durationMs`, and reset when the pull comes back.
 *
 * An operation with no glyph answers `hold`, which drives nothing.
 */
export function glyphDrive(operation: SwipeOperation): { drive: 'hold' | 'play'; durationMs: number } {
  const glyph = GLYPHS[operation];
  return { drive: glyph?.drive ?? 'hold', durationMs: glyph?.durationMs ?? 0 };
}

/**
 * One part, following the drive value.
 *
 * A component rather than a line in a loop because each part needs its own
 * `useAnimatedStyle`, and hooks cannot be called from inside a `map`.
 *
 * Distances arrive in the glyph's 24-unit space and are converted here, because
 * that is the only place the rendered `size` is known — a track written against
 * the drawing stays correct at any size.
 *
 * A rotation or scale about a point that is not the centre is done the way it
 * always is: translate the origin to the centre, turn, translate back. RN
 * applies a transform list outermost-first, which is why the pair straddles the
 * rotation rather than preceding it.
 */
function GlyphPart({
  progress,
  track,
  size,
  children,
}: {
  progress: SharedValue<number>;
  track: Track;
  size: number;
  children: React.ReactNode;
}) {
  const times = track.times ?? PAIR;
  const { x, y, rotate, scale, scaleY, opacity, origin = CENTRE } = track;
  /** One glyph unit, in points. */
  const unit = size / 24;
  const ox = (origin[0] - CENTRE[0]) * unit;
  const oy = (origin[1] - CENTRE[1]) * unit;

  const style = useAnimatedStyle(() => {
    const at = (values: number[] | undefined, fallback: number) =>
      values === undefined ? fallback : interpolate(progress.value, times, values, Extrapolation.CLAMP);

    const s = at(scale, 1);
    return {
      opacity: at(opacity, 1),
      transform: [
        { translateX: at(x, 0) * unit },
        { translateY: at(y, 0) * unit },
        { translateX: ox },
        { translateY: oy },
        { rotate: `${at(rotate, 0)}deg` },
        { scaleX: s },
        { scaleY: s * at(scaleY, 1) },
        { translateX: -ox },
        { translateY: -oy },
      ],
    };
  }, [opacity, ox, oy, progress, rotate, scale, scaleY, times, unit, x, y]);

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {children}
      </Svg>
    </Animated.View>
  );
}

/**
 * The glyph for one swipe operation, at the given ink.
 *
 * Draws nothing for an operation with no glyph, so a caller can render it
 * unconditionally and let `hasGlyph` answer the layout question.
 */
export function SwipeGlyph({
  operation,
  armed,
  color,
  size = 22,
  strokeWidth = 2,
}: {
  operation: SwipeOperation;
  /** 0 at rest, 1 at the end of the motion. Driven by the caller. */
  armed: SharedValue<number>;
  color: string;
  size?: number;
  strokeWidth?: number;
}) {
  const glyph = GLYPHS[operation];
  if (!glyph) return null;

  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none' as const,
  };

  return (
    <View style={{ height: size, width: size }}>
      {glyph.parts.map((part, i) => (
        // The index is the key: this list is a constant, and its order is the
        // drawing order the parts are stacked in.
        <GlyphPart key={i} progress={armed} size={size} track={part.track}>
          {part.draw(common)}
        </GlyphPart>
      ))}
    </View>
  );
}
