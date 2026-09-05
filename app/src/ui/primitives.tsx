import { BlurView } from 'expo-blur';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Modal,
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
import { useReducedMotion } from 'react-native-reanimated';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';

import { avatarTints, color, font, glass, motion, ON_ACCENT, radius, shadow, space, tint, type } from '../theme';
import { useAccent } from './appearance';
import { Icon, IconName } from './Icon';

/* --------------------------------------------------------------- motion ---- */

/** react-native-web has no native animated module; asking for one only warns. */
const NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * Press feedback for anything that reads as a raised control. Opacity alone is
 * ambiguous on a dark ground — a small scale makes the touch land.
 */
/**
 * The returned `style` must be applied **unconditionally**, even while the
 * control is disabled or busy.
 *
 * Swapping it for `undefined` removes the `transform` array from the view's
 * props while the native animation driver still holds the node, and Fabric's
 * prop-override path asserts on exactly that:
 *
 *   assert(outputReadableMap.getType("transform") == ReadableType.Array && …)
 *   — SurfaceMountingManager.overridePropsReadableMap
 *
 * which is a hard `AssertionError` on the main thread, i.e. the whole app dies.
 * It cost a crash on every send, because the Send button sets `busy` mid-flight.
 *
 * Nothing is lost by always applying it: `Pressable`'s own `disabled` already
 * stops `onPressIn`/`onPressOut`, so a disabled control never animates anyway.
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

/**
 * A face, or the initials that stand in for one.
 *
 * `photo` is only ever the signed-in user's own avatar from their provider, so
 * it is drawn directly. It is deliberately **not** offered for message senders:
 * loading a remote image because mail arrived is a tracking pixel with extra
 * steps, and it would tell a sender the message had been looked at. Senders
 * keep their initials.
 *
 * A URL that fails — expired, offline, signed out at the CDN — falls back to
 * the initials rather than leaving a hole, which is also what makes the tinted
 * circle worth keeping underneath.
 *
 * The tint is the ground for those initials and **only** for them: it is not
 * painted while a photo is showing. A coloured disc behind an opaque circular
 * image is invisible everywhere except the one place it is not wanted — the
 * antialiased edge, where it fringes out around the face as a coloured ring
 * that reads as a border nobody asked for.
 *
 * **The image carries its own `borderRadius`, and the container clips as well.**
 * Both, not either: `overflow: 'hidden'` on a rounded `View` does not reliably
 * clip a child `Image` on Android, so a container-only clip renders the photo
 * as a square. The image's own radius is what actually rounds it; the
 * container's `overflow` is the backstop for a source whose aspect ratio makes
 * `cover` overflow the box.
 */
export function Avatar({
  seed,
  label,
  size = 34,
  photo,
}: {
  seed: string;
  label: string;
  size?: number;
  photo?: string;
}) {
  const [broken, setBroken] = useState(false);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bg = avatarTints[h % avatarTints.length];

  // Reset when the account behind this circle changes, so a previous row's
  // failure does not suppress the next one's perfectly good picture.
  useEffect(() => setBroken(false), [photo]);

  const showPhoto = Boolean(photo) && !broken;

  return (
    <View
      style={[
        s.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: showPhoto ? 'transparent' : bg,
        },
      ]}
    >
      {showPhoto ? (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setBroken(true)}
          source={{ uri: photo }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        />
      ) : (
        <Text style={[s.avatarText, { fontSize: size * 0.4 }]}>{label}</Text>
      )}
    </View>
  );
}

/**
 * The "every mailbox at once" face, worn wherever an account avatar would be.
 *
 * It is a primitive because two places have to agree on it exactly: the drawer
 * rail, where it is the thing you press to merge, and the mail bar, which
 * stands in for the active account's photo while merged. If those drifted apart
 * the bar would stop looking like the control that put it there.
 *
 * **The glyph fills when it is the one in use**, the way a starred star does —
 * the circle around it never changes. The accounts beside it are photographs,
 * which are always "solid", so an outline that only changed colour was the one
 * mark on the rail whose state you had to look twice to read. Filling the house
 * itself answers "what am I looking at" at a glance without turning the slot
 * into a coloured disc that competes with the faces under it.
 */
export function AllAccountsAvatar({
  size = 34,
  tone,
  active = false,
}: {
  size?: number;
  tone: string;
  active?: boolean;
}) {
  return (
    <View
      style={[
        s.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: 'transparent',
          borderColor: tone,
          borderWidth: 1,
        },
      ]}
    >
      <Icon
        color={tone}
        fill={active ? tone : 'none'}
        name="home"
        size={Math.round(size * 0.52)}
      />
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
    <Animated.View style={press.style}>
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
          <ActivityIndicator size="small" color={color.ground} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={16} color={disabled ? color.inkFaint : color.ground} /> : null}
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
    <Animated.View style={press.style}>
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
/**
 * How a bar's icon buttons are drawn: bigger, heavier, at full ink.
 *
 * The defaults below are tuned for an icon that sits *beside a label* — the
 * label carries the emphasis and the glyph only has to point at it. A bar is
 * the other case: glyphs alone, often over a lit band, with nothing next to
 * them to read. At 36 / `inkDim` / 1.9 a row of those reads as disabled
 * controls, so every top bar in the app spreads this instead.
 */
export const barIcon = { size: 36, glyph: 24, tint: color.ink, weight: 2.2 } as const;

export function IconButton({
  icon,
  label,
  onPress,
  tint = color.inkDim,
  size = 36,
  glyph,
  weight,
  fill,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
  size?: number;
  /** Paints the glyph's interior as well as its outline — the on state of a
   *  button that toggles, where a colour change alone is the same mark twice.
   *  Only for glyphs drawn as one closed shape; an outline icon made of
   *  several strokes fills into a blob. */
  fill?: string;
  /** Glyph size, when it should not follow the box. A bar sets the two apart:
   *  the glyph stays big and the box shrinks around it, so the icons sit close
   *  together as one set of actions. `hitSlop` keeps the target honest. */
  glyph?: number;
  /** Stroke weight for the glyph, where the default reads too light — a bar of
   *  icons standing on its own, with no text beside it to carry the emphasis. */
  weight?: number;
}) {
  const press = usePressScale(0.92);
  return (
    <Animated.View style={press.style}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        hitSlop={10}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [
          s.iconBtn,
          // Round, so the wash under the press is a circle centred on the
          // glyph rather than a chip with corners the icon does not fill.
          { width: size, height: size, borderRadius: size / 2 },
          pressed && { backgroundColor: color.iconPress },
        ]}
      >
        <Icon name={icon} size={glyph ?? Math.round(size * 0.47)} color={tint} strokeWidth={weight} fill={fill} />
      </Pressable>
    </Animated.View>
  );
}

/** Row that behaves like a list item: whole-surface press wash, no scale. */
export function PressableRow({ style, children, ...rest }: PressableProps & { style?: ViewStyle }) {
  return (
    <Pressable {...rest} style={({ pressed }) => [style, pressed && { backgroundColor: color.rowPress }]}>
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
  const accent = useAccent();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={color.inkFaint}
      selectionColor={accent}
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

/* ------------------------------------------------------------ segmented ---- */

/**
 * A segmented control with a sliding thumb — the inbox's `Primary | Encrypted`,
 * and `Theme | Density`.
 *
 * nativecn's animated tab bar: a track holding a filled pill that *travels* to
 * the selected tab rather than cutting to it, with the unselected labels
 * receding as it goes.
 *
 * The thumb is a neutral grey, not the accent. These tabs sit directly above a
 * list of accented date stamps and unread counts, and an accent-filled thumb
 * makes the bar compete with the mail underneath it — `color.segment` and
 * `color.segmentActive` exist for exactly this pair.
 *
 * Tab widths are **measured**, not divided evenly: "Encrypted" is half again as
 * wide as "Primary", and a thumb sized from `width / count` would sit visibly
 * wrong under both. The row the tabs live in is padding-free for the same
 * reason — an absolutely-positioned thumb and a measured child have to agree on
 * where x = 0 is, and padding on a shared parent is what makes them disagree.
 */
const TAB_IDLE_OPACITY = 0.82;

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
  compact,
  stretch,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  style?: StyleProp<ViewStyle>;
  /** The inbox's Primary/Encrypted pill: a smaller control living inside the
   *  top bar, next to the avatar — the roomier size reads oversized there. */
  compact?: boolean;
  /** Fills the width available to it, each option taking an equal share,
   *  instead of sizing to its own content. */
  stretch?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [layouts, setLayouts] = useState<Record<string, { x: number; width: number }>>({});

  const index = Math.max(0, options.findIndex((o) => o.key === value));
  const progress = useRef(new Animated.Value(index)).current;

  useEffect(() => {
    // Reduced motion still moves the thumb — it just arrives immediately.
    // Leaving it behind would be a lie about which tab is selected.
    if (reducedMotion) {
      progress.setValue(index);
      return;
    }
    Animated.timing(progress, {
      toValue: index,
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
      // translateX + scaleX (below) are the only two properties driving the
      // thumb, and neither is a layout prop — the whole animation can run on
      // the native thread, off whatever the JS thread is doing (e.g. a tab
      // switch re-filtering the mail list). A `width` tween can't join it:
      // that's a layout prop, forces the JS driver, and stutters under load.
      useNativeDriver: true,
    }).start();
  }, [index, progress, reducedMotion]);

  const measured = options.length > 0 && options.every((o) => layouts[o.key]);
  const spread = measured && options.length > 1;
  const inputRange = options.map((_, i) => i);
  // A fixed reference width the thumb is declared at; scaleX stretches it to
  // each tab's measured width instead of animating `width` directly.
  const baseWidth = (measured && (layouts[options[0]?.key]?.width || layouts[options[options.length - 1]?.key]?.width)) || 1;

  /** Interpolate across every tab's measured value, or hold the one we have. */
  const across = (pick: (key: T) => number) =>
    spread
      ? progress.interpolate({ inputRange, outputRange: options.map((o) => pick(o.key)) })
      : measured
        ? pick(options[index]?.key ?? options[0].key)
        : 0;

  return (
    <View style={[s.segment, stretch && s.segmentStretch, style]}>
      <View accessibilityRole="tablist" style={s.segmentTrack}>
        {/* Drawn before the tabs so it sits behind their labels. */}
        <Animated.View
          style={[
            s.segmentThumb,
            {
              opacity: measured ? 1 : 0,
              width: baseWidth,
              transform: [
                {
                  translateX: across(
                    (key) => (layouts[key]?.x ?? 0) + (layouts[key]?.width ?? 0) / 2 - baseWidth / 2,
                  ),
                },
                { scaleX: across((key) => (layouts[key]?.width ?? baseWidth) / baseWidth) },
              ],
            },
          ]}
        />

        {options.map((option, i) => {
          const active = option.key === value;
          // Own index reads 1; every other tab's index pushes it back down.
          const fade = spread
            ? progress.interpolate({
                inputRange,
                outputRange: options.map((_, j) => (j === i ? 1 : TAB_IDLE_OPACITY)),
              })
            : active
              ? 1
              : TAB_IDLE_OPACITY;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              key={option.key}
              onLayout={(e) => {
                const { x, width } = e.nativeEvent.layout;
                setLayouts((prev) =>
                  prev[option.key]?.x === x && prev[option.key]?.width === width
                    ? prev
                    : { ...prev, [option.key]: { x, width } },
                );
              }}
              onPress={() => onChange(option.key)}
              style={[s.segmentItem, compact && s.segmentItemCompact, stretch && s.segmentItemStretch]}
            >
              <Animated.Text
                style={[s.segmentText, compact && s.segmentTextCompact, active && { color: color.ink }, { opacity: fade }]}
              >
                {option.label}
              </Animated.Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ---------------------------------------------------------------- sheet ---- */

/**
 * A bottom sheet: scrim, blur, rounded top, safe-area padding.
 *
 * This is the one surface that still uses blur - a sheet is the only place
 * where the thing behind it should stay legible. Everything else is now a flat
 * fill on the ground.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  bottomInset?: number;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={StyleSheet.absoluteFill}>
        {Platform.OS !== 'web' ? (
          <BlurView intensity={glass.blur.medium} tint="dark" style={StyleSheet.absoluteFill} />
        ) : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim }, frost(glass.blur.medium)]} />
      </Pressable>

      <View style={[s.sheet, shadow.sheet, { paddingBottom: bottomInset + space.lg }]}>
        <View style={s.sheetGrip} />
        {title ? <Text style={s.sheetTitle}>{title}</Text> : null}
        {children}
      </View>
    </Modal>
  );
}

/* ------------------------------------------------------------- settings ---- */

/**
 * A settings destination: icon, label, an optional value line under it, and an
 * optional trailing control.
 *
 * The value line is the reference's own idea and a good one - "Dark / Blue /
 * Roomy" under Display & Appearance means the user reads the current state
 * without opening the screen.
 */
export function SettingsRow({
  icon,
  label,
  value,
  onPress,
  tint,
  trailing,
}: {
  icon: IconName;
  label: string;
  value?: string;
  onPress: () => void;
  /** Overrides the label colour - used for the one destructive row. */
  tint?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <PressableRow accessibilityRole="button" onPress={onPress} style={s.settingsRow}>
      <Icon name={icon} size={21} color={tint ?? color.inkDim} />
      <View style={{ flex: 1 }}>
        <Text style={[s.settingsLabel, tint ? { color: tint } : null]}>{label}</Text>
        {value ? <Text style={s.settingsValue}>{value}</Text> : null}
      </View>
      {trailing}
    </PressableRow>
  );
}

/** The accented heading above a settings group - "Quick Settings", "General". */
export function GroupHeading({ children }: { children: React.ReactNode }) {
  const accent = useAccent();
  return <Text style={[s.groupHeading, { color: accent }]}>{children}</Text>;
}

/**
 * A bordered card holding a run of rows — a settings group, a filter list.
 *
 * This is the one shape that replaces Outlook'''s continuous full-bleed list:
 * a card with air around it and a hairline *inside* it between rows, rather
 * than a flat list where the only edge is the screen itself.
 */
export function Group({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const items = React.Children.toArray(children);
  return (
    <View style={[s.group, style]}>
      {items.map((child, i) => (
        <React.Fragment key={i}>
          {child}
          {i < items.length - 1 ? <View style={s.groupDivider} /> : null}
        </React.Fragment>
      ))}
    </View>
  );
}

/* --------------------------------------------------------------- choice ---- */

/** A labelled radio, drawn in the accent when selected. */
export function Radio({
  label,
  selected,
  onPress,
  disabled,
  hint,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** Why the option is unavailable. Read out, and shown by the caller. */
  hint?: string;
}) {
  const accent = useAccent();
  const ring = disabled ? color.inkFaint : selected ? accent : color.inkDim;
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.radio, disabled && { opacity: 0.45 }]}
    >
      <Text style={s.radioLabel}>{label}</Text>
      <View style={[s.radioRing, { borderColor: ring }]}>
        {selected ? <View style={[s.radioDot, { backgroundColor: ring }]} /> : null}
      </View>
    </Pressable>
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

  // The backstop clip, not the one that rounds the photo — see `Avatar`.
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarText: { color: ON_ACCENT, fontFamily: font.sansBold },

  // A solid neutral button — near-white on true black — rather than an
  // accent-filled one. The accent is reserved for selection and the one or
  // two places per screen that are genuinely "the" action (compose, send);
  // every other button reads as UI chrome, not brand.
  primaryBtn: {
    alignItems: 'center',
    backgroundColor: color.ink,
    borderRadius: radius.sm,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingVertical: 13,
  },
  primaryBtnOff: { backgroundColor: color.card, borderColor: color.border, borderWidth: 1 },
  primaryBtnText: { color: color.ground, fontFamily: font.sansBold, fontSize: 14.5 },
  // Outline, not filled — a hairline border on the card fill rather than a
  // solid grey block.
  secondaryBtn: {
    alignItems: 'center',
    backgroundColor: color.card,
    borderColor: color.border,
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

  // Square-ish ghost tile rather than a filled circle — ghost icon buttons in
  // this family of components sit flush until pressed, they don't sit inside
  // their own filled pill.
  // The radius is set with the box, since a circle is half of whatever size
  // the caller asked for.
  iconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },

  field: {
    backgroundColor: color.surfaceRaised,
    borderColor: 'transparent',
    borderRadius: radius.sm,
    borderWidth: 1,
    marginBottom: 11,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  fieldFocused: { borderColor: color.line },
  fieldWarn: { borderColor: color.coralLine },
  input: { color: color.ink, fontFamily: font.sans, fontSize: 15, padding: 0 },
  inputBig: { minHeight: 120, lineHeight: 22, textAlignVertical: 'top' },

  card: { padding: 16 },
  divider: { backgroundColor: color.lineSoft, height: 1 },

  skeleton: { backgroundColor: color.surfaceRaised },

  // A filled track with a pill thumb that slides between the tabs. The outer
  // view carries the fill and the inset; `segmentTrack` is deliberately
  // padding-free so the thumb's `left: 0` and a tab's measured `x` share an
  // origin.
  segment: {
    alignSelf: 'flex-start',
    backgroundColor: color.segment,
    borderRadius: radius.pill,
    padding: 4,
  },
  segmentStretch: { alignSelf: 'stretch' },
  segmentTrack: { flexDirection: 'row', position: 'relative' },
  segmentThumb: {
    backgroundColor: color.segmentActive,
    borderRadius: radius.pill,
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
  },
  segmentItem: { paddingHorizontal: 20, paddingVertical: 11 },
  segmentItemCompact: { paddingHorizontal: 14, paddingVertical: 7 },
  segmentItemStretch: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  // Both labels stay light: the pill is what says which is selected, so the
  // type does not also have to shout it.
  segmentText: { ...type.tab, color: color.body },
  segmentTextCompact: { fontSize: 13.5 },

  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    bottom: 0,
    left: 0,
    paddingTop: space.sm,
    position: 'absolute',
    right: 0,
  },
  sheetGrip: {
    alignSelf: 'center',
    backgroundColor: color.line,
    borderRadius: radius.pill,
    height: 4,
    marginBottom: space.md,
    width: 36,
  },
  sheetTitle: { ...type.heading, color: color.ink, paddingBottom: space.sm, paddingHorizontal: space.lg },

  settingsRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  settingsLabel: { ...type.settingsRow, color: color.ink },
  settingsValue: { ...type.settingsValue, color: color.inkDim, marginTop: 2 },
  groupHeading: {
    ...type.section,
    paddingBottom: space.sm,
    paddingHorizontal: space.lg + 2,
    paddingTop: space.lg,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontSize: 12.5,
  },

  group: {
    backgroundColor: color.card,
    borderColor: color.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    marginHorizontal: space.lg,
    overflow: 'hidden',
  },
  groupDivider: { backgroundColor: color.border, height: 1, marginLeft: 54 },

  radio: { alignItems: 'center', gap: space.sm },
  radioLabel: { ...type.settingsRow, color: color.ink },
  radioRing: { alignItems: 'center', borderRadius: 10, borderWidth: 2, height: 20, justifyContent: 'center', width: 20 },
  radioDot: { borderRadius: 5, height: 10, width: 10 },


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
