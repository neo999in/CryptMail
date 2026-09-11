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
 * specifically — `archive`, `trash`, the two envelopes (`mark-read`,
 * `mark-unread`), `mark-spam`, `mark-not-spam` and `snooze` are the reference
 * libraries', path for path. The cost is real and worth stating: those now differ
 * slightly from the same-named glyphs the message screen's toolbar and the drawer
 * draw. Six exceptions is well past the point at which moving the whole set over
 * beats keeping two of everything. That move is owed.
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
  /**
   * A turn *out of* the screen, about a horizontal line through `origin` —
   * with perspective, so the edge that swings towards the reader grows as it
   * comes. That growth is the whole reason it exists: a flap folded with
   * `scaleY` has no depth, and a fold with no depth reads as the far side of
   * the object opening away from you. Positive brings the lower edge forward.
   */
  rotateX?: number[];
  scale?: number[];
  scaleY?: number[];
  opacity?: number[];
  /** What a rotation or scale turns about. Defaults to the glyph's centre. */
  origin?: [number, number];
};

const CENTRE: [number, number] = [12, 12];
const PAIR = [0, 1];
/** A track that moves nothing — the `whole` of every glyph that has none. */
const STILL: Track = {};

/**
 * The envelope — the reference library's `MailOpenIcon`, with its flap drawn as
 * a part of its own. The sealed state is not a second drawing: it is this one
 * with the flap folded down over the front (`scaleY` −1 about the hinge), plus
 * the top edge the hinge becomes once it is closed.
 */
/** The walls and floor — the part that is the same open or sealed. */
const MAIL_BODY = 'M22 10v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10';
/** The open envelope's lips: the short turn-in at the top of each wall. */
const MAIL_LIPS = 'M21.2 8.4c.5.38.8.97.8 1.6M2 10a2 2 0 0 1 .8-1.6';
const MAIL_FOLD = 'm22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10';
const MAIL_FLAP = 'M2.8 8.4 10.8 2.4a2 2 0 0 1 2.4 0L21.2 8.4';
/**
 * The sealed top edge, corners and all. Rounded as the `Mail` family rounds
 * its corners — as round as the 1.6 between the top and the walls allows —
 * where the open envelope's lips turn in only a little; a straight edge meeting
 * those read as square corners on the sealed envelope. The lips and this are
 * cut over together, never drawn at once, so the corner is never doubled.
 */
const MAIL_HINGE = 'M2 10a1.6 1.6 0 0 1 1.6-1.6h16.8a1.6 1.6 0 0 1 1.6 1.6';
const MAIL_HINGE_Y: [number, number] = [12, 8.4];
/**
 * How far the sealed envelope sits above the open one. Sealed, the drawing
 * spans 8.4–22; open, 2.4–22. Without the lift the sealed state would sit low
 * in its box, and opening would look like it grew upwards off a shelf.
 */
const MAIL_LIFT = -3;
/**
 * How far the folded-down flap drops to lie on the inner fold when sealed.
 * Hung from the hinge it would put the V's corners in the top corners and its
 * point high; on the fold, the V starts partway down the walls and points a
 * little past the middle — the proportion `mark-spam`'s envelope has, so the
 * two envelopes in the same set read as the same envelope.
 */
const MAIL_FLAP_DROP = 2.6;
/**
 * The sealed V's proportions, to match a sealed envelope's (the `Mail` icon's):
 * corners about a fifth of the way down the walls, point just past the middle.
 * This body is squatter than that icon's, so moving the V down alone would put
 * its point too low — it is made shallower as well. Sealed, the flap is drawn
 * at this fraction of its length, and the fold under it is moved down and
 * flattened to lie on it, so the two stay one V.
 */
const MAIL_SEALED_FLAP = 0.8;
const MAIL_FOLD_DROP = 1;
const MAIL_SEALED_FOLD = 0.84;
/** The fold's corners, which it flattens towards. */
const MAIL_FOLD_TOP: [number, number] = [12, 10];

/**
 * The reference's ease — `cubic-bezier(0.34, 1.4, 0.64, 1)`, a back-out that
 * overshoots and settles — as the classic back-out polynomial it approximates.
 */
function backOut(t: number, overshoot = 1.70158): number {
  const u = t - 1;
  return 1 + (overshoot + 1) * u ** 3 + overshoot * u ** 2;
}

/** `cubic-bezier(0.16, 1, 0.3, 1)` — a fast start that settles long — as the
 *  exponential ease-out it approximates. */
function expoOut(t: number): number {
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
}

/**
 * A stroke being written: gone at the very start of the sequence, then grown
 * back from nothing between `start` and `end` along `ease`, sampled (see
 * `FLAP_TIMES` for why sampled). Returns the `times` and the values for
 * whichever scale channel does the growing.
 *
 * Never exactly zero — a singular transform is not something to hand the
 * renderer, and 1% of a stroke is not a visible mark.
 */
function reveal(start: number, end: number, ease: (t: number) => number): { times: number[]; values: number[] } {
  const steps = 10;
  const times = [0, 0.03];
  const values = [1, 0.01];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    times.push(start + (end - start) * t);
    values.push(Math.max(0.01, ease(t)));
  }
  times.push(1);
  values.push(1);
  return { times, values };
}

/** The reference library's `MailWarningIcon`, fold split at its point. */
const WARN_BODY = 'M22 10.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h12.5';
const WARN_FOLD_LEFT = 'M2 7l8.97 5.7a1.94 1.94 0 0 0 1.03.3';
const WARN_FOLD_RIGHT = 'M22 7l-8.97 5.7a1.94 1.94 0 0 1-1.03.3';
const WARN_STROKE = 'M20 14v4';

/** `mark-spam` — see its entry in `GLYPHS`. */
function warningMail(): Glyph {
  const fold = reveal(0.1, 0.5, expoOut);
  const stroke = reveal(0.3, 0.6, expoOut);
  // The reference's dot lands at 1.5× and settles; a back-out with this much
  // overshoot peaks at about that.
  const dot = reveal(0.5, 0.85, (t) => backOut(t, 5));
  return {
    drive: 'play',
    durationMs: 900,
    // Down a touch and squashed, then up and swelled, then home — sampled so
    // the dip turns into the hop rather than cornering into it.
    whole: {
      times: [0, 0.08, 0.16, 0.26, 0.36, 0.46, 0.56, 1],
      y: [0, 0.4, 0.1, -0.9, -1.2, -0.6, 0, 0],
      scale: [1, 0.97, 0.99, 1.03, 1.05, 1.02, 1, 1],
    },
    parts: [
      { track: {}, draw: (p) => <Path d={WARN_BODY} {...p} /> },
      { track: { times: fold.times, scale: fold.values, origin: [2, 7] }, draw: (p) => <Path d={WARN_FOLD_LEFT} {...p} /> },
      { track: { times: fold.times, scale: fold.values, origin: [22, 7] }, draw: (p) => <Path d={WARN_FOLD_RIGHT} {...p} /> },
      { track: { times: stroke.times, scaleY: stroke.values, origin: [20, 14] }, draw: (p) => <Path d={WARN_STROKE} {...p} /> },
      {
        track: { times: dot.times, scale: dot.values, origin: [20, 22] },
        ink: true,
        // The width of the pen, so it reads as the full stop under the stroke.
        draw: (p) => <Circle cx={20} cy={22} r={1.1} {...p} />,
      },
    ],
  };
}

/** The reference library's `MailCheckIcon`. Its fold is `WARN_FOLD_*`'s path, split the same way. */
const CHECK_BODY = 'M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8';
/** The tick, split at its corner so each stroke can be written from where the pen starts it. */
const CHECK_SHORT = 'M16 19l2 2';
const CHECK_LONG = 'M18 21l4-4';

/**
 * `mark-not-spam` — see its entry in `GLYPHS`.
 *
 * The reference runs about 0.75s at `duration = 1`: lift 0–0.5s, fold drawn
 * 0.08–0.58s, tick drawn 0.24–0.64s and popped 0.28–0.73s. Those stops are kept,
 * as fractions of one 750ms sweep.
 */
function checkMail(): Glyph {
  const s = (seconds: number) => seconds / 0.75;
  const fold = reveal(s(0.08), s(0.58), expoOut);
  // The tick's draw and its pop are one motion here: each stroke grows from its
  // own start, the long one overshooting as it lands (the reference's 1.12).
  const short = reveal(s(0.24), s(0.42), expoOut);
  const long = reveal(s(0.4), s(0.73), (t) => backOut(t, 2.2));
  return {
    drive: 'play',
    durationMs: 750,
    whole: { times: [0, s(0.25), s(0.5), 1], scale: [1, 1.04, 1, 1] },
    parts: [
      { track: {}, draw: (p) => <Path d={CHECK_BODY} {...p} /> },
      { track: { times: fold.times, scale: fold.values, origin: [2, 7] }, draw: (p) => <Path d={WARN_FOLD_LEFT} {...p} /> },
      { track: { times: fold.times, scale: fold.values, origin: [22, 7] }, draw: (p) => <Path d={WARN_FOLD_RIGHT} {...p} /> },
      { track: { times: short.times, scale: short.values, origin: [16, 19] }, draw: (p) => <Path d={CHECK_SHORT} {...p} /> },
      { track: { times: long.times, scale: long.values, origin: [18, 21] }, draw: (p) => <Path d={CHECK_LONG} {...p} /> },
    ],
  };
}

/**
 * The flap's motion, sampled. Segments between keyframes are linear, so an
 * overshoot written as one keyframe at 1.35 is two straight lines with a
 * corner at the peak — and a corner is exactly what reads as the icon being
 * *switched* rather than moving. Thirteen samples of the curve keep every
 * segment short enough that the path is the curve.
 */
const FLAP_TIMES = Array.from({ length: 13 }, (_, i) => i / 12);
/**
 * An ease-in-out, with no overshoot. The reference overshoots, and every
 * version of that tried here read as the flap *stretching*: a hold glyph runs
 * its keyframes backwards on release, so the overshoot comes back at the start
 * of the close — the flap grew taller before folding, and landing sealed it
 * dug a V past the envelope's front.
 */
const FLAP_CURVE = FLAP_TIMES.map((t) => (1 - Math.cos(Math.PI * t)) / 2);

/** The flap's angle at each sample, in radians: −π folded down, 0 upright. */
const FLAP_ANGLES = (opening: boolean) => FLAP_CURVE.map((f) => -Math.PI * (opening ? 1 - f : f));

/** How much wider the flap is drawn at this angle — most when edge-on, where a
 *  flap swinging towards the reader is nearest. 10% is enough to say "in
 *  front"; more starts to look like the flap itself is growing. */
const flapWidth = (angle: number) => 1 + 0.1 * Math.abs(Math.sin(angle));

/** The whole envelope, going sealed → open (`opening`) or open → sealed. */
function envelope(opening: boolean): Glyph {
  // Where the lift is at each sample — linear, so only the flap overshoots.
  const lift = (t: number) => MAIL_LIFT * (opening ? 1 - t : t);
  // How sealed the flap is at each sample, 1 → 0 when opening — the drop onto
  // the fold follows the flap's own ease, so the V never slides on its own.
  const sealedness = FLAP_CURVE.map((f) => (opening ? 1 - f : f));
  return {
    drive: 'hold',
    parts: [
      { track: { y: [lift(0), lift(1)] }, draw: (p) => <Path d={MAIL_BODY} {...p} /> },
      {
        // The lips show only while open — the counterpart of the top edge
        // below, cut over on the same frame.
        track: {
          times: [0, 0.5, 0.501, 1],
          y: [0, 0.5, 0.501, 1].map(lift),
          opacity: opening ? [0, 0, 1, 1] : [1, 1, 0, 0],
        },
        draw: (p) => <Path d={MAIL_LIPS} {...p} />,
      },
      {
        // The inner fold never leaves and never moves on the envelope: it is
        // the one line that is the envelope in both states, so it is the thing
        // that says this is one object throughout. Sealed, the flap lies on it.
        track: {
          times: FLAP_TIMES,
          y: FLAP_TIMES.map((t, i) => lift(t) + MAIL_FOLD_DROP * sealedness[i]),
          scaleY: sealedness.map((s) => 1 - (1 - MAIL_SEALED_FOLD) * s),
          origin: MAIL_FOLD_TOP,
        },
        draw: (p) => <Path d={MAIL_FOLD} {...p} />,
      },
      {
        // The top edge, along the hinge: there while the flap is down, gone
        // once it is up, as the reference's open envelope has none. It is cut,
        // never faded — a half-transparent line mid-motion read as a smudge —
        // and the cut falls on the frame the flap is edge-on over it, halfway
        // (`FLAP_CURVE` is symmetric), where the eye is on the flap.
        track: {
          times: [0, 0.5, 0.501, 1],
          y: [0, 0.5, 0.501, 1].map(lift),
          opacity: opening ? [1, 1, 0, 0] : [0, 0, 1, 1],
        },
        draw: (p) => <Path d={MAIL_HINGE} {...p} />,
      },
      {
        track: {
          times: FLAP_TIMES,
          y: FLAP_TIMES.map((t, i) => lift(t) + MAIL_FLAP_DROP * sealedness[i]),
          // Folded down (−180°) to upright (0°), drawn as the projection of a
          // flap turning towards the reader rather than as a real `rotateX`:
          // its height is the cosine of the angle, and it widens a little as
          // it passes edge-on, the way a nearer thing is larger. A real turn
          // with perspective was tried, and Android's camera exaggerates it
          // wildly at glyph size — the flap ballooned into a spike taller than
          // the envelope as it came edge-on. A flat flip with no widening at
          // all reads as the envelope opening from behind.
          scale: FLAP_ANGLES(opening).map(flapWidth),
          scaleY: FLAP_ANGLES(opening).map(
            (a, i) => (Math.cos(a) * (1 - (1 - MAIL_SEALED_FLAP) * sealedness[i])) / flapWidth(a),
          ),
          origin: MAIL_HINGE_Y,
        },
        draw: (p) => <Path d={MAIL_FLAP} {...p} />,
      },
    ],
  };
}

/**
 * One part of a glyph: what it draws, and how it moves.
 *
 * `draw` takes the stroke props so a part is styled by the caller — the pane
 * renders the same glyph twice in two inks and cross-fades them, since an SVG's
 * `stroke` is a prop rather than a style and recolouring it would mean a render.
 */
type Part = {
  track: Track;
  /**
   * Filled with the colour the glyph sits on, so it hides what is drawn before
   * it. Stroke-only drawing has no front and back — every line shows through
   * every other — and a letter that is visibly *in front of* the envelope, or a
   * message that visibly goes *behind* the box's front, needs something to be
   * opaque. With no `ground` given the fill is none and this does nothing.
   */
  solid?: boolean;
  /**
   * Filled with the ink and not stroked — a dot. A stroke-only circle small
   * enough to be a dot was the first try, relying on the pen's width to close
   * its middle, and Android draws that as a tiny ring.
   */
  ink?: boolean;
  draw: (p: object) => React.ReactNode;
};

type Glyph = {
  /** See the header: hold an armed pose, or play a sequence through once. */
  drive: 'hold' | 'play';
  /** `play` only — how long the sequence takes. */
  durationMs?: number;
  /**
   * A motion of the whole icon at once, on top of each part's own. A part's
   * scale has one origin, so an icon that hops as a unit while one of its
   * strokes grows from its own corner cannot say both in that part's track.
   */
  whole?: Track;
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
   * The message going into the box — a **sequence**, like trash. The lid swings
   * open on its left hinge, a message drops in through the gap, the box takes
   * the weight with a short dip, and the lid closes over it.
   *
   * The paths are the reference library's `ArchiveBoxIcon`; its variants (lid
   * −1.5, every other stroke +1) are not. At the pane's 22pt size those came to
   * about one point of travel, which on a device reads as a flicker rather than
   * as motion — the thing being depicted was simply too small to see. The
   * message sheet is ours, and is what makes it read as *archiving* rather than
   * as a box opening.
   *
   * The lid opens *towards* the reader, hinged along its back edge, so it is
   * the box's front that comes up rather than a lid falling away behind it.
   *
   * Message first, then the box's solid silhouette, then its strokes, then the
   * lid: the sheet falls *into* the box — hidden by its front as it goes in —
   * rather than being drawn across it.
   */
  archive: {
    drive: 'play',
    durationMs: 900,
    parts: [
      {
        // Falls from above the box while the lid is up, and goes in *behind*
        // the box's front — the backing below is what hides it.
        track: { times: [0, 0.15, 0.55, 0.7, 1], y: [-12, -12, 0, 0, 0], opacity: [0, 1, 1, 0, 0] },
        draw: (p) => <Rect x={8} y={12.5} width={8} height={5} rx={1} {...p} />,
      },
      {
        // The box's silhouette, filled and unstroked: the front the message
        // disappears behind. It moves with the box.
        track: { times: [0, 0.55, 0.72, 1], y: [0, 0, 1.5, 0] },
        solid: true,
        draw: (p) => (
          <Path
            d="M3.75 7.5L4.37542 18.1321C4.44538 19.3214 5.43022 20.25 6.62154 20.25H17.3785C18.5698 20.25 19.5546 19.3214 19.6246 18.1321L20.25 7.5Z"
            {...p}
            stroke="none"
          />
        ),
      },
      {
        track: { times: [0, 0.55, 0.72, 1], y: [0, 0, 1.5, 0] },
        draw: (p) => (
          <Path
            d="M19.6246 18.1321C19.5546 19.3214 18.5698 20.25 17.3785 20.25H6.62154C5.43022 20.25 4.44538 19.3214 4.37542 18.1321"
            {...p}
          />
        ),
      },
      {
        track: { times: [0, 0.55, 0.72, 1], y: [0, 0, 1.5, 0] },
        draw: (p) => <Path d="M20.25 7.5L19.6246 18.1321" {...p} />,
      },
      {
        track: { times: [0, 0.55, 0.72, 1], y: [0, 0, 1.5, 0] },
        draw: (p) => <Path d="M3.75 7.5L4.37542 18.1321" {...p} />,
      },
      {
        track: { times: [0, 0.55, 0.72, 1], y: [0, 0, 1.5, 0] },
        draw: (p) => <Path d="M9.99976 11.25H13.9998" {...p} />,
      },
      {
        // Hinged along its back edge, so its front edge swings up and towards
        // the reader — past edge-on, showing a sliver of its underside.
        track: {
          times: [0, 0.2, 0.6, 0.8, 1],
          y: [0, -1, -1, 0, 0],
          rotateX: [0, 115, 115, 0, 0],
          origin: [12, 3.75],
        },
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

  /**
   * A message being flagged: the envelope takes a breath and hops, its fold
   * draws itself in, and the warning mark is written beside it — the stroke,
   * then the dot, which lands with a pop.
   *
   * The reference library's `MailWarningIcon`, paths exactly. Its motion is
   * rebuilt rather than transferred, and improved on where a swipe pane asks
   * for it:
   *
   *  - It "draws" with `pathLength`, an SVG prop, which Fabric does not apply
   *    per frame (see the header). The same reading comes from transforms: the
   *    fold is split at its point and each half grows out of its own corner, so
   *    the V closes inwards the way a pen would make it, and the stroke of the
   *    mark grows down from its top.
   *  - Its lift is a flat 4% scale. Here the envelope dips first and then
   *    hops — anticipation, then release — which is what makes the flag read as
   *    something *happening* to the message rather than an icon breathing.
   *  - Its dot blinks its opacity after landing. At 22pt on a coloured block
   *    that reads as a flicker, so the pop's overshoot carries it alone.
   *
   * A `play` glyph, like trash: it ends as it began, the full warning mark, so
   * the pane at rest already says "spam". Every stroke is drawn at rest; the
   * sequence takes them away for an instant and writes them back, as the
   * reference does on hover.
   */
  'mark-spam': warningMail(),

  /**
   * A message cleared: the envelope lifts, its fold draws itself in, and a tick
   * is written in its corner and lands with a pop.
   *
   * The reference library's `MailCheckIcon`, paths exactly, and the sibling of
   * `mark-spam`'s envelope — the same fold, the same technique, since its
   * `pathLength` draw has to be transforms here too (see `mark-spam`). The tick
   * is split at its corner so the pen writes the short stroke, then the long.
   *
   * A `play` glyph: it ends as it began, the whole mark, so the pane at rest
   * already says "not spam".
   */
  'mark-not-spam': checkMail(),

  /**
   * The envelope opening, and closing again — the two states this action flips
   * between, acted out rather than nudged.
   *
   * **One envelope, not two drawings.** The open state is the reference
   * library's `MailOpenIcon`, and the sealed state is the same drawing with its
   * flap folded down over the front. So opening is the flap swinging up over
   * its hinge — towards the reader — and nothing else. A cross-fade between a
   * sealed and an open icon was tried first, and read as the icon being
   * swapped; a flat flip read as the envelope opening from behind; a real 3D
   * turn ballooned on Android. What is left is a flat flip that widens as it
   * passes edge-on, which is the cue the 3D turn was there to give.
   *
   * The flap's travel is an ease-in-out with no overshoot (`FLAP_CURVE` says
   * why the reference's overshoot was dropped). The whole envelope rises as it
   * opens, because an open envelope is taller than a sealed one.
   *
   * Read goes sealed → open; unread is the film backwards. So each rest pose
   * is the state the message is *in*.
   */
  'mark-read': envelope(true),
  'mark-unread': envelope(false),

  /**
   * Time moving on: the minute hand sweeps a full turn while the hour hand
   * steps forward one hour — the face holds still, as a clock's does.
   *
   * The reference library's clock, paths and motion exactly: minute hand
   * +360°, hour hand +30°, both about the centre. Its hour hand finishes a
   * little sooner (0.5s against 0.6s), which is the 0.83 stop. A full turn
   * ends where it began, so the armed pose looks like the rest pose; the sweep
   * is the whole of it, and it runs back on a pull that is let go.
   */
  snooze: {
    drive: 'hold',
    parts: [
      { track: {}, draw: (p) => <Circle cx={12} cy={12} r={10} {...p} /> },
      { track: { rotate: [0, 360] }, draw: (p) => <Path d="M12 6v6" {...p} /> },
      { track: { times: [0, 0.83, 1], rotate: [0, 30, 30] }, draw: (p) => <Path d="M12 12l4 2" {...p} /> },
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
  const style = useTrackStyle(progress, track, size);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        {children}
      </Svg>
    </Animated.View>
  );
}

/** The whole icon, following a glyph's `whole` track, with its parts inside. */
function GlyphWhole({
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
  const style = useTrackStyle(progress, track, size);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      {children}
    </Animated.View>
  );
}

/** A track, as the animated style of the view that follows it. */
function useTrackStyle(progress: SharedValue<number>, track: Track, size: number) {
  const times = track.times ?? PAIR;
  const { x, y, rotate, rotateX, scale, scaleY, opacity, origin = CENTRE } = track;
  /** How far the eye is from the glyph, for `rotateX`. Far: Android's camera
   *  exaggerates perspective at this size well beyond what the number says,
   *  and at 2.5× a part turning edge-on ballooned past the glyph's bounds. */
  const perspective = size * 8;
  /** One glyph unit, in points. */
  const unit = size / 24;
  const ox = (origin[0] - CENTRE[0]) * unit;
  const oy = (origin[1] - CENTRE[1]) * unit;

  return useAnimatedStyle(() => {
    const at = (values: number[] | undefined, fallback: number) =>
      values === undefined ? fallback : interpolate(progress.value, times, values, Extrapolation.CLAMP);

    const s = at(scale, 1);
    return {
      opacity: at(opacity, 1),
      // Perspective has to come first in the list to apply to what follows.
      transform: [
        { perspective },
        { translateX: at(x, 0) * unit },
        { translateY: at(y, 0) * unit },
        { translateX: ox },
        { translateY: oy },
        { rotate: `${at(rotate, 0)}deg` },
        { rotateX: `${at(rotateX, 0)}deg` },
        { scaleX: s },
        { scaleY: s * at(scaleY, 1) },
        { translateX: -ox },
        { translateY: -oy },
      ],
    };
  }, [opacity, ox, oy, perspective, progress, rotate, rotateX, scale, scaleY, times, unit, x, y]);
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
  ground,
  size = 22,
  strokeWidth = 2,
}: {
  operation: SwipeOperation;
  /** 0 at rest, 1 at the end of the motion. Driven by the caller. */
  armed: SharedValue<number>;
  color: string;
  /**
   * The opaque colour directly behind the glyph, which `solid` parts fill with
   * so they hide what is behind them. Must be what is actually painted there —
   * a translucent wash has to be resolved against its ground first.
   */
  ground?: string;
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
    fill: 'none',
  };
  const solid = { ...common, fill: ground ?? 'none' };
  const inked = { fill: color, stroke: 'none' };

  return (
    <View style={{ height: size, width: size }}>
      <GlyphWhole progress={armed} size={size} track={glyph.whole ?? STILL}>
        {glyph.parts.map((part, i) => (
          // The index is the key: this list is a constant, and its order is the
          // drawing order the parts are stacked in.
          <GlyphPart key={i} progress={armed} size={size} track={part.track}>
            {part.draw(part.ink ? inked : part.solid ? solid : common)}
          </GlyphPart>
        ))}
      </GlyphWhole>
    </View>
  );
}
