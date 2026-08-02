import { BlurView } from 'expo-blur';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  PressableProps,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

import { avatarTints, color, font, glass, motion, radius, shadow, space, type } from '../theme';
import { Icon, IconName } from './Icon';

/* --------------------------------------------------------------- motion ---- */

/** react-native-web has no native animated module; asking for one only warns. */
const NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * Press feedback for anything that reads as a raised control. Opacity alone is
 * ambiguous on a dark ground — a small scale makes the touch land.
 */
function usePressScale(to = 0.97) {
  const scale = useRef(new Animated.Value(1)).current;
  const drive = (value: number) =>
    Animated.timing(scale, {
      toValue: value,
      duration: motion.fast,
      easing: Easing.out(Easing.quad),
      useNativeDriver: NATIVE_DRIVER,
    }).start();
  return {
    style: { transform: [{ scale }] },
    onPressIn: () => drive(to),
    onPressOut: () => drive(1),
  };
}

/** Focus tracking for inputs, so the containing Field can light its border. */
export function useFocus() {
  const [focused, setFocused] = useState(false);
  return {
    focused,
    bind: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
  };
}

/* --------------------------------------------------------------- glass ---- */

/**
 * The gaussian blur, by platform. Native gets expo-blur's `BlurView`; web has no
 * BlurView blur in this SDK, so we emit a real CSS `backdrop-filter` instead.
 * `intensity` is expo-blur's 1–100 scale; ~0.3× reads as a comparable radius.
 */
export function frost(intensity: number): ViewStyle | null {
  if (Platform.OS !== 'web') return null;
  const px = Math.max(2, Math.round(intensity * 0.3));
  return { backdropFilter: `blur(${px}px)`, WebkitBackdropFilter: `blur(${px}px)` } as unknown as ViewStyle;
}

/**
 * A frosted-glass surface: real gaussian blur of the aurora behind it, plus a
 * semi-opaque tint on top. The tint is opaque enough that the surface still
 * reads as an intentional panel if the platform can't blur — it never falls
 * back to see-through.
 */
export function Glass({
  children,
  style,
  contentStyle,
  intensity = glass.blur.medium,
  tint = 'dark',
  fill = glass.fill,
  radius: r = radius.lg,
  border = glass.hairline,
  elevated = true,
  rim = true,
}: {
  children?: React.ReactNode;
  /** Outer layout — margins, size, and any radius override. */
  style?: StyleProp<ViewStyle>;
  /** Inner padding wrapper. */
  contentStyle?: StyleProp<ViewStyle>;
  intensity?: number;
  tint?: 'dark' | 'light' | 'default';
  fill?: string;
  radius?: number;
  border?: string;
  elevated?: boolean;
  /** A lit top hairline that reads as light catching the glass edge. */
  rim?: boolean;
}) {
  return (
    <View style={[{ borderColor: border, borderRadius: r, borderWidth: 1, overflow: 'hidden' }, elevated && shadow.raised, frost(intensity), style]}>
      {Platform.OS !== 'web' ? <BlurView intensity={intensity} tint={tint} style={StyleSheet.absoluteFill} /> : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: fill, pointerEvents: 'none' }]} />
      {rim ? <View style={[s.rim, { pointerEvents: 'none' }]} /> : null}
      <View style={contentStyle}>{children}</View>
    </View>
  );
}

/**
 * A soft radial halo. Drop behind a control (FAB, brand mark) to give the glass
 * something bright to sit over. Non-interactive and self-sizing.
 */
export function Glow({
  tint,
  size,
  opacity = 0.55,
  style,
}: {
  tint: string;
  size: number;
  opacity?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const id = `glow-${tint.replace(/[^a-z0-9]/gi, '')}-${Math.round(opacity * 100)}`;
  return (
    <View style={[{ height: size, pointerEvents: 'none', width: size }, style]}>
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id}>
            <Stop offset="0%" stopColor={tint} stopOpacity={opacity} />
            <Stop offset="100%" stopColor={tint} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Ellipse cx={size / 2} cy={size / 2} rx={size / 2} ry={size / 2} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/* ---------------------------------------------------------------- text ---- */

export function Title({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.title, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export function Mono({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[s.mono, style]}>{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

/** Uppercase mono rule between list sections. */
export function SectionLabel({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.sectionLabel, style]}>
      <Text style={s.sectionLabelText}>{children}</Text>
      <View style={s.sectionRule} />
    </View>
  );
}

/* -------------------------------------------------------------- badges ---- */

export type BadgeTone = 'enc' | 'warn' | 'plain';

export function Badge({ tone, icon, children }: { tone: BadgeTone; icon?: IconName; children: string }) {
  const tint = tone === 'enc' ? color.mint : tone === 'warn' ? color.coral : color.inkFaint;
  return (
    <View style={[s.badge, s[`badge_${tone}`]]}>
      {icon ? <Icon name={icon} size={11} color={tint} /> : null}
      <Text style={[s.badgeText, { color: tint }]}>{children}</Text>
    </View>
  );
}

/** Full-width status strip — the "you always know the state" element. */
export function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'ok' | 'warn';
  icon: IconName;
  children: React.ReactNode;
}) {
  const ok = tone === 'ok';
  return (
    <View style={[s.banner, ok ? s.bannerOk : s.bannerWarn]}>
      <Icon name={icon} size={17} color={ok ? color.mint : color.coral} />
      <Text style={[s.bannerText, { color: ok ? color.mintInk : color.coralInk }]}>{children}</Text>
    </View>
  );
}

export function Callout({ children }: { children: React.ReactNode }) {
  return (
    <View style={s.callout}>
      <Icon name="alert" size={18} color={color.coral} />
      <Text style={s.calloutText}>{children}</Text>
    </View>
  );
}

/* ------------------------------------------------------------- avatars ---- */

export function Avatar({ seed, label, size = 34 }: { seed: string; label: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bg = avatarTints[h % avatarTints.length];
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size * 0.26, backgroundColor: bg }]}>
      <Text style={[s.avatarText, { fontSize: size * 0.36 }]}>{label}</Text>
    </View>
  );
}

/* ------------------------------------------------------------- buttons ---- */

export function PrimaryButton({
  title,
  icon,
  onPress,
  disabled,
  busy,
}: {
  title: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const press = usePressScale();
  const off = disabled || busy;
  return (
    <Animated.View style={off ? undefined : press.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !!off }}
        disabled={off}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[s.primaryBtn, disabled && s.primaryBtnOff, !off && shadow.raised]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={color.brassInk} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={16} color={disabled ? color.inkFaint : color.brassInk} /> : null}
            <Text style={[s.primaryBtnText, disabled && { color: color.inkFaint }]}>{title}</Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

export function SecondaryButton({
  title,
  icon,
  onPress,
  disabled,
  tone,
}: {
  title: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  /** `danger` for destructive actions — coral text, not a coral fill. */
  tone?: 'default' | 'danger';
}) {
  const press = usePressScale();
  const danger = tone === 'danger';
  return (
    <Animated.View style={disabled ? undefined : press.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[s.secondaryBtn, danger && s.secondaryBtnDanger, disabled && { opacity: 0.5 }]}
      >
        {icon ? <Icon name={icon} size={15} color={danger ? color.coral : color.ink} /> : null}
        <Text style={[s.secondaryBtnText, danger && { color: color.coral }]}>{title}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** Square icon-only control used in headers and toolbars. */
export function IconButton({
  icon,
  label,
  onPress,
  tint = color.inkDim,
  size = 36,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
  size?: number;
}) {
  const press = usePressScale(0.92);
  return (
    <Animated.View style={press.style}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [
          s.iconBtn,
          { width: size, height: size },
          pressed && { backgroundColor: color.panel2, borderColor: color.brass },
        ]}
      >
        <Icon name={icon} size={Math.round(size * 0.47)} color={tint} />
      </Pressable>
    </Animated.View>
  );
}

/** Row that behaves like a list item: whole-surface press wash, no scale. */
export function PressableRow({ style, children, ...rest }: PressableProps & { style?: ViewStyle }) {
  return (
    <Pressable {...rest} style={({ pressed }) => [style, pressed && { backgroundColor: color.press }]}>
      {children as React.ReactNode}
    </Pressable>
  );
}

/* -------------------------------------------------------------- fields ---- */

export function Field({
  label,
  focused,
  tone,
  children,
  style,
}: {
  label?: string;
  /** Wire from `useFocus()` so the border tracks the caret. */
  focused?: boolean;
  tone?: 'default' | 'warn';
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[s.field, focused && s.fieldFocused, tone === 'warn' && s.fieldWarn, style]}>
      {label ? <Label>{label}</Label> : null}
      {children}
    </View>
  );
}

export const Input = React.forwardRef<TextInput, TextInputProps & { big?: boolean }>(function Input(
  { big, style, ...rest },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={color.inkFaint}
      selectionColor={color.brass}
      {...rest}
      style={[s.input, big && s.inputBig, style]}
    />
  );
});

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <Glass style={style} contentStyle={s.card}>
      {children}
    </Glass>
  );
}

export function Divider() {
  return <View style={s.divider} />;
}

/* ------------------------------------------------------------- loading ---- */

/** Pulsing placeholder block. Loading should have the shape of the result. */
export function Skeleton({ width, height, radius: r = radius.xs }: { width: number | string; height: number; radius?: number }) {
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[s.skeleton, { width: width as ViewStyle['width'], height, borderRadius: r, opacity: pulse }]}
    />
  );
}

/** Centered icon + copy for "nothing here" and "nothing matched". */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={s.empty}>
      <Glass contentStyle={s.emptyGlyph} radius={radius.lg} style={{ marginBottom: space.lg }}>
        <Icon name={icon} size={26} color={color.inkFaint} />
      </Glass>
      <Text style={s.emptyTitle}>{title}</Text>
      {hint ? <Text style={s.emptyHint}>{hint}</Text> : null}
      {action ? <View style={{ marginTop: space.lg }}>{action}</View> : null}
    </View>
  );
}

const s = StyleSheet.create({
  title: { ...type.heading, color: color.ink },
  muted: { ...type.body, color: color.inkDim },
  mono: { ...type.meta, color: color.inkDim },
  label: {
    ...type.eyebrow,
    color: color.inkFaint,
    letterSpacing: 0.8,
    marginBottom: 8,
  },

  sectionLabel: { alignItems: 'center', flexDirection: 'row', gap: space.md },
  sectionLabelText: { ...type.eyebrow, color: color.inkFaint, letterSpacing: 1.2 },
  sectionRule: { backgroundColor: color.lineSoft, flex: 1, height: 1 },

  badge: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badge_enc: { backgroundColor: color.mintBg, borderColor: color.mintLine },
  badge_warn: { backgroundColor: color.coralBg, borderColor: color.coralLine },
  badge_plain: { backgroundColor: color.panel2, borderColor: color.line },
  badgeText: { fontFamily: font.mono, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase' },

  banner: {
    alignItems: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  bannerOk: { backgroundColor: color.mintBg, borderColor: color.mintLine },
  bannerWarn: { backgroundColor: color.coralBg, borderColor: color.coralLine },
  bannerText: { flex: 1, fontFamily: font.sans, fontSize: 13.5, lineHeight: 19 },

  callout: {
    backgroundColor: color.coralBg,
    borderColor: color.coralLine,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 11,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  calloutText: { color: color.coralInk, flex: 1, fontFamily: font.sans, fontSize: 13, lineHeight: 19 },

  rim: { backgroundColor: 'rgba(255,255,255,0.16)', height: 1, left: 0, position: 'absolute', right: 0, top: 0 },

  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: color.ground, fontFamily: font.displayBold },

  primaryBtn: {
    alignItems: 'center',
    backgroundColor: color.brass,
    borderRadius: radius.sm,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingVertical: 13,
  },
  primaryBtnOff: { backgroundColor: color.chip, borderColor: color.line, borderWidth: 1 },
  primaryBtnText: { color: color.brassInk, fontFamily: font.sansBold, fontSize: 14.5 },
  secondaryBtn: {
    alignItems: 'center',
    backgroundColor: color.chip,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  secondaryBtnDanger: { backgroundColor: color.coralBg, borderColor: color.coralLine },
  secondaryBtnText: { ...type.strong, color: color.ink, fontSize: 13 },

  iconBtn: {
    alignItems: 'center',
    backgroundColor: color.panel,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    justifyContent: 'center',
  },

  field: {
    backgroundColor: color.chip,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginBottom: 11,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  fieldFocused: { backgroundColor: color.panel2, borderColor: color.focus },
  fieldWarn: { borderColor: color.coralLine },
  input: { color: color.ink, fontFamily: font.sans, fontSize: 15, padding: 0 },
  inputBig: { minHeight: 120, lineHeight: 22, textAlignVertical: 'top' },

  card: { padding: 16 },
  divider: { backgroundColor: color.lineSoft, height: 1 },

  skeleton: { backgroundColor: color.panel2 },

  empty: { alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: 56 },
  emptyGlyph: {
    alignItems: 'center',
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  emptyTitle: { ...type.strong, color: color.ink, textAlign: 'center' },
  emptyHint: { ...type.small, color: color.inkFaint, marginTop: 6, textAlign: 'center' },
});
