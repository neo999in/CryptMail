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
import { color, font, radius, shadow, space, type } from '../theme';
import { Icon } from './Icon';
import { OriginRect, useOriginRef } from './expand';
import { MailRowCard } from './mailRow';
import { Skeleton } from './primitives';

export function MailListRow({
  summary,
  encryption,
  mailbox,
  count = 1,
  index,
  padding,
  selfAddress,
  onPress,
}: {
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
  /** Handed the row's own rectangle, when it could be measured, so the message
   *  screen can collapse back onto it — see `ui/expand.tsx`. */
  onPress: (origin?: OriginRect) => void;
}) {
  const [rowRef, measureOrigin] = useOriginRef();

  return (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      // Capped so a long list settles quickly instead of dribbling in.
      transition={{ type: 'timing', duration: 300, delay: Math.min(index, 8) * 45 }}
    >
      <View collapsable={false} ref={rowRef} style={s.row}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void measureOrigin().then(onPress)}
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
}

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
        <Icon name="edit" size={17} color={color.ground} strokeWidth={2.2} />
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
  row: { backgroundColor: color.card, marginBottom: 2 },
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
