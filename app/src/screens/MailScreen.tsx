/**
 * Settings → Mail.
 *
 * How mail *behaves*, as against how it looks — which is Display & Appearance,
 * and stays there: the swipe gestures, and the labels and rules that organise
 * the mailbox in front. The value lines say what each currently is without
 * Settings itself growing two-line rows.
 *
 * The same shape as every other settings screen: a `Group` of `SettingsRow`s
 * under the standard top bar. No new furniture.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { back, RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { SWIPE_ACTION_LABEL } from '../swipe/swipe';
import { color, space, type } from '../theme';
import { useMailPrefs } from '../ui/mailPrefs';
import { Group, GroupHeading, IconButton, SettingsRow } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Mail'>;

/** Plural without the "1 labels" tell, and a sentence when there are none. */
function count(n: number, one: string, many: string, none: string): string {
  return n === 0 ? none : `${n} ${n === 1 ? one : many}`;
}

export function MailScreen({ navigation }: Props) {
  const { swipeLeft, swipeRight } = useMailPrefs();
  const { labels, rules } = useApp();
  const insets = useSafeAreaInsets();
  const labelTotal = Object.keys(labels.labels).length;
  const enabledRules = rules.rules.filter((rule) => rule.enabled).length;

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Mail</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        showsVerticalScrollIndicator={false}
      >
        <GroupHeading>Gestures</GroupHeading>
        <Group>
          <SettingsRow
            icon="forward"
            label="Swipe options"
            // Both sides on the value line, in the order they sit on screen, so
            // the current setup reads without opening the screen — the same idea
            // as the Appearance row's "Dark / Borealis Cyan / Cosy".
            value={`Left: ${SWIPE_ACTION_LABEL[swipeLeft]} · Right: ${SWIPE_ACTION_LABEL[swipeRight]}`}
            onPress={() => navigation.navigate('SwipeOptions')}
          />
        </Group>

        {/* Both belong to the mailbox in front — its stores, its message ids —
            which the value lines do not repeat but the screens themselves say. */}
        <GroupHeading>Organise</GroupHeading>
        <Group>
          <SettingsRow
            icon="file"
            label="Labels"
            value={count(labelTotal, 'label', 'labels', 'Kept on this device')}
            onPress={() => navigation.navigate('Labels')}
          />
          <SettingsRow
            icon="settings"
            label="Rules"
            value={
              rules.rules.length === 0
                ? 'Filter mail on this device, encrypted mail included'
                : `${enabledRules} of ${rules.rules.length} on`
            }
            onPress={() => navigation.navigate('Rules')}
          />
        </Group>
      </ScrollView>
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
});
