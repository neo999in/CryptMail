/**
 * The multi-select action bar — what stands in for the compose button while a
 * list has rows selected.
 *
 * Presentation only. Every action is a callback the list supplies, and the list
 * runs each through the same `useApp()` action a swipe or the reader uses
 * (`ui/swipeRun.tsx`), so a bulk archive is a swiped archive done several times,
 * with one toast and one undo.
 *
 * It floats where the compose button sits, in the same neutral surface, and
 * takes its place rather than joining it: composing while a selection is up is
 * not a thing anyone is trying to do, and two floating controls fight for the
 * same thumb.
 *
 * Each toggle names what a tap will do *now*: "Mark read" while anything
 * selected is unread, "Star" while anything is unstarred. A selection that mixes
 * states resolves toward the state that is not yet true everywhere, which is the
 * direction a person selecting mail to act on almost always means.
 */
import { MotiView } from 'moti';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, font, radius, shadow, space } from '../theme';
import { Icon, IconName } from './Icon';

export type BulkBarProps = {
  /** How many conversations are selected — what the count says. */
  count: number;
  bottom: number;
  /** Whether anything selected is unread, which decides read versus unread. */
  anyUnread: boolean;
  /** Whether everything selected is starred, which decides star versus unstar. */
  allStarred: boolean;
  onCancel: () => void;
  onSelectAll?: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onLabel: () => void;
};

export function BulkBar({
  count,
  bottom,
  anyUnread,
  allStarred,
  onCancel,
  onSelectAll,
  onArchive,
  onTrash,
  onToggleRead,
  onToggleStar,
  onLabel,
}: BulkBarProps) {
  return (
    <MotiView
      from={{ opacity: 0, translateY: 16 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 180 }}
      style={[s.bar, shadow.floating, { bottom }]}
    >
      <View style={s.head}>
        <Action icon="close" label="Cancel selection" onPress={onCancel} />
        <Text
          accessibilityLiveRegion="polite"
          numberOfLines={1}
          style={s.count}
        >
          {count} selected
        </Text>
        {onSelectAll ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={onSelectAll} style={s.selectAll}>
            <Text style={s.selectAllText}>All</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={s.actions}>
        <Action icon="archive" label="Archive" onPress={onArchive} />
        <Action icon="star" label={allStarred ? 'Unstar' : 'Star'} onPress={onToggleStar} filled={allStarred} />
        <Action icon="mail" label={anyUnread ? 'Mark read' : 'Mark unread'} onPress={onToggleRead} />
        <Action icon="file" label="Label" onPress={onLabel} />
        <Action icon="trash" label="Move to Trash" onPress={onTrash} />
      </View>
    </MotiView>
  );
}

function Action({
  icon,
  label,
  onPress,
  filled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  filled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [s.action, pressed && { backgroundColor: color.iconPress }]}
    >
      <Icon name={icon} size={22} color={color.ink} strokeWidth={2.1} fill={filled ? color.ink : undefined} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  bar: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    left: space.lg,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    position: 'absolute',
    right: space.lg,
  },
  head: { alignItems: 'center', flexDirection: 'row', gap: space.xs },
  count: { color: color.ink, flex: 1, fontFamily: font.sansSemibold, fontSize: 15 },
  selectAll: { paddingHorizontal: space.md, paddingVertical: space.sm },
  selectAllText: { color: color.inkDim, fontFamily: font.sansSemibold, fontSize: 14 },
  actions: { flexDirection: 'row', justifyContent: 'space-around', paddingBottom: space.xs },
  action: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
});
