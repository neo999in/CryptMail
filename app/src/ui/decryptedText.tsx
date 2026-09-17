/**
 * Text that resolves out of noise when it has just been decrypted.
 *
 * The real content is laid out from the first frame, invisible, so what sits
 * below it never moves while the noise runs; the scrambled copy is drawn over
 * it and clipped to its bounds. Screen readers only ever get the real content.
 * Under reduced motion or battery saver — the same gates the aurora answers
 * to — it is simply the content.
 */
import React, { useEffect, useState } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, TextStyle, View } from 'react-native';

import { useShouldAnimate } from './aurora/useShouldAnimate';
import { decryptDuration, decryptFrame } from './decrypt';

const TICK_MS = 45;

/**
 * How much of a body is scrambled. The overlay is clipped to the body's height
 * anyway, and regenerating a whole long letter every tick is work nobody sees.
 */
const BODY_NOISE_CHARS = 1200;

/**
 * The current frame of a reveal of `text`, or `null` once it has landed (or
 * when it was never going to run). `animate` is read once, on mount.
 */
function useDecryptFrame(text: string, animate: boolean): string | null {
  const allowed = useShouldAnimate(true);
  const [frame, setFrame] = useState<string | null>(() =>
    animate && allowed && text ? decryptFrame(text, 0) : null,
  );
  const running = frame !== null;

  useEffect(() => {
    if (!running) return;
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
    // Starts once per reveal; `running` flipping to false is the end of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, allowed]);

  return frame;
}

/** A single string — the subject — scrambled over itself, line for line. */
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
  const frame = useDecryptFrame(text, animate);
  const [lines, setLines] = useState<number | undefined>(undefined);

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

/**
 * A rendered body — HTML or plain — with its text scrambled over it.
 *
 * The noise is the message's plain text, not the rendering: formatted mail has
 * no single string to scramble. So the body underneath is held invisible for
 * its layout and shown the moment the text has resolved — a swap, not a fade:
 * the letters are already on screen, and fading them in again reads as the
 * message appearing twice.
 */
export function DecryptReveal({
  text,
  animate,
  style,
  paragraphMargin,
  children,
}: {
  /** The body as plain text; empty means no reveal. */
  text: string;
  animate: boolean;
  style?: StyleProp<TextStyle>;
  /**
   * Space above and below each line of noise, for a body rendered from HTML,
   * where every line of the text version is a paragraph with its own margins.
   * Without it the noise is packed tighter than the message it resolves into,
   * and the lines jump apart at the swap. Omitted for plain text, which is
   * one run of text exactly like the noise.
   */
  paragraphMargin?: number;
  children: React.ReactNode;
}) {
  const frame = useDecryptFrame(text.slice(0, BODY_NOISE_CHARS), animate);

  const running = frame !== null;
  return (
    <View style={running && s.clip}>
      {/* The same element throughout, so the renderer is never remounted. */}
      <View
        accessibilityElementsHidden={running}
        importantForAccessibility={running ? 'no-hide-descendants' : 'auto'}
        pointerEvents={running ? 'none' : 'auto'}
        style={running && s.invisible}
      >
        {children}
      </View>
      {running ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={s.overlay}
        >
          {paragraphMargin === undefined ? (
            <Text style={style}>{frame}</Text>
          ) : (
            // Whitespace is never scrambled, so the frame has the same line
            // breaks as the text on every tick and the blocks never re-split.
            frame.split('\n').map((line, i) => (
              <Text key={i} style={[style, { marginVertical: paragraphMargin }]}>
                {line}
              </Text>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  hidden: { color: 'transparent' },
  clip: { overflow: 'hidden' },
  invisible: { opacity: 0 },
  overlay: { left: 0, position: 'absolute', right: 0, top: 0 },
});
