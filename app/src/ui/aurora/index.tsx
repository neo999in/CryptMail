/**
 * An aurora band, for the strip behind a screen's top bar.
 *
 * Ported from the standalone `reacticx-aurora` component. What changed, and why
 * each change was needed before it could go in here:
 *
 *   - **It is bounded.** The canvas is exactly the band, so the fragment shader
 *     runs over the header's pixels and no others. The sibling `aurora-curtain`
 *     shades `StyleSheet.absoluteFill` — the whole display, every frame — which
 *     is the single biggest cost either component has.
 *   - **It stops.** Upstream drives time from `useFrameCallback`, which runs
 *     every frame for the life of the mount, ignores the OS reduced-motion
 *     setting, and accumulates unbounded seconds. Here a single
 *     `withRepeat(withTiming(...))` walks one seamless 20π loop on the UI
 *     thread (see `shader.ts`), `useReducedMotion()` freezes it on a static
 *     frame, and `active` cancels it outright — pass `useIsFocused()` so it
 *     costs nothing while the screen is off.
 *   - **The colours are upstream's.** The three ribbon hues and the near-black
 *     sky are `reacticx-aurora`'s own combination, chosen by `palette` id from
 *     `AURORA_PALETTES`. This is the one accented-looking surface in the app
 *     that does *not* follow `useAccent()`, which is why the band's colour is a
 *     prop rather than a hook read.
 *   - **Skia is optional.** `RuntimeEffect.Make` is guarded and lazy, so a
 *     platform or a test without the native module renders the flat
 *     `color.surface` bar this replaces rather than throwing at import time.
 *
 * `pointerEvents="none"`: the bar's avatar, tabs and icon buttons sit on top and
 * must keep every touch.
 */
import { Canvas, Fill, Shader, Skia } from '@shopify/react-native-skia';
import React, { memo, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import {
  Easing,
  cancelAnimation,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { color } from '../../theme';
import { AuroraPalette, auroraPalette, hexToRgb } from './palette';
import { AURORA_LOOP, AURORA_SHADER_SKSL } from './shader';
import { useShouldAnimate } from './useShouldAnimate';

/** Compiled once, on first render, and only if Skia is actually present. */
let shader: ReturnType<typeof Skia.RuntimeEffect.Make> | null | undefined;

function auroraShader() {
  if (shader === undefined) {
    try {
      shader = Skia.RuntimeEffect.Make(AURORA_SHADER_SKSL) ?? null;
    } catch {
      shader = null;
    }
  }
  return shader;
}

/** The frame the band freezes on under reduced motion — a full, open curtain. */
const STATIC_PHASE = AURORA_LOOP * 0.18;

export type AuroraProps = {
  /** Band height in px, including any safe-area inset the bar is padded by. */
  height: number;
  /** Defaults to the window width. */
  width?: number;
  /** An `AURORA_PALETTES` id, or the palette itself. Unknown ids fall back. */
  palette?: string | AuroraPalette;
  /** False cancels the animation and holds a frame. Pass `useIsFocused()`. */
  active?: boolean;
  /** Radians of shader time per second. Sets the loop's real duration. */
  speed?: number;
  /** Glow strength. Deliberately low — this sits under readable text. */
  intensity?: number;
  waveDirection?: [number, number];
};

export const Aurora = memo(function Aurora({
  height,
  width: widthProp,
  palette,
  active = true,
  speed = 0.5,
  intensity = 0.4,
  waveDirection = [9, -9],
}: AuroraProps) {
  const { width: windowWidth } = useWindowDimensions();
  const width = widthProp ?? windowWidth;

  // Focus, foreground, reduced motion and battery saver, in one answer.
  const animating = useShouldAnimate(active);
  const phase = useSharedValue(0);

  const scheme = useMemo(
    () => (typeof palette === 'object' ? palette : auroraPalette(palette)),
    [palette],
  );
  const ribbons = useMemo(() => scheme.auroraColors.map(hexToRgb), [scheme]);
  // Normalised on the CPU once, not per fragment: it depends only on a uniform,
  // so computing it in the shader is the same answer a few hundred thousand
  // times a frame. The shader takes it pre-normalised.
  const direction = useMemo(() => {
    const [x, y] = waveDirection;
    const len = Math.hypot(x, y) || 1;
    return [x / len, y / len] as [number, number];
  }, [waveDirection]);
  const sky = useMemo(() => scheme.skyColors.map(hexToRgb), [scheme]);

  React.useEffect(() => {
    if (!animating) {
      cancelAnimation(phase);
      phase.value = STATIC_PHASE;
      return;
    }

    phase.value = 0;
    phase.value = withRepeat(
      withTiming(AURORA_LOOP, {
        // `speed` is folded into the duration rather than the uniform, so the
        // shader always walks exactly one seamless 20π loop per repeat.
        duration: (AURORA_LOOP / Math.max(speed, 0.01)) * 1000,
        easing: Easing.linear,
      }),
      -1,
      false,
    );

    return () => {
      cancelAnimation(phase);
    };
  }, [animating, phase, speed]);

  const uniforms = useDerivedValue(() => ({
    resolution: [width, height],
    time: phase.value,
    color1: ribbons[0],
    color2: ribbons[1],
    color3: ribbons[2],
    skyTop: sky[0],
    skyBottom: sky[1],
    speed: 1,
    intensity,
    waveDirection: direction,
  }));

  const source = auroraShader();
  if (!source || height <= 0) {
    return <View pointerEvents="none" style={[styles.fallback, { height, width }]} />;
  }

  return (
    <Canvas pointerEvents="none" style={{ height, width }}>
      <Fill>
        <Shader source={source} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
});

/** Re-exported so a screen can pick a palette or match something to it. */
export { AURORA_PALETTES, auroraPalette } from './palette';
export type { AuroraPalette } from './palette';

const styles = StyleSheet.create({
  fallback: { backgroundColor: color.surface },
});
