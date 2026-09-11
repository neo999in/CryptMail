/**
 * Settings → Mail.
 *
 * How mail *behaves*, as against how it looks — which is Display & Appearance,
 * and stays there. Today that is the swipe gestures and nothing else, so this is
 * a one-row screen; it exists rather than putting "Swipe options" directly in
 * Settings because the next behaviour setting has an obvious home the moment it
 * lands, and because the value line here can say what both sides currently do
 * without Settings itself growing a two-line row.
 *
 * The same shape as every other settings screen: a `Group` of `SettingsRow`s
 * under the standard top bar. No new furniture.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RootStackParamList } from '../navigation';
import { SWIPE_ACTION_LABEL } from '../swipe/swipe';
import { color, space, type } from '../theme';
import { useMailPrefs } from '../ui/mailPrefs';
import { Group, GroupHeading, IconButton, SettingsRow } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Mail'>;

export function MailScreen({ navigation }: Props) {
  const { swipeLeft, swipeRight } = useMailPrefs();
  const insets = useSafeAreaInsets();

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
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
