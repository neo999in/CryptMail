import React from 'react';
import { Image, StyleSheet, useWindowDimensions, View, ViewStyle } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

import { color } from '../theme';

// A tiling film-grain texture. Matte, filmic, hand-made — the crafted opposite
// of a bright gradient wash. Baked at low alpha so it only whispers.
const grain = require('../../assets/grain.png');

/**
 * The light source for the whole app.
 *
 * Frosted glass only reads as glass when there is something behind it to
 * refract. Earlier this was three saturated radial glows (brass, violet, mint) —
 * a rainbow wash that read as generated sheen. This is the restrained version:
 * one warm light high in the frame, a whisper of cool weight in the far corner,
 * and a fine grain over everything. Enough light for the glass to catch; none of
 * the gradient soup. Mounted once at the root, behind every screen.
 */
export function AuroraBackground({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { width: w, height: h } = useWindowDimensions();

  return (
    <View style={[styles.root, style]}>
      <Svg style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]} width={w} height={h}>
        <Defs>
          <RadialGradient id="light">
            <Stop offset="0%" stopColor={color.brass} stopOpacity="0.15" />
            <Stop offset="100%" stopColor={color.brass} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="cool">
            <Stop offset="0%" stopColor={color.violet} stopOpacity="0.06" />
            <Stop offset="100%" stopColor={color.violet} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        {/* One warm light entering from high center; a cool counter-weight far below. */}
        <Ellipse cx={w * 0.5} cy={-h * 0.06} rx={w * 1.15} ry={h * 0.32} fill="url(#light)" />
        <Ellipse cx={w * 0.92} cy={h * 0.92} rx={w * 0.72} ry={h * 0.3} fill="url(#cool)" />
      </Svg>
      <Image source={grain} resizeMode="repeat" style={[StyleSheet.absoluteFill, styles.grain]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow:hidden clips the oversized light ellipses so they don't create a
  // horizontal scroll gutter (which would expose the white page canvas).
  root: { backgroundColor: color.ground, flex: 1, overflow: 'hidden' },
  grain: { opacity: 0.55, pointerEvents: 'none' },
});
