/**
 * The web build of the aurora band.
 *
 * Skia on web means shipping the CanvasKit wasm blob, which is a large download
 * for a decorative strip behind a header, so this draws the same band with the
 * platform's own 2D canvas instead. It is an approximation of `shader.ts`, not a
 * port of it: three blurred wave bands and a set of soft striations, matching
 * the native version's shape and its accent, not its per-pixel maths.
 *
 * `frost()` in `../primitives` takes the same approach for the same reason.
 *
 * The props are `AuroraProps` from the native module — `active` and the OS
 * reduced-motion setting both stop the `requestAnimationFrame` loop here too,
 * and `palette` picks the same upstream colour combination.
 */
import React, { memo, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { auroraPalette } from './palette';
import { useShouldAnimate } from './useShouldAnimate';

import type { AuroraProps } from './index';

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

  const animating = useShouldAnimate(active);
  const scheme = useMemo(
    () => (typeof palette === 'object' ? palette : auroraPalette(palette)),
    [palette],
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || height <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const [col1, col2, col3] = scheme.auroraColors;
    const [skyTop, skyBottom] = scheme.skyColors;
    let frame = 0;
    let start: number | null = null;

    const draw = (t: number) => {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      // Upstream's sky: a near-black top falling to true black, same as the
      // native build's `skyColors`.
      const sky = ctx.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, skyTop);
      sky.addColorStop(0.7, skyBottom);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);

      const bands = [
        { color: col1, freq: 0.008, amp: 28, phase: t * 1.6, yBase: height * 0.28, alpha: 0.65 },
        { color: col2, freq: 0.006, amp: 36, phase: -t * 1.2, yBase: height * 0.38, alpha: 0.55 },
        { color: col3, freq: 0.01, amp: 22, phase: t * 2.1, yBase: height * 0.48, alpha: 0.45 },
      ];

      for (const band of bands) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        for (let x = 0; x <= width; x += 6) {
          const dirOffset = (x / width) * (waveDirection[0] || 9) * 2;
          const y =
            band.yBase +
            Math.sin(x * band.freq + band.phase + dirOffset) * band.amp +
            Math.cos(x * band.freq * 0.5 - band.phase * 0.7) * (band.amp * 0.4);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(width, 0);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.15, band.color);
        grad.addColorStop(0.65, band.color);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.globalAlpha = Math.min(1, Math.max(0, band.alpha * intensity));
        ctx.filter = 'blur(16px)';
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = 0.25 * intensity;
      ctx.filter = 'blur(8px)';
      for (let x = 10; x < width; x += 24) {
        const rayH = height * 0.6 + Math.sin(x * 0.05 + t * 2) * 20;
        const rayGrad = ctx.createLinearGradient(x, 0, x, rayH);
        rayGrad.addColorStop(0, 'rgba(255,255,255,0)');
        rayGrad.addColorStop(0.3, col1);
        rayGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = rayGrad;
        ctx.fillRect(x, 0, 8, rayH);
      }
      ctx.restore();
      ctx.restore();
    };

    // An unfocused screen, a backgrounded app, reduced motion or battery saver
    // each get one static frame and no loop, matching the native build rather
    // than quietly animating on.
    if (!animating) {
      draw(20 * Math.PI * 0.18 * speed);
      return;
    }

    const tick = (now: number) => {
      if (start === null) start = now;
      draw(((now - start) / 1000) * speed);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [animating, height, intensity, scheme, speed, waveDirection, width]);

  return (
    <View pointerEvents="none" style={[styles.band, { height, width }]}>
      <canvas ref={canvasRef} style={{ display: 'block', height: `${height}px`, width: `${width}px` }} />
    </View>
  );
});

export { AURORA_PALETTES, auroraPalette } from './palette';

const styles = StyleSheet.create({
  band: { backgroundColor: '#000000', overflow: 'hidden' },
});
