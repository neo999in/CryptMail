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
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MailSummary } from '../mail/types';
import { EncryptionState } from '../state/types';
import { resolveSwipe, SwipeContext, SwipeVisual, swipeRemovesRow } from '../swipe/swipe';
import { color, font, radius, shadow, space, type } from '../theme';
import { Icon } from './Icon';
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
};

function MailListRowImpl({
  id,
  summary,
  encryption,
  mailbox,
  count = 1,
  index,
  padding,
  selfAddress,
  onPress,
  swipe,
  onSwipe,
}: MailListRowProps) {
  const [rowRef, measureOrigin] = useOriginRef();
  const { swipeLeft, swipeRight } = useMailPrefs();

  // Both sides, resolved for *this* row in *this* list. `null` on a side is the
  // honest answer for an unconfigured direction and for an action with no
  // meaning here, and the gesture treats the two the same: the row does not move.
  const context = React.useMemo<SwipeContext | null>(
    () => (swipe && onSwipe ? { ...swipe, unread: summary.unread } : null),
    [onSwipe, summary.unread, swipe],
  );
  const left = React.useMemo(() => (context ? resolveSwipe(swipeLeft, context) : null), [context, swipeLeft]);
  const right = React.useMemo(() => (context ? resolveSwipe(swipeRight, context) : null), [context, swipeRight]);

  // Held steady for `SwipeableRow`, which builds its gesture from these: a new
  // function on each render is a new gesture on each render.
  const onAction = React.useCallback((visual: SwipeVisual) => onSwipe?.(visual, id), [id, onSwipe]);
  const removes = React.useCallback(
    (visual: SwipeVisual) => (context ? swipeRemovesRow(visual.operation, context) : true),
    [context],
  );
  const press = React.useCallback(
    () => void measureOrigin().then((origin) => onPress(id, origin)),
    [id, measureOrigin, onPress],
  );

  const row = (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      // Capped so a long list settles quickly instead of dribbling in.
      transition={{ type: 'timing', duration: 300, delay: Math.min(index, 8) * 45 }}
    >
      <View collapsable={false} ref={rowRef} style={s.row}>
        <Pressable
          accessibilityRole="button"
          onPress={press}
          style={({ pressed }) => [pressed && s.rowPressed]}
        >
          <MailRowCard
            summary={summary}
            encryption={encryption}
            mailbox={mailbox}
            count={count}
            padding={padding}
            selfAddress={selfAddress}
          />
        </Pressable>
      </View>
    </MotiView>
  );

  // No swipe on this list: the row carries its own gap, since there is no
  // wrapper to put it on.
  if (!context || !onSwipe) return <View style={s.rowGap}>{row}</View>;

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
    prev.onSwipe === next.onSwipe
  );
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
 */
export function ComposeFab({ onPress, bottom }: { onPress: () => void; bottom: number }) {
  const [pressed, setPressed] = React.useState(false);
  return (
    <MotiView
      from={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: pressed ? 0.94 : 1 }}
      transition={{ type: 'spring', damping: 15, stiffness: 220, mass: 0.7 }}
      style={[s.fab, shadow.floating, { bottom }]}
    >
      <Pressable
        accessibilityLabel="Compose"
        accessibilityRole="button"
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={s.fabPress}
      >
        <Icon name="edit" size={22} color={color.ground} strokeWidth={2.2} />
        <Text style={s.fabLabel}>Compose</Text>
      </Pressable>
    </MotiView>
  );
}

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
    gap: 9,
    paddingHorizontal: 22,
    paddingVertical: 16,
  },
  fabLabel: { color: color.ground, fontFamily: font.sansBold, fontSize: 15 },

  skelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
});
