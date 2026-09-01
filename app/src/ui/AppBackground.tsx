import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';

import { color } from '../theme';

/**
 * The ground the whole app sits on: flat, true black.
 *
 * This was `AuroraBackground` — a warm radial light high in the frame, a cool
 * counter-weight in the far corner, and a film-grain wash over everything, all
 * there to give the frosted glass something to refract. It is gone deliberately:
 * on an OLED panel `#000000` means the pixel is *off*, and every one of those
 * layers lit the whole screen slightly to avoid it. A 0.55-opacity grain in
 * particular put a non-black value on every pixel of the display.
 *
 * The glass surfaces do not need it. `glass.fill` and friends are deliberately
 * opaque enough to stand alone — see the note on those tokens — because they
 * always had to survive a platform where blur is weak or unavailable. Against
 * true black they read as panels rather than as refraction, which is the trade
 * being made here.
 *
 * One aurora did come back, and the distinction is the whole point: `ui/aurora`
 * draws a band *inside the inbox top bar's own bounds*, and its sky falls to
 * `#000000` at the band's lower edge. It replaces the bar's fill, which was
 * never black; it does not light the ground, which still is. A full-screen wash
 * would be the thing this file exists to prevent.
 *
 * Still mounted once at the root, and every surface above it stays transparent,
 * so this remains the single place the app's ground colour is decided.
 */
export function AppBackground({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.root, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { backgroundColor: color.ground, flex: 1 },
});
