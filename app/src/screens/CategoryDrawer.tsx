/**
 * The inbox category drawer.
 *
 * A left navigation drawer that lists "All mail" plus every category the
 * on-device categorizer knows (Primary, Purchases, Bills, Promotions, Spam), each
 * with a badge counting the *unread* mail that falls into it. Tapping one sets the
 * shared category filter (`useCategoryFilter`) and closes the drawer; the inbox
 * list reacts to that filter. This is a views drawer — account actions still live
 * in the inbox's account sheet, so existing navigation is untouched.
 *
 * Counts come from `unreadCountsByCategory`, which honours the encryption
 * boundary: unopened encrypted mail is never classified from its ciphertext, so
 * it counts under Primary until the user opens it. The Spam count is the spam
 * engine's verdict plus any message the user marked themselves, which is why the
 * personal model and the marks are passed through.
 */
import { DrawerContentComponentProps, DrawerContentScrollView } from '@react-navigation/drawer';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Category, CATEGORIES, CATEGORY_LABELS, unreadCountsByCategory } from '../categorizer/categorizer';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, space, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import { SectionLabel } from '../ui/primitives';
import { useCategoryFilter } from '../ui/inboxFilter';

const CATEGORY_ICON: Record<Category, IconName> = {
  primary: 'inbox',
  purchases: 'archive',
  bills: 'mail',
  promotions: 'star',
  spam: 'alert',
};

export function CategoryDrawer({ navigation }: DrawerContentComponentProps) {
  const { messages, searchIndex, encryptionFor, spam, session } = useApp();
  const { category, setCategory } = useCategoryFilter();

  const counts = useMemo(() => {
    const items = messages.map((summary) => ({
      summary,
      encrypted: encryptionFor(summary).kind === 'encrypted',
    }));
    return unreadCountsByCategory(items, searchIndex, {
      model: spam.model,
      marks: spam.marks,
      selfAddress: session?.email,
    });
  }, [messages, searchIndex, encryptionFor, spam, session?.email]);

  const total = messages.filter((m) => m.unread).length;

  const choose = (next: Category | null) => {
    setCategory(next);
    navigation.closeDrawer();
  };

  return (
    <DrawerContentScrollView
      style={s.drawer}
      contentContainerStyle={s.content}
      // The scrim behind the panel already reads the ground; the panel itself is
      // the surface here, so it carries a hairline rather than a shadow.
    >
      <Text style={s.brand}>CryptMail</Text>

      <SectionLabel style={s.section}>Views</SectionLabel>
      <DrawerItem
        icon="mail"
        label="All mail"
        count={total}
        active={category === null}
        onPress={() => choose(null)}
      />

      <SectionLabel style={s.section}>Categories</SectionLabel>
      {CATEGORIES.map((cat) => (
        <DrawerItem
          key={cat}
          icon={CATEGORY_ICON[cat]}
          label={CATEGORY_LABELS[cat]}
          count={counts[cat]}
          active={category === cat}
          onPress={() => choose(cat)}
        />
      ))}
    </DrawerContentScrollView>
  );
}

function DrawerItem({
  icon,
  label,
  count,
  active,
  onPress,
}: {
  icon: IconName;
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  const tint = active ? color.brass : color.inkDim;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count > 0 ? `${label}, ${count} unread` : label}
      onPress={onPress}
      style={({ pressed }) => [s.item, active && s.itemActive, pressed && !active && { backgroundColor: color.press }]}
    >
      <Icon name={icon} size={17} color={tint} />
      <Text numberOfLines={1} style={[s.itemLabel, active && s.itemLabelActive]}>
        {label}
      </Text>
      {count > 0 ? (
        <View style={[s.count, active && s.countActive]}>
          <Text style={[s.countText, active && s.countTextActive]}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  drawer: { backgroundColor: color.ground },
  content: { paddingHorizontal: space.md, paddingTop: space.sm },

  brand: {
    ...type.display,
    color: color.ink,
    marginBottom: space.sm,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
  },

  section: { marginBottom: space.sm, marginTop: space.lg, paddingHorizontal: space.sm },

  item: {
    alignItems: 'center',
    borderRadius: radius.sm,
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: 12,
  },
  itemActive: { backgroundColor: color.brassBg, borderColor: glass.hairlineBrass, borderWidth: 1 },
  itemLabel: { ...type.strong, color: color.inkDim, flex: 1 },
  itemLabelActive: { color: color.ink },

  count: {
    backgroundColor: color.panel2,
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 1,
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  countActive: { backgroundColor: color.brassBg, borderColor: glass.hairlineBrass },
  countText: { color: color.inkDim, fontFamily: font.mono, fontSize: 11, textAlign: 'center' },
  countTextActive: { color: color.brass },
});
