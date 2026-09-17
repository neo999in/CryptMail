/**
 * Text that resolves out of noise when it has just been decrypted.
 *
 * The real string is laid out from the first frame, transparent, so the lines
 * below never move while the noise runs; the scrambled copy is drawn over it
 * and clipped to the same number of lines. Screen readers only ever get the
 * real text. Under reduced motion or battery saver — the same gates the aurora
 * answers to — it is simply the text.
 */
import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, TextStyle, View } from 'react-native';

import { useShouldAnimate } from './aurora/useShouldAnimate';
import { decryptDuration, decryptFrame } from './decrypt';

const TICK_MS = 45;

export function DecryptedText({
  text,
  animate,
  style,
  onLayout,
}: {
  text: string;
  /** Whether to run the reveal on mount. Read once; later changes are ignored. */
  animate: boolean;
  style?: StyleProp<TextStyle>;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const allowed = useShouldAnimate(true);
  const [frame, setFrame] = useState<string | null>(() => (animate && allowed ? decryptFrame(text, 0) : null));
  const [lines, setLines] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (frame === null) return;
    if (!allowed) {
      setFrame(null);
      return;
    }
    const start = Date.now();
    const duration = decryptDuration(text);
    const id = setInterval(() => {
      const progress = (Date.now() - start) / duration;
      if (progress >= 1) {
        clearInterval(id);
        setFrame(null);
      } else {
        setFrame(decryptFrame(text, progress));
      }
    }, TICK_MS);
    return () => clearInterval(id);
    // Runs once per reveal; `frame` changing each tick must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, allowed]);

  const running = frame !== null;
  return (
    <View onLayout={onLayout}>
      <Text
        onTextLayout={(e) => setLines(e.nativeEvent.lines.length || undefined)}
        style={[style, running && s.hidden]}
      >
        {text}
      </Text>
      {running ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          numberOfLines={lines}
          ellipsizeMode="clip"
          style={[style, s.overlay]}
        >
          {frame}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  hidden: { color: 'transparent' },
  overlay: { left: 0, position: 'absolute', right: 0, top: 0 },
});
