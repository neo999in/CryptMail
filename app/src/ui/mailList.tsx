/**
 * The list under a `MailTopBar` — the parts every mailbox draws the same way.
 *
 * The inbox, Sent and Archive are three different queries and one list: rows
 * fade in, group under day headings, and grow into the message screen from the
 * rectangle they were tapped from. Duplicating that per screen is how Sent ends
 * up a visibly cheaper version of the inbox — a flat list with no headings and
 * no transition — so the row, the headings and the loading shape live here and
 * each screen supplies only its own data and empty state.
 *
 * Presentation and measurement only: no fetching, no navigation decisions. The
 * card itself is `ui/mailRow.tsx`, which the message screen also draws as the
 * last frame of its closing transition.
 */
import { MotiView } from 'moti';
import React from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  SharedValue,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { MailSummary } from '../mail/types';
import { EncryptionState } from '../state/types';
import { resolveSwipePair, SwipeContext, SwipeVisual, swipeRemovesRow } from '../swipe/swipe';
import { color, font, radius, shadow, space, tint, type } from '../theme';
import { Icon } from './Icon';
import { useAccent } from './appearance';
import { OriginRect, useOriginRef } from './expand';
import { MailRowCard } from './mailRow';
import { useMailPrefs } from './mailPrefs';
import { Skeleton } from './primitives';
import { SwipeableRow } from './swipeRow';

type MailListRowProps = {
  /**
   * What this row stands for, handed back to `onPress` and `onSwipe` — a
   * message id, or a thread id in the threaded inbox.
   *
   * An id rather than a closure over the row's data, and that is what lets the
   * row be memoised: the list hands every row the *same* two callbacks, and each
   * looks the id up in the list's current data when it fires. A per-row arrow is
   * a new prop on every render of the list, so every render of the list — every
   * store patch, including the ones an opening message makes mid-transition —
   * re-rendered every row in it and rebuilt each one's swipe gesture.
   */
  id: string;
  summary: MailSummary;
  encryption: EncryptionState;
  /** Which mailbox this row came from, shown only while the inbox is merged. */
  mailbox?: string;
  /** Number of messages in this conversation; > 1 shows a thread-count chip. */
  count?: number;
  index: number;
  /**
   * Whether this row should fade and rise in, or simply be there.
   *
   * `'stagger'` is for a list arriving **from nothing** — a launch, a mailbox
   * opened for the first time — where the cascade gives the arrival a shape.
   * `'none'` is for a list whose content is being *replaced*: switching from
   * Sent to Archive, or a refresh landing. Those rows were already known, and
   * replaying the cascade over them costs the full 660 ms of stagger before the
   * mail is readable, which is the lag §7 of Design.md describes — a list that
   * animates into place is a list you cannot read yet.
   *
   * Defaulted to `'stagger'` so a caller that has not thought about it keeps the
   * old behaviour rather than silently losing the animation.
   */
  entry?: 'stagger' | 'none';
  /** Vertical padding for the current density. */
  padding: number;
  /** The active account, so a message you sent leads with who it went to. */
  selfAddress?: string;
  /** Handed the row's `id` and its own rectangle, when it could be measured, so
   *  the message screen can collapse back onto it — see `ui/expand.tsx`. */
  onPress: (id: string, origin?: OriginRect) => void;
  /**
   * Where this row is, so a configured swipe can resolve to what it means here
   * — or to nothing (`swipe/swipe.ts`).
   *
   * Absent on a list that does not swipe. The two mail lists pass it; the
   * message screen's closing ghost draws `MailRowCard` directly and never
   * reaches this component, so a mail cannot collapse back onto a row that is
   * half-swiped.
   */
  swipe?: Omit<SwipeContext, 'unread'>;
  /** Run what the swipe resolved to, for the row's `id`. `ui/swipeRun.tsx` is
   *  what a list hands in. */
  onSwipe?: (visual: SwipeVisual, id: string) => void;
  /** Local label names on this row — drawn by the card (`ui/mailRow.tsx`). */
  labels?: string[];
  /**
   * The list is in multi-select. Swiping is off for every row while it is: a
   * swipe acts on one conversation, and a gesture that quietly ignored the
   * selection around it would be a second, contradictory way to act.
   */
  selecting?: boolean;
  /** This row is one of the selected. */
  selected?: boolean;
  /** Handed the row's `id` on a long press — how a list enters multi-select. */
  onLongPress?: (id: string) => void;
};

/** How long a press is held before a mail row enters multi-select. */
const LONG_PRESS_MS = 280;

function MailListRowImpl({
  id,
  summary,
  encryption,
  mailbox,
  count = 1,
  index,
  entry = 'stagger',
  padding,
  selfAddress,
  onPress,
  swipe,
  onSwipe,
  labels,
  selecting = false,
  selected = false,
  onLongPress,
}: MailListRowProps) {
  const [rowRef, measureOrigin] = useOriginRef();
  const { swipeLeft, swipeRight } = useMailPrefs();
  const accent = useAccent();

  // Both sides, resolved for *this* row in *this* list. `null` on a side is the
  // honest answer for an unconfigured direction and for an action with no
  // meaning here, and the gesture treats the two the same: the row does not move.
  const context = React.useMemo<SwipeContext | null>(
    () => (swipe && onSwipe && !selecting ? { ...swipe, unread: summary.unread } : null),
    [onSwipe, selecting, summary.unread, swipe],
  );
  // Sent, Archive and Spam wear a fixed layout rather than the preference —
  // see `resolveSwipePair`.
  const { left, right } = React.useMemo(
    () => (context ? resolveSwipePair(swipeLeft, swipeRight, context) : { left: null, right: null }),
    [context, swipeLeft, swipeRight],
  );

  // Held steady for `SwipeableRow`, which builds its gesture from these: a new
  // function on each render is a new gesture on each render.
  const onAction = React.useCallback((visual: SwipeVisual) => onSwipe?.(visual, id), [id, onSwipe]);
  const removes = React.useCallback(
    (visual: SwipeVisual) => (context ? swipeRemovesRow(visual.operation, context) : true),
    [context],
  );
  const press = React.useCallback(
    // Selecting, a tap toggles the row and opens nothing, so there is no
    // rectangle worth waiting a measurement for.
    () => (selecting ? onPress(id) : void measureOrigin().then((origin) => onPress(id, origin))),
    [id, measureOrigin, onPress, selecting],
  );
  const longPress = React.useCallback(() => onLongPress?.(id), [id, onLongPress]);

  const row = (
    <MotiView
      from={entry === 'stagger' ? { opacity: 0, translateY: 8 } : { opacity: 1, translateY: 0 }}
      animate={{ opacity: 1, translateY: 0 }}
      // Capped so a long list settles quickly instead of dribbling in. A row
      // told not to stagger starts where it ends, so there is nothing to time.
      transition={
        entry === 'stagger'
          ? { type: 'timing', duration: 300, delay: Math.min(index, 8) * 45 }
          : { type: 'timing', duration: 0 }
      }
    >
      {/* The selected wash is on this view, not on the card: the card is also
          the closing transition's ghost, which is never selected. One
          `Pressable` for tap and long press — a second pressable nested inside
          the row breaks on RN-web. */}
      <View collapsable={false} ref={rowRef} style={[s.row, selected && { backgroundColor: tint(accent, 0.12) }]}>
        <Pressable
          accessibilityRole={selecting ? 'checkbox' : 'button'}
          accessibilityState={selecting ? { checked: selected } : undefined}
          accessibilityHint={selecting ? undefined : 'Long press to select'}
          onPress={press}
          onLongPress={onLongPress ? longPress : undefined}
          // React Native's 500 ms default read as "hold and wait" for a gesture
          // people reach for constantly. Short enough to feel immediate, long
          // enough that a scroll's touch-down or a tap does not trip it.
          delayLongPress={LONG_PRESS_MS}
          style={({ pressed }) => [pressed && !selected && s.rowPressed]}
        >
          <MailRowCard
            summary={summary}
            encryption={encryption}
            mailbox={mailbox}
            count={count}
            padding={padding}
            selfAddress={selfAddress}
            labels={labels}
            selected={selected}
          />
        </Pressable>
      </View>
    </MotiView>
  );

  // No swipe on this list: the row carries its own gap, since there is no
  // wrapper to put it on. Keyed on the *list* swiping, never on `selecting`:
  // switching wrappers when a selection starts remounts every row in the list
  // (see the end of `SwipeableRow`). Selecting reaches the wrapper as two null
  // sides instead, which disables the gesture in place.
  if (!swipe || !onSwipe) return <View style={s.rowGap}>{row}</View>;

  return (
    <SwipeableRow
      left={left}
      right={right}
      onAction={onAction}
      removes={removes}
      // The hairline between rows lives out here, on the wrapper: inside it, it
      // is a strip the row does not cover and the action's colour shows through
      // it. See `SwipeableRow`'s `style`.
      style={s.rowGap}
      // So an offset never outlives the message it belonged to.
      resetKey={summary.id}
    >
      {row}
    </SwipeableRow>
  );
}

/**
 * Whether a row can skip a render: every prop the same, two of them by value.
 *
 * `encryption` is re-derived for every row whenever the list's data changes
 * (`encryptionFor` builds a new object on each call), and `swipe` is an object
 * literal the list writes per row. Equal in every field is the same row; any
 * difference re-renders, so a mistake here costs a render, never a stale row.
 */
function sameRow(prev: MailListRowProps, next: MailListRowProps): boolean {
  return (
    prev.id === next.id &&
    prev.summary === next.summary &&
    shallowEqual(prev.encryption, next.encryption) &&
    prev.mailbox === next.mailbox &&
    prev.count === next.count &&
    prev.index === next.index &&
    prev.padding === next.padding &&
    prev.selfAddress === next.selfAddress &&
    prev.onPress === next.onPress &&
    shallowEqual(prev.swipe, next.swipe) &&
    prev.onSwipe === next.onSwipe &&
    sameList(prev.labels, next.labels) &&
    prev.selecting === next.selecting &&
    prev.selected === next.selected &&
    prev.onLongPress === next.onLongPress
  );
}

/** Label names are rebuilt per render of the list; equal names are the same row. */
function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((name, i) => name === right[i]);
}

function shallowEqual<T extends object>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Memoised, so a list re-rendering does not re-render its rows. The list
 * re-renders on every store patch — opening a message alone makes two or three
 * while its transition is running — and a mounted list is dozens of rows, each
 * a fade-in, a gesture and an animated style.
 */
export const MailListRow = React.memo(MailListRowImpl, sameRow);

/**
 * The one truly floating control on a mail list: an extended, labelled compose
 * button in neutral ink — not an accent-filled circle, which reads as a brand
 * mark rather than as "the" action. Every list that shows mail carries it,
 * because composing is never about which mailbox you happen to be looking at.
 *
 * `foldTarget` folds the label away to a round icon button while the list is
 * being read downwards, so it covers less of the rows; scrolling back up opens
 * it again. The accessibility label says Compose either way.
 */
export function ComposeFab({
  onPress,
  bottom,
  foldTarget,
}: {
  onPress: () => void;
  bottom: number;
  /** 0 open, 1 folded — written by a list's `useComposeScroll` on the UI thread. */
  foldTarget: SharedValue<number>;
}) {
  const [pressed, setPressed] = React.useState(false);
  // The label's natural width, measured off-screen once, so the pill can
  // animate between its full width and a circle rather than jump.
  const [labelWidth, setLabelWidth] = React.useState(0);
  const reduceMotion = useReducedMotion();

  // One value, 0 open → 1 folded, springing on the UI thread. Width, padding
  // and the label's fade are all read from it in a single style, so they move
  // as one instead of as three separately timed layout animations. It follows
  // the list's target without React: a scroll never re-renders anything.
  // Starts open, never read from `foldTarget` during render; the reaction's
  // first run (previous = null) carries it to wherever the list already is.
  const fold = useSharedValue(0);
  useAnimatedReaction(
    () => foldTarget.value,
    (target, previous) => {
      if (target === previous) return;
      fold.value = reduceMotion ? target : withSpring(target, FOLD_SPRING);
    },
    [reduceMotion],
  );

  const open = FAB_OPEN_PAD_LEFT + FAB_GLYPH + FAB_GAP + labelWidth + FAB_OPEN_PAD_RIGHT;
  const pill = useAnimatedStyle(() =>
    labelWidth
      ? {
          width: interpolate(fold.value, [0, 1], [open, FAB_SIZE], Extrapolation.CLAMP),
          paddingLeft: interpolate(fold.value, [0, 1], [FAB_OPEN_PAD_LEFT, FAB_ROUND_PAD], Extrapolation.CLAMP),
        }
      : {},
  );
  // Gone by the time the pill is half folded, so no clipped letters show.
  const label = useAnimatedStyle(() => ({
    opacity: interpolate(fold.value, [0, 0.5], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <MotiView
      from={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: pressed ? 0.94 : 1 }}
      transition={{ type: 'spring', damping: 15, stiffness: 220, mass: 0.7 }}
      style={[s.fab, shadow.floating, { bottom }]}
    >
      <Text
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        onLayout={(e) => setLabelWidth(Math.ceil(e.nativeEvent.layout.width))}
        style={[s.fabLabel, s.fabMeasure]}
      >
        Compose
      </Text>
      <Pressable
        accessibilityLabel="Compose"
        accessibilityRole="button"
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
      >
        <Animated.View style={[s.fabPress, pill]}>
          <Icon name="compose" size={FAB_GLYPH} color={color.ground} strokeWidth={2} />
          <Animated.Text numberOfLines={1} style={[s.fabLabel, { marginLeft: FAB_GAP }, label]}>
            Compose
          </Animated.Text>
        </Animated.View>
      </Pressable>
    </MotiView>
  );
}

/** Glyph size, icon-to-label gap, and the pill's paddings open and folded. */
const FAB_GLYPH = 22;
const FAB_GAP = 9;
const FAB_OPEN_PAD_LEFT = 20;
const FAB_OPEN_PAD_RIGHT = 22;
/** The folded circle: the glyph plus 16 on each side, the same as its height. */
const FAB_ROUND_PAD = 16;
const FAB_SIZE = FAB_GLYPH + FAB_ROUND_PAD * 2;
/** Quick and settled — no overshoot, which on a width reads as a wobble. */
const FOLD_SPRING = { damping: 26, stiffness: 380, mass: 0.6, overshootClamping: true };

/**
 * Scroll handling that folds the compose button: reading down folds it,
 * reaching back up or returning to the top opens it.
 *
 * A worklet, run on the UI thread for every scroll frame, writing the fold
 * target the button reacts to. So the fold starts on the frame the finger
 * moves, however busy the JS thread is — a page of mail landing mid-scroll used
 * to hold it back. A small dead zone stops a finger's jitter from flapping it.
 *
 * Spread onto a **Reanimated** scrollable: `Animated.ScrollView`, or
 * `AnimatedSectionList` below. A plain list cannot take a worklet handler.
 */
export function useComposeScroll(foldTarget: SharedValue<number>) {
  const last = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const y = e.contentOffset.y;
      const dy = y - last.value;
      if (y <= 8) {
        if (foldTarget.value !== 0) foldTarget.value = 0;
        last.value = y;
      } else if (Math.abs(dy) > 6) {
        const next = dy > 0 ? 1 : 0;
        if (foldTarget.value !== next) foldTarget.value = next;
        last.value = y;
      }
    },
  });
  return { onScroll, scrollEventThrottle: 16 } as const;
}

/**
 * `SectionList`, able to take a worklet scroll handler. Typed as the plain list
 * so each screen keeps its item and section generics.
 */
export const AnimatedSectionList = Animated.createAnimatedComponent(SectionList) as unknown as typeof SectionList;

export function SectionHeading({ title }: { title: string }) {
  return <Text style={s.sectionHead}>{title}</Text>;
}

/** A first load has nothing to show under a spinner, so it shows the shape. */
export function MailSkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={s.skelRow}>
          <Skeleton width={44} height={44} radius={22} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width="55%" height={12} />
            <Skeleton width="80%" height={12} />
            <Skeleton width="40%" height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

/* -------------------------------------------------------------- buckets ---- */

/** Group rows into the date sections a `SectionList` renders, newest first. */
/**
 * How much of a mail list is built up front — spread to every `SectionList`
 * that draws mail rows.
 *
 * A list's cost is its *rows*, not its data: the day grouping over a page of
 * twenty measures at about four milliseconds, while mounting the twenty rows
 * that grouping produces measures at over four hundred. Each row is a card, a
 * pressable, a measured origin ref and a swipe gesture, and React Native's
 * defaults (`initialNumToRender: 10`, `windowSize: 21`) build far more of them
 * than a phone screen can show — for a page of twenty, all of them.
 *
 * So the window is cut to roughly what is visible plus a screen of slack. The
 * rest arrive in small batches as the list is scrolled, which is what
 * virtualisation is for and what the defaults were quietly skipping.
 *
 * `removeClippedSubviews` is deliberately **not** here. It is the obvious next
 * lever and it is known to blank rows on Android when they carry their own
 * animations — which these do, every row being a `MotiView` — and a list that
 * is fast because it is empty is not a fix.
 */
export const MAIL_LIST_WINDOW = {
  initialNumToRender: 7,
  maxToRenderPerBatch: 6,
  windowSize: 5,
  updateCellsBatchingPeriod: 50,
} as const;

export function groupByDay<T>(rows: T[], dateOf: (row: T) => string): { title: string; data: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = dayBucket(dateOf(row));
    const list = buckets.get(bucket);
    if (list) list.push(row);
    else buckets.set(bucket, [row]);
  }
  return [...buckets].map(([title, data]) => ({ title, data }));
}

/**
 * Date buckets, matching the reference's headings.
 *
 * "This month" and "Last week" only ever appear below Today/Yesterday, so the
 * list reads as a single descending timeline rather than a set of overlapping
 * ranges.
 */
export function dayBucket(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 14) return 'Last week';
  if (days < 31) return 'This month';
  return 'Earlier';
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const s = StyleSheet.create({
  /**
   * A flat, full-bleed band rather than a floating card. Rows are separated by
   * the ground showing through a hairline gap, which is the bordered card's
   * separation with none of its ink.
   */
  row: { backgroundColor: color.card },
  /** The gap between rows. On the swipe wrapper — see `MailListRow`. */
  rowGap: { marginBottom: 2 },
  rowPressed: { backgroundColor: color.cardPress },

  sectionHead: {
    ...type.settingsValue,
    color: color.inkFaint,
    fontFamily: font.sansSemibold,
    letterSpacing: 0.4,
    paddingBottom: space.sm,
    paddingHorizontal: space.lg + 2,
    paddingTop: space.lg,
    textTransform: 'uppercase',
  },

  fab: {
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    position: 'absolute',
    right: 20,
  },
  fabPress: {
    alignItems: 'center',
    flexDirection: 'row',
    height: FAB_SIZE,
    overflow: 'hidden',
    paddingLeft: FAB_OPEN_PAD_LEFT,
    paddingRight: FAB_OPEN_PAD_RIGHT,
  },
  fabLabel: { color: color.ground, fontFamily: font.sansBold, fontSize: 15 },
  /** Laid out for its width only; never seen and never read out. */
  fabMeasure: { left: 0, opacity: 0, position: 'absolute', top: 0 },

  skelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
});
