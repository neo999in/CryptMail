/**
 * SnoozeModal — the snooze picker.
 *
 * Four presets (`snooze/snooze.ts` computes the times), and nothing else: a
 * date picker here would be a second, slower way to say what one of these rows
 * already says, and the times themselves are what the reader is choosing
 * between — so each row carries its own, spelled out.
 *
 * It is the `Sheet` primitive rather than its own modal. The scrim, the blur,
 * the grabber and the slide are all Sheet's, which is also the one place in the
 * app still allowed to blur.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { quickSnoozeDates } from '../snooze/snooze';
import { color, font, radius, space, type } from '../theme';
import { Icon } from './Icon';
import { PressableRow, Sheet } from './primitives';

type Props = {
  visible: boolean;
  onSnooze: (until: string) => void;
  onClose: () => void;
};

export function SnoozeModal({ visible, onSnooze, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const options = quickSnoozeDates();

  return (
    <Sheet bottomInset={insets.bottom} onClose={onClose} title="Snooze until" visible={visible}>
      {options.map((option, idx) => (
        <PressableRow
          accessibilityLabel={`${option.label}, ${option.sublabel}`}
          accessibilityRole="button"
          key={option.key}
          onPress={() => {
            onSnooze(option.until);
            onClose();
          }}
          style={StyleSheet.flatten([s.option, idx < options.length - 1 && s.optionBorder])}
        >
          <Icon name="clock" size={18} color={color.inkDim} />
          <View style={s.optionContent}>
            <Text style={s.optionLabel}>{option.label}</Text>
            {/* The time itself, not a description of it: "Tomorrow morning" is
                only useful next to the hour it means. */}
            <Text style={s.optionSublabel}>{option.sublabel}</Text>
          </View>
        </PressableRow>
      ))}
    </Sheet>
  );
}

const s = StyleSheet.create({
  option: {
    alignItems: 'center',
    borderRadius: radius.sm,
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: 14,
  },
  optionBorder: {
    borderBottomColor: color.lineSoft,
    borderBottomWidth: 1,
    borderRadius: 0,
  },
  optionContent: {
    flex: 1,
  },
  optionLabel: {
    ...type.strong,
    color: color.ink,
  },
  optionSublabel: {
    ...type.small,
    color: color.inkDim,
    fontFamily: font.sansMedium,
    marginTop: 2,
  },
});
