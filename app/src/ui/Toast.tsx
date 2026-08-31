import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, Pressable, Platform, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, shadow, type, font } from '../theme';
import { useAccent } from './appearance';
import { Icon } from './Icon';

export type ToastProps = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  durationMs: number;
  startedAt: number;
};

/** react-native-web has no native animated module; asking for one only warns. */
const NATIVE_DRIVER = Platform.OS !== 'web';

export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
  durationMs,
  startedAt,
}: ToastProps) {
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const progress = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timeElapsed = Date.now() - startedAt;
    const remainingTime = durationMs - timeElapsed;

    if (remainingTime > 0) {
      Animated.timing(progress, {
        toValue: 0,
        duration: remainingTime,
        easing: Easing.linear,
        useNativeDriver: NATIVE_DRIVER,
      }).start();
    } else {
      progress.setValue(0);
    }
  }, [startedAt, durationMs, progress]);

  return (
    <View
      style={[
        styles.container,
        { bottom: insets.bottom + 16 }
      ]}
    >
      <View style={styles.content}>
        <View style={styles.left}>
          <Icon name="send" size={16} color={accent} />
          <Text style={styles.message} numberOfLines={2}>
            {message}
          </Text>
        </View>
        {actionLabel && (
          <Pressable
            onPress={onAction}
            style={({ pressed }) => [
              styles.actionButton,
              pressed && { backgroundColor: color.press }
            ]}
          >
            <Text style={[styles.actionText, { color: accent }]}>{actionLabel}</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressBar,
            { backgroundColor: accent, transform: [{ scaleX: progress }] },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 16,
    right: 16,
    // Opaque, not a glass fill: the toast floats over whatever screen is up,
    // and a translucent one reads as unfinished against the true-black ground.
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderColor: color.line,
    borderWidth: 1,
    zIndex: 99999,
    elevation: 100,
    overflow: 'hidden',
    ...shadow.floating,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  message: {
    ...type.strong,
    color: color.ink,
    flex: 1,
  },
  actionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.sm,
    marginLeft: 12,
  },
  actionText: {
    fontFamily: font.sansBold,
    fontSize: 13,
    textTransform: 'uppercase',
  },
  progressTrack: {
    height: 2,
    width: '100%',
  },
  progressBar: {
    height: '100%',
    width: '100%',
    opacity: 0.4,
    // Scale from the left edge so the bar shrinks right-to-left.
    transformOrigin: 'left center',
  },
});
