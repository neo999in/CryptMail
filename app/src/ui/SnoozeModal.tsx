/**
 * SnoozeModal — bottom-sheet picker for snooze presets.
 *
 * Shows the four standard options (Later today, Tomorrow morning, This weekend,
 * Next week) plus a dismiss handle. Calls `onSnooze(until)` with the chosen
 * ISO-8601 timestamp and closes itself.
 */
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { quickSnoozeDates } from '../snooze/snooze';
import { color, font, glass, radius, shadow, type } from '../theme';
import { Icon } from './Icon';

type Props = {
  visible: boolean;
  onSnooze: (until: string) => void;
  onClose: () => void;
};

export function SnoozeModal({ visible, onSnooze, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(300)).current;

  useEffect(() => {
    if (visible) {
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    } else {
      slideAnim.setValue(300);
    }
  }, [visible, slideAnim]);

  const options = quickSnoozeDates();

  if (!visible) return null;

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      {/* Scrim */}
      <Pressable accessibilityLabel="Close" onPress={onClose} style={s.scrim}>
        {Platform.OS !== 'web' ? (
          <BlurView intensity={glass.blur.medium} tint="dark" style={StyleSheet.absoluteFill} />
        ) : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim }]} />
      </Pressable>

      {/* Sheet */}
      <Animated.View
        style={[
          s.sheet,
          { paddingBottom: insets.bottom + 24, transform: [{ translateY: slideAnim }] },
        ]}
      >
        {/* Grabber */}
        <View style={s.grabber} />

        {/* Header */}
        <View style={s.header}>
          <Icon name="clock" size={16} color={color.brass} />
          <Text style={s.headerText}>Snooze until…</Text>
        </View>

        {/* Options */}
        {options.map((option, idx) => (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            accessibilityLabel={`${option.label}, ${option.sublabel}`}
            style={({ pressed }) => [
              s.option,
              idx < options.length - 1 && s.optionBorder,
              pressed && s.optionPressed,
            ]}
            onPress={() => {
              onSnooze(option.until);
              onClose();
            }}
          >
            <View style={s.optionContent}>
              <Text style={s.optionLabel}>{option.label}</Text>
              <Text style={s.optionSublabel}>{option.sublabel}</Text>
            </View>
            <Icon name="chevron" size={14} color={color.inkFaint} />
          </Pressable>
        ))}

        {/* Cancel */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={({ pressed }) => [s.cancel, pressed && { opacity: 0.6 }]}
          onPress={onClose}
        >
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: {
    flex: 1,
  },
  sheet: {
    backgroundColor: color.panel,
    borderTopColor: glass.hairline,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    ...shadow.sheet,
  },
  grabber: {
    alignSelf: 'center',
    backgroundColor: color.line,
    borderRadius: radius.pill,
    height: 4,
    marginBottom: 18,
    width: 38,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  headerText: {
    ...type.eyebrow,
    color: color.inkFaint,
    letterSpacing: 1,
  },
  option: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 4,
    paddingVertical: 16,
  },
  optionBorder: {
    borderBottomColor: color.lineSoft,
    borderBottomWidth: 1,
  },
  optionPressed: {
    backgroundColor: color.press,
    borderRadius: radius.sm,
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
    marginTop: 2,
  },
  cancel: {
    alignItems: 'center',
    borderRadius: radius.sm,
    marginTop: 8,
    paddingVertical: 14,
  },
  cancelText: {
    color: color.inkDim,
    fontFamily: font.sansMedium,
    fontSize: 14.5,
  },
});
